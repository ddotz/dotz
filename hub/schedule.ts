import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { log, paths, writeAtomic } from "./config.ts";
import { everyMinutes } from "./watch.ts";

export type Schedule = { id: string; text: string; at: string; every_minutes?: number; created: string; paused?: boolean };

const items: Schedule[] = existsSync(paths.schedules) ? JSON.parse(readFileSync(paths.schedules, "utf8")) : [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const save = () => writeAtomic(paths.schedules, `${JSON.stringify(items, null, 2)}\n`);
let onFire: (s: Schedule) => void = () => {};
const MAX_DELAY = 2 ** 31 - 1;

function arm(s: Schedule): void {
	clearTimeout(timers.get(s.id));
	if (s.paused) return;
	const delay = Math.max(0, Date.parse(s.at) - Date.now());
	timers.set(s.id, setTimeout(() => (delay > MAX_DELAY ? arm(s) : fire(s)), Math.min(delay, MAX_DELAY)));
}

function fire(s: Schedule): void {
	timers.delete(s.id);
	if (s.every_minutes) {
		let next = Date.parse(s.at);
		while (next <= Date.now()) next += s.every_minutes * 60_000;
		s.at = new Date(next).toISOString();
		arm(s);
	} else items.splice(items.indexOf(s), 1);
	save();
	log(`schedule ${s.id} fired`);
	onFire(s);
}

export function startSchedules(handler: (s: Schedule) => void): void {
	onFire = handler;
	for (const s of items) arm(s);
}

// Shutdown: nothing fires again (the items stay saved in schedules.json).
export function stopSchedules(): void {
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
}

export function addSchedule(input: { text?: string; at?: string; in_minutes?: number; every_minutes?: number }): Schedule {
	const text = String(input.text ?? "").trim();
	if (!text) throw new Error("text required");
	const at = input.at ? Date.parse(input.at) : Date.now() + Number(input.in_minutes ?? Number.NaN) * 60_000;
	if (!Number.isFinite(at)) throw new Error("give at (ISO time with offset, e.g. 2026-10-17T09:00:00+09:00) or in_minutes");
	if (input.every_minutes !== undefined && !(Number(input.every_minutes) >= 5)) throw new Error("every_minutes must be at least 5");
	const s: Schedule = { id: randomBytes(3).toString("hex"), text, at: new Date(at).toISOString(), ...(input.every_minutes ? { every_minutes: Number(input.every_minutes) } : {}), created: new Date().toISOString() };
	items.push(s);
	save();
	arm(s);
	return s;
}

// The owner's edit from the project page (PATCH /api/schedules/<id>): persisted and re-armed. `paused` keeps the entry but
// nothing fires; a recurring one resumes at its next slot after now, a one-shot whose time passed fires at once.
export function patchSchedule(id: string, input: { every_minutes?: unknown; at?: unknown; text?: unknown; paused?: unknown }): Schedule {
	const s = items.find(x => x.id === id);
	if (!s) throw new Error(`no schedule ${id}`);
	const every = input.every_minutes === undefined ? s.every_minutes : everyMinutes(input.every_minutes);
	const text = input.text === undefined ? s.text : typeof input.text === "string" ? input.text.trim() : "";
	if (!text) throw new Error("text must be a non-empty string");
	const at = input.at === undefined ? Date.parse(s.at) : typeof input.at === "string" ? Date.parse(input.at) : Number.NaN;
	if (!Number.isFinite(at)) throw new Error("at must be an ISO time with offset, e.g. 2026-10-17T09:00:00+09:00");
	if (input.paused !== undefined && typeof input.paused !== "boolean") throw new Error("paused must be true or false");
	s.text = text;
	s.at = new Date(at).toISOString();
	if (every) s.every_minutes = every;
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
