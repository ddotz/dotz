import { execFile } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { listSync } from "./ovnfs.ts";
import { parseSlotName, slugOf } from "./slots.ts";

const WHEREIS_TIMEOUT_MS = 2_000;
const GIT_TIMEOUT_MS = 30_000;
const FAILURE_MEMORY_MS = 30_000;
const GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const LEAKED_GIT_ENV: readonly string[] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"];

/** Where a path sits: inside slot `name` (number `n`) of `folder`, at `subdir` below the slot's root `path` (empty at the root). `path` and `folder` are real paths. */
export interface Placement {
	readonly name: string;
	readonly path: string;
	readonly folder: string;
	readonly n: number;
	readonly subdir: string;
}

/** What removing a slot would lose. `unlanded`: its HEAD is not reachable from the folder's branch. `uncommitted`: paths git reports changed whose content differs from the folder's current file. `gitError` is set when git could not answer, and that counts as work. */
export interface SlotWork {
	readonly work: boolean;
	readonly unlanded: boolean;
	readonly uncommitted: readonly string[];
	readonly gitError: string | undefined;
}

type Git = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly status: number | undefined; readonly why: string };

const placements = new Map<string, Placement>();
const mountParents = new Set<string>();
const outsideMount = new Set<string>();
const failures = new Map<string, { readonly at: number; readonly path: string | undefined }>();

function realOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * The slot whose root contains `cwd`, from `ovnfs ls --json`, or undefined when `cwd` is in no slot, ovnfs fails or does not answer within 2 s, or the listing cannot be read.
 * Blocks while it asks. A found placement is kept for the life of the process. After a successful listing the parent directories of all checkout roots are remembered, and a `cwd` below none of them is remembered as a miss and never asked again; a `cwd` below one of them that matches no slot is asked again. A failed listing is remembered for 30 s for the `cwd` that asked and the ovnfs its `PATH` resolves: until then that `cwd`, with that same `PATH`, answers undefined without spawning, and its next call after it asks again; another `cwd` asks at once, and a successful listing ends every such memory. Never throws.
 */
export function whereis(cwd: string): Placement | undefined {
	const real = realOrUndefined(cwd);
	if (real === undefined) return undefined;
	const known = placements.get(real);
	if (known !== undefined) return known;
	if (outsideMount.has(real)) return undefined;
	const failure = failures.get(real);
	if (failure !== undefined && failure.path === process.env.PATH && Date.now() - failure.at < FAILURE_MEMORY_MS) return undefined;
	const listed = listSync(WHEREIS_TIMEOUT_MS);
	if (!listed.ok) {
		failures.set(real, { at: Date.now(), path: process.env.PATH });
		return undefined;
	}
	failures.clear();
	for (const row of listed.value) {
		const parent = dirname(row.path);
		mountParents.add(realOrUndefined(parent) ?? parent);
		const n = parseSlotName(row.name, slugOf(row.source));
		if (n === undefined) continue;
		const root = realOrUndefined(row.path);
		if (root === undefined || (real !== root && !real.startsWith(root + sep))) continue;
		const placement: Placement = { name: row.name, path: root, folder: row.source, n, subdir: relative(root, real) };
		placements.set(real, placement);
		return placement;
	}
	if (![...mountParents].some(parent => real.startsWith(parent.endsWith(sep) ? parent : parent + sep))) outsideMount.add(real);
	return undefined;
}

function gitEnv(ceiling: string | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
	for (const name of LEAKED_GIT_ENV) delete env[name];
	if (ceiling !== undefined) env.GIT_CEILING_DIRECTORIES = ceiling;
	return env;
}

function git(cwd: string, args: readonly string[], options: { readonly ceiling?: string; readonly input?: string } = {}): Promise<Git> {
	const { promise, resolve } = Promise.withResolvers<Git>();
	const child = execFile("git", ["-C", cwd, ...args], { env: gitEnv(options.ceiling), encoding: "utf8", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: GIT_OUTPUT_BYTES }, (error, stdout, stderr) => {
		if (error === null) {
			resolve({ ok: true, stdout });
			return;
		}
		const code: unknown = (error as NodeJS.ErrnoException).code;
		resolve({ ok: false, status: typeof code === "number" ? code : undefined, why: `git ${args.join(" ")} in ${cwd}: ${stderr.trim() || error.message}` });
	});
	child.stdin?.end(options.input ?? "");
	return promise;
}

interface StatusEntry {
	readonly path: string;
	readonly staged: boolean;
}

function statusEntries(output: string): StatusEntry[] {
	const fields = output.split("\0");
	const entries: StatusEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i] ?? "";
		if (field.length < 4) continue;
		const [x, y] = [field[0] ?? " ", field[1] ?? " "];
		entries.push({ path: field.slice(3), staged: x !== " " && y !== " " && x !== "?" && x !== "!" });
		if (/[RC]/.test(field.slice(0, 2))) {
			const original = fields[++i];
			if (original !== undefined && original !== "") entries.push({ path: original, staged: false });
		}
	}
	return entries;
}

type Entry = { readonly kind: "missing" } | { readonly kind: "file"; readonly executable: boolean } | { readonly kind: "link"; readonly target: string } | { readonly kind: "directory" } | { readonly kind: "other" };

function entryAt(path: string): Entry {
	try {
		const stat = lstatSync(path);
		if (stat.isFile()) return { kind: "file", executable: (stat.mode & 0o111) !== 0 };
		if (stat.isSymbolicLink()) return { kind: "link", target: readlinkSync(path) };
		if (stat.isDirectory()) return { kind: "directory" };
		return { kind: "other" };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "other" };
	}
}

async function hashes(dir: string, paths: readonly string[]): Promise<Git> {
	return git(dir, ["hash-object", "--no-filters", "--stdin-paths"], { input: `${paths.join("\n")}\n` });
}

async function missingIn(dir: string, shas: readonly string[], ceiling: string | undefined): Promise<string[] | { readonly error: string }> {
	if (shas.length === 0) return [];
	const known = await git(dir, ["cat-file", "--batch-check"], { ceiling, input: `${shas.join("\n")}\n` });
	if (!known.ok) return { error: known.why };
	return known.stdout
		.split("\n")
		.filter(line => line.endsWith(" missing"))
		.map(line => line.slice(0, line.indexOf(" ")));
}

async function holdsMore(mine: string, theirs: string, head: string, ceiling: string | undefined): Promise<{ readonly more: boolean } | { readonly error: string }> {
	const [refs, stashes] = await Promise.all([git(mine, ["for-each-ref", "--format=%(objectname) %(refname)"], { ceiling }), git(mine, ["stash", "list", "--format=%H"], { ceiling })]);
	if (!refs.ok) return { error: refs.why };
	if (!stashes.ok) return { error: stashes.why };
	const named = refs.stdout
		.split("\n")
		.map(line => line.split(" "))
		.filter(([sha, ref]) => sha !== undefined && sha !== "" && ref !== undefined && !ref.startsWith("refs/remotes/"))
		.map(([sha]) => sha ?? "");
	const shas = [...new Set([head, ...named, ...stashes.stdout.split("\n")].filter(sha => sha !== ""))];
	const absent = await missingIn(theirs, shas, undefined);
	if (!Array.isArray(absent)) return absent;
	const gone = await missingIn(mine, absent, ceiling);
	if (!Array.isArray(gone)) return gone;
	return { more: gone.length < absent.length };
}

async function sameNestedRepo(slotDir: string, folderDir: string): Promise<boolean> {
	if (!existsSync(join(slotDir, ".git")) || !existsSync(join(folderDir, ".git"))) return false;
	const [mine, theirs, status] = await Promise.all([git(slotDir, ["rev-parse", "--verify", "--quiet", "HEAD"]), git(folderDir, ["rev-parse", "--verify", "--quiet", "HEAD"]), git(slotDir, ["status", "--porcelain", "-z", "--untracked-files=all"])]);
	if (!mine.ok || !theirs.ok || !status.ok || mine.stdout.trim() === "" || mine.stdout !== theirs.stdout || status.stdout !== "") return false;
	const held = await holdsMore(slotDir, folderDir, mine.stdout.trim(), undefined);
	return "more" in held && !held.more;
}

async function indexOf(dir: string): Promise<Map<string, string> | { readonly error: string }> {
	const listed = await git(dir, ["ls-files", "--stage", "-z"]);
	if (!listed.ok) return { error: listed.why };
	const index = new Map<string, string>();
	for (const record of listed.stdout.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const path = record.slice(tab + 1);
		index.set(path, `${index.get(path) ?? ""}${record.slice(0, tab)};`);
	}
	return index;
}

async function differing(slot: string, folder: string, entries: readonly StatusEntry[]): Promise<{ readonly paths: string[] } | { readonly error: string }> {
	const changed: string[] = [];
	const hashable: string[] = [];
	const indexes = entries.some(entry => entry.staged) ? await Promise.all([indexOf(slot), indexOf(folder)]) : undefined;
	if (indexes !== undefined && !(indexes[0] instanceof Map)) return indexes[0];
	if (indexes !== undefined && !(indexes[1] instanceof Map)) return indexes[1];
	for (const { path, staged } of entries) {
		const stagedApart = staged && indexes !== undefined && indexes[0] instanceof Map && indexes[1] instanceof Map && indexes[0].get(path) !== indexes[1].get(path);
		if (stagedApart || path.includes("\uFFFD")) {
			changed.push(path);
			continue;
		}
		const mine = entryAt(join(slot, path));
		const theirs = entryAt(join(folder, path));
		if (mine.kind === "missing" && theirs.kind === "missing") continue;
		if (mine.kind === "file" && theirs.kind === "file" && mine.executable === theirs.executable && !/[\n\r]/.test(path)) hashable.push(path);
		else if (mine.kind === "link" && theirs.kind === "link" && mine.target === theirs.target) continue;
		else if (mine.kind === "directory" && theirs.kind === "directory" && path.endsWith("/") && (await sameNestedRepo(join(slot, path), join(folder, path)))) continue;
		else changed.push(path);
	}
	if (hashable.length > 0) {
		const [mine, theirs] = await Promise.all([hashes(slot, hashable), hashes(folder, hashable)]);
		if (!mine.ok) return { error: mine.why };
		if (!theirs.ok) return { error: theirs.why };
		const mineLines = mine.stdout.trim().split("\n");
		const theirLines = theirs.stdout.trim().split("\n");
		if (mineLines.length !== hashable.length || theirLines.length !== hashable.length) return { error: `git hash-object in ${slot} answered ${mineLines.length} and ${theirLines.length} hashes for ${hashable.length} paths` };
		hashable.forEach((path, index) => {
			if (mineLines[index] !== theirLines[index]) changed.push(path);
		});
	}
	return { paths: changed.sort() };
}

function failed(why: string): SlotWork {
	return { work: true, unlanded: false, uncommitted: [], gitError: why };
}

function hiddenEntries(output: string, reported: ReadonlySet<string>): StatusEntry[] {
	const entries: StatusEntry[] = [];
	for (const record of output.split("\0")) {
		const tag = record[0] ?? "";
		const path = record.slice(2);
		if (path === "" || reported.has(path)) continue;
		if (tag === "S" || (tag >= "a" && tag <= "z")) entries.push({ path, staged: false });
	}
	return entries;
}

async function editedHidden(slot: string, hidden: readonly StatusEntry[]): Promise<StatusEntry[] | { readonly error: string }> {
	const index = await indexOf(slot);
	if (!(index instanceof Map)) return index;
	const files = hidden.filter(entry => entryAt(join(slot, entry.path)).kind === "file" && !/[\n\r]/.test(entry.path));
	const hashed = files.length > 0 ? await hashes(slot, files.map(entry => entry.path)) : undefined;
	if (hashed !== undefined && !hashed.ok) return { error: hashed.why };
	const lines = hashed === undefined ? [] : hashed.stdout.trim().split("\n");
	if (lines.length !== files.length) return { error: `git hash-object in ${slot} answered ${lines.length} hashes for ${files.length} paths` };
	const untouched = new Set(files.filter((entry, at) => index.get(entry.path)?.split(" ")[1] === lines[at]).map(entry => entry.path));
	return hidden.filter(entry => !untouched.has(entry.path));
}

/**
 * What removing slot `placement` would lose. It holds work when the slot has a commit the folder does not (its HEAD is not an ancestor of the folder's HEAD, or its HEAD, a ref outside `refs/remotes/` or a stash entry names an object the slot has and the folder lacks; a commit left only in the reflog is not counted), or when a path of `git status --untracked-files=all` has content that differs from the folder's current file by `git hash-object`, differs in the executable bit, has an index entry that differs from the folder's index entry, has a name that is not UTF-8, or is an untracked nested repository that differs from the folder's (missing on one side, another HEAD, its own changes, or a ref or stash the folder's copy lacks).
 * A tracked file flagged skip-worktree or assume-unchanged is hidden from `git status`; one `git ls-files -v` finds them, and each one the slot edited (its file no longer hashes to its index entry) is compared with the folder's file like a reported path, so a flagged file only the folder changed is not the slot's work. Ignored files are not work.
 * Any git error counts as work. ovnfs's own `dirty` flag is not consulted. Never throws.
 */
export async function workOf(placement: Placement): Promise<SlotWork> {
	const head = await git(placement.path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { ceiling: dirname(placement.path) });
	if (!head.ok) return failed(head.why);
	const ancestor = await git(placement.folder, ["merge-base", "--is-ancestor", head.stdout.trim(), "HEAD"]);
	if (!ancestor.ok && ancestor.status === undefined) return failed(ancestor.why);
	const held = await holdsMore(placement.path, placement.folder, head.stdout.trim(), dirname(placement.path));
	if ("error" in held) return failed(held.error);
	const [status, flagged] = await Promise.all([git(placement.path, ["status", "--porcelain", "-z", "--untracked-files=all"], { ceiling: dirname(placement.path) }), git(placement.path, ["ls-files", "-v", "-z"], { ceiling: dirname(placement.path) })]);
	if (!status.ok) return failed(status.why);
	if (!flagged.ok) return failed(flagged.why);
	const entries = statusEntries(status.stdout);
	const hidden = hiddenEntries(flagged.stdout, new Set(entries.map(entry => entry.path)));
	const edited = hidden.length > 0 ? await editedHidden(placement.path, hidden) : hidden;
	if (!Array.isArray(edited)) return failed(edited.error);
	const compared = await differing(placement.path, placement.folder, [...entries, ...edited]);
	if ("error" in compared) return failed(compared.error);
	const unlanded = !ancestor.ok || held.more;
	return { work: unlanded || compared.paths.length > 0, unlanded, uncommitted: compared.paths, gitError: undefined };
}
