// What used the plan, for the usage screen: the sessions and models behind at least SHARE_MIN of the last day's spend, from the nightly
// token audit (hub/token-audit.ts writes them into token-audit.json). Opening the screen reads that small file (re-parsed only when it
// changed): no session scan and no model call on the request path.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export const USE_FILE = join(DATA_DIR, "token-audit.json");

export const SHARE_MIN = 0.1;
// name: the lane name, the task name of a worker, the session id otherwise; model: the model that cost the session most.
export type ShareRow = { kind: "orchestrator" | "lane" | "worker" | "other"; name: string; model: string; cost: number; tokens: number; pct: number };
export type ModelShare = { model: string; cost: number; pct: number };
export type UseShare = { at: number; hours: number; cost: number; tokens: number; sessions: number; rows: ShareRow[]; models: ModelShare[]; rest: { sessions: number; pct: number } };
export type SessionUse = { kind: ShareRow["kind"]; name: string; models: Record<string, number>; cost: number; tokens: number };

const round = (n: number, d = 2): number => Number(n.toFixed(d));
const top = (models: Record<string, number>): string => Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

// Pure: the rows at or over `min` of the spend (by cost; by tokens on a day that cost nothing), biggest first, the models the same way,
// and what the rest adds up to.
export function sharesOf(list: SessionUse[], at: number, hours: number, min = SHARE_MIN): UseShare {
	const cost = list.reduce((a, s) => a + s.cost, 0), tokens = list.reduce((a, s) => a + s.tokens, 0);
	const part = (c: number, t: number): number => (cost > 0 ? c / cost : tokens > 0 ? t / tokens : 0);
	const rows = list
		.map((s): ShareRow => ({ kind: s.kind, name: s.name, model: top(s.models), cost: round(s.cost), tokens: s.tokens, pct: round(part(s.cost, s.tokens) * 100, 1) }))
		.filter(r => r.pct >= min * 100)
		.sort((a, b) => b.pct - a.pct);
	const byModel: Record<string, number> = {};
	for (const s of list) for (const [m, c] of Object.entries(s.models)) byModel[m] = (byModel[m] ?? 0) + c;
	const models = Object.entries(byModel)
		.map(([model, c]) => ({ model, cost: round(c), pct: round(cost > 0 ? (c / cost) * 100 : 0, 1) }))
		.filter(m => m.pct >= min * 100)
		.sort((a, b) => b.pct - a.pct);
	const shown = rows.reduce((a, r) => a + r.pct, 0);
	return { at, hours, cost: round(cost), tokens, sessions: list.length, rows, models, rest: { sessions: list.length - rows.length, pct: round(Math.max(0, 100 - shown), 1) } };
}

// The `use` of the newest recorded audit day, or undefined when there is none yet.
let held: { stamp: string; value: UseShare | undefined } | undefined;
export function readUseShare(historyFile = USE_FILE): UseShare | undefined {
	let stamp: string;
	try {
		const s = statSync(historyFile);
		stamp = `${s.mtimeMs}:${s.size}`;
	} catch {
		return undefined;
	}
	if (held?.stamp === stamp) return held.value;
	let value: UseShare | undefined;
	try {
		value = (JSON.parse(readFileSync(historyFile, "utf8")).days ?? []).at(-1)?.use;
	} catch {
		value = undefined; // a file caught mid-write is read again on the next change
	}
	held = { stamp, value };
	return value;
}

// The usage screen's part of GET /api/quota: { use } when an audit recorded one.
export function useField(): { use?: UseShare } {
	const use = readUseShare();
	return use ? { use } : {};
}
