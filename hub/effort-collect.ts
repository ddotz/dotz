// why(vendor): the page https://artificialanalysis.ai/leaderboards/models embeds one JSON record per model and effort in script strings with escaped quotes; code reads only numbers and an effort from the fixed list, and runs, writes or passes on nothing else of the untrusted page.
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

const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const sameModel = (id: string[], name: string[]): boolean => {
	const want = id.length > 1 && /^\d{8}$/.test(id[id.length - 1]!) ? id.slice(0, -1) : id;
	const base = name.length > want.length && /^\d{3,4}$/.test(name[name.length - 1]!) ? name.slice(0, -1) : name;
	return want.length > 0 && base.length === want.length && base.every((t, i) => t === want[i]);
};

const RECORD_HEAD = /"name":"([^"]*)","shortName"/g;
const RECORD_NAME = /^(.*?)\s*\(([^()]*)\)$/;
const RECORD_LIMIT = 8_000;
const field = (record: string, key: string): number | undefined => {
	const m = new RegExp(`"${key}":(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)[,}]`).exec(record);
	return m ? Number(m[1]) : undefined;
};

type BoardRow = { effort: Effort; score: number; cost: number; minutes?: number };

/** The rows of one model from the leaderboard page: one per effort record the page embeds for it. */
export function boardRows(html: string, id: string): BoardRow[] {
	const text = html.replaceAll('\\"', '"');
	const heads = [...text.matchAll(RECORD_HEAD)];
	const want = tokens(id);
	const out: BoardRow[] = [];
	heads.forEach((head, i) => {
		const name = RECORD_NAME.exec(head[1]!);
		const effort = name ? KIND[name[2]!.split(",")[0]!.trim().toLowerCase()] : undefined;
		if (!effort || !name || !sameModel(want, tokens(name[1]!))) return;
		const record = text.slice(head.index, Math.min(heads[i + 1]?.index ?? text.length, head.index + RECORD_LIMIT));
		const [score, cost, seconds] = [field(record, "intelligenceIndex"), field(record, "intelligenceIndexCostPerTask"), field(record, "intelligenceIndexTimePerTask")];
		if (score !== undefined && cost !== undefined) out.push({ effort, score, cost, ...(seconds !== undefined ? { minutes: seconds / 60 } : {}) });
	});
	return out;
}

/** The collector `learnTick` uses: nothing when the page cannot be read or has no rows for the model. */
export const collectFromBoard = (fetchPage: (url: string) => Promise<string | undefined> = url => fetchCapped(url)) => async (id: string): Promise<Collected | undefined> => {
	const html = await fetchPage(BOARD_URL);
	const rows = html ? boardRows(html, id) : [];
	return rows.length ? { rows, sources: [{ url: BOARD_URL }] } : undefined;
};
