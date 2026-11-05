import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// A big backlog stays readable: 답장 대기 (web/js/30-replies.js) says what each row is about, counts per app, shows what is being sent, updates by key without
// moving the reader and draws at most a page of rows per section; the mail list (30-monitoring.js monChronoNodes, 30-mail-box.js) draws 100 mails at a time.
setDefaultTimeout(30_000);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const app = (key: string, label: string, extra: object = {}) => ({ key, app: key, label, icon: "chat", kind: "app", unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 }, ...extra });
const CAN = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"];
type Mail = { key: string; subject: string; at: string };
let mails: Mail[] = [];
let notices: object[] = [];
const mkMails = (n: number): Mail[] => Array.from({ length: n }, (_, i) => ({ key: `m${i}`, subject: `메일 ${i}`, at: ago(i + 1) }));
const sendingNotice = (id: string, state: string) => ({
	id, ts: ago(1), updated: ago(1), kind: "decision", tone: "ok", title: "답장을 보냈어요", text: "보냈어요", open: "mail:s", src: "mail:s", at: ago(1), read: true,
	decision: { options: [{ n: 1, label: "보내기", desc: "", rec: true }], to: "mail:s", state: "closed", answer: "1) 보내기", send: { state, at: ago(1) }, draft: { toLabel: "받는이", to: "Kim <kim@example.com>", subject: "Re: 견적", body: "안녕하세요.", ref: `ref-${id}` } },
});

const hub = fakeHub({
	api: (req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: notices, unread: 0 });
		if (p === "/api/approvals") return json({ groups: [], results: [], triageMin: 3 });
		if (p === "/api/integrations") return json({ items: [app("mail", "메일", { icon: "mail", conv: ["mail:"] }), app("youtube", "유튜브"), app("instagram", "인스타그램")], available: [] });
		if (p === "/api/conversations") return json({ items: mails.map(m => ({ target: `mail:${m.key}`, unread: 0, read: null, mail: { subject: m.subject, from: "Kim <kim@example.com>", source: "kdb", at: m.at, summary: "요약", read: true, archived: false, starred: false, can: CAN }, last: { ts: m.at, text: m.subject, from: "bot" } })) });
		return undefined;
	},
});
afterAll(() => hub.stop());

const boot = async (): Promise<View> => {
	const v = await hub.view({ width: 1280, height: 900 });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof rqAll === "function" && NT.loaded && RQ.loaded && INTG.items.length === 3`);
	return v;
};
const comments = (n: number, appKey = "youtube", extra: object = {}) => Array.from({ length: n }, (_, i) => ({
	kind: "comment", app: appKey, via: appKey, code: `${appKey}${i}`, thread: "p", to: "가나", title: `영상 ${i}`, text: "답", at: Date.now() - 60_000 - i * 1000,
	original: { who: "가나", text: `댓글 ${i}` }, attachmentsNone: true, cannotAttach: [], ...extra,
}));
const seed = (v: View, list: object[], failed: object[] = []) => run(v, `RQ.local = ${JSON.stringify(list)}; RQ.failed = ${JSON.stringify(failed)}; RQ.loaded = true; MON.sig = ""; go("monitoring", "replies")`);
const repaint = (v: View, list: object[]) => run(v, `RQ.local = ${JSON.stringify(list)}; MON.sig = ""; renderMonitoring()`);
const rows = (v: View) => ev<number>(v, `document.querySelectorAll("#mon-tl .rq-r.ask").length`);

describe("답장 대기 with a big backlog", () => {
	test("a mail row names its mail, a comment row its post or comment", async () => {
		const v = await boot();
		const what = await ev<string[]>(v, `(() => {
			MAILS.set("mail:zz", { subject: "레슨 안내 문의", from: "Kim <kim@example.com>" });
			const n = { id: "z1", title: "이 답장 보낼까요? (RSE1)", decision: { to: "mail:zz", options: [], draft: { ref: "r1", subject: "Re: 레슨 안내 문의" } } };
			const mail = rqAskRow({ key: "n:|z1", kind: "notice", inst: "mail", label: "메일", pc: null, at: 1, n }).what;
			const post = rqAskRow({ key: "comment:|c1", kind: "comment", inst: "youtube", label: "유튜브", pc: null, at: 1, d: { kind: "comment", code: "c1", title: "첫 번째 영상", original: { who: "가나", text: "자막 언제?" } } }).what;
			const text = rqAskRow({ key: "comment:|c2", kind: "comment", inst: "youtube", label: "유튜브", pc: null, at: 1, d: { kind: "comment", code: "c2", title: "", original: { who: "가나", text: "자막 언제?" } } }).what;
			return [mail, post, text];
		})()`);
		expect(what).toEqual(["레슨 안내 문의", "첫 번째 영상", "자막 언제?"]);
	});

	test("the app chips with their counts show while two or more apps wait and the count reaches the triage minimum", async () => {
		const v = await boot();
		await seed(v, [...comments(2, "youtube"), ...comments(2, "instagram")]);
		await waitFor(v, `document.querySelector("#mon-tl .rq-r")`);
		const chips = () => ev<string[][]>(v, `[...document.querySelectorAll("#mon-tl .rq-filter .mr-f")].map(b => [b.dataset.filter, b.querySelector(".mr-fn") ? b.querySelector(".mr-fn").textContent : ""]).sort()`);
		expect(await chips()).toEqual([["all", "4"], ["|instagram", "2"], ["|youtube", "2"]]);
		await run(v, `document.querySelector('#mon-tl .rq-filter .mr-f[data-filter="|youtube"]').click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-r.ask").length === 2`);
		await repaint(v, comments(4, "youtube"));
		await run(v, `RQ.app = ""; MON.sig = ""; renderMonitoring()`);
		expect(await ev<number>(v, `document.querySelectorAll("#mon-tl .rq-filter").length`)).toBe(0);
	});

	test("the meta line counts replies queued or sending", async () => {
		notices = [sendingNotice("s1", "sending"), sendingNotice("s2", "queued"), sendingNotice("s3", "sent")];
		const v = await boot();
		await seed(v, comments(1));
		await waitFor(v, `document.querySelector("#mon-tl .rq-qm .meta") && document.querySelector("#mon-tl .rq-qm .meta").textContent.includes("보내는 중 2건")`);
		notices = [];
	});

	test("the meta line counts the gateway's own queued or sending sends when no notice holds them, and drops them once sent", async () => {
		notices = [];
		const v = await boot();
		await run(v, `TR.results = { a: { ref: "a", state: "queued", at: Date.now() }, b: { ref: "b", state: "sending", at: Date.now() }, c: { ref: "c", state: "queued", at: Date.now() }, d: { ref: "d", state: "sent", at: Date.now() } }`);
		await seed(v, comments(1));
		await waitFor(v, `document.querySelector("#mon-tl .rq-qm .meta") && document.querySelector("#mon-tl .rq-qm .meta").textContent.includes("보내는 중 3건")`);
		await run(v, `for (const ref of ["a", "b", "c"]) trLive({ ref, state: "sent", at: Date.now() }); rqSoon()`);
		await waitFor(v, `!document.querySelector("#mon-tl .rq-qm .meta").textContent.includes("보내는 중")`);
	});

	test("a send the gateway no longer holds stops counting on the next load, so a lost frame leaves no 보내는 중 behind", async () => {
		notices = [];
		const v = await boot();
		await run(v, `TR.results = { gone: { ref: "gone", state: "sending", at: Date.now() }, done: { ref: "done", state: "sent", at: Date.now() } }`);
		await seed(v, comments(1));
		await waitFor(v, `document.querySelector("#mon-tl .rq-qm .meta") && document.querySelector("#mon-tl .rq-qm .meta").textContent.includes("보내는 중 1건")`);
		await run(v, `trLoad()`);
		await waitFor(v, `!document.querySelector("#mon-tl .rq-qm .meta").textContent.includes("보내는 중")`);
		expect(await ev<string>(v, `TR.results.done.state`)).toBe("sent");
	});

	test("a live update keeps the row nodes and the reader's place", async () => {
		const v = await boot();
		const list = comments(458);
		await seed(v, list);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-r.ask").length > 100`);
		const probe = `(() => { const box = $("#mon-timeline"), top = box.getBoundingClientRect().top, r = [...document.querySelectorAll("#mon-tl .rq-r")].find(e => e.getBoundingClientRect().bottom > top); return { key: r.dataset.qr, off: r.getBoundingClientRect().top - top, st: box.scrollTop }; })()`;
		await run(v, `window.__keep = [...document.querySelectorAll("#mon-tl .rq-r")].slice(0, 40); $("#mon-timeline").scrollTop = 1500; window.__n = 0; window.__mo = new MutationObserver(() => {}); __mo.observe(rqUi().ls, { childList: true, subtree: true })`);
		const before = await ev<{ key: string; off: number; st: number }>(v, probe);
		expect(before.st).toBeGreaterThan(0);
		await repaint(v, [...comments(1, "youtube", { code: "NEW", at: Date.now(), title: "새 영상" }), ...list]);
		const added = await ev<number>(v, `__mo.takeRecords().reduce((c, r) => c + r.addedNodes.length, 0)`);
		const after = await ev<{ key: string; off: number; st: number }>(v, probe);
		expect(after.key).toBe(before.key);
		expect(Math.abs(after.off - before.off)).toBeLessThan(2);
		expect(added).toBeLessThanOrEqual(6);
		expect(await ev<boolean>(v, `__keep.every(n => n.isConnected)`)).toBe(true);
		// at the very top a new row just shows there
		await run(v, `$("#mon-timeline").scrollTop = 0`);
		await repaint(v, [...comments(1, "youtube", { code: "NEW2", at: Date.now() + 1000, title: "더 새 영상" }), ...comments(1, "youtube", { code: "NEW", at: Date.now(), title: "새 영상" }), ...list]);
		expect(await ev<string>(v, `document.querySelector("#mon-tl .rq-r").dataset.qr`)).toBe("comment:|NEW2");
	});

	test("a section draws a page of rows, 더 보기 adds a page, the counts stay full and failed rows all show", async () => {
		const v = await boot();
		const failed = Array.from({ length: 250 }, (_, i) => ({ key: `F${i}`, kind: "mail", app: "mail", who: "Kim", what: `견적 ${i}`, at: Date.now() - i * 1000, why: `이유 ${i}` }));
		await seed(v, comments(458), failed);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-r.ask").length > 0`);
		expect(await rows(v)).toBe(200);
		expect(await ev<number>(v, `document.querySelectorAll("#mon-tl .rq-r.fail").length`)).toBe(250);
		expect(await ev<string[]>(v, `[...document.querySelectorAll(".rq-tabs .n")].map(n => n.textContent)`)).toEqual(["", "458", "250", ""]);
		await run(v, `document.querySelector("#mon-tl .rq-ls .cv-more").click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-r.ask").length === 400`);
		await run(v, `document.querySelector("#mon-tl .rq-ls .cv-more").click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-r.ask").length === 458`);
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
		await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="archived"]').click()`);
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
