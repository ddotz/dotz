import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { ompAgentDir } from "../agent-home.ts";
import { mainCheckoutExcluded } from "../guard/machine-rules.ts";
import { claim, dropClaims, liveClaims, livePeers, peersDir } from "../peers/bus.ts";
import { classifyArgv, OMP_COMMANDS } from "./classify-argv.ts";
import { withFolderLock } from "./lock.ts";
import { drop, list, newCheckout, removeCheckout, type Row, snap, snapshots } from "./ovnfs.ts";
import { type Placement, type SlotWork, workOf } from "./place.ts";
import { mergeWays } from "./report.ts";
import { classify, parseSlotName, pickContinue, pickNew, type SlotState, slotName, slugOf } from "./slots.ts";

const BUDGET_MS = 20_000;
const LIST_MS = 5_000;
const LOCK_WAIT_MS = 8_000;
const GIT_MS = 5_000;
const HEADER_BYTES = 64 * 1024;
const RECREATE_LABEL = "main-checkout recreate";
const LEAKED_GIT_ENV: readonly string[] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"];

/** How a main checkout was obtained: made new, recreated in place, or continued with its earlier sessions. */
export type How = "new" | "recreated" | "continued";

/** What the launcher decided: `here` runs omp in the directory it was typed in (`notes` holds one warning line when that is a fallback, none when it is the normal answer); `run` runs it in `dir`, a slot of the folder or a subdirectory of it, and `notes` are the lines for the user. */
export type Entry =
	| { readonly kind: "here"; readonly why: string; readonly notes: readonly string[] }
	| { readonly kind: "run"; readonly dir: string; readonly how: How; readonly notes: readonly string[] };

/** What one launch is typed with: the interactive shell's pid (`shellPid`, which keeps the launch claim alive), its working directory, the arguments omp was given, and the environment. */
export interface LaunchInput {
	readonly shellPid: number;
	readonly pwd: string;
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Overrides of the time limits, in milliseconds: the whole decision (default 20000), one `ovnfs ls` (5000), the wait for the folder lock (8000). */
export interface LaunchLimits {
	readonly budgetMs?: number;
	readonly listMs?: number;
	readonly lockWaitMs?: number;
}

interface Slot {
	readonly name: string;
	readonly path: string;
	readonly row: Row;
	readonly state: SlotState;
	readonly work: SlotWork | undefined;
}

interface Survey {
	readonly folder: string;
	readonly slug: string;
	readonly rows: readonly Row[];
	readonly slots: ReadonlyMap<string, Slot>;
	readonly states: Map<string, SlotState>;
	readonly refused: Map<string, Refusal>;
}

interface Refusal {
	readonly text: string;
	readonly commits: boolean;
}

interface Target {
	readonly folder: string;
	readonly slug: string;
	readonly subdir: string;
	readonly shellPid: number;
}

type Made = { readonly ok: true; readonly name: string; readonly path: string; readonly how: "new" | "recreated"; readonly snapshot: string | undefined } | { readonly ok: false; readonly why: string };

const realOrResolved = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};

const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);

const here = (why: string): Entry => ({ kind: "here", why, notes: [] });

const skipped = (why: string, pwd: string): Entry => ({ kind: "here", why, notes: [`omp: main checkout skipped (${why}); running in ${pwd}`] });

function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
	for (const name of LEAKED_GIT_ENV) delete env[name];
	return env;
}

function gitOut(cwd: string, args: readonly string[]): Promise<string | undefined> {
	const { promise, resolve: done } = Promise.withResolvers<string | undefined>();
	execFile("git", ["-C", cwd, ...args], { env: gitEnv(), encoding: "utf8", timeout: GIT_MS, killSignal: "SIGKILL" }, (error, stdout) => {
		done(error === null ? stdout.trim() : undefined);
	});
	return promise;
}

function sessionsDir(): string {
	return join(ompAgentDir(), "sessions");
}

function bucketOf(cwd: string): string {
	const home = realOrResolved(process.env.HOME || homedir());
	if (within(cwd, home)) return `-${relative(home, cwd).split(sep).join("-")}`;
	return `--${cwd.split(sep).filter(Boolean).join("-")}--`;
}

function newestSession(slotPath: string): number | undefined {
	const bucket = join(sessionsDir(), bucketOf(slotPath));
	let newest: number | undefined;
	let files: string[];
	try {
		files = readdirSync(bucket);
	} catch {
		return undefined;
	}
	for (const file of files) {
		if (!file.endsWith(".jsonl")) continue;
		try {
			const mtime = statSync(join(bucket, file)).mtimeMs;
			if (newest === undefined || mtime > newest) newest = mtime;
		} catch {
			continue;
		}
	}
	return newest;
}

function recordedCwd(file: string): string | undefined {
	const buffer = Buffer.alloc(HEADER_BYTES);
	let length: number;
	const fd = openSync(file, "r");
	try {
		length = readSync(fd, buffer, 0, HEADER_BYTES, 0);
	} finally {
		closeSync(fd);
	}
	for (const line of buffer.subarray(0, length).toString("utf8").split("\n")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "session") return "cwd" in parsed && typeof parsed.cwd === "string" ? parsed.cwd : undefined;
	}
	return undefined;
}

function sessionFilesWithId(id: string): string[] {
	const root = sessionsDir();
	const found: string[] = [];
	let buckets: string[];
	try {
		buckets = readdirSync(root);
	} catch {
		return found;
	}
	for (const bucket of buckets) {
		let files: string[];
		try {
			files = readdirSync(join(root, bucket));
		} catch {
			continue;
		}
		for (const file of files) {
			const at = file.indexOf("_");
			if (file.endsWith(".jsonl") && at >= 0 && file.slice(at + 1, -".jsonl".length).startsWith(id)) found.push(join(root, bucket, file));
		}
	}
	return found;
}

function holdersOf(slot: { readonly name: string; readonly path: string }, peerCwds: readonly string[], claimed: ReadonlySet<string>): number {
	let count = claimed.has(slot.name) ? 1 : 0;
	for (const cwd of peerCwds) if (within(cwd, slot.path)) count++;
	return count;
}

async function survey(folder: string, slug: string, listMs: number): Promise<Survey | string> {
	const listed = await list(listMs);
	if (!listed.ok) return listed.why;
	const dir = peersDir();
	const peerCwds = livePeers(dir).map(peer => realOrResolved(peer.cwd));
	const claimed = new Set(liveClaims(dir, Date.now()).map(entry => entry.slot));
	const own = listed.value.filter(row => parseSlotName(row.name, slug) !== undefined && row.source === folder);
	const found = await Promise.all(
		own.map(async (row): Promise<Slot> => {
			const path = realOrResolved(row.path);
			const holders = holdersOf({ name: row.name, path }, peerCwds, claimed);
			let work: SlotWork | undefined;
			if (holders === 0) {
				const placement: Placement = { name: row.name, path, folder, n: parseSlotName(row.name, slug) ?? 0, subdir: "" };
				work = await workOf(placement);
			}
			return { name: row.name, path, row, state: classify(Array.from({ length: holders }), work ?? { work: false }), work };
		}),
	);
	const slots = new Map(found.map(slot => [slot.name, slot]));
	return { folder, slug, rows: listed.value, slots, states: new Map(found.map(slot => [slot.name, slot.state])), refused: new Map() };
}

function describeParked(slot: Slot, refusal: Refusal | undefined): string {
	if (refusal !== undefined) return refusal.text;
	const work = slot.work;
	if (work === undefined) return "holds work";
	if (work.gitError !== undefined) return "git could not tell what it holds";
	const parts: string[] = [];
	if (work.unlanded) parts.push("unlanded commits");
	if (work.uncommitted.length > 0) parts.push(`${work.uncommitted.length} uncommitted path${work.uncommitted.length === 1 ? "" : "s"}`);
	return parts.join(", ") || "holds work";
}

function parkedLines(found: Survey, except: string): string[] {
	const lines: string[] = [];
	for (const [name, state] of found.states) {
		const slot = found.slots.get(name);
		if (state !== "parked" || name === except || slot === undefined) continue;
		const refusal = found.refused.get(name);
		const ways = refusal !== undefined ? { land: refusal.commits, apply: false } : slot.work === undefined ? { land: false, apply: false } : mergeWays(slot.work);
		const hints = ["`omp -c` continues it"];
		if (ways.land) hints.push(`\`ovnfs land ${name}\` lands its commits`);
		if (ways.apply) hints.push(`\`ovnfs apply ${name}\` merges its uncommitted changes`);
		lines.push(`parked: ${name} (${describeParked(slot, refusal)}): ${hints.join("; ")}`);
	}
	return lines;
}

async function headerLine(name: string, folder: string, how: string): Promise<string> {
	const [branch, sha] = await Promise.all([gitOut(folder, ["rev-parse", "--abbrev-ref", "HEAD"]), gitOut(folder, ["rev-parse", "--short", "HEAD"])]);
	return `main checkout ${name} of ${folder} (folder branch ${branch ?? "unknown"} at ${sha ?? "unknown"}; ${how})`;
}

async function started(found: Survey, target: Target, made: { readonly name: string; readonly path: string; readonly how: How; readonly snapshot?: string }): Promise<Entry> {
	const notes = [await headerLine(made.name, target.folder, made.snapshot === undefined ? made.how : `${made.how}; earlier state kept as snapshot ${made.snapshot}`)];
	let dir = target.subdir === "" ? made.path : join(made.path, target.subdir);
	if (!existsSync(dir)) {
		notes.push(`${target.subdir} is not in ${made.name}; starting at its root`);
		dir = made.path;
	}
	notes.push(...parkedLines(found, made.name));
	return { kind: "run", dir, how: made.how, notes };
}

async function retire(name: string): Promise<{ readonly ok: true; readonly snapshot: string } | { readonly ok: false; readonly refusal: Refusal }> {
	const taken = await snap(name, RECREATE_LABEL);
	if (!taken.ok) return { ok: false, refusal: { text: "ovnfs could not snapshot it", commits: false } };
	const removed = await removeCheckout(name, { stickySnapshots: true });
	if (removed.ok) return { ok: true, snapshot: taken.value };
	await drop(taken.value);
	return { ok: false, refusal: { text: "ovnfs refused to remove it", commits: true } };
}

async function dropOlder(name: string, keep: string): Promise<void> {
	const listed = await snapshots();
	if (!listed.ok) return;
	for (const snapshot of listed.value) if (snapshot.checkout === name && snapshot.orphan && snapshot.label === RECREATE_LABEL && snapshot.id !== keep) await drop(snapshot.id);
}

async function takeNew(found: Survey, target: Target): Promise<Made> {
	for (;;) {
		const pick = pickNew({ slug: found.slug, folder: found.folder, rows: found.rows, states: found.states });
		const name = slotName(found.slug, pick.n);
		claim(peersDir(), name, target.shellPid, Date.now());
		let snapshot: string | undefined;
		if (pick.recreate) {
			const retired = await retire(name);
			if (!retired.ok) {
				dropClaims(peersDir(), name);
				found.states.set(name, "parked");
				found.refused.set(name, retired.refusal);
				continue;
			}
			snapshot = retired.snapshot;
		}
		const made = await newCheckout(found.folder, name);
		if (!made.ok) {
			dropClaims(peersDir(), name);
			return { ok: false, why: made.why };
		}
		if (snapshot !== undefined) await dropOlder(name, snapshot);
		return { ok: true, name, path: made.value, how: pick.recreate ? "recreated" : "new", snapshot };
	}
}

async function plainLaunch(target: Target, limits: LaunchLimits, pwd: string): Promise<Entry> {
	const found = await survey(target.folder, target.slug, limits.listMs ?? LIST_MS);
	if (typeof found === "string") return skipped(found, pwd);
	const made = await takeNew(found, target);
	if (!made.ok) return skipped(made.why, pwd);
	return started(found, target, made);
}

async function continueLaunch(target: Target, limits: LaunchLimits, pwd: string): Promise<Entry> {
	const found = await survey(target.folder, target.slug, limits.listMs ?? LIST_MS);
	if (typeof found === "string") return skipped(found, pwd);
	const sessions = new Map<string, number>();
	for (const slot of found.slots.values()) {
		const mtime = newestSession(slot.path);
		if (mtime !== undefined) sessions.set(slot.name, mtime);
	}
	const name = pickContinue({ slug: found.slug, folder: found.folder, rows: found.rows, states: found.states }, sessions);
	const slot = name === undefined ? undefined : found.slots.get(name);
	if (slot === undefined) return here("no earlier session in a checkout of this folder");
	claim(peersDir(), slot.name, target.shellPid, Date.now());
	let path = slot.path;
	const extra: string[] = [];
	if (slot.state === "free") {
		const retired = await retire(slot.name);
		if (retired.ok) {
			const made = await newCheckout(found.folder, slot.name);
			if (!made.ok) {
				dropClaims(peersDir(), slot.name);
				return skipped(made.why, pwd);
			}
			path = made.value;
			await dropOlder(slot.name, retired.snapshot);
			extra.push(`${slot.name} was recreated: it holds the folder as it is now; earlier state kept as snapshot ${retired.snapshot}`);
		} else {
			found.states.set(slot.name, "parked");
			found.refused.set(slot.name, retired.refusal);
		}
	}
	const entry = await started(found, target, { name: slot.name, path, how: "continued" });
	return entry.kind === "run" ? { ...entry, notes: [entry.notes[0] ?? "", ...extra, ...entry.notes.slice(1)] } : entry;
}

function heldBy(slot: { readonly name: string; readonly path: string }, shellPid: number): string | undefined {
	const dir = peersDir();
	const names = [...new Set(livePeers(dir).filter(peer => within(realOrResolved(peer.cwd), slot.path)).map(peer => peer.name))].sort();
	if (names.length > 0) return names.join(", ");
	return liveClaims(dir, Date.now()).some(entry => entry.slot === slot.name && entry.shellPid !== shellPid) ? "a starting session" : undefined;
}

async function resumeLaunch(id: string, shellPid: number, rows: readonly Row[], limits: LaunchLimits): Promise<Entry> {
	const files = sessionFilesWithId(id);
	const file = files.length === 1 ? files[0] : undefined;
	if (file === undefined) return here(files.length === 0 ? `no session file for ${id}` : `${id} names more than one session`);
	const recorded = recordedCwd(file);
	if (recorded === undefined) return here("the session file records no cwd");
	const cwd = realOrResolved(recorded);
	for (const row of rows) {
		if (parseSlotName(row.name, slugOf(row.source)) === undefined || !within(cwd, realOrResolved(row.path))) continue;
		const slot = { name: row.name, path: realOrResolved(row.path) };
		const take = (): string | undefined => {
			const holder = heldBy(slot, shellPid);
			if (holder === undefined) claim(peersDir(), row.name, shellPid, Date.now());
			return holder;
		};
		const locked = await withFolderLock(row.source, take, { waitMs: limits.lockWaitMs ?? LOCK_WAIT_MS });
		const holder = locked.acquired ? locked.value : take();
		const why = `resuming a session of ${row.name}`;
		return holder === undefined ? here(why) : { kind: "here", why, notes: [`omp: ${row.name} is in use by ${holder}; the resumed session will share its working tree`] };
	}
	return here("the session's cwd is in no main checkout");
}

async function decide(input: LaunchInput, limits: LaunchLimits): Promise<Entry> {
	const argv = classifyArgv(input.argv, OMP_COMMANDS, input.env);
	if (argv.kind === "here") return here(argv.why);
	const pwd = realOrResolved(input.pwd);
	const top = await gitOut(pwd, ["rev-parse", "--show-toplevel"]);
	if (top === undefined || top === "") return here("not in a git work tree");
	const folder = realOrResolved(top);
	if (mainCheckoutExcluded(folder)) return here("the folder is excluded in machine-rules.json");
	if ((await gitOut(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) === undefined) return here("the folder has no commit yet");
	const listed = await list(limits.listMs ?? LIST_MS);
	if (!listed.ok) return skipped(listed.why, input.pwd);
	if (listed.value.some(row => within(pwd, realOrResolved(row.path)))) return here("already inside a checkout");
	if (argv.kind === "resume") return resumeLaunch(argv.id, input.shellPid, listed.value, limits);
	const target: Target = { folder, slug: slugOf(folder), subdir: relative(folder, pwd), shellPid: input.shellPid };
	const locked = await withFolderLock(folder, () => (argv.kind === "continue" ? continueLaunch(target, limits, input.pwd) : plainLaunch(target, limits, input.pwd)), { waitMs: limits.lockWaitMs ?? LOCK_WAIT_MS });
	return locked.acquired ? locked.value : skipped(locked.why, input.pwd);
}

/**
 * Decides where an `omp` start runs and prepares it: `here` for print mode, subcommands, `--cwd`, a folder outside git, without a commit yet or excluded by the machine rules, a cwd already inside a checkout, ovnfs not answering and a folder lock not obtained (the last two with a warning note); `run` in a main checkout slot of the folder otherwise.
 * A plain start takes the lowest absent or free slot under the folder lock and claims it before creating or recreating it; `-c` takes the slot of the folder whose session bucket holds the newest file and that nothing holds. A free slot is recreated only after its state is kept as a snapshot (`ovnfs snap`, `rm --sticky-snapshots`); one whose snapshot cannot be taken is treated like one ovnfs refuses to remove. `-r`/`--resume`/`--restore` with an id returns `here`, and claims the slot the session's recorded cwd is in unless a live peer or another shell's claim already holds it, in which case the entry carries one note saying so.
 * The whole decision has one budget (default 20 s); running out of it, like any unexpected failure, rejects.
 */
export async function enter(input: LaunchInput, limits: LaunchLimits = {}): Promise<Entry> {
	const budgetMs = limits.budgetMs ?? BUDGET_MS;
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error(`no decision within ${budgetMs / 1000} s`)), budgetMs);
	try {
		return await Promise.race([decide(input, limits), expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function emit(stream: NodeJS.WriteStream, text: string): Promise<void> {
	const { promise, resolve: done } = Promise.withResolvers<void>();
	stream.write(text, () => done());
	return promise;
}

async function main(args: readonly string[]): Promise<number> {
	const shellPid = Number(args[0]);
	const pwd = args[1];
	if (!Number.isInteger(shellPid) || shellPid <= 0 || pwd === undefined || pwd === "" || args[2] !== "--") {
		await emit(process.stderr, "usage: bun launch.ts <shell-pid> <pwd> -- <omp args...>\n");
		return 2;
	}
	let entry: Entry;
	try {
		entry = await enter({ shellPid, pwd, argv: args.slice(3), env: process.env });
	} catch (error) {
		await emit(process.stderr, `omp launcher: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	if (entry.notes.length > 0) await emit(process.stderr, `${entry.notes.join("\n")}\n`);
	await emit(process.stdout, entry.kind === "run" ? `run\t${entry.dir}\n` : "here\n");
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
