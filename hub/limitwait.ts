// Work deferred by the budget gate or the usage limit (owner 2026-11-02): its state.json open_tasks item carries
// waiting_for "limit-reset" and resume_at (ISO), and the web 지금 진행 중 list, the worklog line (update_key lane:<name>) and
// state.json show the badge "한도 리셋되면 재개 (HH:MM)" drawn from those fields. When the work starts, all three lose it.
import { existsSync, readFileSync } from "node:fs";
import { TZ, writeAtomic } from "./config.ts";

export const LIMIT_RESET = "limit-reset";
type Task = Record<string, unknown>;

// The older way put the time into the text itself; it is dropped so the badge never shows twice.
const LEGACY = /^\s*\[한도 리셋 뒤 재개 \d{1,2}:\d{2}\]\s*/;
export const stripLegacy = (what: string): string => what.replace(LEGACY, "");

export function limitBadge(resumeAt: unknown, tz = TZ): string {
	const d = new Date(typeof resumeAt === "string" || typeof resumeAt === "number" ? resumeAt : Number.NaN);
	if (Number.isNaN(d.getTime())) return "한도 리셋되면 재개";
	const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
	return `한도 리셋되면 재개 (${hm})`;
}

export const isLimitWait = (t: Task): boolean => t.waiting_for === LIMIT_RESET;
const matches = (t: Task, lane: string) => t.lane === lane || t.session === lane || t.id === lane;
const tasksOf = (state: Task): Task[] => (Array.isArray(state.open_tasks) ? (state.open_tasks as unknown[]).filter((t): t is Task => !!t && typeof t === "object") : []);
const readState = (file: string): Task => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Task) : {});
const writeState = (file: string, state: Task) => writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);

export function withoutLimitWait(t: Task): Task {
	const { waiting_for: _w, resume_at: _r, ...rest } = t;
	return typeof rest.what === "string" ? { ...rest, what: stripLegacy(rest.what) } : rest;
}

// The budget gate refused lane `lane`: its open_tasks item (by lane / session / id; a minimal one when none) waits for the reset.
export function markLimitWait(file: string, lane: string, title: string, resumeAt: string, now = Date.now()): Task {
	const state = readState(file);
	const tasks = tasksOf(state);
	let hit = tasks.find(t => matches(t, lane));
	if (!hit) {
		hit = { id: lane, what: title || lane, lane, since: new Date(now).toISOString() };
		tasks.push(hit);
	}
	Object.assign(hit, withoutLimitWait(hit), { waiting_for: LIMIT_RESET, resume_at: resumeAt });
	writeState(file, { ...state, open_tasks: tasks });
	return hit;
}

// Lane `lane` started: its items lose the wait fields. True when one had them (the file is rewritten only then).
export function clearLimitWait(file: string, lane: string): boolean {
	const state = readState(file);
	let changed = false;
	const tasks = tasksOf(state).map(t => {
		if (!matches(t, lane) || (!isLimitWait(t) && !("resume_at" in t))) return t;
		changed = true;
		return withoutLimitWait(t);
	});
	if (changed) writeState(file, { ...state, open_tasks: tasks });
	return changed;
}

export function limitWaits(file: string): { id: string; what: string; lane?: string; next?: string; resume_at?: string; since?: string }[] {
	try {
		return tasksOf(readState(file)).filter(isLimitWait).map(t => ({
			id: String(t.id ?? t.lane ?? ""), what: stripLegacy(String(t.what ?? t.id ?? "")),
			...(typeof t.lane === "string" ? { lane: t.lane } : {}), ...(typeof t.next === "string" ? { next: t.next } : {}), ...(typeof t.resume_at === "string" ? { resume_at: t.resume_at } : {}), ...(typeof t.since === "string" ? { since: t.since } : {}),
		}));
	} catch {
		return [];
	}
}

type Post = (target: string, key: string, text: string) => Promise<unknown>;
type Log = (line: string) => void;

// Refusal by the budget gate: state.json item + the lane's worklog line carry the badge.
export function deferForLimit(file: string, lane: string, title: string, resumeAt: string, post: Post, log: Log, now = Date.now()): void {
	try {
		markLimitWait(file, lane, title, resumeAt, now);
	} catch (e) {
		log(`lane ${lane}: limit-reset wait not recorded in state.json: ${(e as Error).message}`);
	}
	void post("worklog", `lane:${lane}`, `[run] ${title || lane}: ${limitBadge(resumeAt)}`).catch(e => log(`lane ${lane}: limit-reset worklog post failed: ${e}`));
}

// The lane started: the badge goes from state.json and its worklog line (edited in place) when it had one.
export function limitWaitStarted(file: string, lane: string, title: string, post: Post, log: Log): boolean {
	let cleared = false;
	try {
		cleared = clearLimitWait(file, lane);
	} catch (e) {
		log(`lane ${lane}: limit-reset wait not cleared in state.json: ${(e as Error).message}`);
	}
	if (cleared) void post("worklog", `lane:${lane}`, `[run] ${title || lane}: 시작했어요`).catch(e => log(`lane ${lane}: worklog start post failed: ${e}`));
	return cleared;
}
