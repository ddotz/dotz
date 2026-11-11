// Which of the processes a parked agent leaves behind are still useful. hub/agent-tree.ts keeps the record and the end points.
// A routine idle park (lane or conversation session) ends the agent's process, not what it started for the owner. Two questions:
//  - Did the owner's shell tool start it? Not the runtime's own helpers (task-worker hosts `--mode rpc`, eval kernels under
//    .omo/agent/runtime, the `claude --output-format stream-json` helper): they listen on TCP too, and every resume starts new ones.
//    Measured: omp runs a command as a direct child of the agent (own embedded shell, no shell process); OmO and claude run it under
//    `bash -c` / `zsh -c`, a child of the agent or of a task-worker host. So walking up from the process, a shell reached before
//    a runtime helper (or no runtime helper up to the agent) means the owner's. One async `ps` of the candidates at the park, never per tick.
//  - Is it useful? It used CPU recently (the CPU time in the shared 30 s `ps` listing grew between two listings, no extra call), or it
//    listens on a TCP port (one async `lsof` at the park, with its own short limit).
// If the `ps` fails nothing is kept (the runtime's helpers cannot be told apart). If `lsof` fails or is slow, every process of the
// owner's is kept: the long idle bound ends what nobody uses.
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

/** pid -> command line of those of `pids`; undefined when ps failed. */
async function commands(pids: readonly number[]): Promise<Map<number, string> | undefined> {
	const text = await probe(["ps", "-ww", "-o", "pid=,args=", "-p", pids.join(",")]);
	if (text === undefined) return undefined;
	const out = new Map<number, string>();
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		if (m) out.set(Number(m[1]), m[2]!);
	}
	return out;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** The runtime's own helpers: task-worker hosts, eval kernels and the claude stream helper. */
const RUNTIME = /--mode[ =]rpc\b|--output-format[ =]stream-json|\/@code-yeongyu\/|\/\.omo\/agent\/runtime\//;
const program = (args: string): string => /^(.*?\.app\/Contents\/\S+|\S+)/.exec(args)?.[1] ?? "";
const isShell = (args: string): boolean => SHELLS.has(program(args).split("/").pop()!.replace(/^-/, ""));
const MAX_DEPTH = 64;

/** The owner's shell tool started `pid`: walking up, a shell comes before any runtime helper, or there is no helper up to the agent. */
function fromShellTool(pid: number, byPid: ReadonlyMap<number, Proc>, args: ReadonlyMap<number, string>): boolean {
	for (let p = byPid.get(pid), n = 0; p && n < MAX_DEPTH; p = byPid.get(p.ppid), n++) {
		const a = args.get(p.pid) ?? "";
		if (isShell(a)) return true;
		if (RUNTIME.test(a)) return false;
	}
	return true;
}

/** "bun :3000, node +2": the first few useful processes by name, for the one line the owner may read. */
function describe(useful: readonly number[], ports: ReadonlyMap<number, string>, args: ReadonlyMap<number, string>): string {
	const text = useful.slice(0, NAMED).map(pid => `${program(args.get(pid) ?? "").split("/").pop() || `pid ${pid}`}${ports.has(pid) ? ` :${ports.get(pid)}` : ""}`).join(", ");
	return useful.length > NAMED ? `${text} +${useful.length - NAMED}` : text;
}

/**
 * Of the processes an agent leaves at a park (`victims`, already proven to be the recorded ones): the useful ones the owner's shell
 * tool started, the processes between them and their shell (a wrapper passes its end on to them) and what they started.
 * `what` names the useful ones.
 */
export async function pickKept<T extends Proc>(victims: readonly T[], kids: readonly Kid[], now: number): Promise<{ keep: T[]; what: string }> {
	const args = victims.length ? await commands(victims.map(v => v.pid)) : undefined;
	if (!args) return { keep: [], what: "" };
	const byPid = new Map(victims.map(v => [v.pid, v]));
	const mine = victims.filter(v => fromShellTool(v.pid, byPid, args));
	const busy = new Set(kids.filter(k => k.busyAt !== undefined && now - k.busyAt <= RECENT_BUSY_MS).map(k => k.pid));
	const ports = await listening(mine.filter(v => !busy.has(v.pid)).map(v => v.pid));
	const useful = (ports ? mine.filter(v => busy.has(v.pid) || ports.has(v.pid)) : mine).map(v => v.pid);
	if (!useful.length) return { keep: [], what: "" };
	const keep = new Set<number>(useful);
	for (const pid of useful) {
		for (let p = byPid.get(byPid.get(pid)!.ppid); p && !keep.has(p.pid); p = byPid.get(p.ppid)) {
			keep.add(p.pid);
			if (isShell(args.get(p.pid) ?? "")) break;
		}
	}
	for (let grown = true; grown; ) {
		grown = false;
		for (const v of victims) if (!keep.has(v.pid) && keep.has(v.ppid)) grown = !!keep.add(v.pid);
	}
	const order = [...keep].slice(0, MAX_KEPT);
	return { keep: order.map(pid => byPid.get(pid)!), what: ports ? describe(useful, ports, args) : "" };
}
