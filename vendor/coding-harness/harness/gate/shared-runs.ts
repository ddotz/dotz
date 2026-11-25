import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./gate-file.ts";
import { readPassed, repoStateKey, stateDir } from "./log.ts";
import { startRun } from "./runs.ts";
import type { CheckResult, Run } from "./runs.ts";
import { isRecord, message } from "./util.ts";

const POLL_MS = 100;
const STALE_GRACE_SEC = 30;
const HEARTBEAT_MS = 1000;
const STALE_BEAT_MS = 5000;
const MAX_KEPT_OUTPUT = 64 * 1024;

/** A gate check's run in flight, kept per repo and check name where every omp process of the machine can see it: who runs it (`owner`, a token per gate session, and the process `pid`; the owner touches the file every second while the run has no `result`, and a claim not touched for 5 s is abandoned), when it started, the tree fingerprint and command it runs for, its `timeoutSec`, and, once the process has ended, its `result`. */
export interface Claim {
	owner: string;
	pid: number;
	startedAt: number;
	print: string;
	command: string;
	timeoutSec: number;
	result?: CheckResult;
}

/** What a stop finds when it asks whether another session already runs the check on its tree: that session's result, the run still going at the stop's deadline, or nothing to wait for. */
export type Peer = { kind: "result"; result: CheckResult } | { kind: "running"; startedAt: number } | { kind: "none" };

/** Where the run of check `name` in `repo` is claimed: `claims/` under the gate's state directory. */
export const claimFile = (repo: string, name: string): string => join(stateDir(), "claims", `${repoStateKey(repo)}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}.json`);

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

function parseResult(value: unknown): CheckResult | undefined {
	if (!isRecord(value) || typeof value.timedOut !== "boolean" || typeof value.output !== "string") return undefined;
	const { code, signal, timedOut, output } = value;
	if ((code !== null && typeof code !== "number") || (signal !== null && typeof signal !== "string")) return undefined;
	return { code, signal: signal as NodeJS.Signals | null, timedOut, output, ...(typeof value.spawnError === "string" ? { spawnError: value.spawnError } : {}) };
}

function readClaim(repo: string, name: string): Claim | undefined {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(claimFile(repo, name), "utf8"));
	} catch {
		return undefined;
	}
	if (!isRecord(data)) return undefined;
	const { owner, pid, startedAt, print, command, timeoutSec } = data;
	if (typeof owner !== "string" || typeof pid !== "number" || typeof startedAt !== "number" || typeof print !== "string" || typeof command !== "string" || typeof timeoutSec !== "number") return undefined;
	const result = data.result === undefined ? undefined : parseResult(data.result);
	return { owner, pid, startedAt, print, command, timeoutSec, ...(result === undefined ? {} : { result }) };
}

function beatAt(repo: string, name: string): number {
	try {
		return statSync(claimFile(repo, name)).mtimeMs;
	} catch {
		return 0;
	}
}

function writeClaim(repo: string, name: string, claim: Claim): void {
	try {
		const file = claimFile(repo, name);
		mkdirSync(join(stateDir(), "claims"), { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(claim));
		renameSync(temp, file);
	} catch {
		return;
	}
}

const beats = new Map<string, NodeJS.Timeout>();

function beat(repo: string, name: string, owner: string): void {
	const file = claimFile(repo, name);
	clearInterval(beats.get(file));
	const timer = setInterval(() => {
		const held = readClaim(repo, name);
		if (held?.owner !== owner || held.result !== undefined) {
			clearInterval(timer);
			if (beats.get(file) === timer) beats.delete(file);
			return;
		}
		const now = new Date();
		try {
			utimesSync(file, now, now);
		} catch {
			clearInterval(timer);
		}
	}, HEARTBEAT_MS);
	timer.unref();
	beats.set(file, timer);
}

/** Records that `claim.owner` runs check `name` in `repo`, replacing any claim there, and keeps the claim's heartbeat until it has a result, is released or taken over. A claim that cannot be written leaves the check unshared and runs it all the same. */
export function claimRun(repo: string, name: string, claim: Claim): void {
	writeClaim(repo, name, claim);
	beat(repo, name, claim.owner);
}

/** Records how the run of `owner` for tree fingerprint `print` ended; the output kept is its last 64 KiB. A claim that is gone or belongs to another run is left alone. */
export function settleClaim(repo: string, name: string, owner: string, print: string, result: CheckResult): void {
	const claim = readClaim(repo, name);
	if (claim === undefined || claim.owner !== owner || claim.print !== print) return;
	writeClaim(repo, name, { ...claim, result: { ...result, output: result.output.slice(-MAX_KEPT_OUTPUT) } });
}

/** Removes the claim on check `name` in `repo` when `owner` holds it. */
export function releaseClaim(repo: string, name: string, owner: string): void {
	if (readClaim(repo, name)?.owner !== owner) return;
	rmSync(claimFile(repo, name), { force: true });
}

/**
 * The claim another owner holds on `check` for tree fingerprint `print` and the check's current command, or undefined when there is none
 * worth waiting for. A claim whose process is gone is removed; one that has no result and whose heartbeat is older than 5 s (its owner
 * is gone, or its pid went to another process) is removed; one that has no result and is older than the check's `timeoutSec` plus 30 s
 * is stale and ignored.
 */
export function peerClaim(repo: string, check: Check, print: string, owner: string, now = Date.now()): Claim | undefined {
	const claim = readClaim(repo, check.name);
	if (claim === undefined || claim.owner === owner) return undefined;
	if (!alive(claim.pid)) {
		rmSync(claimFile(repo, check.name), { force: true });
		return undefined;
	}
	if (claim.result === undefined && now - beatAt(repo, check.name) > STALE_BEAT_MS) {
		rmSync(claimFile(repo, check.name), { force: true });
		return undefined;
	}
	if (claim.print !== print || claim.command !== check.command) return undefined;
	if (claim.result === undefined && now - claim.startedAt > (claim.timeoutSec + STALE_GRACE_SEC) * 1000) return undefined;
	return claim;
}

/** Whether a result stands for a pass: the process exited 0, in time. */
export const passes = (result: CheckResult): boolean => result.spawnError === undefined && !result.timedOut && result.code === 0;

/**
 * Waits for the run another session has going on this tree until `limit.until` (epoch milliseconds) or `limit.signal` ends it. A pass
 * recorded for the tree by any process is a result at once. A run that ended while this call watched is a result, a failure
 * included; a failure found already ended, a run that could not start, an owner whose process is gone and a stale claim are
 * `none`, and the caller runs the check itself.
 */
export async function awaitPeer(repo: string, check: Check, print: string, owner: string, limit: { until: number; signal?: AbortSignal; watched?: boolean }): Promise<Peer> {
	let watched = limit.watched === true;
	for (;;) {
		const known = readPassed(repo)[check.name];
		if (known?.fingerprint === print && known.command === check.command) return { kind: "result", result: { code: 0, signal: null, timedOut: false, output: "" } };
		const claim = peerClaim(repo, check, print, owner);
		if (claim === undefined) return { kind: "none" };
		if (claim.result !== undefined) {
			if (claim.result.spawnError !== undefined || (!watched && !passes(claim.result))) return { kind: "none" };
			return { kind: "result", result: claim.result };
		}
		watched = true;
		const left = limit.until - Date.now();
		if (left <= 0 || limit.signal?.aborted === true) return { kind: "running", startedAt: claim.startedAt };
		await Bun.sleep(Math.min(POLL_MS, left));
	}
}

const CANCELLED: CheckResult = { code: null, signal: "SIGKILL", timedOut: false, output: "" };

/**
 * A run of check `name` for a stop that found another session's run of it still going: it ends with that run's result, a failure
 * included. When the other run ends without one (its process gone, its heartbeat stopped, past its time limit) it runs the check itself
 * and claims it. `startedAt` is when the other run began. `cancel` ends the wait and any run of its own.
 */
export function followPeer(repo: string, check: Check, print: string, owner: string, startedAt: number): Run {
	const abort = new AbortController();
	const { promise, resolve } = Promise.withResolvers<CheckResult>();
	let own: Run | undefined;
	const follow = async (): Promise<CheckResult> => {
		const peer = await awaitPeer(repo, check, print, owner, { until: Number.POSITIVE_INFINITY, signal: abort.signal, watched: true });
		if (peer.kind === "result") return peer.result;
		if (abort.signal.aborted) return CANCELLED;
		own = startRun(repo, check.command, check.timeoutSec, check.name);
		claimRun(repo, check.name, { owner, pid: process.pid, startedAt: own.startedAt, print, command: check.command, timeoutSec: check.timeoutSec });
		const result = await own.promise;
		settleClaim(repo, check.name, owner, print, result);
		return result;
	};
	const run: Run = { startedAt, promise, cancel: () => {
		abort.abort();
		own?.cancel();
	} };
	void follow()
		.catch((error: unknown): CheckResult => ({ code: 1, signal: null, timedOut: false, output: `waiting for another session's run of "${check.name}" failed: ${message(error)}` }))
		.then(result => {
			run.settled = result;
			resolve(result);
		});
	return run;
}
