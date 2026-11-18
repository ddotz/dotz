// While a gateway restart waits (hub/restart.ts markRestartPending), the orchestrator and every lane start no new task worker and
// launch no session: the workers already running finish, the count reaches 0 and the restart goes. Running work is never cut.
// 2026-11-10: a lane kept starting a worker as the last one ended, and an update with security fixes waited over 75 minutes.
// why(platform): omp spawns through eval agent() and workpool() without a task tool call, and only before_subagent_spawn sees those; OmO has no such event (omp@18.22.0 docs/extensions.md)
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { WorkerRunning } from "./guard.ts";
import { dirname, join } from "node:path";

// The names hub/restart.ts writes and reads; extension/restart-hold.test.ts writes the marker with the hub's own code, so they cannot drift.
const RESTART_PENDING_FILE = "restart-pending.json";
const AGENT_PATH = /^agent:\/\/([^/?#]+)/;
const RESTART_HELD_FILE = "restart-held";

export const RESTART_HOLD_LANE = "게이트웨이 재시작 대기 중: 새 task 워커는 띄우지 않아요. 지금 도는 워커가 끝나면 재시작돼요. 지금 상태와 남은 일을 짧게 보고하고(report.md에 남아요) 멈추세요. 재시작 뒤 이어서 하라는 메시지가 와요.";
export const RESTART_HOLD_MAIN = "게이트웨이 재시작 대기 중: 새 task 워커와 세션은 띄우지 않아요. 지금 도는 워커가 끝나면 재시작돼요. 남은 일을 state.json open_tasks에 적고 멈추세요. 재시작 뒤 이어서 해요.";

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Only a live hub's marker holds: one a crashed hub left behind does not (and the next hub removes it when it starts).
export function restartPending(data: string): boolean {
	try {
		const { pid } = JSON.parse(readFileSync(join(data, RESTART_PENDING_FILE), "utf8"));
		return typeof pid === "number" && alive(pid);
	} catch {
		return false;
	}
}

const RUNNING = new Set(["running", "queued", "pending"]);
// Whether the child a task_send names still runs, read from OmO's task store (<agent dir>/projects/*/senpi-task/tasks, hub/bgwork.ts);
// undefined when it is not found there.
function childRunning(sessionFile: string | undefined, to: string): boolean | undefined {
	const root = /_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(sessionFile ?? "")?.[1];
	if (!root || !to) return undefined;
	const projects = join(dirname(dirname(dirname(sessionFile!))), "projects");
	if (!existsSync(projects)) return undefined;
	for (const project of readdirSync(projects)) {
		const tasks = join(projects, project, "senpi-task", "tasks");
		if (!existsSync(tasks)) continue;
		for (const file of readdirSync(tasks).filter(n => n.endsWith(".json"))) {
			try {
				const rec = JSON.parse(readFileSync(join(tasks, file), "utf8"));
				if (rec.root_session_id === root && (rec.task_id === to || rec.name === to)) return RUNNING.has(rec.status);
			} catch {
				continue; // a record OmO is rewriting right now: the others still answer
			}
		}
	}
	return undefined;
}

// A task_send starts work when it re-dispatches a child or sends text to one that no longer runs (OmO resumes it: a new run). Steering
// a running child and the structured shutdown messages start nothing; a child not found is left to OmO to refuse.
const sendStarts = (input: any, ctx: any): boolean =>
	input?.redispatch === true || (typeof input?.message === "string" && childRunning(ctx?.sessionManager?.getSessionFile?.(), String(input?.to ?? "")) === false);

const markHeld = (held: string): void => {
	if (!existsSync(dirname(held))) return;
	writeFileSync(`${held}.tmp`, `${new Date().toISOString()}\n`);
	renameSync(`${held}.tmp`, held);
};

// A refusal leaves restart-held so the next gateway start tells the refused one to go on: a lane's in <data>/lanes/<lane>/ (hub/laneops.ts),
// the orchestrator's and a conversation session's in <data>/ (hub/main.ts wakes the orchestrator once). 2026-11-18: the main session was
// told "재시작 뒤 이어서 해요", nothing woke it after the restart, and a launch the owner chose waited until his next message.
export function holdOnRestart(pi: any, data: string, lane?: string, running: WorkerRunning = () => false): void {
	const hold = () => {
		if (!restartPending(data)) return undefined;
		markHeld(lane ? join(data, "lanes", lane, RESTART_HELD_FILE) : join(data, RESTART_HELD_FILE));
		return { block: true, reason: lane ? RESTART_HOLD_LANE : RESTART_HOLD_MAIN };
	};
	pi.on("before_subagent_spawn", hold);
	pi.on("tool_call", (event: any, ctx: any) => {
		const tool = event?.toolName;
		const target = tool === "write" ? AGENT_PATH.exec(String(event?.input?.path ?? ""))?.[1] : undefined;
		const revives = target !== undefined && target !== "all" && restartPending(data) && !running(ctx, target);
		const starts = tool === "task" || revives || (tool === "task_send" && restartPending(data) && sendStarts(event?.input, ctx));
		return starts ? hold() : undefined;
	});
}

export function restartHeld(action: string, data: string): string | undefined {
	if (action !== "launch" || !restartPending(data)) return undefined;
	markHeld(join(data, RESTART_HELD_FILE));
	return RESTART_HOLD_MAIN;
}
