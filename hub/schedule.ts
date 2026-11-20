import { randomBytes } from "node:crypto";
import { log, paths, readJsonOrQuarantine, writeAtomic } from "./config.ts";
import { msg } from "./i18n.ts";
import { convTargetOf } from "./session-key.ts";
import { everyMinutes } from "./watch.ts";
import { scheduleLabel } from "./watchtext.ts";

export const MIN_EVERY_MINUTES = 5; // shortest repeat a schedule takes

/** "owner": a reminder, the text is words to pass on to the owner at that time (delivered and notified); "task": work the owner gave the assistant
 *  (an instruction it carries out at that time); "check": the assistant's own system check or follow-up (quiet). No kind, or a kind this version
 *  does not know (a file written by a newer one), reads as "owner" (scheduleKind). */
export type ScheduleKind = "owner" | "task" | "check";
export const SCHEDULE_KINDS: readonly ScheduleKind[] = ["owner", "task", "check"];
/** The longest schedule name; a longer one is cut. */
export const NAME_MAX = 40;
/** `name`: the short title the owner reads (the assistant writes it, the owner edits it); entries stored before names existed have none until the one-time naming. */
export type Schedule = { id: string; name?: string; text: string; at: string; every_minutes?: number; created: string; paused?: boolean; last?: string; /** The conversation (ch:/th:/mail:/settings: target) whose session it fires into; none = main, as for items stored before this field. */ conv?: string; kind?: ScheduleKind };
/** What became of one fire: "fired" when the timer went off and the turn was queued; the later states are set by whoever learns the turn's outcome. */
export type ScheduleRunState = "fired" | "answered" | "silent" | "held" | "failed";
/** One fire of a schedule, kept for RUN_KEEP_MS in schedule-runs.json even after a one-shot or check entry is gone; `run` is the id the inbox event carries. */
export type ScheduleRun = { run: string; scheduleId: string; name: string; kind: ScheduleKind; text: string; firedAt: string; state: ScheduleRunState };
/** The one-time naming of entries stored before names and the task kind (routine entries excepted: hub/custom.ts names those). "asked": a hard sign
 *  (hardTask) already made those of no kind or "owner" a task, and the assistant names and judges each id in one quiet turn (dotz_schedule edit);
 *  `hard` are the ids a rule made a task. "done" for good: what it left unnamed after NAMING_WAIT_MS got a name from its text and stayed as it was. */
export type ScheduleNamingState = { state: "asked" | "done"; at: string; ids: string[]; hard: string[] };
/** What the one-time naming needs from the running gateway: a quiet wake of the assistant and the one owner-visible line. */
export type ScheduleNaming = { wake: (text: string) => void; post: (line: string) => void };

export const GRID_MS = 30 * 60_000; // check items fire on a :00 / :30 grid, so those of one conversation due together become one turn
const SLOT_TOL_MS = 1000; // a timer can fire a few ms before its slot
export const RUN_KEEP_MS = 7 * 24 * 3600_000;
export const RUN_CAP = 500;
/** How long the one-time naming waits for the assistant before the unnamed entries get a name from their text and stay reminders. */
export const NAMING_WAIT_MS = 30 * 60_000;
const kindOf = (value: unknown): ScheduleKind => {
	if (!SCHEDULE_KINDS.includes(value as ScheduleKind)) throw new Error(`kind must be ${SCHEDULE_KINDS.join(" or ")}`);
	return value as ScheduleKind;
};
/** The kind a stored entry acts as: its own when this version knows it, else "owner" (ringing is the safe side). */
export const scheduleKind = (s: { kind?: unknown }): ScheduleKind => (SCHEDULE_KINDS.includes(s.kind as ScheduleKind) ? (s.kind as ScheduleKind) : "owner");
const nameOf = (value: unknown): string => {
	const name = typeof value === "string" ? [...value.replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("").trim() : "";
	if (!name) throw new Error(`name must be a non-empty string (up to ${NAME_MAX} characters)`);
	return name;
};
const nameFromText = (s: { id: string; text: string }): string => nameOf(scheduleLabel(s.text) || `예약 ${s.id}`);

/** The next :00 or :30 of the hub's clock at or after `ms` (a time already on the grid stays). */
export function roundUpToGrid(ms: number): number {
	const off = new Date(ms).getTimezoneOffset() * 60_000;
	return Math.ceil((ms - off) / GRID_MS) * GRID_MS + off;
}

const HARD_TASK = [
	/`[^`\n]+`/,
	/(?:^|[\s("'])(?:~|\.{1,2})?\/[\w.@-]+\/[\w.@-]|\b[\w.-]+\/[\w./-]*\.\w{1,5}\b|\b[\w-]+\.(?:sh|py|ts|js|mjs|jsonl?|md|ya?ml|toml|log|csv)\b/,
	/(?:^|\s)(?:ch|lane):\S/,
	/보고해|올려|돌려|정리해|요약해|실행해|점검해|^\s*(?:report|post|run|summari[sz]e)\b/im,
];
/** Is this entry work for the assistant by a rule, with no judgement needed: a backtick command, a file path, a ch:/lane: target (in its text or
 *  its conversation) or an instruction verb? */
export const hardTask = (s: { text: string; conv?: string }): boolean => /^(?:ch|lane):/.test(s.conv ?? "") || HARD_TASK.some(re => re.test(s.text));
const stamp = () => new Date(Date.now()).toISOString();

const items: Schedule[] = readJsonOrQuarantine(paths.schedules, () => []);
let runs: ScheduleRun[] = readJsonOrQuarantine(paths.scheduleRuns, () => [], { keepGood: false });
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const save = () => writeAtomic(paths.schedules, `${JSON.stringify(items, null, 2)}\n`);
const keepRuns = () => {
	const since = Date.now() - RUN_KEEP_MS;
	runs = runs.filter(r => Date.parse(r.firedAt) >= since).slice(-RUN_CAP);
};
const saveRuns = () => writeAtomic(paths.scheduleRuns, `${JSON.stringify(runs, null, 1)}\n`);
let onFire: (s: Schedule, group: Schedule[] | undefined, runs: string[]) => void = () => {};
const MAX_DELAY = 2 ** 31 - 1;

function arm(s: Schedule): void {
	clearTimeout(timers.get(s.id));
	if (s.paused) return;
	const delay = Math.max(0, Date.parse(s.at) - Date.now());
	timers.set(s.id, setTimeout(() => (delay > MAX_DELAY ? arm(s) : fire(s)), Math.min(delay, MAX_DELAY)));
}

function settle(s: Schedule): void {
	clearTimeout(timers.get(s.id));
	timers.delete(s.id);
	s.last = new Date().toISOString();
	if (s.every_minutes) {
		// Always step past this slot: a timer can fire a few ms before s.at, and a plain while would re-arm the same slot and fire twice.
		let next = Date.parse(s.at) + s.every_minutes * 60_000;
		while (next <= Date.now()) next += s.every_minutes * 60_000;
		s.at = new Date(next).toISOString();
		arm(s);
	} else items.splice(items.indexOf(s), 1);
}

function recordRun(s: Schedule): string {
	const run = randomBytes(4).toString("hex");
	runs.push({ run, scheduleId: s.id, name: s.name ?? nameFromText(s), kind: scheduleKind(s), text: s.text, firedAt: stamp(), state: "fired" });
	return run;
}

/** The other check items of the same conversation due in the same slot as `s`. */
const slotMates = (s: Schedule): Schedule[] =>
	s.kind === "check" ? items.filter(x => x !== s && x.kind === "check" && !x.paused && (x.conv ?? "") === (s.conv ?? "") && Math.abs(Date.parse(x.at) - Date.parse(s.at)) < SLOT_TOL_MS) : [];
/** Ids of the other checks of `s`'s conversation due in its slot (the add result names them). */
export const checksSharingSlot = (s: Schedule): string[] => slotMates(s).map(x => x.id);

function fire(s: Schedule): void {
	// A check fires together with the checks of its conversation due in the same slot: one turn, one handler call with all of them.
	const group = s.kind === "check" ? [s, ...slotMates(s)] : undefined;
	const all = group ?? [s];
	const ids = all.map(recordRun);
	keepRuns();
	for (const x of all) settle(x);
	save();
	saveRuns();
	for (const x of all) log(`schedule ${x.id} fired`);
	onFire(s, group, ids);
}

/** Arms every entry; `handler` gets the fired entry, its check group, and the run ids (one per entry of `group ?? [s]`, in that order).
 *  `naming` starts (or resumes after a restart) the one-time naming of entries stored before names; without it (no orchestrator) the naming waits. */
export function startSchedules(handler: (s: Schedule, group: Schedule[] | undefined, runs: string[]) => void, naming?: ScheduleNaming): void {
	onFire = handler;
	for (const s of items) arm(s);
	if (naming) startNaming(naming);
}

// Shutdown: nothing fires again (the items stay saved in schedules.json).
export function stopSchedules(): void {
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
	clearTimeout(namingTimer);
}

/** Where a fired schedule is delivered: its conversation, else the gateway's default channel (main's session). */
export const scheduleTarget = (s: Schedule, fallback: string): string => s.conv ?? fallback;

// `conv` / `project`: the conversation it belongs to; `session`: the key of the session that creates it (a conversation session's schedule belongs to that conversation).
export function addSchedule(input: { name?: unknown; text?: string; at?: string; in_minutes?: number; every_minutes?: number; conv?: string; project?: string; session?: string; kind?: unknown }): Schedule {
	const text = String(input.text ?? "").trim();
	if (!text) throw new Error("text required");
	const at = input.at ? Date.parse(input.at) : Date.now() + Number(input.in_minutes ?? Number.NaN) * 60_000;
	if (!Number.isFinite(at)) throw new Error("give at (ISO time with offset, e.g. 2026-10-17T09:00:00+09:00) or in_minutes");
	if (input.every_minutes !== undefined && !(Number(input.every_minutes) >= MIN_EVERY_MINUTES)) throw new Error(`every_minutes must be at least ${MIN_EVERY_MINUTES}`);
	const conv = convTargetOf(input);
	const kind = input.kind === undefined ? undefined : kindOf(input.kind);
	const id = randomBytes(3).toString("hex");
	const name = input.name === undefined ? nameFromText({ id, text }) : nameOf(input.name);
	// A one-shot check is never earlier than asked: it waits for the next :00 or :30 so checks of one conversation share a turn.
	const when = kind === "check" && !input.every_minutes ? roundUpToGrid(at) : at;
	const s: Schedule = { id, name, text, at: new Date(when).toISOString(), ...(input.every_minutes ? { every_minutes: Number(input.every_minutes) } : {}), ...(conv ? { conv } : {}), ...(kind ? { kind } : {}), created: new Date().toISOString() };
	items.push(s);
	save();
	arm(s);
	return s;
}

// The owner's edit from the project page (PATCH /api/schedules/<id>): persisted and re-armed. `paused` keeps the entry but
// nothing fires; a recurring one resumes at its next slot after now, a one-shot whose time passed fires at once. `every_minutes: null` makes it one-shot.
export function patchSchedule(id: string, input: { name?: unknown; every_minutes?: unknown; at?: unknown; text?: unknown; paused?: unknown; kind?: unknown }): Schedule {
	const s = items.find(x => x.id === id);
	if (!s) throw new Error(`no schedule ${id}`);
	const name = input.name === undefined ? s.name : nameOf(input.name);
	const every = input.every_minutes === undefined ? s.every_minutes : input.every_minutes === null ? undefined : everyMinutes(input.every_minutes);
	const text = input.text === undefined ? s.text : typeof input.text === "string" ? input.text.trim() : "";
	if (!text) throw new Error("text must be a non-empty string");
	const at = input.at === undefined ? Date.parse(s.at) : typeof input.at === "string" ? Date.parse(input.at) : Number.NaN;
	if (!Number.isFinite(at)) throw new Error("at must be an ISO time with offset, e.g. 2026-10-17T09:00:00+09:00");
	if (input.paused !== undefined && typeof input.paused !== "boolean") throw new Error("paused must be true or false");
	const kind = input.kind === undefined ? s.kind : kindOf(input.kind);
	if (name) s.name = name;
	s.text = text;
	s.at = new Date(at).toISOString();
	if (kind) s.kind = kind;
	if (every) s.every_minutes = every;
	else delete s.every_minutes;
	if (input.paused !== undefined) {
		if (input.paused) s.paused = true;
		else delete s.paused;
	}
	if (!s.paused && s.every_minutes && input.at === undefined) {
		let next = Date.parse(s.at);
		while (next <= Date.now()) next += s.every_minutes * 60_000;
		s.at = new Date(next).toISOString();
	}
	save();
	arm(s);
	const asked = naming?.state.ids;
	if (asked && !items.some(x => !x.name && asked.includes(x.id))) finishNaming();
	return s;
}

export function removeSchedule(id: string): boolean {
	const i = items.findIndex(s => s.id === id);
	if (i < 0) return false;
	clearTimeout(timers.get(id));
	timers.delete(id);
	items.splice(i, 1);
	save();
	return true;
}

export const listSchedules = () => [...items];
/** The fires of the last RUN_KEEP_MS, oldest first (a one-shot's record outlives its entry). */
export const listScheduleRuns = (): ScheduleRun[] => {
	keepRuns();
	return [...runs];
};
/** Sets what became of one fire; undefined when the record is gone (older than RUN_KEEP_MS) or never existed. */
export function markScheduleRun(run: string, state: ScheduleRunState): ScheduleRun | undefined {
	const r = runs.find(x => x.run === run);
	if (!r) return undefined;
	r.state = state;
	keepRuns();
	saveRuns();
	return r;
}

let naming: { deps: ScheduleNaming; state: ScheduleNamingState } | undefined;
let namingTimer: ReturnType<typeof setTimeout> | undefined;
const saveNaming = (state: ScheduleNamingState) => writeAtomic(paths.scheduleNaming, `${JSON.stringify(state, null, 1)}\n`);

function startNaming(deps: ScheduleNaming): void {
	let state = readJsonOrQuarantine<ScheduleNamingState | undefined>(paths.scheduleNaming, () => undefined, { keepGood: false });
	if (state?.state === "done") return;
	if (!state) {
		const legacy = items.filter(s => !s.name && !s.text.startsWith("[routine:"));
		if (!legacy.length) return saveNaming({ state: "done", at: stamp(), ids: [], hard: [] });
		const hard = legacy.filter(s => (s.kind === undefined || s.kind === "owner") && hardTask(s));
		for (const s of hard) s.kind = "task";
		save();
		state = { state: "asked", at: stamp(), ids: legacy.map(s => s.id), hard: hard.map(s => s.id) };
		saveNaming(state);
		naming = { deps, state };
		try {
			deps.wake(msg().scheduleNaming(legacy.map(s => ({ id: s.id, text: s.text, ...(s.conv ? { conv: s.conv } : {}), ...(s.kind && s.kind !== "owner" ? { fixed: s.kind } : {}) }))));
		} catch (e) {
			log(`schedule naming wake failed: ${(e as Error).message}`);
			return finishNaming();
		}
	}
	naming = { deps, state };
	const ids = state.ids;
	if (!items.some(s => !s.name && ids.includes(s.id))) return finishNaming();
	namingTimer = setTimeout(finishNaming, Math.max(0, Date.parse(state.at) + NAMING_WAIT_MS - Date.now()));
}

function finishNaming(): void {
	if (!naming) return;
	const { deps, state } = naming;
	naming = undefined;
	clearTimeout(namingTimer);
	const named = state.ids.flatMap(id => items.filter(s => s.id === id));
	for (const s of named) {
		s.name ??= nameFromText(s);
		if (state.hard.includes(s.id)) s.kind = "task";
	}
	save();
	saveNaming({ ...state, state: "done", at: stamp() });
	log(`schedule naming done: ${named.length} named`);
	if (named.length) deps.post(msg().scheduleNamed(named.map(s => ({ name: s.name!, kind: scheduleKind(s) }))));
}
