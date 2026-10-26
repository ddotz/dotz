// A fake KakaoTalk screen for the send tests: the chat list rows (what room.jxa.js `rows` reads), the window each row opens (what `probe`
// reads) and a record of every action, so a test can see what was opened and that nothing else ran. Nothing here touches the real app.
import { loadJxa } from "./jxa.fixture.ts";
import type { WindowFacts } from "./room.ts";
import type { Runner } from "./types.ts";

// texts: what the row cell shows after the title: [title, member count (groups), time, ...noise (unread badge, ...), preview].
export type FakeRow = { id: string; title: string; count?: number; noise?: string[]; preview?: string; window?: WindowFacts | "unreadable" };

const norm = (s: string) => s.normalize("NFC").replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim();
// The open step's recheck is room.jxa.js's own rule.
const { rowStillIs } = loadJxa();

// What room.jxa.js (axScan) prints: the hint row first, then its neighbours, then the list; a paged list scrolls page by page; the budget
// stops the read. `scanned` is how many rows were actually read, `hits` those whose title is the name (with all their texts).
function scanRows(rows: FakeRow[], req: { name: string; first?: boolean; hint?: number; need?: number }, pageSize: number | undefined, scanLimit: number | undefined) {
	const want = norm(req.name);
	const enough = req.first ? 1 : (req.need ?? 0);
	const perPage = pageSize && pageSize > 0 ? pageSize : rows.length;
	const limit = scanLimit === undefined ? Number.POSITIVE_INFINITY : scanLimit;
	const seen = new Set<number>();
	const hits: { index: number; texts: string[] }[] = [];
	let scanned = 0;
	let pages = 0;
	let stopped = "end";
	for (;;) {
		const from = pages * perPage;
		const to = Math.min(rows.length, from + perPage);
		const order: number[] = [];
		const hint = req.hint;
		if (typeof hint === "number" && hint >= from && hint < to) {
			order.push(hint);
			for (let d = 1; d <= 30; d++) {
				if (hint + d < to) order.push(hint + d);
				if (hint - d >= from) order.push(hint - d);
			}
		}
		for (let i = from; i < to; i++) order.push(i);
		let over = false;
		for (const index of order) {
			if (seen.has(index)) continue;
			if (scanned >= limit) {
				stopped = "budget";
				over = true;
				break;
			}
			seen.add(index);
			scanned++;
			const texts = rowTexts(rows[index]!);
			if (norm(texts[0] ?? "") === want) {
				hits.push({ index, texts });
				if (enough && hits.length >= enough) {
					stopped = "found";
					break;
				}
			}
		}
		if (stopped === "found" || over) break;
		if (to >= rows.length) break;
		pages++;
		if (pages >= 20) break;
	}
	return { ok: true, rows: rows.length, scanned, hits, stopped, pages, ms: { scan: scanned } };
}
export const rowTexts = (r: FakeRow) => [r.title, ...(r.count === undefined ? [] : [String(r.count)]), "오후 4:58", ...(r.noise ?? []), ...(r.preview === undefined ? [] : [r.preview])];

// `listShown`: the list window of KakaoTalk exists (rows reads it); off, rows says no_list until `openlist` succeeds.
// `openlist`: what the openlist action does while no list window exists: "ok" shows the list (KakaoTalk took the focus and the previous app
// was put back), "fail" leaves it closed (menu step fails). Default "fail".
// `openFail`: the row open fails at this step (room.jxa.js open: menu, press, window).
// `axSend`: the JSON room.jxa.js send prints (default {ok:true}); its sends are recorded as ["ax-send", name, text].
export function fakeScreen(
	rows: FakeRow[],
	opts: {
		front?: string;
		kakaoShown?: boolean;
		listShown?: boolean;
		openlist?: "ok" | "fail";
		// A failing row open: always, or from the n-th attempt on (1-based).
		openFail?: { step: string; why: string } | ((n: number) => { step: string; why: string } | undefined);
		// The window the probe reads after the n-th open (0: a window kept open from an earlier send).
		windowAt?: (n: number) => WindowFacts | "unreadable" | undefined;
		// A row whose chat window is already open at the start (a kept window); rows then answers opened:true for it.
		currentAtStart?: string;
		// The list exposes only this many rows at a time (a paged list); the scan scrolls page by page.
		pageSize?: number;
		// How many rows the scan may read before its budget runs out (a slow read); the rest is left unread.
		scanLimit?: number;
		axSend?: (n: number, req: { name: string; text: string; ours?: string[]; priorPressed?: string[] }) => object;
	} = {},
) {
	const opened: string[] = [];
	const sends: string[][] = [];
	const sendReqs: { name: string; text: string; ours?: string[]; priorPressed?: string[] }[] = [];
	let opens = 0;
	const focus: string[][] = [];
	const rowCalls: Record<string, unknown>[] = [];
	const other: string[][] = [];
	const order: string[] = [];
	let listShown = opts.listShown !== false;
	const listCalls: number[] = [];
	let menus = 0;
	let closes = 0;
	let current: string | undefined = opts.currentAtStart;
	const out = (o: object) => ({ code: 0, stdout: `${JSON.stringify(o)}\n`, stderr: "" });
	const runner: Runner = async (argv, o) => {
		if (argv[0] === "open") {
			focus.push(argv);
			order.push("open");
			return { code: 0, stdout: "", stderr: "" };
		}
		if (argv[0] === "osascript" && argv[1] !== "-l") {
			focus.push(argv);
			order.push("front");
			return { code: 0, stdout: `${opts.front ?? "com.example.Editor"} ${opts.kakaoShown ? 1 : 0}\n`, stderr: "" };
		}
		if (argv[0] !== "osascript") {
			other.push(argv);
			return { code: 1, stdout: "", stderr: "unexpected call" };
		}
		const req = JSON.parse((o?.stdin ?? "{}").trim());
		if (req.action === "rows") {
			rowCalls.push(req);
			if (!listShown) return out({ ok: false, step: "list", why: "no_list" });
			const open = rows.find(r => r.id === current);
			if (open && open.title === req.name) return out({ ok: true, opened: true });
			return out(scanRows(rows, req, opts.pageSize, opts.scanLimit));
		}
		if (req.action === "openlist") {
			listCalls.push(1);
			order.push("openlist");
			if (listShown) return out({ ok: true, ms: {}, focus: { took: false, restored: false } });
			if (opts.openlist !== "ok") return out({ ok: false, step: "menu", why: "no_item" });
			listShown = true;
			return out({ ok: true, ms: { press: 2, window: 3, restore: 1 }, focus: { from: opts.front ?? "com.example.Editor", took: true, restored: true } });
		}
		if (req.action === "open") {
			const row = rows[req.row];
			if (!row || !rowStillIs(rowTexts(row), req.name, req.expect)) return out({ ok: false, step: "recheck", why: "moved", ms: {} });
			menus++;
			opens++;
			const fail = typeof opts.openFail === "function" ? opts.openFail(opens) : opts.openFail;
			if (fail) return out({ ok: false, ...fail, ms: {} });
			current = row.id;
			opened.push(`ax:${current}`);
			order.push("ax-open");
			return out({ ok: true, ms: { recheck: 1, menu: 1, press: 1, window: 1 } });
		}
		if (req.action === "send") {
			sends.push(["ax-send", req.name, req.text]);
			sendReqs.push(req);
			order.push("send");
			return out(opts.axSend?.(sends.length, req) ?? { ok: true });
		}
		if (req.action === "close") {
			closes++;
			current = undefined;
			return out({ ok: true });
		}
		const w = (opts.windowAt?.(opens) ?? rows.find(r => r.id === current)?.window) as WindowFacts | "unreadable" | undefined;
		if (w === "unreadable" || w === undefined) return out({ ok: false });
		return out({ ok: true, windows: [w] });
	};
	return { runner, opened, sends, sendReqs, focus, rowCalls, other, order, listCalls, menus: () => menus, closes: () => closes };
}
