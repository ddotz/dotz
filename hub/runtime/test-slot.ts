// A whole-suite `bun test`, or a run with a WebView test file, takes the machine-wide heavy test slot (hub/heavyslot.ts) before it starts,
// from the test preload, so a plain `bun test`, `bun test --parallel=4` or `bun run test` from any session waits its turn instead of
// fighting the other sessions' runs for CPU and the macOS daemons every WebView wakes. It waits, it does not refuse, and it waits for as
// long as a live run holds the slot: the only ways past a holder are the reclaim rules of heavyslot.ts (the holder died, or it is older
// than the max hold). While it waits it prints what holds the slot and the latest time it frees, once a minute. The slot is its own
// directory (heavy-suite, one slot): dotz_verify (hub/receipts.ts) takes up to cpus/4 slots of `heavy`, and one of those could not keep a
// suite under dotz_verify and a direct suite apart. A run of a few plain files stays free. Only node builtins and heavyslot.ts, and it
// must run before the preload installs the fake clock.
// The preload does not run in the process that got the command line: a plain run loads it in that one process, a --parallel run loads
// it in each worker (BUN_TEST_WORKER_ID) and not in the coordinator, whose command line is read from the process table.
// A lane's repeat full runs are refused here too: the third in 6 hours in one worktree does not start and prints the files that failed and
// the one last pre-merge run (DOTZ_TEST_FINAL=1). Only a lane (DOTZ_LANE) is limited, so the gates (self-update, release, CI) never are, and
// a limit that breaks runs the tests.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireHeavySlot, holderInfo, MAX_HOLD_MS } from "../heavyslot.ts";

// Flags whose value is the next argument (the others take --flag=value or none).
const VALUE_FLAGS = new Set(["-t", "--test-name-pattern", "--timeout", "--rerun-each", "--retry", "--seed", "--reporter", "--reporter-outfile", "--max-concurrency", "--path-ignore-patterns", "--shard", "--timings", "--changed", "--coverage-reporter", "--coverage-dir", "--bail", "--parallel-delay", "--preload", "-r", "--config", "-c"]);
const FEW_FILES = 20;
const WINDOW_MS = 6 * 3_600_000;
const FREE_RUNS = 2;
const LAST_RESULT = ".dotz-last-test.xml"; // written by every run: bunfig.toml, [test.reporter]
// Time for the coordinator of a --parallel run to print the worker that crashed with the refusal, before a later worker stops the run.
const PRINT_MS = 300;

// One worktree's log of full runs: <DOTZ_DIR>/test-runs/<hash of its path>.log. Append-only lines, so parallel workers need no lock:
// "<ms> run <pid> [final]", "<ms> failed <file>", "<ms> refused <pid>".
export const runLogPath = (dotzDir: string, cwd: string): string => join(dotzDir, "test-runs", `${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.log`);
// A wait has no end of its own (the longest timer there is, 24 days): the holder's death or its max hold ends it. A caller whose own
// timeout is shorter kills the waiting run, which holds nothing; the progress line is what it saw.
const FOREVER_MS = 2 ** 31 - 1;
const NOTE_MS = 60_000;
// A WebView test file: its name, or (the ones outside the name) the Bun.WebView or fakeHub (hub/test-web.ts) call in its text.
const WEB_NAME = /-web\.test\.[cm]?[jt]sx?$/;
const WEB_USE = /Bun\.WebView|\bfakeHub\(/;
const usesWebView = (file: string): boolean => WEB_NAME.test(file) || (existsSync(file) && WEB_USE.test(readFileSync(file, "utf8")));

// The file arguments of a `bun test` command line (["bun", "test", ...args]), or undefined for any other command and for a --test-worker.
function namedFiles(words: string[]): string[] | undefined {
	const args = words.slice(1);
	if (args[0] !== "test" || args.includes("--test-worker")) return undefined;
	const named: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--") continue;
		if (a.startsWith("-")) {
			if (VALUE_FLAGS.has(a)) i++;
			continue;
		}
		named.push(a);
	}
	return named;
}

// True when the command line starts a run of many files: no file argument at all, a directory or name filter, or many files.
export function isFullSuite(words: string[]): boolean {
	const named = namedFiles(words);
	return !!named && (named.length === 0 || named.length > FEW_FILES || named.some(n => !/\.[cm]?[jt]sx?$/.test(n)));
}

// "full" (the whole suite), "web" (a few files, one a WebView test: the WebView tests starve each other) or "free".
export const runKind = (words: string[]): "full" | "web" | "free" => (isFullSuite(words) ? "full" : namedFiles(words)?.some(usesWebView) ? "web" : "free");

// What the waiting run prints: the holder, how long it has held the slot, and the latest time the slot frees without a release.
function waitLine(dir: string, heldBy: string): string {
	const info = holderInfo(dir);
	const held = info ? `, ${Math.floor((Date.now() - info.at) / 60_000)} min so far; the slot frees by itself in ${Math.max(0, Math.ceil((info.at + MAX_HOLD_MS - Date.now()) / 60_000))} min at most` : "";
	return `[dotz] this test run has not started: a heavy test run holds the slot (${(info?.label ?? heldBy).slice(0, 80)}${held}); waiting for it`;
}

const commandLine = (pid: number): string[] => Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)]).stdout.toString().trim().split(/\s+/);

// The pid and everything above it, read from one process table.
function ancestors(pid: number): number[] {
	const parent = new Map(Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="]).stdout.toString().trim().split("\n").map(l => l.trim().split(/\s+/).map(Number) as [number, number]));
	const out: number[] = [];
	for (let p = pid; p > 1 && out.length < 32; p = parent.get(p) ?? 0) out.push(p);
	return out;
}

const readLog = (log: string): string[][] => {
	try {
		return readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => l.split(" "));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
};

function append(log: string, lines: string[]): void {
	mkdirSync(dirname(log), { recursive: true });
	appendFileSync(log, lines.map(l => `${Date.now()} ${l}\n`).join(""));
}

// The last result is overwritten by every run, a passing rerun of one file included, so what it failed goes into the log first.
function noteFailures(log: string): void {
	let xml: string;
	try {
		xml = readFileSync(LAST_RESULT, "utf8");
	} catch {
		return; // no run here yet
	}
	const failed = [...xml.matchAll(/<testsuite name="[^"]*" file="([^"]*)"[^>]* failures="[1-9]/g)].map(m => `failed ${m[1]}`);
	if (failed.length) append(log, failed);
}

function refusal(runs: number, failed: string[], finalUsed: boolean): string {
	const shown = failed.slice(0, FEW_FILES);
	return [
		`[dotz] full test run refused: this worktree already ran the whole suite ${runs} times in the last ${WINDOW_MS / 3_600_000} hours.`,
		shown.length ? `Run only what failed since the last full run: bun test ${shown.join(" ")}${failed.length > shown.length ? ` (first ${shown.length} of ${failed.length})` : ""}` : "No failed file is recorded since the last full run.",
		"A failure unrelated to this branch that passes alone is reported, not chased.",
		finalUsed ? "The one last pre-merge run of this window is already used: report what still fails." : "The one last run right before merge: DOTZ_TEST_FINAL=1 bun run test",
	].join("\n");
}

function refuse(message: string, log: string, run: number, worker: boolean): never {
	if (worker) {
		// A worker that exits only crashes its file and the coordinator starts the next, so every file of the suite would cost a worker and
		// print this. The first crash prints it (a coordinator that is stopped drops what its running workers said); the next worker stops the run.
		if (readLog(log).some(l => l[1] === "refused" && l[2] === String(run) && Date.now() - Number(l[0]) < 60_000)) {
			Bun.sleepSync(PRINT_MS);
			process.kill(run, "SIGTERM");
			process.exit(2);
		}
		console.error(message);
		append(log, [`refused ${run}`]);
		process.exit(2);
	}
	console.error(message);
	process.exit(2);
}

// Refuses the run, or returns what to log for it once it holds the slot.
function checkRepeatRun(env: Record<string, string | undefined>, log: string, run: number, worker: boolean): string {
	const lines = readLog(log);
	const earlier = lines.filter(l => l[1] === "run" && l[2] !== String(run) && Date.now() - Number(l[0]) < WINDOW_MS);
	const runs = new Set(earlier.map(l => l[2])).size;
	if (runs < FREE_RUNS) return `run ${run}`;
	const finalUsed = earlier.some(l => l[3] === "final");
	if (env.DOTZ_TEST_FINAL && !finalUsed) return `run ${run} final`;
	const since = lines.slice(lines.findLastIndex(l => l[1] === "run") + 1);
	refuse(refusal(runs, [...new Set(since.filter(l => l[1] === "failed").map(l => l.slice(2).join(" ")))], finalUsed), log, run, worker);
}

function failOpen<T>(fallback: T, step: () => T): T {
	try {
		return step();
	} catch (e) {
		console.error(`[dotz] repeat-run limit skipped: ${e}`);
		return fallback;
	}
}

// Takes the slot for a whole-suite run or a run with a WebView test file. The run is one holder, named by the pid of the process that was
// started (the coordinator for the workers of a --parallel run), so every worker of that run counts as the holder and a killed run leaves a
// slot the next waiter reclaims. A test run that a holder's test starts goes on at once: waiting for it would wait for itself.
export async function takeSuiteSlot(env: Record<string, string | undefined>): Promise<void> {
	const worker = env.BUN_TEST_WORKER_ID !== undefined;
	const run = worker ? process.ppid : process.pid;
	// Decided once per run: a --isolate worker loads the preload again for every file. The run's pid is part of the value, so a
	// `bun test` that a test starts (which inherits the variable) decides for itself.
	const decided = env.TEST_SLOT_DECISION?.split(":");
	const dotzDir = env.DOTZ_DIR ?? join(homedir(), ".dotz");
	const log = env.DOTZ_LANE ? runLogPath(dotzDir, process.cwd()) : undefined;
	if (decided?.[0] !== String(run)) {
		env.TEST_SLOT_DECISION = `${run}:${runKind(commandLine(run))}`;
		if (log) failOpen(undefined, () => noteFailures(log));
	}
	const kind = env.TEST_SLOT_DECISION!.split(":")[1];
	if (kind === "free") return;
	const entry = log && kind === "full" ? failOpen(undefined, () => checkRepeatRun(env, log, run, worker)) : undefined; // a WebView file is no full run
	const dir = join(dotzDir, "heavy-suite");
	let ticker: ReturnType<typeof setInterval> | undefined;
	const slot = await acquireHeavySlot({
		dir,
		label: `${process.cwd()}: ${commandLine(run).join(" ")}`.slice(0, 120),
		slots: 1,
		timeoutMs: FOREVER_MS,
		pid: run,
		family: ancestors(run),
		onWait: heldBy => {
			console.error(waitLine(dir, heldBy));
			ticker = setInterval(() => console.error(waitLine(dir, heldBy)), NOTE_MS);
		},
	}).finally(() => clearInterval(ticker));
	// A --isolate worker comes back here for every file: it asks once.
	env.TEST_SLOT_DECISION = `${run}:free`;
	if (log && entry) failOpen(undefined, () => append(log, [entry]));
	if (slot.note) console.error(`[dotz] ${slot.note}`);
	if (!worker) process.on("exit", slot.release);
}
