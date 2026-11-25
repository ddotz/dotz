import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:os";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { until } from "./deadline.ts";
import type { Check } from "./gate-file.ts";
import { appendRow } from "./log.ts";
import type { CheckResultKind } from "./log.ts";
import { message } from "./util.ts";

const OUTPUT_LINES = 60;
const SHELL_LIMIT_SEC = 20;
const TIMEOUT_EXIT = 124;
const NOT_STARTED_EXIT = 127;
const MAX_CAPTURE = 256 * 1024;
const TERM_GRACE_MS = 2_000;
const PIPE_GRACE_MS = 500;
const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const VOLATILE: readonly (readonly [RegExp, string])[] = [
	[/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
	[/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>"],
	[/\b\d+(?:\.\d+)?\s?(?:ms|\u00b5s|us|ns|seconds?|secs?|minutes?|mins?|s)\b/g, "<duration>"],
	[/\b0x[0-9a-fA-F]{6,}\b/g, "<address>"],
	[/\b\d{9,}\b/g, "<number>"],
	[/\/(?:private\/)?(?:var\/folders|tmp)\/\S+/g, "<tmp>"],
];

/** How a check's process ended; `spawnError` is set when the process could not be started at all. */
export interface CheckResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	output: string;
	spawnError?: string;
}

/** A check's process: `settled` is set once it has ended and its whole process group has been killed. */
export interface Run {
	startedAt: number;
	promise: Promise<CheckResult>;
	settled?: CheckResult;
	cancel(): void;
}

const live = new Set<Run>();
let exitHooked = false;

function hookExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	process.on("exit", cancelLiveRuns);
}

/** Kills the process group of every run that has not settled yet; used when the host process goes away. */
export function cancelLiveRuns(): void {
	for (const run of live) run.cancel();
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		return;
	}
}

function recordEnd(name: string | undefined, repo: string, startedAt: number, result: CheckResultKind): void {
	if (name === undefined) return;
	const endedAt = Date.now();
	appendRow({ at: new Date(endedAt).toISOString(), check: name, repo, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), durationMs: endedAt - startedAt, result });
}

function failedToStart(startedAt: number, error: unknown): Run {
	const settled: CheckResult = { code: null, signal: null, timedOut: false, output: "", spawnError: message(error) };
	return { startedAt, promise: Promise.resolve(settled), settled, cancel: () => undefined };
}

/**
 * Runs `command` with bash in `repo` as the leader of its own process group. The whole group is killed when the shell
 * exits, when `timeoutSec` passes (SIGTERM, then SIGKILL), on `cancel()` and when the host process exits. A child that
 * leaves the group, for example under `set -m` or `setsid`, is not killed. With a `name`, the run is a gate check and its end
 * leaves one row in gate.jsonl: how long it ran and whether it passed, failed, timed out or was cancelled.
 */
export function startRun(repo: string, command: string, timeoutSec: number, name?: string): Run {
	const startedAt = Date.now();
	let child: ChildProcessByStdio<null, Readable, Readable>;
	try {
		child = spawn("bash", ["-c", command], { cwd: repo, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
	} catch (error) {
		recordEnd(name, repo, startedAt, "fail");
		return failedToStart(startedAt, error);
	}
	const { promise, resolve } = Promise.withResolvers<CheckResult>();
	const decoder = new StringDecoder("utf8");
	const timers: NodeJS.Timeout[] = [];
	let output = "";
	let timedOut = false;
	let finished = false;
	let groupGone = false;
	let recorded = false;
	let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };

	const killGroup = (signal: NodeJS.Signals) => {
		if (child.pid !== undefined && !groupGone) signalGroup(child.pid, signal);
	};
	const record = (result: CheckResultKind) => {
		if (recorded) return;
		recorded = true;
		recordEnd(name, repo, startedAt, result);
	};
	const finish = (spawnError?: string) => {
		if (finished) return;
		finished = true;
		record(timedOut ? "timeout" : spawnError === undefined && exit.code === 0 ? "pass" : "fail");
		groupGone = true;
		for (const timer of timers) clearTimeout(timer);
		child.stdout.destroy();
		child.stderr.destroy();
		live.delete(run);
		resolve({ ...exit, timedOut, output: (output + decoder.end()).slice(-MAX_CAPTURE), ...(spawnError === undefined ? {} : { spawnError }) });
	};
	const append = (chunk: Buffer) => {
		output = (output + decoder.write(chunk)).slice(-MAX_CAPTURE);
	};

	child.stdout.on("data", append);
	child.stderr.on("data", append);
	child.on("error", error => finish(error.message));
	child.on("exit", (code, signal) => {
		exit = { code, signal };
		killGroup("SIGKILL");
		groupGone = true;
		timers.push(setTimeout(() => finish(), PIPE_GRACE_MS));
	});
	child.on("close", () => finish());
	timers.push(
		setTimeout(() => {
			timedOut = true;
			killGroup("SIGTERM");
			timers.push(setTimeout(() => killGroup("SIGKILL"), TERM_GRACE_MS));
		}, timeoutSec * 1000).unref(),
	);

	const cancel = () => {
		if (!finished && !groupGone && !timedOut) record("cancelled");
		killGroup("SIGKILL");
	};
	const run: Run = { startedAt, promise, cancel };
	live.add(run);
	hookExit();
	void promise.then(result => {
		run.settled = result;
	});
	return run;
}

/** The run's result, or undefined when it is still going after `ms` (or when `signal` aborts first). */
export async function waitFor(run: Run, ms: number, signal?: AbortSignal): Promise<CheckResult | undefined> {
	const limit = AbortSignal.timeout(Math.max(0, ms));
	return (await until(run.promise, signal ? AbortSignal.any([limit, signal]) : limit))?.value;
}

export function tail(output: string): string {
	const lines = output.replace(ANSI, "").replace(/\r\n?/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	const last = lines.slice(-OUTPUT_LINES).map(line => (line.length > 400 ? `${line.slice(0, 400)}…` : line));
	return last.length ? last.join("\n") : "(no output)";
}

/** The output tail with durations, clock times, addresses, long numbers and temp paths blanked, so two runs of the same failure compare equal. */
export function normalizedTail(output: string): string {
	return VOLATILE.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), tail(output));
}

/** The exit status (or timeout, or signal) plus a hash of the normalized output tail: what makes two failures of a check "the same". */
export function failureState(result: CheckResult): string {
	const how = result.timedOut ? "timeout" : result.signal ? `signal:${result.signal}` : `exit:${result.code}`;
	return `${how}:${createHash("sha256").update(normalizedTail(result.output)).digest("hex").slice(0, 16)}`;
}

export function failureText(repo: string, check: Check, result: CheckResult): string {
	const how = result.timedOut ? `timed out after ${check.timeoutSec}s` : result.signal ? `killed by ${result.signal}` : `exit status ${result.code}`;
	return [`done-gate: check "${check.name}" failed in ${repo} (${how}).`, `Command: ${check.command}`, `Last ${OUTPUT_LINES} output lines:`, tail(result.output)].join("\n");
}

/** How a failed check is told apart in the log: it ran out of time, was killed by a signal, or exited with a failing status. */
export const failureClass = (result: CheckResult): string => (result.timedOut ? "timeout" : result.signal ? "signal" : "failed");

/** Runs `command` with bash in `cwd` for at most 20 s and captures its output: a timeout exits 124, bash that cannot start 127, and a process killed by a signal 128 plus the signal number. */
export async function runShell(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
	const result = await startRun(cwd, command, SHELL_LIMIT_SEC).promise;
	if (result.spawnError !== undefined) return { exitCode: NOT_STARTED_EXIT, output: `could not start bash in ${cwd}: ${result.spawnError}` };
	if (result.timedOut) return { exitCode: TIMEOUT_EXIT, output: `${result.output}\n(timed out after ${SHELL_LIMIT_SEC}s)` };
	if (result.signal) return { exitCode: 128 + (constants.signals[result.signal] ?? 0), output: result.output };
	return { exitCode: result.code ?? 1, output: result.output };
}
