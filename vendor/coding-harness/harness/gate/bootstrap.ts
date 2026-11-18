import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { gateFilePath } from "./gate-file.ts";
import { stateDir } from "./log.ts";
import { initRuleKit } from "./rules.ts";
import { git as runGit } from "./snapshot.ts";
import { isRecord, message } from "./util.ts";

const NODE_PATHS = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "package.json", "tsconfig*.json"];
const PYTHON_PATHS = ["**/*.py", "pyproject.toml"];
const RUST_PATHS = ["**/*.rs", "Cargo.toml"];
const GO_PATHS = ["**/*.go", "go.mod"];
const MAKE_PATHS = ["**/*"];
const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "tsc"];
const TEST_SCRIPTS = ["test:unit", "test"];
const NO_TEST_STUB = "no test specified";
const PYTHON_TEST_FILE = /^(test_.*|.*_test)\.py$/;
const SKIPPED_DIRS = ["node_modules", "__pycache__"];
const WALK_SKIPPED = [...SKIPPED_DIRS, "target"];
const MAKE_RULE = /^([^\s#:=][^:=#]*):{1,2}(?![:=])/;
const MANIFESTS = ["package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "pyproject.toml", "setup.cfg", "pytest.ini", "ruff.toml", "mypy.ini", "uv.lock", "Cargo.toml", "go.mod", "Makefile"];
const PACKAGE_MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
const DEPENDENCY_DIRS = ["node_modules", ".venv", "target"];
const LINKED_DIRS = ["node_modules", ".venv"];
const DEPENDENCY_DEPTH = 3;
const GATE_FILE = ".omp/gate.json";
const CALIBRATE_DIR = "calibrate";
const CARGO_TARGET = ".calibrate-target";
const IGNORED_CHILD = ".calibrate-probe";
const LEFTOVER_MS = 60 * 60 * 1000;
const INSTALL_HINT = "install it and run the script again to add it";
const DEFAULT_LIMITS: Limits = { includeSec: 20, maxSec: 20, budgetSec: 90 };
const BACKSTOP_SEC = 2;
const MIN_TIMEOUT_SEC = 30;
const FAILURE_LINES = 5;
const PATHS_SHOWN = 5;
const MAX_LINE = 300;
const PIPE_GRACE_MS = 500;
const KEPT_OUTPUT = 64 * 1024;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 20;
const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const BOM = /^\uFEFF/;
const DECLINED = "declined by the user; only the user can undo it with /gate-decline undo";
const WRAPPER = [
	"limit=$1",
	"group=$$",
	"exec 3<&0",
	'sh -c "$2" 0</dev/null 3<&- &',
	"child=$!",
	'(while read -r line; do :; done <&3; kill -KILL "-$group") >/dev/null 2>&1 &',
	'(sleep "$limit" && kill -KILL "-$group") 3<&- >/dev/null 2>&1 &',
	'wait "$child"',
	"exit $?",
].join("\n");

interface Limits {
	includeSec: number;
	maxSec: number;
	budgetSec: number;
}

interface Ran {
	exitCode: number | null;
	output: string;
	seconds: number;
	timedOut: boolean;
}

interface Recorded {
	at: string;
	result: "created" | "nothing-passed" | "declined";
	included: string[];
	excluded: { name: string; reason: string }[];
	manifests: string;
	gateSha256?: string;
	missing?: string[];
}

type Known = Pick<Recorded, "result" | "manifests" | "gateSha256"> & { missing: string[] };

interface Identities {
	checkout: string;
	common: string;
}

interface Calibrated {
	verdicts: Verdict[];
	missing: string[];
}

/** A check command a repo declares. `name` is `typecheck`, `lint` or `test`, prefixed by the ecosystem when two ecosystems give the same name; `paths` are the globs of the files the check covers. */
export interface Candidate {
	name: string;
	command: string;
	paths: string[];
}

/** What calibration made of one candidate: `included` when it exited 0 within the include limit and left the checkout as it was, otherwise `reason` says why not. */
export interface Verdict {
	candidate: Candidate;
	included: boolean;
	seconds: number;
	reason?: string;
}

/** The outcome of one bootstrap: `created` lists the files written (empty in a dry run), `verdicts` is empty when no candidate ran, `error` is set when the state could not be written, in which case no file was. */
export interface BootstrapReport {
	repo: string;
	result: "created" | "nothing-passed" | "environment-missing" | "exists" | "committed" | "declined";
	verdicts: Verdict[];
	created: string[];
	error?: string;
}

const errno = (error: unknown): string | undefined => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined);

const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function lstatOptional(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes(errno(error) ?? "")) return undefined;
		throw error;
	}
}

function bytesOf(file: string): Buffer | undefined {
	try {
		return readFileSync(file);
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "EISDIR"].includes(errno(error) ?? "")) return undefined;
		throw error;
	}
}

const readOptional = (file: string): string | undefined => bytesOf(file)?.toString("utf8").replace(BOM, "");

function writeAtomically(file: string, text: string): void {
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, text);
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function removeIfEmpty(dir: string): void {
	try {
		rmdirSync(dir);
	} catch (error) {
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errno(error) ?? "")) throw error;
	}
}

function checksOf(paths: readonly string[], entries: readonly (readonly [string, string | undefined])[]): Candidate[] {
	return entries.flatMap(([name, command]) => (command === undefined ? [] : [{ name, command, paths: [...paths] }]));
}

function scriptsOf(manifest: string): Map<string, string> {
	const scripts = new Map<string, string>();
	let data: unknown;
	try {
		data = JSON.parse(manifest);
	} catch (error) {
		if (error instanceof SyntaxError) return scripts;
		throw error;
	}
	if (isRecord(data) && isRecord(data.scripts)) for (const [name, body] of Object.entries(data.scripts)) if (typeof body === "string") scripts.set(name, body);
	return scripts;
}

function nodeChecks(repo: string): Candidate[] {
	const manifest = readOptional(join(repo, "package.json"));
	if (manifest === undefined) return [];
	const has = (name: string) => existsSync(join(repo, name));
	const runner = has("bun.lock") || has("bun.lockb") ? "bun run" : has("pnpm-lock.yaml") ? "pnpm run" : has("yarn.lock") ? "yarn" : "npm run";
	const scripts = scriptsOf(manifest);
	const typecheck = TYPECHECK_SCRIPTS.find(name => scripts.has(name));
	const test = TEST_SCRIPTS.find(name => {
		const body = scripts.get(name);
		return body !== undefined && !body.includes(NO_TEST_STUB);
	});
	const tsc = has("tsconfig.json") && has(join("node_modules", ".bin", "tsc")) ? "node_modules/.bin/tsc --noEmit -p ." : undefined;
	return checksOf(NODE_PATHS, [
		["typecheck", typecheck === undefined ? tsc : `${runner} ${typecheck}`],
		["lint", scripts.has("lint") ? `${runner} lint` : undefined],
		["test", test === undefined ? undefined : `${runner} ${test}`],
	]);
}

function holdsPythonTest(dir: string): boolean {
	if (!isDirectory(dir)) return false;
	return readdirSync(dir, { withFileTypes: true }).some(entry => (entry.isFile() && PYTHON_TEST_FILE.test(entry.name)) || (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.includes(entry.name) && holdsPythonTest(join(dir, entry.name))));
}

function pythonChecks(repo: string): Candidate[] {
	const has = (name: string) => existsSync(join(repo, name));
	if (!has("pyproject.toml") && !has("setup.cfg") && !has("pytest.ini")) return [];
	const toml = readOptional(join(repo, "pyproject.toml")) ?? "";
	const prefix = has("uv.lock") ? "uv run " : "";
	const mypy = toml.includes("[tool.mypy") || has("mypy.ini");
	const ruff = toml.includes("[tool.ruff") || has("ruff.toml");
	const pytest = toml.includes("[tool.pytest") || has("pytest.ini") || ["tests", "test"].some(dir => holdsPythonTest(join(repo, dir)));
	return checksOf(PYTHON_PATHS, [
		["typecheck", mypy ? `${prefix}mypy .` : undefined],
		["lint", ruff ? `${prefix}ruff check .` : undefined],
		["test", pytest ? `${prefix}pytest -q` : undefined],
	]);
}

function rustChecks(repo: string): Candidate[] {
	if (!existsSync(join(repo, "Cargo.toml"))) return [];
	return checksOf(RUST_PATHS, [
		["typecheck", "cargo check --quiet"],
		["test", "cargo test --quiet"],
	]);
}

function goChecks(repo: string): Candidate[] {
	if (!existsSync(join(repo, "go.mod"))) return [];
	return checksOf(GO_PATHS, [
		["typecheck", "go vet ./..."],
		["test", "go test ./..."],
	]);
}

function makeChecks(repo: string, taken: ReadonlySet<string>): Candidate[] {
	const text = readOptional(join(repo, "Makefile"));
	if (text === undefined) return [];
	const targets = new Set<string>();
	for (const line of text.split("\n")) {
		const rule = MAKE_RULE.exec(line);
		if (rule) for (const name of rule[1].split(/\s+/)) targets.add(name);
	}
	const offer = (name: string, target: string): [string, string | undefined] => [name, targets.has(target) && !taken.has(name) ? `make ${target}` : undefined];
	return checksOf(MAKE_PATHS, [offer("typecheck", "check"), offer("lint", "lint"), offer("test", "test")]);
}

/** The check commands a repo declares, found from its files alone; the same repo always gives the same list in the same order. */
export function candidates(repo: string): Candidate[] {
	const root = resolve(repo);
	const groups: [string, Candidate[]][] = [
		["node", nodeChecks(root)],
		["python", pythonChecks(root)],
		["rust", rustChecks(root)],
		["go", goChecks(root)],
	];
	groups.push(["make", makeChecks(root, new Set(groups.flatMap(([, found]) => found.map(candidate => candidate.name))))]);
	const counts = new Map<string, number>();
	for (const [, found] of groups) for (const { name } of found) counts.set(name, (counts.get(name) ?? 0) + 1);
	return groups.flatMap(([ecosystem, found]) => found.map(candidate => ((counts.get(candidate.name) ?? 0) > 1 ? { ...candidate, name: `${ecosystem}-${candidate.name}` } : candidate)));
}

function subdirectories(dir: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(errno(error) ?? "")) return [];
		throw error;
	}
	return entries
		.filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && !WALK_SKIPPED.includes(entry.name))
		.map(entry => entry.name)
		.sort();
}

function directoriesWithin(root: string, depth: number): string[] {
	const found = [""];
	let level = [""];
	for (let step = 0; step < depth; step++) {
		level = level.flatMap(dir => subdirectories(join(root, dir)).map(name => join(dir, name)));
		found.push(...level);
	}
	return found;
}

function packageRoots(repo: string): string[] {
	return directoriesWithin(repo, DEPENDENCY_DEPTH - 1).filter(dir => dir === "" || PACKAGE_MANIFESTS.some(name => existsSync(join(repo, dir, name))));
}

function manifestFingerprint(repo: string): string {
	const hash = createHash("sha256");
	for (const dir of packageRoots(repo)) {
		hash.update(`root\0${dir}\0`);
		for (const name of MANIFESTS) {
			const content = bytesOf(join(repo, dir, name));
			if (content !== undefined) hash.update(`${name}\0${content.length}\0`).update(content).update("\0");
		}
		for (const name of DEPENDENCY_DIRS) hash.update(`${name}\0${isDirectory(join(repo, dir, name)) ? 1 : 0}\0`);
	}
	return hash.digest("hex");
}

function lastLines(output: string, count: number): string[] {
	const lines = output
		.replace(ANSI, "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map(line => line.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.slice(-count).map(line => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line));
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (!["ESRCH", "EPERM"].includes(errno(error) ?? "")) throw error;
	}
}

function runCandidate(command: string, worktree: string, limitSec: number, signal?: AbortSignal): Promise<Ran> {
	const { promise, resolve: settle, reject: fail } = Promise.withResolvers<Ran>();
	if (signal?.aborted) {
		fail(signal.reason);
		return promise;
	}
	const started = performance.now();
	const env = { ...process.env, CARGO_TARGET_DIR: join(worktree, CARGO_TARGET) };
	const child = spawn("sh", ["-c", WRAPPER, "sh", String(limitSec + BACKSTOP_SEC), command], { cwd: worktree, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	const decoder = new StringDecoder("utf8");
	const timers: NodeJS.Timeout[] = [];
	let output = "";
	let timedOut = false;
	let settled = false;
	let groupGone = false;
	let endedAt: number | undefined;

	const sweep = () => {
		if (child.pid !== undefined && !groupGone) killGroup(child.pid);
	};
	const finish = (exitCode: number | null) => {
		if (settled) return;
		settled = true;
		groupGone = true;
		for (const timer of timers) clearTimeout(timer);
		signal?.removeEventListener("abort", sweep);
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		if (signal?.aborted) fail(signal.reason);
		else settle({ exitCode, output: output + decoder.end(), seconds: Math.round((endedAt ?? performance.now()) - started) / 1000, timedOut });
	};
	const append = (chunk: Buffer) => {
		output = (output + decoder.write(chunk)).slice(-KEPT_OUTPUT);
	};

	child.stdout.on("data", append);
	child.stderr.on("data", append);
	child.on("error", error => {
		endedAt ??= performance.now();
		output += error.message;
		finish(null);
	});
	child.on("exit", exitCode => {
		endedAt ??= performance.now();
		sweep();
		groupGone = true;
		timers.push(setTimeout(() => finish(exitCode), PIPE_GRACE_MS));
	});
	child.on("close", exitCode => finish(exitCode));
	timers.push(
		setTimeout(() => {
			timedOut = true;
			sweep();
		}, limitSec * 1000),
	);
	signal?.addEventListener("abort", sweep, { once: true });
	return promise;
}

const calibrateRoot = () => join(stateDir(), CALIBRATE_DIR);

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
	if (!isDirectory(cwd)) return undefined;
	try {
		return await runGit(cwd, args, signal);
	} catch (error) {
		if (isRecord(error) && typeof error.code === "number") return undefined;
		throw error;
	}
}

function unlinkDependencyLinks(worktree: string): void {
	for (const dir of directoriesWithin(worktree, DEPENDENCY_DEPTH - 1)) {
		for (const name of LINKED_DIRS) {
			const path = join(worktree, dir, name);
			if (lstatOptional(path)?.isSymbolicLink()) unlinkSync(path);
		}
	}
}

async function removeWorktree(owner: string, dir: string): Promise<void> {
	unlinkDependencyLinks(dir);
	if ((await git(owner, ["worktree", "remove", "--force", "--force", dir])) === undefined) rmSync(dir, { recursive: true, force: true });
	await git(owner, ["worktree", "prune"]);
	removeIfEmpty(calibrateRoot());
}

async function addWorktree(repo: string, signal?: AbortSignal): Promise<string> {
	if ((await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], signal)) === undefined) throw new Error(`${repo} has no commit yet; the bootstrap calibrates at HEAD`);
	mkdirSync(calibrateRoot(), { recursive: true });
	const dir = join(calibrateRoot(), `${Date.now()}-${randomUUID().slice(0, 8)}`);
	try {
		await runGit(repo, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--detach", dir, "HEAD"], signal);
	} catch (error) {
		await removeWorktree(repo, dir);
		throw error;
	}
	return dir;
}

async function sweepLeftovers(repo: string): Promise<void> {
	let found: string[];
	try {
		found = readdirSync(calibrateRoot());
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes(errno(error) ?? "")) return;
		throw error;
	}
	const stale = Date.now() - LEFTOVER_MS;
	for (const name of found) {
		const dir = join(calibrateRoot(), name);
		const stat = lstatOptional(dir);
		if (stat === undefined || stat.mtimeMs > stale) continue;
		const common = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))?.trim();
		await removeWorktree(common === undefined || common === "" ? repo : common, dir);
	}
}

async function ignoredAmong(repo: string, paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
	const env: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_LITERAL_PATHSPECS"]) delete env[key];
	const proc = Bun.spawn(["git", "-C", repo, "check-ignore", "-z", "--stdin"], { env, stdin: new TextEncoder().encode(paths.map(path => `${path}\0`).join("")), stdout: "pipe", stderr: "pipe", signal });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	signal?.throwIfAborted();
	if (code > 1) throw new Error(`git check-ignore failed in ${repo}: ${err.trim()}`);
	return new Set(out.split("\0"));
}

async function linkDependencies(repo: string, worktree: string, signal?: AbortSignal): Promise<string[]> {
	const present = directoriesWithin(repo, DEPENDENCY_DEPTH - 1)
		.flatMap(dir => LINKED_DIRS.map(name => join(dir, name)))
		.filter(path => isDirectory(join(repo, path)));
	if (present.length === 0) return [];
	const asked = present.map(path => join(path, IGNORED_CHILD));
	const ignored = await ignoredAmong(repo, asked, signal);
	const linked: string[] = [];
	for (const [at, path] of present.entries()) {
		if (!ignored.has(asked[at])) continue;
		const to = join(worktree, path);
		if (lstatOptional(to) !== undefined) continue;
		mkdirSync(dirname(to), { recursive: true });
		symlinkSync(join(repo, path), to);
		linked.push(path);
	}
	return linked;
}

async function changesIn(worktree: string, linked: ReadonlySet<string>, signal?: AbortSignal): Promise<string[]> {
	const raw = await runGit(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ".", `:(exclude)${CARGO_TARGET}`], signal);
	return raw
		.split("\0")
		.filter(entry => entry.length > 3)
		.map(entry => entry.slice(3))
		.filter(path => !linked.has(path))
		.sort();
}

async function resetTree(worktree: string, linked: readonly string[]): Promise<void> {
	await runGit(worktree, ["reset", "--hard", "--quiet"]);
	await runGit(worktree, ["clean", "-f", "-d", "-x", "--quiet", "-e", CARGO_TARGET, ...linked.flatMap(path => ["-e", path])]);
}

function changesLines(changed: readonly string[]): string[] {
	if (changed.length === 0) return [];
	const more = changed.length > PATHS_SHOWN ? `, and ${changed.length - PATHS_SHOWN} more` : "";
	return [`changes files: ${changed.slice(0, PATHS_SHOWN).join(", ")}${more}`];
}

function failureOf(ran: Ran, limits: Limits, capped: boolean, absent: boolean): string[] | undefined {
	if (ran.timedOut) return [capped ? "budget" : `timed out after ${limits.maxSec} s`];
	if (absent) return ["environment", ...lastLines(ran.output, FAILURE_LINES), INSTALL_HINT];
	if (ran.exitCode !== 0) return ["fails now", ...lastLines(ran.output, FAILURE_LINES)];
	if (ran.seconds > limits.includeSec) return [`slower than ${limits.includeSec} s (${ran.seconds.toFixed(1)} s)`];
	return undefined;
}

function judge(candidate: Candidate, ran: Ran, limits: Limits, outcome: { capped: boolean; absent: boolean; changed: readonly string[] }): Verdict {
	const { capped, absent, changed } = outcome;
	const lines = [...(failureOf(ran, limits, capped, absent) ?? []), ...changesLines(changed)];
	const verdict = { candidate, seconds: ran.seconds };
	return lines.length === 0 ? { ...verdict, included: true } : { ...verdict, included: false, reason: lines.join("\n") };
}

async function calibrate(found: Candidate[], repo: string, limits: Limits, signal?: AbortSignal): Promise<Calibrated> {
	const worktree = await addWorktree(repo, signal);
	try {
		const links = await linkDependencies(repo, worktree, signal);
		const linked = new Set(links);
		const verdicts: Verdict[] = [];
		const missing: string[] = [];
		const started = performance.now();
		for (const candidate of found) {
			const left = limits.budgetSec - (performance.now() - started) / 1000;
			if (left <= 0) {
				verdicts.push({ candidate, included: false, seconds: 0, reason: "budget" });
				continue;
			}
			const limit = Math.min(limits.maxSec, left);
			const ran = await runCandidate(candidate.command, worktree, limit, signal);
			const changed = await changesIn(worktree, linked, signal);
			if (changed.length > 0) await resetTree(worktree, links);
			const absent = !ran.timedOut && (ran.exitCode === 126 || ran.exitCode === 127);
			if (absent) missing.push(candidate.name);
			verdicts.push(judge(candidate, ran, limits, { capped: limit < limits.maxSec, absent, changed }));
		}
		return { verdicts, missing };
	} finally {
		await removeWorktree(repo, worktree);
	}
}

const checkOf = ({ candidate, seconds }: Verdict) => ({ name: candidate.name, command: candidate.command, paths: candidate.paths, timeoutSec: Math.max(MIN_TIMEOUT_SEC, Math.ceil(3 * seconds)) });

const gateText = (checks: readonly unknown[]): string => `${JSON.stringify({ checks }, null, 2)}\n`;

function extendedText(repo: string, found: readonly Candidate[], passed: readonly Verdict[]): string {
	const data: unknown = JSON.parse(readFileSync(gateFilePath(repo), "utf8"));
	const kept: unknown[] = isRecord(data) && Array.isArray(data.checks) ? data.checks : [];
	const order = new Map(found.map((candidate, at) => [candidate.name, at]));
	const rank = (check: unknown): number => (isRecord(check) && typeof check.name === "string" ? (order.get(check.name) ?? found.length) : found.length);
	return gateText([...kept, ...passed.map(checkOf)].sort((a, b) => rank(a) - rank(b)));
}

const stateFile = () => join(stateDir(), "bootstrap.json");

function readState(): Record<string, unknown> {
	const file = stateFile();
	const stat = lstatOptional(file);
	if (stat === undefined) return {};
	if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
	try {
		const data: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isRecord(data) ? data : {};
	} catch (error) {
		if (error instanceof SyntaxError) return {};
		throw error;
	}
}

function known(value: unknown): Known | undefined {
	if (!isRecord(value)) return undefined;
	const { result, gateSha256, manifests } = value;
	if (typeof manifests !== "string" || (result !== "created" && result !== "nothing-passed" && result !== "declined")) return undefined;
	return { result, manifests, gateSha256: typeof gateSha256 === "string" ? gateSha256 : undefined, missing: names(value.missing) };
}

function declinedIn(common: string): boolean {
	try {
		return known(readState()[common])?.result === "declined";
	} catch {
		return false;
	}
}

async function locked<T>(action: () => T): Promise<T> {
	const lock = `${stateFile()}.lock`;
	mkdirSync(stateDir(), { recursive: true });
	const giveUp = Date.now() + LOCK_WAIT_MS;
	let acquired = false;
	while (!acquired) {
		try {
			mkdirSync(lock);
			acquired = true;
		} catch (error) {
			if (errno(error) !== "EEXIST") throw error;
			const held = statSync(lock, { throwIfNoEntry: false });
			if (held === undefined) continue;
			if (Date.now() - held.mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
			else if (Date.now() > giveUp) throw new Error(`${lock} is held by another process`);
			else await Bun.sleep(LOCK_POLL_MS);
		}
	}
	try {
		return action();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

function update<T>(change: (state: Record<string, unknown>) => T): Promise<T> {
	return locked(() => {
		const state = readState();
		const result = change(state);
		writeAtomically(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
		return result;
	});
}

const record = (key: string, entry: Recorded): Promise<void> =>
	update(state => {
		state[key] = entry;
	});

async function identitiesOf(repo: string, signal?: AbortSignal): Promise<Identities | undefined> {
	const out = await git(repo, ["rev-parse", "--show-toplevel", "--git-common-dir"], signal);
	if (out === undefined) return undefined;
	const [top, common] = out.trim().split("\n");
	return { checkout: realpathSync(top), common: realpathSync(resolve(repo, common)) };
}

async function requireIdentities(repo: string, signal?: AbortSignal): Promise<Identities> {
	const identities = await identitiesOf(repo, signal);
	if (identities === undefined) throw new Error(`${repo} is not a git repository`);
	return identities;
}

async function defaultBranch(repo: string, signal?: AbortSignal): Promise<string | undefined> {
	const origin = (await git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], signal))?.trim();
	if (origin !== undefined && origin !== "") return origin;
	for (const name of ["main", "master"]) {
		const ref = `refs/heads/${name}`;
		if ((await git(repo, ["rev-parse", "--verify", "--quiet", ref], signal)) !== undefined) return ref;
	}
	return undefined;
}

async function gateCommitted(repo: string, signal?: AbortSignal): Promise<boolean> {
	const holds = async (ref: string | undefined): Promise<boolean> => ref !== undefined && (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}:${GATE_FILE}`], signal)) !== undefined;
	return (await holds("HEAD")) || (await holds(await defaultBranch(repo, signal)));
}

function install(repo: string, text: string): string[] | undefined {
	const gate = gateFilePath(repo);
	if (existsSync(gate)) return undefined;
	const kit = existsSync(join(repo, ".omp", "lint")) ? [] : initRuleKit({ repo });
	mkdirSync(dirname(gate), { recursive: true });
	try {
		writeFileSync(gate, text, { flag: "wx" });
	} catch (error) {
		if (errno(error) === "EEXIST") return undefined;
		throw error;
	}
	return [GATE_FILE, ...kit];
}

function writtenEntry(repo: string, checkout: string): Known | undefined {
	const entry = known(readState()[checkout]);
	const content = bytesOf(gateFilePath(repo));
	return entry?.result === "created" && entry.gateSha256 !== undefined && content !== undefined && sha256(content) === entry.gateSha256 ? entry : undefined;
}

function pendingChecks(repo: string, checkout: string): string[] | undefined {
	try {
		const missing = writtenEntry(repo, checkout)?.missing ?? [];
		return missing.length === 0 ? undefined : missing;
	} catch {
		return undefined;
	}
}

async function extend(repo: string, checkout: string, found: readonly Candidate[], calibrated: Calibrated): Promise<BootstrapReport> {
	const { verdicts, missing } = calibrated;
	const passed = verdicts.filter(verdict => verdict.included);
	const text = extendedText(repo, found, passed);
	const retried = new Set(verdicts.map(verdict => verdict.candidate.name));
	try {
		await update(state => {
			const previous: unknown = state[checkout];
			const was = isRecord(previous) ? previous : {};
			const kept = (Array.isArray(was.excluded) ? was.excluded : []).filter((item: unknown) => !(isRecord(item) && typeof item.name === "string" && retried.has(item.name)));
			state[checkout] = {
				...was,
				at: new Date().toISOString(),
				included: [...names(was.included), ...passed.map(verdict => verdict.candidate.name)],
				excluded: [...kept, ...verdicts.filter(verdict => !verdict.included).map(verdict => ({ name: verdict.candidate.name, reason: verdict.reason ?? "" }))],
				gateSha256: sha256(text),
				missing,
			};
		});
	} catch (error) {
		return { repo, result: "created", verdicts, created: [], error: message(error) };
	}
	writeAtomically(gateFilePath(repo), text);
	return { repo, result: "created", verdicts, created: [GATE_FILE] };
}

/** Finds a repo's check commands, runs each once in a disposable detached worktree of HEAD under `<stateDir>/calibrate` (git hooks off, the checkout's git-ignored `node_modules` and `.venv` directories up to three levels down linked in, `CARGO_TARGET_DIR` inside it), and writes the passing ones to `.omp/gate.json` together with the rule kit; see "D5 contract", "D5 after review round 2" and "D5 after review round 3" in plan/DEFAULTS.md. The user's working tree is never written by calibration, so "passes now" means "passes at HEAD": uncommitted changes, untracked files and ignored files other than the linked directories are not there. A candidate runs at most `limits.maxSec` (default 20 s) and is included when it exits 0 within `limits.includeSec` (default 20 s) and changes no file of that checkout (one that does is excluded as `changes files`, and the checkout is reset for the next candidate); the whole calibration takes at most `limits.budgetSec` (default 90 s), and the candidates left are excluded as `budget`. A candidate counts as environment-missing only by exit status 126 or 127: the ones that passed are kept and written, the missing ones are listed with how to add them (running the script again calibrates just those and adds the ones that pass, while the gate file is still the one the script wrote), and a run where none passed and one was missing is `environment-missing`, which writes and records nothing. Each checkout calibrates for itself and the entry is recorded under its top-level path, with the sha256 of the gate file written. Calibration checkouts left by a run that was killed are removed at the start of the next run once they are an hour old. A repo whose HEAD or default branch holds `.omp/gate.json` answers `committed`. Aborting `signal` kills the running candidate's process group, removes the checkout and rejects. */
export async function bootstrap(input: { repo: string; dryRun?: boolean; limits?: { includeSec: number; maxSec: number; budgetSec?: number }; signal?: AbortSignal }): Promise<BootstrapReport> {
	const repo = resolve(input.repo);
	const limits: Limits = { ...DEFAULT_LIMITS, ...input.limits };
	const identities = await requireIdentities(repo, input.signal);
	const empty = (result: BootstrapReport["result"]): BootstrapReport => ({ repo, result, verdicts: [], created: [] });
	await sweepLeftovers(repo);
	if (declinedIn(identities.common)) return empty("declined");
	const gated = existsSync(gateFilePath(repo));
	const pending = gated ? pendingChecks(repo, identities.checkout) : undefined;
	if (gated && pending === undefined) return empty("exists");
	if (!gated && (await gateCommitted(repo, input.signal))) return empty("committed");
	const fingerprint = manifestFingerprint(repo);
	const found = candidates(repo);
	const wanted = pending === undefined ? found : found.filter(candidate => pending.includes(candidate.name));
	if (pending !== undefined && wanted.length === 0) return empty("exists");
	const calibrated = wanted.length === 0 ? { verdicts: [], missing: [] } : await calibrate(wanted, repo, limits, input.signal);
	const { verdicts, missing } = calibrated;
	const passed = verdicts.filter(verdict => verdict.included);
	if (passed.length === 0 && missing.length > 0) return { repo, result: "environment-missing", verdicts, created: [] };
	if (pending !== undefined) {
		if (passed.length === 0) return { repo, result: "exists", verdicts, created: [] };
		return input.dryRun ? { repo, result: "created", verdicts, created: [] } : await extend(repo, identities.checkout, found, calibrated);
	}
	const entry: Recorded = {
		at: new Date().toISOString(),
		result: passed.length === 0 ? "nothing-passed" : "created",
		included: passed.map(verdict => verdict.candidate.name),
		excluded: verdicts.filter(verdict => !verdict.included).map(verdict => ({ name: verdict.candidate.name, reason: verdict.reason ?? "" })),
		manifests: fingerprint,
		...(missing.length > 0 ? { missing } : {}),
	};
	if (passed.length === 0) {
		try {
			if (!input.dryRun) await record(identities.checkout, entry);
		} catch (error) {
			return { repo, result: "nothing-passed", verdicts, created: [], error: message(error) };
		}
		return { repo, result: "nothing-passed", verdicts, created: [] };
	}
	if (input.dryRun) return { repo, result: "created", verdicts, created: [] };
	const text = gateText(passed.map(checkOf));
	if (existsSync(gateFilePath(repo))) return { repo, result: "exists", verdicts, created: [] };
	try {
		await record(identities.checkout, { ...entry, gateSha256: sha256(text) });
	} catch (error) {
		return { repo, result: "created", verdicts, created: [], error: message(error) };
	}
	const created = install(repo, text);
	return created === undefined ? { repo, result: "exists", verdicts, created: [] } : { repo, result: "created", verdicts, created };
}

/** Whether the gate should ask for the script to be run in this checkout: it has no `.omp/gate.json`, the repo is not declined, neither HEAD nor the repo's default branch (the target of `refs/remotes/origin/HEAD`, else local `main`, else `master`) has `.omp/gate.json` (that checkout should bring in the committed file; other branches do not count), and the checkout's own state entry is missing, `created`, or `nothing-passed` with a changed fingerprint: the manifests and lockfiles at its root, and whether `node_modules`, `.venv` and `target` exist at its root and at each package root (a directory up to two levels down that holds a `package.json`, `pyproject.toml`, `Cargo.toml` or `go.mod`). False for a path that is not a git repo. Rejects when the state file is not a regular file; aborting `signal` stops the git commands it runs and rejects. */
export async function needsBootstrap(repo: string, signal?: AbortSignal): Promise<boolean> {
	const root = resolve(repo);
	if (existsSync(gateFilePath(root))) return false;
	const identities = await identitiesOf(root, signal);
	if (identities === undefined) return false;
	const state = readState();
	if (known(state[identities.common])?.result === "declined") return false;
	const entry = known(state[identities.checkout]);
	if (entry?.result === "nothing-passed" && entry.manifests === manifestFingerprint(root)) return false;
	return !(await gateCommitted(root, signal));
}

/** Whether `.omp/gate.json` of the checkout at `repo` holds, byte for byte, the file the script last wrote there; false when the script never wrote one there or the file is gone. Rejects when the state file is not a regular file. */
export async function gateWrittenByScript(repo: string, signal?: AbortSignal): Promise<boolean> {
	const root = resolve(repo);
	const identities = await identitiesOf(root, signal);
	if (identities === undefined) return false;
	return writtenEntry(root, identities.checkout) !== undefined;
}

/** Records that the user does not want a gate file in this repo, in any of its checkouts; only the user's `/gate-decline` command calls it. */
export async function declineBootstrap(repo: string): Promise<void> {
	const root = resolve(repo);
	const identities = await requireIdentities(root);
	await record(identities.common, { at: new Date().toISOString(), result: "declined", included: [], excluded: [], manifests: manifestFingerprint(root) });
}

/** Removes the user's decline of this repo and returns whether there was one; only the user's `/gate-decline undo` command calls it. */
export async function undoDeclineBootstrap(repo: string): Promise<boolean> {
	const identities = await requireIdentities(resolve(repo));
	if (known(readState()[identities.common])?.result !== "declined") return false;
	return update(state => {
		const declined = known(state[identities.common])?.result === "declined";
		if (declined) delete state[identities.common];
		return declined;
	});
}

function closing(report: BootstrapReport, dryRun: boolean): string[] {
	if (report.error !== undefined) return ["Nothing was written or recorded: the state could not be written."];
	switch (report.result) {
		case "exists":
			return [".omp/gate.json already exists; nothing was written."];
		case "committed":
			return ["HEAD or the default branch of this repo has .omp/gate.json; bring that file into this checkout with git (restore it from HEAD, or merge or rebase the default branch) instead of writing a second copy. Nothing was written."];
		case "declined":
			return [DECLINED];
		case "environment-missing":
			return ["A command a check needs is missing here (exit status 126 or 127) and no check passed, so nothing was written or recorded and the gate asks again. Install what the repo needs, then run the script again."];
		case "created":
			return dryRun ? ["A real run would write .omp/gate.json with the included checks and create the rule kit under .omp/lint when it is absent."] : [];
		case "nothing-passed":
			return [...(report.verdicts.length === 0 ? ["No check command was found in the repo's manifests."] : []), "No check passes yet; the gate asks again when the repo's manifests change."];
	}
}

function formatReport(report: BootstrapReport, dryRun: boolean): string {
	const lines = [`bootstrap ${report.repo}: ${report.result}${dryRun ? " (dry run, nothing written)" : report.error === undefined ? "" : " (not written)"}`];
	const included = report.verdicts.filter(verdict => verdict.included);
	const excluded = report.verdicts.filter(verdict => !verdict.included);
	if (included.length > 0) lines.push("included:", ...included.map(verdict => `  ${verdict.candidate.name}: ${verdict.candidate.command} (${verdict.seconds.toFixed(1)} s)`));
	if (excluded.length > 0) lines.push("excluded:", ...excluded.flatMap(verdict => [`  ${verdict.candidate.name}: ${verdict.candidate.command}`, ...(verdict.reason ?? "").split("\n").map(line => `    ${line}`)]));
	if (report.created.length > 0) lines.push("created:", ...report.created.map(file => `  ${file}`));
	lines.push(...closing(report, dryRun));
	return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
	const flags = argv.filter(arg => arg.startsWith("--"));
	const paths = argv.filter(arg => !arg.startsWith("--"));
	if (paths.length !== 1 || flags.length > 1 || flags.some(flag => flag !== "--dry-run")) {
		console.error(`usage: bun ${import.meta.path} <repo> [--dry-run]`);
		return 2;
	}
	const repo = resolve(paths[0]);
	const top = (await git(repo, ["rev-parse", "--show-toplevel"]))?.trim();
	if (top === undefined) {
		console.error(`${repo} is not a git repository`);
		return 2;
	}
	if (realpathSync(top) !== realpathSync(repo)) {
		console.error(`${repo} is not the root of its git repository; run it for ${top}`);
		return 2;
	}
	const abort = new AbortController();
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, () => abort.abort(new Error(`interrupted by ${name}`)));
	const dryRun = flags.length === 1;
	try {
		const report = await bootstrap({ repo, dryRun, signal: abort.signal });
		if (report.result === "declined") {
			console.error(`bootstrap ${repo}: ${DECLINED}`);
			return 3;
		}
		console.log(formatReport(report, dryRun));
		if (report.error === undefined) return 0;
		console.error(report.error);
		return 1;
	} catch (error) {
		console.error(message(error));
		return 1;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
