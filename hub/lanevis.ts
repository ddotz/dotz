// What runs right now, read from the hub's own state (no model call): a lane's running task workers for `dotz_lane list`
// and the one-line header at the head of every owner prompt.
import { subagentLists } from "./activity.ts";
import { msg } from "./i18n.ts";

const KST_MS = 9 * 3600e3;
const clip = (s: string | undefined, n: number): string => {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// "HH:MM" in KST (the owner's clock), from an epoch ms or an ISO string.
export const kstClock = (at: number | string): string => new Date((typeof at === "string" ? Date.parse(at) : at) + KST_MS).toISOString().slice(11, 16);

export type WorkerView = { name: string; description: string; started_at: string; started_kst: string; last_intent: string; updated_at: string };

// The running task workers of one agent process (source = "orchestrator" or "lane:<name>"). The name is the worker's agent
// type when it has a specific one (scout), else its task id: the generic "task" agent would make every worker look alike.
export function workersOf(source: string): WorkerView[] {
	return (subagentLists()[source] ?? [])
		.filter(s => s.status === "running")
		.map(s => ({
			name: s.agent && s.agent !== "task" ? s.agent : s.id,
			description: clip(s.description, 80),
			started_at: new Date(s.started_at).toISOString(),
			started_kst: kstClock(s.started_at),
			last_intent: clip(s.intent, 80),
			updated_at: new Date(s.updated_at).toISOString(),
		}));
}

export type RunningLane = { name: string; status: string; workers: string[] };
export const HEADER_MAX = 200;
const NAME_MAX = 24;

// One line for the head of an owner prompt: lanes working or with running workers, plus the orchestrator's own workers.
// Empty when nothing runs, so an idle gateway adds no tokens. Longer than `max`, it loses the worker names first, then the
// lane names, so it never has to cut mid-word.
export function formatHeader(lanes: RunningLane[], orchWorkers: string[], max = HEADER_MAX): string {
	const t = msg();
	const busy = lanes.filter(l => l.status === "working" || l.status === "starting" || l.workers.length > 0);
	if (!busy.length && !orchWorkers.length) return "";
	const names = (list: string[]) => list.map(n => clip(n, NAME_MAX)).join(",");
	const laneBody = (withNames: boolean) => busy.map(l => (l.workers.length ? `${l.name}: ${t.nowWorkers(l.workers.length, withNames ? names(l.workers) : "")}` : `${l.name}: ${t.nowLaneBusy}`));
	const build = (lanePart: string[], orchPart: string): string => {
		const parts = [lanePart.length ? t.nowLanes(busy.length, lanePart.join("; ")) : "", orchPart].filter(Boolean);
		return `${t.nowRunning} ${parts.join(" · ")}`;
	};
	const orch = (withNames: boolean) => (orchWorkers.length ? t.nowOrchestrator(orchWorkers.length, withNames ? names(orchWorkers) : "") : "");
	for (const withNames of [true, false]) {
		const line = build(laneBody(withNames), orch(withNames));
		if (line.length <= max) return line;
	}
	// Counts only: the lane count is what a huge fleet can still say in a few characters.
	const workers = busy.reduce((n, l) => n + l.workers.length, 0);
	const counted = build(busy.length ? [t.nowWorkers(workers, "")] : [], orch(false));
	return counted.length <= max ? counted : counted.slice(0, max - 1) + "…";
}
