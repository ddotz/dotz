// The ⋯ at the top right of a mail card in 모니터링: the same actions on every incoming mail (초안 작성, 답장 안 함 or 답장 필요로 표시 by state, 삭제),
// 삭제 alone on an outgoing one, and the row's buttons by the one rule (owed rows only), on this computer's mail and on a peer's mail
// (sent once to the computer that holds it), in a headless browser against a fake hub that keeps the changes, so a reload shows them.
// MAIL_MENU_SHOTS=<dir> keeps the screenshots of a card with its menu open (390 and 1280 wide).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.MAIL_MENU_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown, status = 200) => Response.json(v, { status });
const iso = (h: number) => new Date(Date.UTC(2026, 9, 27, h, 0)).toISOString();

type Mail = { target: string; h: number; unread: number; card: Record<string, unknown> };
const mail = (target: string, subject: string, h: number, owed: boolean): Mail => ({ target, h, unread: 0, card: { subject, from: "Kim <kim@example.com>", source: "mail", at: iso(h), summary: "금요일까지 회신 부탁드려요.", ...(owed ? { reply: "needs", unreplied: true } : {}) } });
const sent = (target: string, subject: string, h: number): Mail => ({ target, h, unread: 0, card: { subject, from: "Owner <owner@example.com>", to: "Kim <kim@example.com>", dir: "out", source: "mail", at: iso(h), summary: "보내 드립니다." } });
let local: Mail[] = [];
let peer: Mail[] = [];
beforeEach(() => {
	local = [mail("mail:loc-1", "계약서 확인 부탁드립니다", 9, true), mail("mail:loc-2", "회의록 공유", 8, false), sent("mail:loc-3", "Re: 회의록 공유", 7)];
	peer = [mail("mail:peer-1", "견적 문의드립니다", 7, true), mail("mail:peer-2", "배송 안내", 6, false)];
	reqs = [];
});
const owed = (list: Mail[]) => list.filter(m => m.card.unreplied).length;
const app = (list: Mail[]) => ({ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread: 0, unreplied: owed(list), needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: owed(list) } });
// A mail conversation whose mail was deleted (an older hub still lists it, without a mail): never a row, on this computer or the other.
const GHOST = { target: "mail:gone-1", unread: 2, read: null, last: { ts: iso(10), text: "지운 메일에 봇이 남긴 말", from: "bot" } };
const convs = (list: Mail[]) => [...list.map(m => ({ target: m.target, unread: m.unread, read: null, mail: m.card, last: { ts: iso(m.h), text: String(m.card.subject), from: "bot" } })), GHOST];
// The hub's rules for the marks and 삭제 (hub/routes.ts), on whichever list holds the mail.
function apply(list: Mail[], key: string, op: "fyi" | "unfyi" | "delete"): Mail[] {
	const t = `mail:${key}`;
	if (op === "delete") return list.filter(m => m.target !== t);
	for (const m of list) if (m.target === t) { m.card.reply = op === "fyi" ? "fyi" : "needs"; if (op === "fyi") delete m.card.unreplied; else m.card.unreplied = true; }
	return list;
}

type Req = { method: string; path: string; body?: any };
let reqs: Req[] = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, { name: "맥미니", url: "http://mini.test", self: false, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json([{ name: "맥미니", url: "http://mini.test", online: true, stale: false, items: { name: "맥미니", rev: `r${reqs.length}`, monitors: [], notices: [], available: [], integrations: [app(peer)], conversations: convs(peer) } }]);
		if (p === "/api/integrations") return json({ items: [app(local)], available: [] });
		if (p === "/api/conversations") return json({ items: convs(local) });
		if (req.method !== "GET") {
			const body = await req.json().catch(() => undefined);
			if (p.startsWith("/api/mail/") || p === "/api/peer/proxy") reqs.push({ method: req.method, path: p, body });   // the mail actions only (read positions and viewing posts are not asserted)
			if (p === "/api/peer/proxy") {
				const a = body as { action: string; args: { key: string; on?: boolean } };
				if (a.action === "fyi") peer = apply(peer, a.args.key, a.args.on === false ? "unfyi" : "fyi");
				if (a.action === "mail-delete") peer = apply(peer, a.args.key, "delete");
				return json({ ok: true });
			}
			const fyi = /^\/api\/mail\/([^/]+)\/fyi$/.exec(p), del = /^\/api\/mail\/([^/]+)$/.exec(p);
			if (fyi) local = apply(local, fyi[1]!, req.method === "POST" ? "fyi" : "unfyi");
			else if (del && req.method === "DELETE") local = apply(local, del[1]!, "delete");
			return json({ ok: true });
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 5000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };

const SUBJECT: Record<string, string> = { "mail:loc-1": "계약서 확인 부탁드립니다", "mail:loc-2": "회의록 공유", "mail:loc-3": "Re: 회의록 공유", "mail:peer-1": "견적 문의드립니다", "mail:peer-2": "배송 안내" };
const row = (t: string) => `[...document.querySelectorAll("#mon-tl .mr")].find(r => r.querySelector(".rc-title").textContent === ${JSON.stringify(SUBJECT[t])})`;
const stateOf = (v: View, t: string) => q<string>(v, `const r = ${row(t)}; return r ? (r.querySelector(".rc-hd .tag") || {}).textContent || "" : "gone"`);
const menuOf = async (v: View, t: string) => { await run(v, `${row(t)}.querySelector(".mr-more").click()`); await waitFor(v, `document.querySelector(".menu .mi")`); const l = await menuLabels(v); await run(v, `closeMenu()`); return l; };
const inlineOf = (v: View, t: string) => q<string[]>(v, `return [...${row(t)}.querySelectorAll(".mr-slot button")].map(b => b.textContent)`);
async function openList(v: View, peerItem: boolean) {
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && typeof INTG !== "undefined" && INTG.items.length === 1`);
	await run(v, `go("monitoring")`);
	const sel = peerItem ? `#mon-side .cv-row[data-k^="p:"][data-k$="i:mail"]` : `#mon-side .cv-row[data-k="i:mail"]`;
	await waitFor(v, `document.querySelector('${sel}')`);
	await run(v, `document.querySelector('${sel}').click()`);
	await waitFor(v, `document.querySelector("#mon-tl .mr")`);
}
async function pick(v: View, t: string, label: string) {
	await run(v, `${row(t)}.querySelector(".mr-more").click()`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await run(v, `[...document.querySelectorAll(".menu .mi")].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
}
const menuLabels = (v: View) => q<string[]>(v, `return [...document.querySelectorAll(".menu .mi")].map(b => b.textContent)`);
const confirmDelete = async (v: View) => {
	await waitFor(v, `document.querySelector("dialog[open] .btn.danger")`);
	expect(await q<string>(v, `return document.querySelector("dialog[open] .dbody").textContent`)).toBe("이 메일을 목록에서 지울까요? 실제 메일함의 메일은 그대로 있어요");
	await run(v, `document.querySelector("dialog[open] .btn.danger").click()`);
};

for (const [width, height] of [[390, 844], [1280, 900]] as const) {
	describe(`mail card ⋯ at ${width}px`, () => {
		const v = new Bun.WebView({ width, height });
		views.push(v);

		test("the ⋯ sits at the top right of every card and opens 초안 작성, 답장 안 함 and 삭제", async () => {
			await openList(v, false);
			const box = await q<{ card: DOMRect; btn: DOMRect }[]>(v, `return [...document.querySelectorAll("#mon-tl .mr")].map(r => ({ card: r.getBoundingClientRect().toJSON(), btn: r.querySelector(".mr-more").getBoundingClientRect().toJSON() }))`);
			expect(box.length).toBe(2);   // 전체 is the received mail; the sent one is under 보낸 메일
			expect(await q<boolean>(v, `return !!${row("mail:loc-3")}`)).toBe(false);
			expect(await q<boolean>(v, `return document.querySelector("#mon-tl").textContent.includes("지운 메일에 봇이 남긴 말")`)).toBe(false);
			for (const { card, btn } of box) {
				expect(card.right - btn.right).toBeLessThanOrEqual(16);
				expect(btn.top - card.top).toBeLessThanOrEqual(12);
			}
			await run(v, `${row("mail:loc-1")}.querySelector(".mr-more").click()`);
			await waitFor(v, `document.querySelector(".menu .mi")`);
			expect(await menuLabels(v)).toEqual(["초안 작성", "답장 안 함", "삭제"]);
			expect(await q<string>(v, `return location.hash`)).not.toContain("c:");   // the tap opened the menu, not the mail
			expect(await q<boolean>(v, `return document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
			await shot(v, `mail-menu-${width}.png`);
			await run(v, `closeMenu()`);
		});

		test("every incoming mail offers the same actions by its state, an outgoing one only 삭제, and the row buttons follow one rule", async () => {
			await openList(v, false);
			expect(await menuOf(v, "mail:loc-2")).toEqual(["초안 작성", "답장 필요로 표시", "삭제"]);
			expect(await inlineOf(v, "mail:loc-1")).toEqual(["초안 작성", "답장 안 함"]);
			expect(await inlineOf(v, "mail:loc-2")).toEqual([]);
			// 답장 필요로 표시 on a mail with no state makes it 답장 필요, with the same buttons as every owed row
			await pick(v, "mail:loc-2", "답장 필요로 표시");
			await waitFor(v, `${row("mail:loc-2")}.querySelector(".rc-hd .tag")?.textContent === "답장 필요"`);
			expect(await inlineOf(v, "mail:loc-2")).toEqual(["초안 작성", "답장 안 함"]);
			expect(reqs.map(r => [r.method, r.path])).toEqual([["DELETE", "/api/mail/loc-2/fyi"]]);
			// the sent mail, under 보낸 메일: only 삭제, no row buttons
			await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="sent"]').click()`);
			await waitFor(v, `${row("mail:loc-3")} && !${row("mail:loc-2")}`);
			expect(await menuOf(v, "mail:loc-3")).toEqual(["삭제"]);
			expect(await inlineOf(v, "mail:loc-3")).toEqual([]);
			await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="all"]').click()`);
		});

		test("답장 안 함 updates the row, the 답장 필요 filter and the 미답장 badge at once, survives a reload, and can be undone", async () => {
			await openList(v, false);
			expect(await stateOf(v, "mail:loc-1")).toBe("답장 필요");
			await pick(v, "mail:loc-1", "답장 안 함");
			await waitFor(v, `${row("mail:loc-1")}.querySelector(".rc-hd .tag").textContent === "답장 안 함"`);
			expect(await q<string>(v, `return document.querySelector('#mon-tl .mr-f[data-filter="owed"]').textContent`)).toBe("답장 필요");
			await waitFor(v, `!document.querySelector('#mon-side .cv-row[data-k="i:mail"] .nb.unreplied')`);
			expect(await q<number>(v, `return ${row("mail:loc-1")}.querySelectorAll(".mr-slot .unrep-no, .tag.unreplied").length`)).toBe(0);
			expect(reqs.map(r => [r.method, r.path])).toEqual([["POST", "/api/mail/loc-1/fyi"]]);

			await openList(v, false);
			expect(await stateOf(v, "mail:loc-1")).toBe("답장 안 함");
			await pick(v, "mail:loc-1", "답장 필요로 표시");
			await waitFor(v, `${row("mail:loc-1")}.querySelector(".rc-hd .tag").textContent === "답장 필요"`);
			await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"] .nb.unreplied')`);
			expect(reqs.at(-1)).toMatchObject({ method: "DELETE", path: "/api/mail/loc-1/fyi" });
		});

		test("삭제 asks first, removes the mail from the list, and it stays gone after a reload", async () => {
			await openList(v, false);
			await pick(v, "mail:loc-2", "삭제");
			await confirmDelete(v);
			await waitFor(v, `!${row("mail:loc-2")}`);
			expect(reqs.map(r => [r.method, r.path])).toEqual([["DELETE", "/api/mail/loc-2"]]);
			await openList(v, false);
			expect(await stateOf(v, "mail:loc-2")).toBe("gone");
			expect(await q<number>(v, `return document.querySelectorAll("#mon-tl .mr").length`)).toBe(1);
		});

		test("a peer's mail: the mark, its undo and 삭제 each go once to the computer that holds it", async () => {
			await openList(v, true);
			await pick(v, "mail:peer-1", "답장 안 함");
			await waitFor(v, `${row("mail:peer-1")}.querySelector(".rc-hd .tag").textContent === "답장 안 함"`);
			await pick(v, "mail:peer-1", "답장 필요로 표시");
			await waitFor(v, `${row("mail:peer-1")}.querySelector(".rc-hd .tag").textContent === "답장 필요"`);
			await pick(v, "mail:peer-2", "삭제");
			await confirmDelete(v);
			await waitFor(v, `!${row("mail:peer-2")}`);
			expect(reqs.map(r => [r.method, r.path, r.body?.action, r.body?.args])).toEqual([
				["POST", "/api/peer/proxy", "fyi", { key: "peer-1", on: true }],
				["POST", "/api/peer/proxy", "fyi", { key: "peer-1", on: false }],
				["POST", "/api/peer/proxy", "mail-delete", { key: "peer-2" }],
			]);
			await openList(v, true);
			expect(await stateOf(v, "mail:peer-2")).toBe("gone");
			expect(await q<string[]>(v, `return [...document.querySelectorAll("#mon-tl .mr .rc-title")].map(t => t.textContent)`)).toEqual(["견적 문의드립니다"]);
		});

		test("the card at the top of a mail's conversation has the same ⋯", async () => {
			await openList(v, false);
			await run(v, `${row("mail:loc-1")}.click()`);
			await waitFor(v, `current === "chat" && monCtx === "mail:loc-1"`);
			await run(v, `ingestMsg({ ts: "${iso(9)}", kind: "mail", conv: "mail:loc-1", mail: "loc-1", subject: "계약서 확인 부탁드립니다", from: "Kim <kim@example.com>", text: "Kim · 계약서 확인 부탁드립니다\\n\\n금요일까지 회신 부탁드려요." })`);
			await waitFor(v, `[...document.querySelectorAll(".bm.rc:not(.mr) .rc-hd .mr-more")].find(b => b.offsetParent)`);
			// the conversation finishes loading (its thread panel) before the tap: the ⋯ has kept the same place for 10 frames
			await waitFor(v, `(() => { const b = [...document.querySelectorAll(".bm.rc:not(.mr) .rc-hd .mr-more")].find(b => b.offsetParent), y = b && b.getBoundingClientRect().top; window.__mm = window.__mm && window.__mm.y === y ? { y, n: window.__mm.n + 1 } : { y, n: 0 }; return window.__mm.n >= 10; })()`);
			await run(v, `[...document.querySelectorAll(".bm.rc:not(.mr) .rc-hd .mr-more")].find(b => b.offsetParent).click()`);
			await waitFor(v, `document.querySelector(".menu .mi")`);
			expect(await menuLabels(v)).toEqual(["초안 작성", "답장 안 함", "삭제"]);
			const at = await q<{ a: DOMRect; m: DOMRect }>(v, `return { a: openMenu.anchor.getBoundingClientRect().toJSON(), m: document.querySelector(".menu").getBoundingClientRect().toJSON() }`);
			expect(at.a.width).toBeGreaterThan(0);
			expect(Math.abs(at.m.top - at.a.bottom)).toBeLessThanOrEqual(12);
			await shot(v, `mail-conv-menu-${width}.png`);
			await run(v, `closeMenu()`);
		});
	});
}
