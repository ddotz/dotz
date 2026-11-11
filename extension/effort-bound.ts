// Results are read at the effort their work was spawned at (owner 2026-11-09). The orchestrator records its thinking level
// with each piece of background work it starts: a task worker (OmO `task`, a [later] request's worker included) and a lane
// (dotz_lane launch/send/handover). A turn that a result starts (OmO's "task completion" wake, a lane's report from the
// gateway inbox) runs at the recorded level, and the level goes back at the end of that turn, so the owner's next message and
// work spawned after a switch use the current setting. Several results in one turn run at the highest of their levels;
// a recorded level equal to the current one makes no switch at all. A result that arrives while a turn runs joins that turn.
//
// Cost: on Opus/Sonnet 5.5 OmO sends an effort change as a configuration message appended to the session (agent-session
// _setThinkingLevel, supportsConfigurationUpdate), so the cached prefix stays. Measured on the gateway orchestrator's own
// sessions, 2026-11-02..09: 9 of 9 in-place effort switches at 132-249K context read the whole prefix from cache and wrote
// 0.5-3.2K (e.g. medium -> xhigh at 243,668 read: next turn 244,424 read, 1,789 written). The one rewrite in the log (39K
// read, 95K written) came with a process restart, not the switch. A per-result switch costs two such small writes.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Book = { tasks: Record<string, string>; lanes: Record<string, string> };
const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LANES_KEPT = 100;
// OmO's wake after a worker ended: one "task completion name:<n> id:st_x ..." per worker (hub/runtime/omp.ts finishedWorkers).
const TASK_DONE = /task completion name:\S+ id:(st_[0-9a-z]+)/g;
const TASK_ID = /\bst_[0-9a-z]{6,}\b/g;
const LANE_WORK = new Set(["launch", "send", "handover"]);
// The gateway's lane report lead (hub/intake.ts inboxBody: inboxLaneReport in hub/i18n-en.ts and hub/i18n-ko.ts), kept
// here as text because the extension stays off hub imports (engineering rule 4); effort-bound.test.ts checks both leads.
const LANE_REPORT = [/session report from (\S+?):/g, /세션 (\S+?)의 보고:/g];

const textOf = (content: unknown): string =>
	Array.isArray(content) ? content.map(b => (typeof b?.text === "string" ? b.text : "")).join("\n") : typeof content === "string" ? content : "";

export function installEffortBound(pi: any, file: string): void {
	const load = (): Book => {
		try {
			const b = JSON.parse(readFileSync(file, "utf8"));
			return { tasks: b.tasks ?? {}, lanes: b.lanes ?? {} };
		} catch {
			return { tasks: {}, lanes: {} };
		}
	};
	const store = (b: Book) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(`${file}.tmp`, JSON.stringify(b));
		renameSync(`${file}.tmp`, file);
	};
	// While a result turn runs at its recorded level: the level to go back to, and the level set for the turn.
	let back: string | undefined, set: string | undefined;

	pi.on("tool_result", (event: any) => {
		if (event.isError) return;
		const level = String(pi.getThinkingLevel?.() ?? "");
		if (!level) return;
		const said = textOf(event.content);
		if (event.toolName === "task") {
			const ids = [...new Set(said.match(TASK_ID) ?? [])];
			if (!ids.length) return;
			const b = load();
			for (const id of ids) b.tasks[id] = level;
			store(b);
		} else if (event.toolName === "dotz_lane" && LANE_WORK.has(String(event.input?.action))) {
			let out: any;
			try {
				out = JSON.parse(said);
			} catch {
				return;
			}
			const name = out?.lane ?? event.input?.name;
			if (out?.error || typeof name !== "string" || !name) return;
			const b = load();
			delete b.lanes[name];
			b.lanes[name] = level;
			const names = Object.keys(b.lanes);
			for (const old of names.slice(0, Math.max(0, names.length - LANES_KEPT))) delete b.lanes[old];
			store(b);
		}
	});

	pi.on("before_agent_start", (event: any) => {
		if (event.preview || back !== undefined) return;
		const prompt = String(event.prompt ?? "");
		const ids = [...prompt.matchAll(TASK_DONE)].map(m => m[1]!);
		const lanes = LANE_REPORT.flatMap(re => [...prompt.matchAll(re)].map(m => m[1]!));
		if (!ids.length && !lanes.length) return;
		const b = load();
		const levels = [...ids.map(id => b.tasks[id]), ...lanes.map(l => b.lanes[l])].filter((l): l is string => Boolean(l));
		if (ids.some(id => id in b.tasks)) {
			for (const id of ids) delete b.tasks[id];
			store(b);
		}
		if (!levels.length) return;
		const target = levels.reduce((a, l) => (ORDER.indexOf(l) > ORDER.indexOf(a) ? l : a));
		const current = String(pi.getThinkingLevel?.() ?? "");
		if (target === current) return;
		back = current;
		set = target;
		pi.setThinkingLevel(target);
	});

	// A level chosen from outside during the result turn (the owner's switch, applied by the gateway) is the one to go back to.
	pi.on("thinking_level_select", (event: any) => {
		if (back !== undefined && event.level !== set) back = event.level;
	});

	pi.on("agent_end", (event: any) => {
		if (back === undefined || event?.willRetry) return;
		const to = back;
		back = set = undefined;
		pi.setThinkingLevel(to);
	});
}
