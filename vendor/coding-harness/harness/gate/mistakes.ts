import { execFile } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { agentHome, logsDir } from "../agent-home.ts";
import { commandHead, shellSegments } from "../guard/shell.ts";
import { until } from "./deadline.ts";
import { EMPTY_TREE, git } from "./snapshot.ts";
import { say } from "../notice.ts";
import type { Finding } from "./types.ts";
import { shellHome } from "./util.ts";

/** "advisor" is read from records written while the advisor was on; the harness no longer produces it. */
export type MistakeSource = "user" | "advisor" | "agent";
export type CheckKind = "type" | "lint" | "test" | "property" | "guard" | "none";

/** The existing check that already covers a mistake closed as kind none: the path of a test, lint rule or guard file and the command that runs it. */
export interface Covered {
	path: string;
	command: string;
}

export interface Check {
	kind: CheckKind;
	path?: string;
	command?: string;
	reason?: string;
	covered?: Covered;
}

export interface Mistake {
	id: string;
	source: MistakeSource;
	text: string;
	openedAt: string;
	status: "open" | "proposed-unencoded" | "resolved" | "unencoded";
	cause?: string;
	check?: Check;
	resolvedAt?: string;
	snapshots?: BasePoint[];
	snapshotError?: string;
}

export interface RunResult {
	exitCode: number;
	output: string;
}

/** The repo a session baselined and the commit (or the empty tree, for a repo without commits) its changes are measured from. */
export interface BasePoint {
	repo: string;
	base: string;
}

export interface ResolveDeps {
	changedFiles(): Promise<string[]>;
	run(command: string, cwd: string): Promise<RunResult>;
	bases(): Promise<BasePoint[]>;
	cwd?: string;
	proofBudgetMs?: number;
}

const proofBudget = (deps: ResolveDeps): number => deps.proofBudgetMs ?? PROOF_BUDGET_MS;

export type ResolveResult = { ok: true; mistake: Mistake } | { ok: false; reason: string };

export interface MistakeStats {
	opened: number;
	resolved: number;
	unencoded: number;
	refused: number;
	byKind: Record<string, number>;
}

const MIN_UNENCODED_REASON = 30;
const PROOF_BUDGET_MS = 60_000;
const NO_VERDICT_EXITS = [124, 127];
const CD_FAILED = /\bcd: [^\n]*(?:No such file or directory|Not a directory|not a directory)/;
const ASSERTION_FAILURE = /^\(fail\)|^error: expect\(|AssertionError|^not ok /m;
const ASSERTION_SHOWN = /\bexpect\((?:received|actual)\)|AssertionError/;
const LOAD_SIGNALS: readonly RegExp[] = [
	/^# Unhandled error between tests/m,
	/^(?:error|\w*Error(?: \[\w+\])?): (?:Cannot find (?:module|package)|Failed to resolve import|Could not resolve)\b/m,
	/\bERR_MODULE_NOT_FOUND\b/,
	/^(?:ModuleNotFoundError|ImportError)\b/m,
	/: (?:command )?not found$/m,
	/\berror TS(?:2307|2305|2724)\b/,
	/Test suite failed to run/,
];
const TEST_SUPPORT_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|__fixtures__|testdata|__snapshots__)\/|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/;
const MIN_UNENCODED_WORDS = 6;
const TYPED_EXTENSIONS = ["ts", "tsx", "mts", "cts", "rs", "go", "swift", "kt", "java", "cs", "py", "pyi"];
const LINT_CONFIG_NAME = /^(?:\.oxlintrc|eslint\.config\.|\.eslintrc|biome\.json|clippy\.toml$|ruff\.toml$|pyproject\.toml$|\.golangci\.)/;
const TEST_FILE_NAME = /(?:\.(?:test|spec)\.|_test\.go$|_test\.py$|^test_.*\.py$|_spec\.rb$)/;
const TEST_DIRECTORIES = ["test", "tests", "__tests__", "spec"];
const GUARD_DIRECTORIES = ["extensions", "harness"];
const TRIVIAL_COMMAND = /^(?:(?:true|echo|printf|exit)(?![\w-])|:(?:\s|$))/;
const RULE_KIT_COMMAND = /(?:^|[\s/])harness\/gate\/rules\.ts\s+\S/;
const AST_GREP_COMMAND = /(?:^|[\s;&|/])ast-grep\s/;
const SHELL_SAFE_PATH = /^[\w@%+=:,./-]+$/;
const MAPPED_PATH = /"((?:\/|\$HOME\/|\$\{HOME\}\/)[^"]*)"|'(\/[^']*)'|(?<![\w.@+~/}-])((?:\/|~\/|\$HOME\/|\$\{HOME\}\/)[\w@+~./-]*)(?=$|[\s"'`;&|()<>])/g;
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/)/;
const DOUBLE_QUOTE_UNSAFE = /[$`\\"]/;
const OUTPUT_TAIL_CHARS = 1500;
const DAY_MS = 86_400_000;
const CHECK_KINDS: readonly CheckKind[] = ["type", "lint", "test", "property", "guard", "none"];

function stateDir(): string {
	return process.env.DONE_GATE_STATE_DIR ?? join(agentHome(), "gate-state");
}

function logDir(): string {
	return process.env.DONE_GATE_LOG_DIR ?? logsDir();
}

function stateFile(sessionId: string): string {
	return join(stateDir(), "mistakes", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function logFile(): string {
	return join(logDir(), "mistakes.jsonl");
}

function field(value: unknown, name: string): unknown {
	return value && typeof value === "object" && name in value ? Reflect.get(value, name) : undefined;
}

function isMistake(value: unknown): value is Mistake {
	return ["id", "text", "status", "source"].every(name => typeof field(value, name) === "string");
}

function readMistakes(sessionId: string): Mistake[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
		return Array.isArray(parsed) ? parsed.filter(isMistake) : [];
	} catch {
		return [];
	}
}

const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 5;

function withLock<T>(file: string, action: () => T): T {
	const lock = `${file}.lock`;
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			closeSync(openSync(lock, "wx"));
			break;
		} catch (error) {
			if (field(error, "code") !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
			} catch {
				continue;
			}
			Atomics.wait(pause, 0, 0, LOCK_RETRY_MS);
		}
	}
	try {
		return action();
	} finally {
		try {
			unlinkSync(lock);
		} catch {
			// why(platform): a stale-lock sweep by another process may already have removed it, which unlink(2) man page reports as ENOENT
		}
	}
}

function updateMistakes<T>(sessionId: string, change: (mistakes: Mistake[]) => { next?: Mistake[]; result: T }): T {
	const file = stateFile(sessionId);
	mkdirSync(join(stateDir(), "mistakes"), { recursive: true });
	return withLock(file, () => {
		const { next, result } = change(readMistakes(sessionId));
		if (next) {
			const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
			writeFileSync(tmp, JSON.stringify(next, null, "\t"));
			renameSync(tmp, file);
		}
		return result;
	});
}

interface LogEntry {
	sessionId: string;
	id: string;
	event: "open" | "propose" | "resolve" | "refuse";
	source: MistakeSource;
	kind?: CheckKind;
	text?: string;
	cause?: string;
	reason?: string;
	path?: string;
	failedAtBase?: true;
	baseExit?: number;
}

function appendLog(entry: LogEntry): void {
	mkdirSync(logDir(), { recursive: true });
	appendFileSync(logFile(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? resolve(path) : join(canonical(parent), basename(path));
	}
}

function isLoadError(output: string, file: string): boolean {
	if (ASSERTION_FAILURE.test(output)) return false;
	if (LOAD_SIGNALS.some(signal => signal.test(output))) return true;
	if (/^\s*0 pass\s*$/m.test(output) && /^\s*0 fail\s*$/m.test(output) && /^\s*[1-9]\d* errors?\s*$/m.test(output)) return true;
	const name = basename(file);
	return output.split("\n").some(line => line.includes("No such file or directory") && line.includes(name));
}

function outputTail(output: string): string {
	const trimmed = output.trim();
	return trimmed.length > OUTPUT_TAIL_CHARS ? `...${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed;
}

/** Records an obligation for the session; identical text from the same source returns the existing one. A user obligation is deduped only against one still unresolved, so a repeated correction reopens a closed one. Every change to a session's obligations runs under an exclusive lock, so concurrent writers (other turns, other processes) never overwrite each other. */
export function openMistake(sessionId: string, input: { source: MistakeSource; text: string }): Mistake {
	return openOrFind(sessionId, input).mistake;
}

/** Whether an obligation still holds: open, or closed only by a proposal the user has not accepted with /gate-ok. */
export function isUnresolved(mistake: Mistake): boolean {
	return mistake.status === "open" || mistake.status === "proposed-unencoded";
}

function openOrFind(sessionId: string, input: { source: MistakeSource; text: string }): { mistake: Mistake; created: boolean } {
	const text = input.text.trim();
	return updateMistakes<{ mistake: Mistake; created: boolean }>(sessionId, mistakes => {
		const existing = mistakes.find(m => m.source === input.source && m.text === text && (input.source !== "user" || isUnresolved(m)));
		if (existing) return { result: { mistake: existing, created: false } };
		const mistake: Mistake = { id: `m${mistakes.length + 1}`, source: input.source, text, openedAt: new Date().toISOString(), status: "open" };
		appendLog({ sessionId, id: mistake.id, event: "open", source: mistake.source, text });
		return { next: [...mistakes, mistake], result: { mistake, created: true } };
	});
}

const execFileAsync = promisify(execFile);
const SNAPSHOT_BUDGET_MS = 20_000;

async function workingTreeCommit(repo: string): Promise<string> {
	const holder = mkdtempSync(join(tmpdir(), "mistake-index-"));
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(holder, "index"), GIT_OPTIONAL_LOCKS: "0" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX"]) delete env[key];
	const signal = AbortSignal.timeout(SNAPSHOT_BUDGET_MS);
	const run = async (args: string[]) => (await execFileAsync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", ...args], { env, maxBuffer: 64 * 1024 * 1024, signal })).stdout.trim();
	try {
		const head = await run(["rev-parse", "--verify", "-q", "HEAD"]).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === 1) return "";
			throw error;
		});
		if (head) await run(["read-tree", head]);
		await run(["add", "-A"]);
		const tree = await run(["write-tree"]);
		return await run(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "mistake snapshot"]);
	} finally {
		rmSync(holder, { recursive: true, force: true });
	}
}

/** Records on the obligation the tree each baselined repo had when it was opened: the state that still holds the mistake, which a check must fail on. */
export async function snapshotOpened(sessionId: string, id: string, bases: Promise<BasePoint[]>): Promise<void> {
	let snapshots: BasePoint[] = [];
	let failure: string | undefined;
	try {
		snapshots = await Promise.all((await bases).map(async point => ({ repo: point.repo, base: await workingTreeCommit(point.repo) })));
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	updateMistakes<undefined>(sessionId, fresh => ({ next: fresh.map(m => (m.id === id ? { ...m, ...(failure === undefined ? { snapshots } : { snapshotError: failure }) } : m)), result: undefined }));
}

/** Copies the obligations of the parent session into a child session that has none yet; open ones stay open and resolved ones stay resolved. */
export function inheritMistakes(parentSessionId: string, childSessionId: string): void {
	if (parentSessionId === childSessionId) return;
	const inherited = readMistakes(parentSessionId);
	if (inherited.length === 0) return;
	updateMistakes(childSessionId, existing => ({ next: existing.length === 0 ? inherited : undefined, result: undefined }));
}

/** Closes every obligation of the session whose "no check possible" reason the agent proposed, as unencoded; the gate core calls it when the user's /gate-ok is spent. */
export function acceptProposed(sessionId: string): Mistake[] {
	return updateMistakes(sessionId, mistakes => {
		const accepted: Mistake[] = [];
		const next = mistakes.map(m => {
			if (m.status !== "proposed-unencoded") return m;
			const closed: Mistake = { ...m, status: "unencoded", resolvedAt: new Date().toISOString() };
			accepted.push(closed);
			return closed;
		});
		for (const m of accepted) appendLog({ sessionId, id: m.id, event: "resolve", source: m.source, kind: "none", cause: m.cause, reason: m.check?.reason?.trim() });
		return { next: accepted.length > 0 ? next : undefined, result: accepted };
	});
}

/** Every obligation of the session, open and resolved, in the order they were opened. */
export function listMistakes(sessionId: string): Mistake[] {
	return readMistakes(sessionId);
}

function refusePathFit(kind: CheckKind, path: string): string | undefined {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const directories = path.split("/").slice(0, -1);
	if (kind === "lint") {
		const fits = `/${path}`.includes("/.omp/lint/rules/") || `/${path}`.includes("/.omp/lint/tests/") || LINT_CONFIG_NAME.test(name);
		return fits ? undefined : `a lint check lives in a rule file under .omp/lint/rules/, its test under .omp/lint/tests/, or a lint configuration file (.oxlintrc*, eslint.config.*, biome.json*, ruff.toml, clippy.toml, ...); ${path} is none of those.`;
	}
	if (kind === "test" || kind === "property") {
		const fits = TEST_FILE_NAME.test(name) || directories.some(d => TEST_DIRECTORIES.includes(d));
		return fits ? undefined : `a ${kind} check lives in a test file (*.test.ts, *.spec.ts, *_test.go, test_*.py, or a file under test/, tests/, __tests__/, spec/); ${path} is not one.`;
	}
	if (kind === "type") {
		const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
		return TYPED_EXTENSIONS.includes(extension) ? undefined : `a type check lives in a source file of a typed language (${TYPED_EXTENSIONS.join(", ")}); ${path} is docs, configuration or another file type.`;
	}
	return directories.some(d => GUARD_DIRECTORIES.includes(d)) ? undefined : `a guard lives in a file under an extensions/ or harness/ directory; ${path} is not under one.`;
}

function isTrivialCommand(command: string): boolean {
	const [first = "", ...rest] = command.split(/\|\||;|\n/);
	const startsTrivial = (piece: string): boolean => TRIVIAL_COMMAND.test(piece.trim());
	return startsTrivial(first.split("&&")[0] ?? "") || rest.some(part => part.split("&&").some(startsTrivial));
}

function refuseCommand(kind: CheckKind, path: string, command: string | undefined): string | undefined {
	const text = command?.trim() ?? "";
	const name = path.slice(path.lastIndexOf("/") + 1);
	const underLint = `/${path}`.includes("/.omp/lint/");
	const example = kind === "lint" && underLint ? "the rule kit (bun <harness>/gate/rules.ts <repo>) or an ast-grep command" : `a command that runs the check and names ${name} (for example "bun test ${name}")`;
	if (!text) return `kind "${kind}" needs a command that exits 0 and runs the check: ${example}.`;
	if (isTrivialCommand(text)) return `command "${text}" runs nothing: true, :, exit 0 and echo prove no check. Give ${example}.`;
	const segments = shellSegments(text);
	const lead = segments.length > 1 && commandHead(segments[0].words)?.name === "cd" && /^\s*cd\s[^;&|\n]*&&/.test(text) ? 1 : 0;
	const run = segments.slice(lead);
	if (run.length !== 1 || /(?<![&>])&\s*$/.test(text)) return `command "${text}" must run the check file alone: one command, optionally after "cd <dir> &&", with no &&, ||, ;, | chain or background run. Give ${example}.`;
	if (run[0].words.some(word => word.text.includes(name))) return undefined;
	if (kind === "lint" && underLint && (RULE_KIT_COMMAND.test(text) || AST_GREP_COMMAND.test(text))) return undefined;
	return `command "${text}" does not run ${name} (its arguments do not name it; a comment does not count), so it does not run this check. Give ${example}.`;
}

function usesAssertionRunner(command: string): boolean {
	return shellSegments(command).some(segment => {
		const head = commandHead(segment.words);
		return head !== undefined && (head.name === "jest" || head.name === "vitest" || (head.name === "bun" && head.args[0]?.text === "test") || head.args.some(word => ["jest", "vitest"].includes(basename(word.text))));
	});
}

const COVERING_KINDS: readonly CheckKind[] = ["test", "lint"];
const TEST_FILTER = /(?:^|\s)(?:-t|--test-name-pattern|--testNamePattern|--pass-with-no-tests|--passWithNoTests|-k|--grep)(?:[\s=]|$)/;
const LINTER_COMMAND = /(?:^|[\s/])(?:oxlint|eslint|biome|ruff|golangci-lint|cargo\s+clippy)\s/;

function refuseCoveringRun(kind: CheckKind, command: string): string | undefined {
	if (kind === "test") {
		if (!usesAssertionRunner(command)) return `covered command "${command}" does not run the file with a test runner (bun test, jest, vitest), so it proves no assertion.`;
		if (TEST_FILTER.test(command)) return `covered command "${command}" filters the tests by name or passes with no tests, so it can pass without running the covering test.`;
		return undefined;
	}
	return RULE_KIT_COMMAND.test(command) || AST_GREP_COMMAND.test(command) || LINTER_COMMAND.test(command) ? undefined : `covered command "${command}" does not run the rule kit, ast-grep or a linter, so it checks nothing.`;
}

function shownPath(cwd: string, path: string): string {
	const inside = relative(cwd, path);
	return (inside.startsWith("..") || isAbsolute(inside) ? path : inside).replaceAll("\\", "/");
}

async function refuseUnlessPasses(command: string, cwd: string, deps: ResolveDeps, deadline: AbortSignal): Promise<string | undefined> {
	const now = await until(deps.run(command, cwd), deadline);
	if (!now) return `the check took longer than the ${proofBudget(deps) / 1000}s proof budget. Refused, not accepted; make the check faster.`;
	if (now.value.exitCode !== 0) return `check command exited ${now.value.exitCode}: ${command}\n${outputTail(now.value.output)}\nThe check must pass before the obligation closes; fix the check or the code, then resolve again.`;
	return undefined;
}

async function refuseCovered(covered: Covered | undefined, cwd: string, deps: ResolveDeps, deadline: AbortSignal): Promise<string | undefined> {
	const ask = `kind "none" must name the check that already covers this mistake: covered { path, command }, the path of an existing test, lint rule or guard file and the command that runs it and exits 0 now. If no check covers it, write one and resolve with its kind (skill://correct).`;
	if (!covered?.path?.trim()) return `kind "none" has no covered check. ${ask}`;
	const path = resolve(cwd, covered.path);
	const link = lstatSync(path, { throwIfNoEntry: false });
	if (!link) return `covered path ${path} does not exist. ${ask}`;
	if (link.isSymbolicLink()) return `covered path ${path} is a symbolic link; name the file itself. ${ask}`;
	if (!link.isFile()) return `covered path ${path} is not a file. ${ask}`;
	const shown = shownPath(cwd, path);
	if (isAbsolute(shown)) return `covered path ${path} is outside the working directory ${cwd}; a covering check lives in the project it covers. ${ask}`;
	const kind = COVERING_KINDS.find(candidate => refusePathFit(candidate, shown) === undefined);
	if (!kind) return `covered path ${shown} is not a test file or a lint rule, test or config under .omp/lint/. ${ask}`;
	const commandRefusal = refuseCommand(kind, shown, covered.command) ?? refuseCoveringRun(kind, covered.command.trim());
	if (commandRefusal) return `covered command: ${commandRefusal}`;
	return await refuseUnlessPasses(covered.command.trim(), cwd, deps, deadline);
}

async function refuseNone(check: Check, source: MistakeSource, cwd: string, deps: ResolveDeps, deadline: AbortSignal): Promise<string | undefined> {
	const reason = check.reason?.trim() ?? "";
	const words = new Set(reason.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).size;
	if (reason.length < MIN_UNENCODED_REASON || words < MIN_UNENCODED_WORDS) {
		return `kind "none" needs a reason of at least ${MIN_UNENCODED_REASON} characters and ${MIN_UNENCODED_WORDS} distinct words saying why no type, lint rule, test or guard can catch this class (got ${reason.length} characters, ${words} distinct words). Encode it instead if you can; skill://correct shows how.`;
	}
	return source === "user" ? undefined : await refuseCovered(check.covered, cwd, deps, deadline);
}

type Verdict = { refusal: string } | { baseExit?: number };

function isInside(root: string, file: string): boolean {
	const rel = relative(root, file);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

function linkDependencies(repo: string, tree: string, cwdRel: string): void {
	const steps = cwdRel.split(sep).filter(Boolean);
	for (let depth = 0; depth <= steps.length; depth++) {
		const dir = steps.slice(0, depth).join(sep);
		const source = join(repo, dir, "node_modules");
		const link = join(tree, dir, "node_modules");
		if (!existsSync(source) || existsSync(link)) continue;
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(source, link);
	}
}

function plainPathInTree(tree: string, target: string): boolean {
	let current = tree;
	for (const step of relative(tree, dirname(target)).split(sep).filter(Boolean)) {
		current = join(current, step);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) return true;
		if (!stat.isDirectory()) return false;
	}
	return true;
}

function copyIntoTree(file: string, target: string): void {
	if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(target);
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(file, target);
}

function overlayTestSupport(repo: string, tree: string, files: readonly string[]): void {
	for (const file of files) {
		if (!isInside(repo, file) || !TEST_SUPPORT_PATH.test(relative(repo, file).replaceAll("\\", "/"))) continue;
		const target = join(tree, relative(repo, file));
		if (!plainPathInTree(tree, target)) continue;
		if (existsSync(file) && statSync(file).isFile()) copyIntoTree(file, target);
		else if (!existsSync(file)) rmSync(target, { recursive: true, force: true });
	}
}

function commonAncestor(first: string, second: string): string {
	let dir = first;
	while (!isInside(dir, second) && dirname(dir) !== dir) dir = dirname(dir);
	return dir;
}

function pathInBase(typed: string, repo: string, tree: string): string | undefined {
	const real = canonical(typed.replace(HOME_PREFIX, shellHome()));
	if (!isInside(repo, real)) return undefined;
	const mapped = join(tree, relative(repo, real));
	return existsSync(mapped) ? mapped : undefined;
}

function inBaseCopy(command: string, repo: string, tree: string): string {
	return command.replace(MAPPED_PATH, (typed, double: string | undefined, single: string | undefined, bare: string | undefined) => {
		if (double !== undefined) {
			const mapped = DOUBLE_QUOTE_UNSAFE.test(double.replace(HOME_PREFIX, "")) ? undefined : pathInBase(double, repo, tree);
			return mapped === undefined || DOUBLE_QUOTE_UNSAFE.test(mapped) ? typed : `"${mapped}"`;
		}
		if (single !== undefined) {
			const mapped = pathInBase(single, repo, tree);
			return mapped === undefined || mapped.includes("'") ? typed : `'${mapped}'`;
		}
		const mapped = pathInBase(bare ?? typed, repo, tree);
		return mapped !== undefined && SHELL_SAFE_PATH.test(mapped) ? mapped : typed;
	});
}

async function runAtBase(point: BasePoint, cwd: string, file: string, changed: readonly string[], command: string, deps: ResolveDeps, deadline: AbortSignal): Promise<RunResult | undefined> {
	const repo = canonical(point.repo);
	const anchor = commonAncestor(repo, cwd);
	const cwdInRepo = anchor === repo;
	const holder = mkdtempSync(join(tmpdir(), "mistake-base-"));
	const mirror = join(holder, "tree");
	const tree = join(mirror, relative(anchor, repo));
	const mapped = join(mirror, relative(anchor, cwd));
	try {
		if (point.base === EMPTY_TREE) {
			mkdirSync(tree, { recursive: true });
		} else {
			await git(repo, ["-c", "core.hooksPath=/dev/null", "clone", "--shared", "--no-checkout", "--quiet", repo, tree], deadline);
			await git(tree, ["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", point.base], deadline);
		}
		const target = join(tree, relative(repo, file));
		if (!plainPathInTree(tree, target) || (cwdInRepo && !plainPathInTree(tree, join(mapped, "-")))) throw new Error(`a directory on the way to ${relative(repo, file)} or to the check's directory is a symlink or a file at base, so the check would be written or run outside the base copy`);
		copyIntoTree(file, target);
		overlayTestSupport(repo, tree, changed);
		linkDependencies(repo, tree, relative(repo, cwdInRepo ? cwd : dirname(file)));
		mkdirSync(mapped, { recursive: true });
		return (await until(deps.run(inBaseCopy(command, repo, tree), mapped), deadline))?.value;
	} finally {
		rmSync(holder, { recursive: true, force: true });
	}
}

async function owningRepo(file: string, deadline: AbortSignal): Promise<string | undefined> {
	try {
		return canonical((await git(dirname(file), ["rev-parse", "--show-toplevel"], deadline)).trim());
	} catch {
		return undefined;
	}
}

async function proveAtBase(check: Check, file: string, cwd: string, changed: readonly string[], deps: ResolveDeps, deadline: AbortSignal, opened: readonly BasePoint[]): Promise<Verdict> {
	const command = check.command?.trim() ?? "";
	const real = canonical(file);
	const bases = await deps.bases();
	const root = [...opened, ...bases].map(candidate => canonical(candidate.repo)).filter(candidate => isInside(candidate, real)).sort((a, b) => b.length - a.length)[0];
	const atOpen = root === undefined ? undefined : opened.find(candidate => canonical(candidate.repo) === root);
	const point = atOpen ?? (root === undefined ? undefined : bases.find(candidate => canonical(candidate.repo) === root));
	if (!point || root === undefined || (await owningRepo(real, deadline)) !== root) {
		return { refusal: `no session base point is known for ${file} (it is not inside a git repo this session baselined), so the check cannot be shown to fail without the fix. Kind "${check.kind}" is refused there; kind "none" with a reason and covered (an existing check that already covers the mistake) is the only way to close it.` };
	}
	let result: RunResult | undefined;
	try {
		result = await runAtBase(point, canonical(cwd), real, changed, command, deps, deadline);
	} catch (error) {
		return { refusal: `the check could not be run at the base point ${point.base.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}. Refused, not accepted; resolve again.` };
	}
	if (!result) return { refusal: `running the check at the base point took longer than the ${proofBudget(deps) / 1000}s proof budget. Refused, not accepted; make the check faster.` };
	const where = atOpen ? `on the tree as it was when the mistake was opened (${point.base.slice(0, 12)})` : `at the base point ${point.base.slice(0, 12)} (the check file over the session's starting tree)`;
	if (result.exitCode === 0) return { refusal: `the check passed ${where}: it does not fail without the fix, so it encodes nothing. Make it assert the mistaken behavior so it fails at base and passes now.` };
	if (NO_VERDICT_EXITS.includes(result.exitCode) || result.exitCode > 128 || CD_FAILED.test(result.output)) return { refusal: `the check did not run to a verdict ${where} (exit ${result.exitCode}${CD_FAILED.test(result.output) ? ", a cd in the command found no such directory in the base copy" : ""}):\n${outputTail(result.output)}\nMake it run at base and fail by an assertion.` };
	if (isLoadError(result.output, real)) return { refusal: `the check failed ${where} only because something it loads does not exist there (exit ${result.exitCode}):\n${outputTail(result.output)}\nA load error proves nothing. Make the check exercise behavior that existed at base (a CLI, an existing export, a rule over existing code) and fail by an assertion.` };
	if (usesAssertionRunner(command) && !ASSERTION_SHOWN.test(result.output)) return { refusal: `the check failed ${where} by a runtime error (a TypeError, ReferenceError or missing export), not by an assertion (exit ${result.exitCode}):\n${outputTail(result.output)}\nMake the check assert the mistaken behavior with expect(...) so that the failure shows an assertion diff.` };
	return { baseExit: result.exitCode };
}

async function refuseCheck(check: Check, source: MistakeSource, deps: ResolveDeps, opened: readonly BasePoint[]): Promise<Verdict> {
	const deadline = AbortSignal.timeout(proofBudget(deps));
	const cwd = deps.cwd ?? process.cwd();
	if (check.kind === "none") {
		const refusal = await refuseNone(check, source, cwd, deps, deadline);
		return refusal ? { refusal } : {};
	}
	const refuse = (refusal: string): Verdict => ({ refusal });
	if (!check.path?.trim()) return refuse(`kind "${check.kind}" needs the path of the file that encodes the check (a type, a .omp/lint/ rule or its test, a test, a guard).`);
	const path = resolve(cwd, check.path);
	const shown = shownPath(cwd, path);
	const misfit = refusePathFit(check.kind, shown);
	if (misfit) return refuse(misfit);
	const commandRefusal = refuseCommand(check.kind, shown, check.command);
	if (commandRefusal) return refuse(commandRefusal);
	if (!existsSync(path)) return refuse(`check path ${path} does not exist. Write the check first, then resolve.`);
	const reported = await deps.changedFiles();
	const changed = reported.map(canonical);
	if (!changed.includes(canonical(path))) return refuse(`check path ${path} is not among the files this session changed. A check that already existed does not encode this mistake; add or extend one in this session.`);
	const failure = await refuseUnlessPasses(check.command?.trim() ?? "", cwd, deps, deadline);
	if (failure) return refuse(failure);
	return await proveAtBase(check, path, cwd, changed, deps, deadline, opened);
}

/** Closes an obligation when its check is real; a refusal returns the reason and leaves it open. Kind none on a user obligation only records a proposal that stays unresolved until the user accepts it with /gate-ok. */
export async function resolveMistake(sessionId: string, id: string, input: { cause: string; check: Check }, deps: ResolveDeps): Promise<ResolveResult> {
	const mistakes = readMistakes(sessionId);
	const target = mistakes.find(m => m.id === id);
	if (!target) return { ok: false, reason: `no mistake ${id} in this session. Open ones: ${mistakes.filter(isUnresolved).map(m => m.id).join(", ") || "none"}.` };
	if (!isUnresolved(target)) return { ok: false, reason: `${id} is already ${target.status}.` };
	const cause = input.cause.trim();
	if (!cause) return { ok: false, reason: "cause is empty. State in one line why the mistake happened, then pick the check that makes the class impossible." };
	if (!CHECK_KINDS.includes(input.check.kind)) return { ok: false, reason: `unknown check kind "${input.check.kind}"; use ${CHECK_KINDS.join(", ")}.` };
	const verdict = await refuseCheck(input.check, target.source, deps, target.snapshots ?? []);
	if ("refusal" in verdict) {
		appendLog({ sessionId, id, event: "refuse", source: target.source, kind: input.check.kind, path: input.check.path ?? input.check.covered?.path, cause: verdict.refusal.split("\n", 1)[0] });
		return { ok: false, reason: verdict.refusal };
	}
	return updateMistakes<ResolveResult>(sessionId, fresh => {
		const current = fresh.find(m => m.id === id);
		if (!current) return { result: { ok: false, reason: `no mistake ${id} in this session.` } };
		if (!isUnresolved(current)) return { result: { ok: false, reason: `${id} is already ${current.status}.` } };
		const proposed = input.check.kind === "none" && current.source === "user";
		const resolved: Mistake = {
			...current,
			status: proposed ? "proposed-unencoded" : input.check.kind === "none" ? "unencoded" : "resolved",
			cause,
			check: input.check,
			resolvedAt: proposed ? undefined : new Date().toISOString(),
		};
		const proof = verdict.baseExit === undefined ? {} : { failedAtBase: true as const, baseExit: verdict.baseExit };
		appendLog({ sessionId, id, event: proposed ? "propose" : "resolve", source: resolved.source, kind: input.check.kind, cause, reason: input.check.reason?.trim(), path: input.check.path ?? input.check.covered?.path, ...proof });
		return { next: fresh.map(m => (m.id === id ? resolved : m)), result: { ok: true, mistake: resolved } };
	});
}

function unresolvedMessage(mistake: Mistake): string {
	if (mistake.status === "proposed-unencoded") {
		return [
			`Mistake ${mistake.id} (from ${mistake.source}) is not closed: ${mistake.text}`,
			`You proposed that no check can encode it (${mistake.check?.reason ?? ""}). A mistake the user reported is closed that way only by the user, with /gate-ok; the agent cannot accept its own reason.`,
			"Either encode the class with a real check and resolve it again, or tell the user the reason and let them accept it.",
		].join("\n");
	}
	const noneRule =
		mistake.source === "user"
			? `Only if no check can encode it: kind "none" with a reason of at least ${MIN_UNENCODED_REASON} characters and ${MIN_UNENCODED_WORDS} distinct words; for a user-reported mistake that is only a proposal, and it stays unresolved until the user accepts it with /gate-ok.`
			: `Only if an existing check already covers it: kind "none" with covered { path, command } (an existing test, lint rule or guard file that exists, and the command that runs it and exits 0 now) and a reason of at least ${MIN_UNENCODED_REASON} characters and ${MIN_UNENCODED_WORDS} distinct words saying why that check covers it; that is logged as unencoded and shown to the user. A mistake no existing check covers is not closed as none: write the check.`;
	return [
		`Unresolved mistake ${mistake.id} (from ${mistake.source}): ${mistake.text}`,
		"Finishing is refused until this is closed with a check, not an excuse. First state the cause: why did it happen?",
		"Then encode the class with the strongest check that fits, in this order: a type that makes it unrepresentable; a lint rule with a test under .omp/lint/ (skill://correct); a test or property test; a guard.",
		`Resolve it with the mistake tool: action "resolve", id "${mistake.id}", cause, check { kind: type|lint|test|property|guard, path, command }. The path must be a file you changed in this session (in any git repo you edited, also outside the working directory), fit the kind (type: a typed source file; lint: .omp/lint/ rule or test, or a lint config; test or property: a test file; guard: under extensions/ or harness/), and the command must exit 0 and name that file, after a leading "cd <repo> &&" when the file is in another repo (a lint rule under .omp/lint/ may use the rule kit or ast-grep).`,
		noneRule,
	].join("\n");
}

/** One finding per unresolved obligation of the session, for the stop gate. */
export function mistakeFindings(sessionId: string): Finding[] {
	return readMistakes(sessionId)
		.filter(isUnresolved)
		.map(m => ({ stage: "mistakes", class: "unresolved", message: unresolvedMessage(m), text: m.text }));
}

function readLog(): Record<string, unknown>[] {
	let raw = "";
	try {
		raw = readFileSync(logFile(), "utf8");
	} catch {
		return [];
	}
	const entries: Record<string, unknown>[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object") entries.push(Object.fromEntries(Object.entries(parsed)));
		} catch {
			continue;
		}
	}
	return entries;
}

/** Counts from the last `days` days of the log: opened, encoded (resolved, by kind) and unencoded. */
export function mistakeStats(days: number): MistakeStats {
	const since = Date.now() - days * DAY_MS;
	const stats: MistakeStats = { opened: 0, resolved: 0, unencoded: 0, refused: 0, byKind: {} };
	for (const entry of readLog()) {
		if (typeof entry.at !== "string" || Date.parse(entry.at) < since) continue;
		if (entry.event === "open") stats.opened++;
		if (entry.event === "refuse") stats.refused++;
		if (entry.event !== "resolve") continue;
		if (entry.kind === "none") {
			stats.unencoded++;
			continue;
		}
		stats.resolved++;
		const kind = typeof entry.kind === "string" ? entry.kind : "unknown";
		stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
	}
	return stats;
}

interface Ui {
	notify(text: string, level: "info" | "warning"): void;
}

/** The host context fields this module reads. */
export interface MistakeCtx {
	agent?: { kind?: string };
	cwd?: string;
	ui?: Ui;
}

interface SchemaNode {
	optional(): SchemaNode;
}

interface Schema {
	object(shape: Record<string, SchemaNode>): SchemaNode;
	enum(values: string[]): SchemaNode;
	string(): SchemaNode;
}

interface ToolParams {
	action: "open" | "resolve" | "list";
	text?: string;
	source?: "user" | "agent";
	id?: string;
	cause?: string;
	check?: Check;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** The host API surface registerMistakes uses. */
export interface MistakeApi {
	zod: Schema;
	sendMessage(message: { customType: string; display: boolean; content: string }, options: { deliverAs: "nextTurn"; triggerTurn: boolean }): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: SchemaNode;
		execute(id: string, params: ToolParams, signal: unknown, onUpdate: unknown, ctx: MistakeCtx): Promise<ToolResult>;
	}): void;
	registerCommand(name: string, command: { description: string; handler(args: unknown, ctx: MistakeCtx): Promise<void> }): void;
}

export interface MistakeHostDeps {
	sessionId(ctx: MistakeCtx): string;
	changedFiles(ctx: MistakeCtx): Promise<string[]>;
	bases(ctx: MistakeCtx): Promise<BasePoint[]>;
	run(command: string, cwd: string): Promise<RunResult>;
}

const TOOL_DESCRIPTION =
	"Record and close mistake obligations. A mistake (a user correction, a review or drive finding) blocks completion until it is encoded as a check. action open: text = the mistake, source = user when the user found it (a correction or complaint in their message), omitted when you or a review found it. action resolve: id, cause (one line: why it happened), check { kind: type|lint|test|property|guard|none, path (a file you changed this session that fits the kind, in any git repo you edited, also outside the working directory), command (required for every kind but none: must exit 0 now, name the path's file, and exit non-zero on the tree as it was when the mistake was opened (the session's base point when that tree is unknown) with only the check file copied over it, by an assertion, not by a load error; for a check in another repo begin with cd into it: its absolute path, or one relative to the working directory, then names the copy at that tree; a lint rule under .omp/lint/ may use the rule kit or ast-grep), reason (kind none only, at least 30 characters and 6 distinct words), covered (kind none only, required unless the mistake came from the user: { path, command } of an existing test, lint rule or guard file that already covers this mistake and the command that runs it; the path must exist and the command must exit 0 now, so a mistake that no existing check covers cannot be closed as none; for a user-reported mistake none is only a proposal the user accepts with /gate-ok) }. action list: show the session's obligations. Strongest check first: type, lint rule with a test under .omp/lint/ (skill://correct), test or property test, guard.";

function reply(text: string, isError = false): ToolResult {
	return { content: [{ type: "text", text }], isError };
}

function describe(mistake: Mistake): string {
	return `${mistake.id} [${mistake.status}] (${mistake.source}) ${mistake.text}`;
}

async function runTool(params: ToolParams, ctx: MistakeCtx, deps: MistakeHostDeps): Promise<ToolResult> {
	if (ctx.agent?.kind !== "main") {
		return reply("mistake: only the main session records mistakes. Put this finding in your final answer for the orchestrator to record with the mistake tool.");
	}
	const sessionId = deps.sessionId(ctx);
	if (params.action === "list") {
		const all = listMistakes(sessionId);
		return reply(all.length ? all.map(describe).join("\n") : "mistake: no obligations in this session.");
	}
	if (params.action === "open") {
		if (!params.text?.trim()) return reply('mistake: action "open" needs text describing the mistake.', true);
		const { mistake, created } = openOrFind(sessionId, { source: params.source === "user" ? "user" : "agent", text: params.text });
		if (created) await snapshotOpened(sessionId, mistake.id, deps.bases(ctx));
		return reply(created ? `mistake: opened ${describe(mistake)}\nResolve it with a check before finishing.` : `mistake: already recorded as ${describe(mistake)}`);
	}
	if (!params.id || !params.check) return reply('mistake: action "resolve" needs id, cause and check { kind, path, command }.', true);
	const outcome = await resolveMistake(sessionId, params.id, { cause: params.cause ?? "", check: params.check }, {
		changedFiles: () => deps.changedFiles(ctx),
		bases: () => deps.bases(ctx),
		run: deps.run,
		cwd: ctx.cwd,
	});
	if (!outcome.ok) return reply(`mistake: refused to resolve ${params.id}: ${outcome.reason}`, true);
	if (outcome.mistake.status === "proposed-unencoded") {
		ctx.ui?.notify(say({ en: `mistake ${params.id}: the agent proposes no check can encode it (${outcome.mistake.check?.reason ?? ""}); accept with /gate-ok or the agent must encode it.`, ko: `mistake ${params.id}: 에이전트가 이 실수는 검사로 만들 수 없다고 제안했습니다(${outcome.mistake.check?.reason ?? ""}). /gate-ok로 받아들이거나, 에이전트가 검사로 만들어야 합니다.` }), "warning");
		return reply(`mistake: ${params.id} is NOT closed. Your reason is recorded as a proposal; only the user can accept it with /gate-ok. Encode a real check or leave it for the user.`);
	}
	if (outcome.mistake.status === "unencoded") {
		ctx.ui?.notify(say({ en: `mistake ${params.id} closed as unencoded: ${outcome.mistake.check?.reason ?? ""}`, ko: `mistake ${params.id}을(를) 검사 없이 닫았습니다: ${outcome.mistake.check?.reason ?? ""}` }), "warning");
		return reply(`mistake: ${params.id} closed as unencoded (shown to the user).`);
	}
	return reply(`mistake: ${params.id} resolved by ${outcome.mistake.check?.kind} check ${outcome.mistake.check?.path}.`);
}

/** Registers the mistake tool and the /mistake command. */
export function registerMistakes(pi: MistakeApi, deps: MistakeHostDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "mistake",
		label: "Mistake",
		description: TOOL_DESCRIPTION,
		parameters: z.object({
			action: z.enum(["open", "resolve", "list"]),
			text: z.string().optional(),
			source: z.enum(["user", "agent"]).optional(),
			id: z.string().optional(),
			cause: z.string().optional(),
			check: z
				.object({
					kind: z.enum(["type", "lint", "test", "property", "guard", "none"]),
					path: z.string().optional(),
					command: z.string().optional(),
					reason: z.string().optional(),
					covered: z.object({ path: z.string(), command: z.string() }).optional(),
				})
				.optional(),
		}),
		execute: (_id, params, _signal, _onUpdate, ctx) => runTool(params, ctx, deps),
	});

	pi.registerCommand("mistake", {
		description: "Record a mistake the agent made; it must be encoded as a check (type, lint rule with test, test, guard) before the session can finish",
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();
			if (!text) return ctx.ui?.notify(say({ en: "usage: /mistake <what the agent did wrong>", ko: "사용법: /mistake <에이전트가 잘못한 내용>" }), "warning");
			const { mistake, created } = openOrFind(deps.sessionId(ctx), { source: "user", text });
			ctx.ui?.notify(created ? say({ en: `mistake ${mistake.id} opened: the agent must encode it as a check before finishing.`, ko: `mistake ${mistake.id}을(를) 등록했습니다. 에이전트는 끝내기 전에 이를 검사로 만들어야 합니다.` }) : say({ en: `mistake already recorded as ${describe(mistake)}`, ko: `이미 ${describe(mistake)}(으)로 기록된 실수입니다.` }), "info");
			if (!created) return;
			await snapshotOpened(deps.sessionId(ctx), mistake.id, deps.bases(ctx));
			pi.sendMessage({ customType: "mistake", display: true, content: unresolvedMessage(mistake) }, { deliverAs: "nextTurn", triggerTurn: true });
		},
	});
}
