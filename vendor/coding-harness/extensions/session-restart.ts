import { execFileSync } from "node:child_process";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent";
import { pendingLater } from "../harness/gate/later.ts";
import { createSessionRestart, markRelaunch, restartDir } from "../harness/restart/restart.ts";
import type { RestartApi, SessionRestart } from "../harness/restart/restart.ts";

function startedAt(pid: number): string | undefined {
	try {
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Lets an interactive main session restart itself through omp's own composer: when the agent calls `session_restart`, and after a harness deploy. */
export default function registerSessionRestart(pi: RestartApi): SessionRestart {
	const started = startedAt(process.pid);
	const relaunched = started === undefined ? undefined : markRelaunch(restartDir(), process.pid, started, process.argv);
	return createSessionRestart(pi, async () => CustomEditor, pendingLater, () => relaunched);
}
