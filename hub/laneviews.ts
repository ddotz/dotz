import { parseSelector } from "./config.ts";
import { keyedSelector } from "./fallback.ts";
import { laneLive, laneWorkerModel, lanes } from "./lanestate.ts";
import { ctxView } from "./context.ts";
import { workersOf, kstClock, formatHeader } from "./lanevis.ts";

export function liveLanes(): { live: string[]; ended: string[] } {
	const all = [...lanes.values()];
	return { live: all.filter(laneLive).map(l => l.name), ended: all.filter(l => !laneLive(l)).map(l => l.name) };
}

export const laneModels = () => [...lanes.values()].map(l => ({ name: l.name, ...parseSelector(l.model), status: l.status, live: laneLive(l), running: Boolean(l.proc), worker_model: laneWorkerModel(l), worker_model_override: l.workerModel, ...(l.proc ? { active_model: l.activeModel, active_worker_model: l.activeWorkerModel } : {}) }));

export function laneSummary(): Array<Record<string, unknown>> {
	return [...lanes.values()].map(l => ({
		name: l.name,
		...(l.title ? { title: l.title } : {}),
		cwd: l.cwd,
		// the checkout a worktree lane works for (its cwd is ~/.dotz/lanes/<name>/worktree)
		...(l.worktree ? { repo: l.worktree.repo } : {}),
		model: l.model,
		// the process runs on an API-key fallback entry (the chat bar shows "api사용중")
		key_fallback: keyedSelector(l.activeModel),
		worker_model: laneWorkerModel(l),
		status: l.status,
		...(l.waiting ? { waiting: l.waiting } : {}),
		live: laneLive(l),
		startedAt: l.startedAt,
		reports: l.reports,
		claim: l.claim,
		pendingAsk: l.pendingAsk,
		sessionFile: l.sessionFile,
		resumable: !l.proc && Boolean(l.sessionFile),
		lastText: l.lastText.slice(0, 600),
		context: ctxView(l.ctx),
	}));
}

// The parent project of each session, from the gateway's channel map (docs/layers.md §1): a session started in a work channel
// has `home: "ch:<id>"` and `project`, the channel's name; one started from chat has neither (a top-level session).
// The gateway drops its mapping when the session stops or ends, so the lane record (home, homeName) is the fallback.
// The channel's current name wins; the stored name is used when the channel is gone.
export function withHomes(rows: Array<Record<string, unknown>>, ch: { homes?: Record<string, string>; work?: Record<string, string> }): Array<Record<string, unknown>> {
	return rows.map(r => {
		const rec = lanes.get(String(r.name));
		const id = ch.homes?.[String(r.name)] ?? rec?.home;
		return id ? { ...r, home: `ch:${id}`, project: ch.work?.[id] ?? rec?.homeName ?? "" } : r;
	});
}

// The `dotz_lane list` view: the lane summary plus what each lane is doing right now (running task workers with their last
// tool intent, from the hub's own state) and when its last report went out. The new keys come first because the tool
// output is cut at a fixed length, and a long lastText must not push the workers out of it.
export function laneList(): Array<Record<string, unknown>> {
	return laneSummary().map(s => {
		const lane = lanes.get(String(s.name))!;
		return { name: s.name, status: s.status, workers: workersOf(`lane:${lane.name}`), last_report_at: lane.lastReportAt ?? null, last_report_kst: lane.lastReportAt ? kstClock(lane.lastReportAt) : null, ...s };
	});
}

// The leading line of an owner prompt (see formatHeader); empty when nothing runs.
export const turnHeader = (): string => formatHeader([...lanes.values()].map(l => ({ name: l.name, status: l.status, workers: workersOf(`lane:${l.name}`).map(w => w.name) })), workersOf("orchestrator").map(w => w.name));
