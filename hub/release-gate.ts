// The release gate (docs/releases.md): the full suite on the head of origin/main before a slot dispatches release.yml. Not a CI step: the suite has
// only been shown green on the owner's machine. The owner's slot watch kills a tick after ~2 minutes and the suite takes minutes, so the gate runs
// across ticks: one tick starts a detached runner (`release.ts --gate-run`) and returns; later ticks only read the state it leaves in the watch's
// state dir. The runner keeps its own clone there, because the install that runs the watch is usually a tarball with no .git.
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../firstrun/atomic.ts"; // not hub/config.ts: it needs a data dir at load

type Output = { code: number; out: string };
export type GitFn = (args: readonly string[], cwd: string) => Promise<Output>;
// failures: the failed tests (name and first error line), from the junit file; detail: the tail of the run's output
export type FailedTest = { file: string; name: string; error: string };
export type SuiteResult = { green: boolean; failed: string[]; detail: string; flaky?: string[]; failures?: FailedTest[] }; // flaky: files that failed the full run and passed the one retry
export type SuiteFn = (dir: string) => Promise<SuiteResult>;

// What the tick needs from the machine: start a detached runner (its pid), ask if a pid lives, kill a runner with its children.
export type GateEnv = {
	origin: string;
	spawn: (cmd: readonly string[], logFile: string) => number;
	alive: (pid: number) => boolean;
	kill: (pid: number) => void;
};
export type GateCtx = GateEnv & { stateDir: string; slot: string; now: Date };
export type GateOutcome =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "nothing"; sha: string } // nothing on main since the newest release tag: the suite was not run
	| { kind: "green"; sha: string; flaky: string[]; release?: ReleaseResult } // release: what releasing that commit did (a runner from before the release moved here has none)
	| { kind: "red"; sha: string; failed: string[]; failures: FailedTest[]; detail: string }
	| { kind: "unrunnable"; reason: string };

export type ReleaseResult = { code: number; out: string };
type RunFile = { slot: string; pid: number; startedAt: string };
type ResultFile = { slot: string; sha?: string; nothing?: boolean; green?: boolean; failed?: string[]; failures?: FailedTest[]; flaky?: string[]; detail?: string; release?: ReleaseResult; error?: string };
const RELEASE_OUT_CHARS = 1500;

const RUN_FILE = "gate-run.json";
const RESULT_FILE = "gate-result.json";
const LOG_FILE = "gate.log";
const MAX_RUN_MS = 45 * 60_000; // the suite's own limit is 40 minutes; past this the run is taken for lost
const SUITE_TIMEOUT_MS = 40 * 60_000;
const RED_FILE = "release-red.json"; // the evidence of the last red run; clearGate leaves it, the next red run replaces it
const DETAIL_CHARS = 2000;
const LAST_RESULT = ".dotz-last-test.xml"; // written by every run: bunfig.toml, [test.reporter]

function readState<T>(file: string): T | null {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null; // half-written or damaged: taken as no state, the tick starts over
	}
}

export function clearGate(stateDir: string): void {
	rmSync(join(stateDir, RUN_FILE), { force: true });
	rmSync(join(stateDir, RESULT_FILE), { force: true });
}

// Keeps what a red run showed (failed tests with their first error line, the output tail) in the state dir: the gate's own files are cleared at
// the end of the slot, and without this a skipped slot leaves nothing to read.
export function saveRedEvidence(stateDir: string, slot: string, sha: string, red: { failed: readonly string[]; failures: readonly FailedTest[]; detail: string }, now: Date): void {
	writeAtomic(join(stateDir, RED_FILE), `${JSON.stringify({ slot, sha, at: now.toISOString(), failed: red.failed, failures: red.failures, detail: red.detail })}\n`);
}

function stopRun(c: GateCtx, run: RunFile): void {
	if (c.alive(run.pid)) c.kill(run.pid);
	clearGate(c.stateDir);
}

// Reads the state of the gate for this slot, and cleans up what a lost or old run left. Fast: files and one pid check, no git.
export function gateStatus(c: GateCtx): GateOutcome {
	const run = readState<RunFile>(join(c.stateDir, RUN_FILE));
	if (!run) {
		clearGate(c.stateDir);
		return { kind: "idle" };
	}
	if (run.slot !== c.slot) {
		stopRun(c, run); // a new slot: the old run is stopped before a new one starts
		return { kind: "idle" };
	}
	const result = readState<ResultFile>(join(c.stateDir, RESULT_FILE));
	if (result && result.slot === c.slot) {
		if (result.error !== undefined || !result.sha) {
			stopRun(c, run);
			return { kind: "unrunnable", reason: result.error ?? "결과 파일이 비어 있어요" };
		}
		if (result.nothing) return { kind: "nothing", sha: result.sha };
		if (result.green) return { kind: "green", sha: result.sha, flaky: result.flaky ?? [], release: result.release };
		return { kind: "red", sha: result.sha, failed: result.failed ?? [], failures: result.failures ?? [], detail: result.detail ?? "" };
	}
	if (c.now.getTime() - Date.parse(run.startedAt) > MAX_RUN_MS) {
		stopRun(c, run);
		return { kind: "unrunnable", reason: "45분이 지나도 테스트가 끝나지 않아 멈췄어요" };
	}
	if (!c.alive(run.pid)) {
		stopRun(c, run);
		return { kind: "unrunnable", reason: "테스트 프로세스가 결과 없이 끝났어요" };
	}
	return { kind: "running" };
}

// Starts the runner for this slot and records its pid. `cmd` is the runner's command line (release.ts --gate-run ...).
export function startGate(c: GateCtx, cmd: readonly string[]): void {
	clearGate(c.stateDir);
	const pid = c.spawn(cmd, join(c.stateDir, LOG_FILE));
	writeAtomic(join(c.stateDir, RUN_FILE), `${JSON.stringify({ slot: c.slot, pid, startedAt: c.now.toISOString() } satisfies RunFile)}\n`);
}

export function realGateEnv(origin: string): GateEnv {
	return {
		origin,
		spawn: (cmd, logFile) => {
			const fd = openSync(logFile, "w");
			try {
				const proc = Bun.spawn([...cmd], { stdin: "ignore", stdout: fd, stderr: fd, detached: true, timeout: MAX_RUN_MS }); // detached: its own process group
				proc.unref();
				return proc.pid;
			} finally {
				closeSync(fd);
			}
		},
		alive: pid => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false; // no such process
			}
		},
		kill: pid => {
			try {
				process.kill(-pid, "SIGTERM"); // the group: the suite's children go with it
			} catch {
				// already gone
			}
		},
	};
}

// hasNewCommits(repo, sha): whether `sha` has anything to release since the newest release tag in `repo`; release.ts passes the rule --auto uses.
// release(dir, sha): releases the commit the suite was green on, from the worktree `dir`; its code and last output go into the result.
// log: the runner's own log (gate.log, its stdout) when not given.
export type RunGateOptions = {
	stateDir: string;
	slot: string;
	origin: string;
	git: GitFn;
	runSuite: SuiteFn;
	hasNewCommits: (repo: string, sha: string) => Promise<boolean>;
	release?: (dir: string, sha: string) => Promise<ReleaseResult>;
	log?: (line: string) => void;
};

// The detached runner. Clones origin once into the state dir, fetches main and the tags, leaves a "nothing" result when main has nothing to release
// since the newest tag (no suite), otherwise runs the suite on a worktree of the fetched commit, removes the worktree
// and leaves the result file for the ticks. Any failure to get that far is written as an error result: the gate did not run, the slot stays open.
export async function runGate(o: RunGateOptions): Promise<void> {
	const resultFile = join(o.stateDir, RESULT_FILE);
	const repo = join(o.stateDir, "gate-repo");
	const tree = join(o.stateDir, "gate-tree");
	try {
		if (!existsSync(join(repo, ".git")) || (await o.git(["rev-parse", "--git-dir"], repo)).code !== 0) {
			const part = `${repo}.part`; // cloned aside and renamed, so a killed clone never looks like a repo
			rmSync(repo, { recursive: true, force: true });
			rmSync(part, { recursive: true, force: true });
			const cloned = await o.git(["clone", "--quiet", "--no-checkout", o.origin, part], o.stateDir);
			if (cloned.code !== 0) throw new Error(`저장소를 받지 못했어요: ${cloned.out}`);
			renameSync(part, repo);
		}
		const fetched = await o.git(["fetch", "--quiet", "--tags", "origin", "main"], repo);
		if (fetched.code !== 0) throw new Error(`origin/main을 가져오지 못했어요: ${fetched.out}`);
		const head = await o.git(["rev-parse", "origin/main"], repo);
		if (head.code !== 0) throw new Error(`origin/main의 커밋을 읽지 못했어요: ${head.out}`);
		const sha = head.out;
		if (!(await o.hasNewCommits(repo, sha))) {
			writeAtomic(resultFile, `${JSON.stringify({ slot: o.slot, sha, nothing: true } satisfies ResultFile)}\n`);
			return;
		}
		// A runner killed in the middle of a run leaves its worktree behind: the fixed path is cleared before the next one.
		if (existsSync(tree)) await o.git(["worktree", "remove", "--force", tree], repo);
		rmSync(tree, { recursive: true, force: true });
		await o.git(["worktree", "prune"], repo);
		const added = await o.git(["worktree", "add", "--detach", tree, sha], repo);
		if (added.code !== 0) throw new Error(`테스트용 작업 폴더를 만들지 못했어요: ${added.out}`);
		try {
			const suite = await o.runSuite(tree);
			if (suite.flaky?.length) (o.log ?? console.log)(`flaky: ${suite.flaky.length} test file(s) failed the full run and passed the retry: ${suite.flaky.join(", ")}`);
			let release: ReleaseResult | undefined;
			if (suite.green && o.release) {
				const made = await o.release(tree, sha).catch((e: unknown): ReleaseResult => ({ code: 1, out: e instanceof Error ? e.message : String(e) }));
				release = { code: made.code, out: made.out.slice(-RELEASE_OUT_CHARS) };
			}
			writeAtomic(resultFile, `${JSON.stringify({ slot: o.slot, sha, ...suite, ...(release ? { release } : {}) } satisfies ResultFile)}\n`);
		} finally {
			await o.git(["worktree", "remove", "--force", tree], repo);
			rmSync(tree, { recursive: true, force: true });
		}
	} catch (e) {
		writeAtomic(resultFile, `${JSON.stringify({ slot: o.slot, error: e instanceof Error ? e.message : String(e) } satisfies ResultFile)}\n`);
	}
}

async function spawn(cmd: readonly string[], cwd: string): Promise<Output> {
	const proc = Bun.spawn([...cmd], { cwd, env: { ...process.env, DOTZ_TEST_MAX_MS: String(SUITE_TIMEOUT_MS) }, stdout: "pipe", stderr: "pipe", timeout: SUITE_TIMEOUT_MS }); // the suite stops itself no sooner than this
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out: `${out}${err}` };
}

// The test files that failed, from the junit file the run leaves in `dir`.
export function failedFiles(xml: string): string[] {
	return [...new Set([...xml.matchAll(/<testsuite name="[^"]*" file="([^"]*)"[^>]* failures="[1-9]/g)].map(m => m[1]!))];
}

const unescapeXml = (s: string): string => s.replace(/&#10;/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// The tests that failed, from the junit file the run leaves in `dir`: name, file and the first line of the error.
export function failedTests(xml: string): FailedTest[] {
	const found: FailedTest[] = [];
	for (const m of xml.matchAll(/<testcase name="([^"]*)"[^>]*? file="([^"]*)"[^>]*[^/]>\s*<failure([^>]*?)(\/?)>([^<]*)/g)) {
		const attr = /message="([^"]*)"/.exec(m[3]!)?.[1];
		const error = unescapeXml(attr || m[5] || "").split("\n")[0]!.trim();
		found.push({ file: m[2]!, name: unescapeXml(m[1]!), error });
	}
	return found;
}

// All test files of the run in the junit file (a describe block is a suite of its own, so files are counted once).
export function testFileCount(xml: string): number {
	return new Set([...xml.matchAll(/<testsuite name="[^"]*" file="([^"]*)"/g)].map(m => m[1])).size;
}

// One run of the suite in `dir`: all of it, or only `files`. `total` is the number of test files in that run's report.
export type Attempt = { green: boolean; failed: string[]; total: number; detail: string; failures?: FailedTest[] };
export type AttemptFn = (dir: string, files?: readonly string[]) => Promise<Attempt>;

export const RETRY_MAX_FAILED_SHARE = 0.15; // the share of all test files that may fail and still be retried; more is a real breakage and stays red

// The gate's verdict on a full run: a red run whose failing files are few is retried once, only those files, in one process; green when they
// all pass then (they are the `flaky` files), red as before otherwise. Never a second retry.
export async function runWithRetry(dir: string, attempt: AttemptFn): Promise<SuiteResult> {
	const first = await attempt(dir);
	if (first.green) return { green: true, failed: [], detail: "" };
	const red: SuiteResult = { green: false, failed: first.failed, failures: first.failures ?? [], detail: first.detail };
	if (first.failed.length === 0 || first.total <= 0 || first.failed.length / first.total > RETRY_MAX_FAILED_SHARE) return red;
	const second = await attempt(dir, first.failed);
	if (second.green) return { green: true, failed: [], detail: "", flaky: first.failed };
	return { green: false, failed: second.failed.length ? second.failed : first.failed, failures: (second.failed.length ? second.failures : first.failures) ?? [], detail: second.detail };
}

function suiteAttempt(): AttemptFn {
	return async (dir, files) => {
		const report = join(dir, LAST_RESULT);
		rmSync(report, { force: true }); // a report from an earlier run must not be read as this one's
		// The retry is plain `bun test` on the named files: one process, files one after another (no --parallel).
		const tested = await spawn(files ? ["bun", "test", ...files.map(f => `./${f}`)] : ["bun", "run", "test"], dir);
		const green = tested.code === 0 && /^\s*0 fail/m.test(tested.out);
		const xml = existsSync(report) ? readFileSync(report, "utf8") : "";
		return { green, failed: failedFiles(xml), failures: failedTests(xml), total: testFileCount(xml), detail: tested.out.trim().slice(-DETAIL_CHARS) };
	};
}

// Installs from the lockfile and runs `bun run test` (the heavy slot, like any full run) in `dir`, with the one retry of runWithRetry. An install
// that fails throws: that is the gate not running, not the suite failing.
export async function runSuiteIn(dir: string): Promise<SuiteResult> {
	const installed = await spawn(["bun", "install", "--frozen-lockfile"], dir);
	if (installed.code !== 0) throw new Error(`bun install이 실패했어요: ${installed.out.trim().slice(-300)}`);
	return runWithRetry(dir, suiteAttempt());
}
