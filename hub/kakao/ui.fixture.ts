// A fake KakaoTalk screen for the send tests: the chat list rows (what room.jxa.js `rows` reads), the window each row opens (what `probe`
// reads) and a record of every action, so a test can see what was opened and that nothing else ran. Nothing here touches the real app.
import type { WindowFacts } from "./room.ts";
import type { Runner } from "./types.ts";

// texts: what the row cell shows after the title: [title, member count (groups), time, ...noise (unread badge, ...)].
export type FakeRow = { id: string; title: string; count?: number; noise?: string[]; window?: WindowFacts | "unreadable" };

const norm = (s: string) => s.normalize("NFC").replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim();
export const rowTexts = (r: FakeRow) => [r.title, ...(r.count === undefined ? [] : [String(r.count)]), "오후 4:58", ...(r.noise ?? [])];

// `listShown`: the list window of KakaoTalk exists (rows reads it); off, rows says no_list.
// `openFail`: the row open fails at this step (room.jxa.js open: menu, press, window).
// `axSend`: the JSON room.jxa.js send prints (default {ok:true}); its sends are recorded as ["ax-send", name, text].
export function fakeScreen(rows: FakeRow[], opts: { front?: string; kakaoShown?: boolean; listShown?: boolean; openFail?: { step: string; why: string }; axSend?: () => object } = {}) {
	const opened: string[] = [];
	const sends: string[][] = [];
	const focus: string[][] = [];
	const rowCalls: Record<string, unknown>[] = [];
	const other: string[][] = [];
	const order: string[] = [];
	let menus = 0;
	let closes = 0;
	let current: string | undefined;
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
			if (opts.listShown === false) return out({ ok: false, step: "list", why: "no_list" });
			const open = rows.find(r => r.id === current);
			if (open && open.title === req.name) return out({ ok: true, opened: true });
			const read: string[][] = [];
			let stopped = "end";
			for (const r of rows.slice(0, req.max)) {
				read.push(rowTexts(r));
				if (req.first && norm(r.title) === norm(req.name)) {
					stopped = "found";
					break;
				}
			}
			return out({ ok: true, rows: read, stopped, ms: { table: 1, read: 1 } });
		}
		if (req.action === "open") {
			const row = rows[req.row];
			if (!row || norm(row.title) !== norm(req.name)) return out({ ok: false, step: "recheck", why: "moved", ms: {} });
			menus++;
			if (opts.openFail) return out({ ok: false, ...opts.openFail, ms: {} });
			current = row.id;
			opened.push(`ax:${current}`);
			order.push("ax-open");
			return out({ ok: true, ms: { recheck: 1, menu: 1, press: 1, window: 1 } });
		}
		if (req.action === "send") {
			sends.push(["ax-send", req.name, req.text]);
			order.push("send");
			return out(opts.axSend?.() ?? { ok: true });
		}
		if (req.action === "close") {
			closes++;
			current = undefined;
			return out({ ok: true });
		}
		const w = rows.find(r => r.id === current)?.window;
		if (w === "unreadable" || w === undefined) return out({ ok: false });
		return out({ ok: true, windows: [w] });
	};
	return { runner, opened, sends, focus, rowCalls, other, order, menus: () => menus, closes: () => closes };
}
