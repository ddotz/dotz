// What this install learned about model efforts, in one file in the data folder (model-efforts.json), written atomically.
// `baseline` is the model ids seen at the first run (never collected), `listed` the ids seen last time (a change reopens stopped retries),
// `attempts` the times of collections in the last day (the daily cap), `entries` one record per collected model: its effort, the rows
// and sources it came from, when, and whether it is a benchmark value or a provisional record of tries. The file is read back with
// every field checked: only ids of a plain shape, efforts from the fixed list, numeric rows and https URLs survive.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";
import { cleanRows, type EffortRow } from "./effort-knee.ts";
import { EFFORT_ORDER, type Effort, type Learned } from "./model-effort.ts";

export type EffortSource = { url: string; at: string };
export type EffortEntry = {
	id: string;
	effort: Effort;
	rows: EffortRow[];
	sources: EffortSource[];
	at: string;
	status: "benchmark" | "provisional";
	/** Provisional only: collections tried, the first one, when the next is due, and whether the two weeks of daily retries are over. */
	tries?: number;
	first?: string;
	next?: string;
	stopped?: boolean;
};
export type EffortState = { baseline?: string[]; listed?: string[]; attempts: number[]; entries: Record<string, EffortEntry> };

export const storeFile = (dir: string): string => join(dir, "model-efforts.json");
export const emptyState = (): EffortState => ({ attempts: [], entries: {} });

const ID = /^[a-z0-9][a-z0-9._-]{0,80}$/;
export const validId = (id: string): boolean => ID.test(id);
const MAX_IDS = 2000;
const ids = (v: unknown): string[] | undefined => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && ID.test(x)))].slice(0, MAX_IDS) : undefined);
const time = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : undefined);
const effortOf = (v: unknown): Effort | undefined => EFFORT_ORDER.find(e => e === v);
export const httpsUrl = (v: unknown): string | undefined => {
	if (typeof v !== "string" || v.length > 300) return undefined;
	try {
		return new URL(v).protocol === "https:" ? v : undefined;
	} catch {
		return undefined;
	}
};

function entryOf(id: string, raw: any): EffortEntry | undefined {
	const effort = effortOf(raw?.effort), at = time(raw?.at);
	if (!ID.test(id) || !effort || !at || (raw.status !== "benchmark" && raw.status !== "provisional")) return undefined;
	const rows = cleanRows(raw.rows);
	const sources = (Array.isArray(raw.sources) ? raw.sources : []).flatMap((s: any) => {
		const url = httpsUrl(s?.url), when = time(s?.at);
		return url && when ? [{ url, at: when }] : [];
	});
	if (raw.status === "benchmark" && (!rows.length || !sources.length)) return undefined;
	const tries = Number.isInteger(raw.tries) && raw.tries >= 0 && raw.tries < 10_000 ? raw.tries : undefined;
	return { id, effort, rows, sources, at, status: raw.status, ...(tries !== undefined ? { tries } : {}), ...(time(raw.first) ? { first: raw.first } : {}), ...(time(raw.next) ? { next: raw.next } : {}), ...(raw.stopped === true ? { stopped: true } : {}) };
}

/** The stored state; a missing or unreadable file is an empty state, and a field that does not check out is dropped. */
export function loadState(dir: string): EffortState {
	let raw: any;
	try {
		raw = JSON.parse(readFileSync(storeFile(dir), "utf8"));
	} catch {
		return emptyState();
	}
	const entries: Record<string, EffortEntry> = {};
	for (const [id, e] of Object.entries(raw?.entries && typeof raw.entries === "object" ? raw.entries : {})) {
		const entry = entryOf(id, e);
		if (entry) entries[id] = entry;
	}
	const attempts = (Array.isArray(raw?.attempts) ? raw.attempts : []).filter((t: unknown): t is number => typeof t === "number" && Number.isFinite(t)).slice(-100);
	return { ...(ids(raw?.baseline) ? { baseline: ids(raw.baseline) } : {}), ...(ids(raw?.listed) ? { listed: ids(raw.listed) } : {}), attempts, entries };
}

export function saveState(dir: string, state: EffortState): void {
	mkdirSync(dir, { recursive: true });
	writeAtomic(storeFile(dir), `${JSON.stringify(state, null, 2)}\n`);
}

/** The values `sweetSpot` reads: every stored model by id. */
export const learnedOf = (state: EffortState): Map<string, Learned> => new Map(Object.values(state.entries).map(e => [e.id, { effort: e.effort, status: e.status }]));
