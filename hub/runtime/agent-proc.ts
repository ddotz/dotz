// How the gateway starts and ends an agent process (omp, omo, claude and the warm model runner).
//  - nice 10: `/usr/bin/nice -n 10` is an argv prefix that execs the agent, so the pid stays the agent's and every child (task
//    workers, shells, test runs, WebView hosts) inherits the lower priority; a loaded machine then still answers the gateway.
//  - own process group: the agent is a session leader, so its pid is the id of a group that holds all it started. When the agent
//    ends (its own exit, a crash, a kill) the rest of that group is ended too; a daemon that put itself in another session
//    (OmO's host, hub/runtime/omo-hosts.ts) is not in the group and is closed the way it is today.
//  - what the agent's shell tool started sits in other sessions: hub/agent-tree.ts records those while the agent lives and ends them
//    when it exits, by whatever path (a kill, a crash, its own exit).
//  - a write to a stdin whose process is gone never takes the gateway down (writeQuietly, also exported by omp.ts).
import type { Subprocess } from "bun";
import { agentEnded, trackAgent } from "../agent-tree.ts";

export const NICE = ["/usr/bin/nice", "-n", "10"];
const GROUP_KILL_GRACE_MS = 2000;
// Agents whose group may still hold processes; an exit of the gateway takes those with it (launchd did this for the whole job).
const live = new Set<number>();

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		// no such group: nothing is left in it
		return false;
	}
}

// Ends what the agent left behind: a polite signal, then a kill for what ignores it.
function endGroup(pid: number): void {
	live.delete(pid);
	if (!signalGroup(pid, "SIGTERM")) return;
	setTimeout(() => signalGroup(pid, "SIGKILL"), GROUP_KILL_GRACE_MS).unref();
}

process.on("exit", () => {
	for (const pid of live) signalGroup(pid, "SIGKILL");
});

/** Bun.spawn for an agent: nice 10, its own process group, and the group ended when the agent is. */
export function spawnAgent<const T extends "pipe" | "ignore" = "pipe">(argv: string[], o: { cwd?: string; env?: Record<string, string | undefined>; stderr?: T }): Subprocess<"pipe", "pipe", T> {
	const proc = Bun.spawn([...NICE, ...argv], { cwd: o.cwd, env: o.env, stdin: "pipe", stdout: "pipe", stderr: o.stderr ?? "pipe", detached: true });
	// A stand-in process of a test has no exit state and no group of its own: its made-up pid must never be signalled.
	if ("exitCode" in proc) {
		live.add(proc.pid);
		trackAgent(proc.pid);
		void proc.exited.then(() => {
			endGroup(proc.pid);
			void agentEnded(proc.pid);
		});
	}
	return proc as Subprocess<"pipe", "pipe", T>;
}

// A worker whose stdin is closed answers a write with EPIPE: thrown for a small frame, a rejected promise for a large one.
// Either one escaping would take the whole gateway down; the hub learns of the dead worker from `exited` instead.
const gone = (): void => {
	// the process is gone; `exited` tells the hub
};
export function writeQuietly(stdin: Pick<Subprocess<"pipe", "pipe", "pipe">["stdin"], "write" | "flush">, text: string): void {
	try {
		const written = stdin.write(text);
		if (written instanceof Promise) written.catch(gone);
		const flushed = stdin.flush();
		if (flushed instanceof Promise) flushed.catch(gone);
	} catch {
		// the same EPIPE, thrown synchronously
	}
}

/** Ends the agent: a plain stop signals the agent (its own shutdown runs, then the group goes); force kills the whole group at once. */
export function killAgent(proc: Subprocess<any, any, any>, force?: boolean): void {
	if (!force) return void proc.kill();
	if (proc.exitCode === null && live.has(proc.pid) && signalGroup(proc.pid, "SIGKILL")) return;
	proc.kill(9);
}
