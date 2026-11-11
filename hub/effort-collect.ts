// The collector behind hub/effort-learn.ts: the published per-effort results of one model, read by code from a fixed public page.
// Artificial Analysis' leaderboard page carries one table row per model and effort ("Claude Sonnet 5.5 (high)") with the intelligence index,
// the cost per task and the time per task. Code fetches the page (timeout, size cap), finds the rows of the model by its id and keeps only
// numbers and an effort from the fixed list. The page is untrusted: no part of it is run, written or passed on except those numbers.
import type { Collected } from "./effort-learn.ts";
import type { Effort } from "./model-effort.ts";

export const BOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const KIND: Record<string, Effort> = { max: "max", xhigh: "xhigh", high: "high", medium: "medium", low: "low", minimal: "minimal", "non-reasoning": "off" };

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** The page as text, or undefined when it is not a 200 with a body of at most MAX_BYTES. */
export async function fetchCapped(url: string, fetchFn: Fetch = fetch as Fetch, maxBytes = MAX_BYTES): Promise<string | undefined> {
	const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/html", "user-agent": "dotz-effort-learn" } });
	if (!res.ok || !res.body) return undefined;
	const reader = res.body.getReader(), parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			return undefined;
		}
		parts.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(parts));
}

const cellsOf = (tr: string): string[] => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => m[1]!.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim());
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const number = (s: string | undefined): number | undefined => {
	const m = /^\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)$/.exec(s ?? "");
	return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
};
const sameModel = (id: string[], name: string[]): boolean => {
	const want = id.length > 1 && /^\d{8}$/.test(id[id.length - 1]!) ? id.slice(0, -1) : id;
	const base = name.length > want.length && /^\d{3,4}$/.test(name[name.length - 1]!) ? name.slice(0, -1) : name;
	return want.length > 0 && base.length === want.length && base.every((t, i) => t === want[i]);
};

/** The rows of one model from the leaderboard page: one per effort the page lists for it. */
export function boardRows(html: string, id: string): Array<{ effort: Effort; score: number; cost: number; minutes?: number }> {
	const table = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(m => cellsOf(m[0]));
	const head = table.find(r => r[0] === "Model");
	const at = (re: RegExp): number => head?.findIndex(c => re.test(c)) ?? -1;
	const [iScore, iCost, iTime] = [at(/Intelligence Index/i), at(/Cost per Task/i), at(/Time per Task/i)];
	if (iScore < 0 || iCost < 0) return [];
	const want = tokens(id);
	const out: Array<{ effort: Effort; score: number; cost: number; minutes?: number }> = [];
	for (const r of table) {
		const m = /^(.*?)\s*\(([^()]*)\)$/.exec(r[0] ?? "");
		const effort = m ? KIND[m[2]!.trim().toLowerCase()] : undefined;
		const [score, cost, minutes] = [number(r[iScore]), number(r[iCost]), iTime >= 0 ? number(r[iTime]) : undefined];
		if (effort && m && sameModel(want, tokens(m[1]!)) && score !== undefined && cost !== undefined) out.push({ effort, score, cost, ...(minutes !== undefined ? { minutes } : {}) });
	}
	return out;
}

/** The collector `learnTick` uses: nothing when the page cannot be read or has no rows for the model. */
export const collectFromBoard = (fetchPage: (url: string) => Promise<string | undefined> = url => fetchCapped(url)) => async (id: string): Promise<Collected | undefined> => {
	const html = await fetchPage(BOARD_URL);
	const rows = html ? boardRows(html, id) : [];
	return rows.length ? { rows, sources: [{ url: BOARD_URL }] } : undefined;
};
