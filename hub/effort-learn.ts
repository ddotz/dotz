// When a new model appears, this install collects the published per-effort results itself and records the model's sweet spot (hub/effort-knee.ts).
// One tick looks at the connected providers' model list. The first tick only records the ids as the baseline: nothing is collected for the models
// that were already there. Later, an id that is not in the baseline and has no table row, and a model the config names that has neither a table
// row nor a recorded benchmark value, is collected: one model per tick, at most MAX_PER_DAY collections in 24 hours. A collection that finds no
// usable rows is recorded as provisional and tried again a day later for two weeks, then it waits until the model list changes.
// The fetch, the clock, the data folder and the lists are injected; hub/effort-collect.ts is the real collector.
import { benchmarkEffort, cleanRows } from "./effort-knee.ts";
import { type EffortEntry, type EffortSource, httpsUrl, loadState, saveState, validId } from "./effort-store.ts";
import { bareId, sweetSpot, tableEffort } from "./model-effort.ts";

export type Collected = { rows: unknown; sources: Array<{ url: unknown }> };
export type LearnDeps = {
	dir: string;
	enabled: () => boolean;
	/** The model selectors of the connected providers. */
	listed: () => Promise<string[]>;
	/** The models config.json names (the three targets and their fallbacks). */
	named: () => string[];
	collect: (id: string) => Promise<Collected | undefined>;
	now: () => number;
	/** A benchmark value was recorded for a model that had none. */
	learned: (entry: EffortEntry) => void;
};

export const MAX_PER_DAY = 3;
export const RETRY_DAYS = 14;
const DAY_MS = 24 * 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const idsOf = (selectors: readonly string[]): string[] => [...new Set(selectors.map(bareId).filter(validId))];
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every(x => b.includes(x));

/** One look at the model list; collects at most one model. Returns the entry it recorded, if any. */
export async function learnTick(d: LearnDeps): Promise<EffortEntry | undefined> {
	if (!d.enabled()) return undefined;
	const ids = idsOf(await d.listed());
	if (!ids.length) return undefined;
	const now = d.now();
	const state = loadState(d.dir);
	if (!state.baseline) {
		saveState(d.dir, { ...state, baseline: ids, listed: ids });
		return undefined;
	}
	if (!sameSet(state.listed ?? [], ids)) {
		for (const e of Object.values(state.entries)) delete e.stopped;
		state.listed = ids;
		saveState(d.dir, state);
	}
	const baseline = new Set(state.baseline);
	const due = (id: string): boolean => {
		const e = state.entries[id];
		return !e || (e.status === "provisional" && !e.stopped && (!e.next || Date.parse(e.next) <= now));
	};
	const candidates = idsOf([...d.named(), ...ids.filter(id => !baseline.has(id))]).filter(id => tableEffort(id) === undefined && due(id));
	const recent = state.attempts.filter(t => now - t < DAY_MS);
	const id = candidates[0];
	if (!id || recent.length >= MAX_PER_DAY) return undefined;
	saveState(d.dir, { ...state, attempts: [...recent, now] });

	let got: Collected | undefined;
	try {
		got = await d.collect(id);
	} catch {
		// A failed fetch is the same as no rows found: the model stays provisional and is tried again tomorrow.
		got = undefined;
	}
	const rows = cleanRows(got?.rows), effort = benchmarkEffort(rows);
	const sources: EffortSource[] = (got?.sources ?? []).flatMap(s => {
		const url = httpsUrl(s?.url);
		return url ? [{ url, at: iso(now) }] : [];
	});
	const prev = state.entries[id];
	let entry: EffortEntry;
	if (effort && sources.length) entry = { id, effort, rows, sources, at: iso(now), status: "benchmark" };
	else {
		const first = prev?.first ?? iso(now), stopped = now - Date.parse(first) >= RETRY_DAYS * DAY_MS;
		entry = { id, effort: sweetSpot(id).effort, rows: [], sources: [], at: iso(now), status: "provisional", tries: (prev?.tries ?? 0) + 1, first, ...(stopped ? { stopped: true } : { next: iso(now + DAY_MS) }) };
	}
	const latest = loadState(d.dir);
	saveState(d.dir, { ...latest, entries: { ...latest.entries, [id]: entry } });
	if (entry.status === "benchmark") d.learned(entry);
	return entry;
}
