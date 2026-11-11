// Which of the processes a parked agent leaves behind are still useful. hub/agent-tree.ts keeps the record and the end points.
// A routine idle park (lane or conversation session) ends the agent's process, not what it started for the owner. Useful means:
//  - it used CPU recently: the CPU time in the shared 30 s `ps` listing grew between two listings (no extra call), or
//  - it listens on a TCP port: one async `lsof` at the moment of the park, never per tick, with its own short limit.
// If that check fails or is slow, everything that was recorded is kept: the long idle bound ends what nobody uses.
import { log } from "./config.ts";

export type Kid = { pid: number; start: string; cpu?: number; busyAt?: number };
type Proc = { pid: number; ppid: number; start: string; cpu?: number };

/** CPU within the last 5 min counts as work: a build pauses between steps, a stuck process does not. */
export const RECENT_BUSY_MS = 5 * 60_000;
/** A kept process that did nothing for a day ends: a demo left up overnight survives, a server nobody asks for does not. */
export const IDLE_BOUND_MS = 24 * 3_600_000;
/** One session never keeps more than this many processes, so the record stays small. */
export const MAX_KEPT = 64;
const CPU_STEP_S = 0.2;
const NAMED = 3;
const PROBE_MS = 3000;

/** `ps` TIME ("276:21.39", "1:02:03.45") in seconds. */
export function cpuSeconds(text: string): number | undefined {
	const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
	return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

/** The records of `procs` (new listing), each with the time its CPU last grew by CPU_STEP_S or more since `before`. */
export function withCpu(before: readonly Kid[], procs: readonly Proc[], now: number): Kid[] {
	const old = new Map(before.map(k => [k.pid, k]));
	return procs.map(p => {
		const k = old.get(p.pid);
		const same = k !== undefined && k.start === p.start;
		const grew = same && p.cpu !== undefined && k.cpu !== undefined && p.cpu - k.cpu >= CPU_STEP_S;
		return { pid: p.pid, start: p.start, cpu: p.cpu, busyAt: grew ? now : same ? k.busyAt : undefined };
	});
}

/** Output of a short-lived tool; undefined when it could not run or was cut at its limit. */
async function probe(argv: string[]): Promise<string | undefined> {
	try {
		const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", timeout: PROBE_MS, killSignal: "SIGKILL" });
		const text = await new Response(p.stdout).text();
		await p.exited;
		return p.signalCode ? undefined : text;
	} catch (e) {
		log(`kept processes: ${argv[0]} failed: ${e}`);
		return undefined;
	}
}

/** The pids in the process group `pgid` (the agent's group), or undefined when pgrep failed. */
export async function groupMembers(pgid: number): Promise<number[] | undefined> {
	const text = await probe(["/usr/bin/pgrep", "-g", String(pgid)]);
	return text === undefined ? undefined : text.split("\n").map(Number).filter(n => n > 0);
}

/** pid -> port for those of `pids` that listen on a TCP port; undefined when lsof failed or timed out. */
async function listening(pids: readonly number[]): Promise<Map<number, string> | undefined> {
	const ports = new Map<number, string>();
	if (!pids.length) return ports;
	const text = await probe(["/usr/sbin/lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fpn", "-p", pids.join(",")]);
	if (text === undefined) return undefined;
	let pid = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid && !ports.has(pid)) ports.set(pid, line.slice(line.lastIndexOf(":") + 1));
	}
	return ports;
}

/** "bun :3000, node +2": the first few useful processes by name, for the one line the owner may read. */
async function describe(useful: readonly number[], ports: ReadonlyMap<number, string>): Promise<string> {
	const some = useful.slice(0, NAMED);
	const names = new Map<number, string>();
	for (const line of ((await probe(["ps", "-o", "pid=,comm=", "-p", some.join(",")])) ?? "").split("\n")) {
		const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		if (m) names.set(Number(m[1]), m[2]!.split("/").pop()!);
	}
	const text = some.map(pid => `${names.get(pid) ?? `pid ${pid}`}${ports.has(pid) ? ` :${ports.get(pid)}` : ""}`).join(", ");
	return useful.length > NAMED ? `${text} +${useful.length - NAMED}` : text;
}

/**
 * Of the processes an agent leaves at a park (`victims`, already proven to be the recorded ones): the useful ones, the processes
 * between them and the agent (a wrapper passes its end on to them) and what they started. `what` names the useful ones.
 */
export async function pickKept<T extends Proc>(victims: readonly T[], kids: readonly Kid[], now: number): Promise<{ keep: T[]; what: string }> {
	const busy = new Set(kids.filter(k => k.busyAt !== undefined && now - k.busyAt <= RECENT_BUSY_MS).map(k => k.pid));
	const ports = await listening(victims.filter(v => !busy.has(v.pid)).map(v => v.pid));
	const useful = ports ? victims.filter(v => busy.has(v.pid) || ports.has(v.pid)).map(v => v.pid) : victims.map(v => v.pid);
	if (!useful.length) return { keep: [], what: "" };
	const byPid = new Map(victims.map(v => [v.pid, v]));
	const keep = new Set<number>(useful);
	for (const pid of useful) for (let p = byPid.get(byPid.get(pid)!.ppid); p && !keep.has(p.pid); p = byPid.get(p.ppid)) keep.add(p.pid);
	for (let grown = true; grown; ) {
		grown = false;
		for (const v of victims) if (!keep.has(v.pid) && keep.has(v.ppid)) grown = !!keep.add(v.pid);
	}
	const order = [...keep].slice(0, MAX_KEPT);
	return { keep: order.map(pid => byPid.get(pid)!), what: ports ? await describe(useful, ports) : "" };
}
