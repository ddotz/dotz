import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// A big backlog stays readable: 답장 대기 (web/js/30-replies.js, the one reply queue) counts per app, shows what is being sent, updates by key without
// moving the reader and draws at most a page of cards per section; the mail list (30-monitoring.js monChronoNodes, 30-mail-box.js) draws 100 mails at a time.
setDefaultTimeout(30_000);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const app = (key: string, label: string, extra: object = {}) => ({ key, app: key, label, icon: "chat", kind: "app", unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 }, ...extra });
const CAN = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"];
type Mail = { key: string; subject: string; at: string };
let mails: Mail[] = [];
let notices: object[] = [];
const mkMails = (n: number): Mail[] => Array.from({ length: n }, (_, i) => ({ key: `m${i}`, subject: `메일 ${i}`, at: ago(i + 1) }));
// One item of the reply queue (GET /api/reply/queue); `send` puts it in the undo window, on its way, sent or failed.
const qItem = (ref: string, appKey: string, label: string, at: number, extra: object = {}) => ({ item: `${appKey}:${ref}`, ref, kind: "comment", app: appKey, label, conv: `i:${appKey}`, at,
	can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "대상", to: "가나", text: `답 ${ref}` }, original: { who: "가나", text: `댓글 ${ref}` }, ...extra });
let queue: object[] = [];

const hub = fakeHub({
	api: (req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: notices, unread: 0 });
		if (p === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 3, undoSec: 10 });
		if (p === "/api/integrations") return json({ items: [app("mail", "메일", { icon: "mail", conv: ["mail:"] }), app("youtube", "유튜브"), app("instagram", "인스타그램")], available: [] });
		if (p === "/api/conversations") return json({ items: mails.map(m => ({ target: `mail:${m.key}`, unread: 0, read: null, mail: { subject: m.subject, from: "Kim <kim@example.com>", source: "acme", at: m.at, summary: "요약", read: true, archived: false, starred: false, can: CAN }, last: { ts: m.at, text: m.subject, from: "bot" } })) });
		return undefined;
	},
});
afterAll(() => hub.stop());

const boot = async (): Promise<View> => {
	const v = await hub.view({ width: 1280, height: 900 });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof rqRows === "function" && NT.loaded && RQ.loaded && RA.loaded && INTG.items.length === 3`);
	return v;
};
const comments = (n: number, appKey = "youtube", label = "유튜브", extra: object = {}) => Array.from({ length: n }, (_, i) => qItem(`${appKey}${i}`, appKey, label, Date.now() - 60_000 - i * 1000, extra));
// The queue the hub answers, read again and drawn on 답장 대기.
const seed = async (v: View, list: object[]) => { queue = list; await run(v, `rqLoad().then(() => { MON.sig = ""; go("monitoring", "replies"); })`); };
const repaint = async (v: View, list: object[]) => { queue = list; await run(v, `rqLoad()`); };
const sending = { state: "sending", at: Date.now(), actions: [] };

describe("답장 대기 with a big backlog", () => {
	test("the app filter is one 앱 select with each app's count in its menu, shown while two or more apps wait and the count reaches the triage minimum", async () => {
		const v = await boot();
		await seed(v, [...comments(2, "youtube", "유튜브"), ...comments(2, "instagram", "인스타그램")]);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-c").length === 4`);
		const sel = `document.querySelectorAll("#mon-tl .rq-chips .sel")`;
		expect(await ev<number[]>(v, `[${sel}.length, document.querySelectorAll("#mon-tl .rq-chips .mr-f").length, document.querySelectorAll("#mon-tl .rq-tabs").length]`)).toEqual([1, 0, 1]);
		expect(await ev<string>(v, `${sel}[0].getAttribute("aria-label")`)).toBe("앱: 전체");
		await run(v, `${sel}[0].click()`);
		await waitFor(v, `document.querySelectorAll(".menu [role=option]").length === 3`);
		expect(await ev<string[]>(v, `[...document.querySelectorAll(".menu [role=option] .ml")].map(x => x.textContent)`)).toEqual(["전체 · 4", "유튜브 · 2", "인스타그램 · 2"]);
		await run(v, `document.querySelectorAll(".menu [role=option]")[1].click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-c").length === 2`);
		await repaint(v, comments(4));
		await run(v, `RQ.app = ""; MON.sig = ""; renderMonitoring()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-chips .sel").length === 0`);
	});

	test("the meta line counts the queue's replies in their undo window, queued or sending, and drops them once the queue says sent", async () => {
		const v = await boot();
		const out = (state: string) => ({ send: { ...sending, state }, draft: { state: "approved", toLabel: "대상", to: "가나", text: "답" } });
		await seed(v, [...comments(1), qItem("s1", "youtube", "유튜브", Date.now(), out("sending")), qItem("s2", "youtube", "유튜브", Date.now(), out("queued")), qItem("s3", "youtube", "유튜브", Date.now(), out("undo")), qItem("s4", "youtube", "유튜브", Date.now(), out("sent"))]);
		await waitFor(v, `document.querySelector("#mon-tl .rq-qm .meta") && document.querySelector("#mon-tl .rq-qm .meta").textContent.includes("보내는 중 3건")`);
		await repaint(v, [...comments(1), ...["s1", "s2", "s3", "s4"].map(r => qItem(r, "youtube", "유튜브", Date.now(), out("sent")))]);
		await waitFor(v, `!document.querySelector("#mon-tl .rq-qm .meta").textContent.includes("보내는 중")`);
	});

	test("a live update keeps the card nodes and the reader's place", async () => {
		const v = await boot();
		const list = comments(458);
		await seed(v, list);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-c").length > 100`);
		const probe = `(() => { const box = $("#mon-timeline"), top = box.getBoundingClientRect().top, r = [...document.querySelectorAll("#mon-tl .rq-c")].find(e => e.getBoundingClientRect().bottom > top); return { key: r.dataset.qr, off: r.getBoundingClientRect().top - top, st: box.scrollTop }; })()`;
		await run(v, `window.__keep = [...document.querySelectorAll("#mon-tl .rq-c")].slice(0, 40); $("#mon-timeline").scrollTop = 3000; window.__mo = new MutationObserver(() => {}); __mo.observe(rqUi().ls, { childList: true, subtree: true })`);
		const before = await ev<{ key: string; off: number; st: number }>(v, probe);
		expect(before.st).toBeGreaterThan(0);
		await repaint(v, [...comments(1, "youtube", "유튜브", { ref: "NEW", item: "youtube:NEW", at: Date.now() }), ...list]);
		await waitFor(v, `document.querySelector('#mon-tl .rq-c[data-qr="i:|NEW"]')`);
		const after = await ev<{ key: string; off: number; st: number }>(v, probe);
		expect(after.key).toBe(before.key);
		expect(Math.abs(after.off - before.off)).toBeLessThan(2);
		expect(await ev<boolean>(v, `__keep.every(n => n.isConnected)`)).toBe(true);
	});

	test("a section draws a page of cards, 더 보기 adds a page, the counts stay full and failed cards all show", async () => {
		const v = await boot();
		const failed = Array.from({ length: 250 }, (_, i) => qItem(`F${i}`, "mail", "메일", Date.now() - i * 1000, { send: { state: "failed", at: Date.now(), reason: { code: "offline", text: `이유 ${i}` }, actions: ["retry"] } }));
		await seed(v, [...comments(458), ...failed]);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-c").length > 0`);
		const ask = `document.querySelectorAll("#mon-tl .rq-c:not(:has(.rq-send))").length`;
		expect(await ev<number>(v, `document.querySelectorAll("#mon-tl .rq-c").length`)).toBe(450);
		expect(await ev<number>(v, `document.querySelectorAll("#mon-tl .rq-c:has(.rq-send.failed)").length`)).toBe(250);
		expect(await ev<number>(v, ask)).toBe(200);
		expect(await ev<string[]>(v, `[...document.querySelectorAll(".rq-tabs .n")].map(n => n.textContent)`)).toEqual(["", "458", "250", ""]);
		await run(v, `document.querySelector("#mon-tl .rq-ls .cv-more").click()`);
		await waitFor(v, `${ask} === 400`);
		await run(v, `document.querySelector("#mon-tl .rq-ls .cv-more").click()`);
		await waitFor(v, `${ask} === 458`);
		expect(await ev<number>(v, `document.querySelectorAll("#mon-tl .rq-ls .cv-more").length`)).toBe(0);
	});
});

describe("메일 목록 with 2,000 mails", () => {
	const openList = async (): Promise<View> => {
		mails = mkMails(2000);
		const v = await boot();
		await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
		await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
		await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
		await waitFor(v, `document.querySelector("#mon-tl > .mr") && document.querySelector("#mbox-bar") && MBOX.vis.length === 2000`);
		return v;
	};
	const drawn = (v: View) => ev<number>(v, `document.querySelectorAll("#mon-tl > .mr").length`);

	test("draws 100 mails, 더 보기 adds 100, select-all and the count cover all 2,000", async () => {
		const v = await openList();
		expect(await drawn(v)).toBe(100);
		await run(v, `document.querySelector("#mon-tl [data-mb-more]").click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl > .mr").length === 200`);
		expect(await ev<string>(v, `document.querySelector(".mbox-n").textContent`)).toBe("메일 2000개");
		await run(v, `document.querySelector(".mbox-all").click()`);
		expect(await ev<number>(v, `MBOX.sel.size`)).toBe(2000);
	});

	test("a live new mail keeps the drawn count; a filter change resets it to 100", async () => {
		const v = await openList();
		await run(v, `document.querySelector("#mon-tl [data-mb-more]").click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl > .mr").length === 200`);
		mails = [{ key: "live", subject: "새 메일", at: new Date().toISOString() }, ...mails];
		await run(v, `convLoad()`);
		await waitFor(v, `CONV.has("mail:live")`, 3000);
		await waitFor(v, `MBOX.vis.includes("mail:live")`, 3000);
		expect(await drawn(v)).toBe(200);
		expect(await ev<number>(v, `MBOX.drawn`)).toBe(200);
		await run(v, `document.querySelector('#mon-tl [data-filter="archived"]').click()`);
		await waitFor(v, `MON.mailFilter === "archived" && MBOX.drawn === 100`);
	});

	const more = async (v: View) => {
		await run(v, `document.querySelector("#mon-tl [data-mb-more]").click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl > .mr").length === 200`);
	};
	const firstInView = `(() => { const box = $("#mon-timeline"), top = box.getBoundingClientRect().top, r = [...document.querySelectorAll("#mon-tl > .mr")].find(e => e.getBoundingClientRect().bottom > top); return { t: r.dataset.t, off: r.getBoundingClientRect().top - top, st: box.scrollTop }; })()`;

	test("a new mail keeps the first row in view where it was and redraws only the rows that changed", async () => {
		const v = await openList();
		await more(v);
		await run(v, `$("#mon-timeline").scrollTop = 2000`);
		const before = await ev<{ t: string; off: number; st: number }>(v, firstInView);
		expect(before.st).toBeGreaterThan(0);
		await run(v, `window.__keep = [...document.querySelectorAll("#mon-tl > .mr")].slice(0, 150); window.__mo = new MutationObserver(() => {}); __mo.observe(document.getElementById("mon-tl"), { childList: true })`);
		mails = [{ key: "live", subject: "새 메일", at: ago(0) }, ...mails];
		await run(v, `convLoad()`);
		await waitFor(v, `MBOX.vis.includes("mail:live") && document.querySelector('#mon-tl > .mr[data-t="mail:live"]')`, 3000);
		const rowsMoved = await ev<number>(v, `__mo.takeRecords().reduce((c, r) => c + [...r.addedNodes, ...r.removedNodes].filter(n => n.classList && n.classList.contains("mr")).length, 0)`);
		const after = await ev<{ t: string; off: number; st: number }>(v, firstInView);
		expect(after.t).toBe(before.t);
		expect(Math.abs(after.off - before.off)).toBeLessThan(2);
		expect(rowsMoved).toBeLessThanOrEqual(6);
		expect(await ev<boolean>(v, `__keep.slice(0, 149).every(n => n.isConnected)`)).toBe(true);
	});

	test("at the top a new mail just shows there", async () => {
		const v = await openList();
		mails = [{ key: "live2", subject: "맨 위 메일", at: ago(0) }, ...mails];
		await run(v, `convLoad()`);
		await waitFor(v, `document.querySelector("#mon-tl > .mr").dataset.t === "mail:live2"`, 3000);
		expect(await ev<number>(v, `$("#mon-timeline").scrollTop`)).toBe(0);
	});

	test("더 보기 keeps the first 100 row nodes", async () => {
		const v = await openList();
		await run(v, `window.__keep = [...document.querySelectorAll("#mon-tl > .mr")]`);
		await more(v);
		expect(await ev<boolean>(v, `__keep.length === 100 && __keep.every((n, i) => document.querySelectorAll("#mon-tl > .mr")[i] === n)`)).toBe(true);
	});

	test("a selected row and an unread change redraw that row, the rest stay", async () => {
		const v = await openList();
		const row = (t: string) => `document.querySelector('#mon-tl > .mr[data-t="${t}"]')`;
		const redraw = (js: string) => run(v, `${js}; MON.sig = ""; renderMonitoring()`);
		await run(v, `window.__other = ${row("mail:m6")}`);
		await redraw(`MBOX.sel.add("mail:m5")`);
		expect(await ev<boolean>(v, `${row("mail:m5")}.classList.contains("mr-sel") && ${row("mail:m5")}.querySelector(".mr-chk").checked`)).toBe(true);
		await redraw(`MAILS.get("mail:m5").read = false`);
		expect(await ev<boolean>(v, `${row("mail:m5")}.classList.contains("mr-new") && !!${row("mail:m5")}.querySelector(".mr-unread") && ${row("mail:m5")}.classList.contains("mr-sel")`)).toBe(true);
		await redraw(`MAILS.get("mail:m5").read = true; MBOX.sel.delete("mail:m5")`);
		expect(await ev<boolean>(v, `!${row("mail:m5")}.classList.contains("mr-new") && !${row("mail:m5")}.classList.contains("mr-sel") && ${row("mail:m6")} === __other`)).toBe(true);
	});

	test("the 확인 대기 filter is not picked again by a live update", async () => {
		const v = await openList();
		await run(v, `MON.mailFilter = "owed"`);
		mails = [{ key: "live3", subject: "또 새 메일", at: ago(0) }, ...mails];
		await run(v, `convLoad()`);
		await waitFor(v, `CONV.has("mail:live3")`, 3000);
		await run(v, `MON.sig = ""; renderMonitoring()`);
		expect(await ev<string>(v, `MON.mailFilter`)).toBe("owed");
	});
});
