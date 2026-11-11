import { afterAll, expect, test } from "bun:test";
import { fakeHub, json } from "./test-web.ts";

// The browser's back button as the stack of what was showing (web/js/32-history-nav.js): a press beside the view (another tab, another item)
// stacks an entry, and back returns to the view that was showing. Real history.back() in a headless Bun.WebView against a small fake hub;
// every step awaits the popstate it caused and then the exact state, never a sleep.
const now = new Date().toISOString();
const MAIL = (n: number, subject: string) => ({ subject, from: "Alex <alex@example.com>", source: "fx", at: now, summary: "요약", n });
const KK_ROOMS = [100, 200].map(n => ({ chatId: String(n), name: `방 ${n}`, kind: "group", watched: true, autoDraft: false, unread: 0, lastAt: Date.now() }));
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		if (url.pathname === "/api/monitors") return json({ items: [] });
		if (url.pathname === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", conv: ["mail:"], unread: 0, notices: [] }, { key: "kakao", label: "카카오톡", icon: "chat", kind: "app", conv: [], notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } }, { key: "youtube", label: "유튜브", icon: "youtube", kind: "app", conv: [], notices: [], unread: 0, needs: { drafts: 0, unread: 0, sentToday: 0 } }] });
		if (url.pathname === "/api/comments/sources") return json({ on: true, sources: [{ key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, autoSend: false, error: null, ranAt: Date.now() }] });
		if (url.pathname === "/api/comments/threads") return json({ threads: ["v1", "v2"].map(t => ({ source: "youtube", thread: t, title: `영상 ${t}`, link: "https://video.example/" + t, lastAt: Date.now(), lastText: "댓글", lastAuthor: "가나", unread: 0, drafts: 0 })) });
		const ct = /^\/api\/comments\/thread\/youtube\/(\w+)$/.exec(url.pathname);
		if (ct) return json({ source: { key: "youtube", kind: "youtube", label: "유튜브 댓글" }, thread: { id: ct[1], title: `영상 ${ct[1]}`, link: "https://video.example/" + ct[1] }, comments: [{ id: "cm:youtube:c1", parent: null, author: "가나", text: "잘 봤어요", at: Date.now(), mine: false, needsReply: false }], read: null, drafts: [], sends: [] });
		if (url.pathname === "/api/kakao/rooms") return json({ on: true, rooms: KK_ROOMS });
		const kc = /^\/api\/kakao\/chat\/(\w+)$/.exec(url.pathname);
		if (kc) return json({ room: KK_ROOMS.find(r => r.chatId === kc[1]), messages: [{ logId: "3001", authorId: "u1", sender: "가나", text: "안녕하세요", type: 1, sentAt: Date.now(), fromMe: false, unread: 0 }], read: null, drafts: [], sends: [], kakaoUnread: 0 });
		if (url.pathname === "/api/conversations") return json({ items: Array.from({ length: 40 }, (_, i) => ({ target: `mail:fx-${i}`, unread: 0, last: { ts: now, text: `메일 ${i}`, from: "bot" }, mail: MAIL(i, `메일 ${i}`) })) });
	},
});
afterAll(() => hub.stop());

type V = InstanceType<typeof Bun.WebView>;
const until = (v: V, cond: string, what: string) => v.evaluate(`new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = (${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > 10000) rej(new Error(${JSON.stringify(what)})); else requestAnimationFrame(tick); }; tick(); })`);
const ev = async <T>(v: V, code: string) => JSON.parse((await v.evaluate(`JSON.stringify(${code})`)) as string) as T;
// history.back() and the popstate it causes, then the view the page settled on
const back = async (v: V) => {
	await v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("no popstate")), 8000); addEventListener("popstate", () => { clearTimeout(t); res(true); }, { once: true }); history.back(); })`);
};
const tab = (v: V, k: string) => v.evaluate(`document.querySelector('#nav .ni[data-view="${k}"]').click()`);
const where = (v: V) => ev<{ cur: string; hash: string; len: number }>(v, `({ cur: current, hash: location.hash, len: history.length })`);
async function open(width: number, hash = "home") {
	const v = await hub.view({ width, height: 900 });
	await v.navigate(`${hub.origin}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`${hub.origin}/?light#${hash}`);
	await until(v, `typeof go === "function" && typeof INTG !== "undefined" && CV.loaded && current === ${JSON.stringify(hash.split("/")[0])}`, "page not ready");
	return v;
}
const MAIL_LIST = "#monitoring/i%3Amail";

test("390: back after another tab returns to the mail item that was showing, then its list, then 홈", async () => {
	const v = await open(390);
	const len0 = (await where(v)).len;
	await tab(v, "monitoring");
	await until(v, `current === "monitoring"`, "monitoring not shown");
	await v.evaluate(`go("monitoring", "i:mail")`);
	await until(v, `current === "monitoring" && MON.sel === "i:mail" && location.hash === ${JSON.stringify(MAIL_LIST)} && document.querySelectorAll("#mon-tl .mr").length > 0`, "mail list not shown");
	await v.evaluate(`document.querySelector("#mon-tl .mr").click()`);
	await until(v, `current === "chat" && monCtx && location.hash.startsWith("#monitoring/c:")`, "mail not opened");
	const mailHash = (await where(v)).hash;
	await tab(v, "settings");
	await until(v, `current === "settings"`, "settings not shown");
	expect((await where(v)).len - len0).toBe(4);   // 모니터링, list, mail, 설정: one entry each, no entry twice for one press

	await back(v);
	await until(v, `current === "chat" && monCtx && location.hash === ${JSON.stringify(mailHash)}`, "back did not return to the mail");
	await back(v);
	await until(v, `current === "monitoring" && MON.sel === "i:mail" && location.hash === ${JSON.stringify(MAIL_LIST)}`, "back did not return to the mail list");
	await back(v);
	await until(v, `current === "monitoring" && MON.list`, "back did not return to the monitoring list");
	await back(v);
	await until(v, `current === "home"`, "back did not return to 홈");
	expect((await where(v)).len - len0).toBe(4);   // going back adds no entry
});

test("390: back after a tab keeps the list scroll of the screen that was showing", async () => {
	const v = await open(390, "monitoring/i:mail");
	await until(v, `current === "monitoring" && document.querySelectorAll("#mon-tl .mr").length === 40`, "mail list not drawn");
	const top = await ev<number>(v, `(() => { const s = [...document.querySelectorAll("#mon-tl .mr")][0].closest("#mon-timeline, .views, #v-monitoring") || document.scrollingElement; s.scrollTop = 600; return s.scrollTop; })()`);
	expect(top).toBeGreaterThan(0);
	await tab(v, "settings");
	await until(v, `current === "settings"`, "settings not shown");
	await back(v);
	await until(v, `current === "monitoring" && document.querySelectorAll("#mon-tl .mr").length === 40`, "list not back");
	expect(await ev<number>(v, `([...document.querySelectorAll("#mon-tl .mr")][0].closest("#mon-timeline, .views, #v-monitoring") || document.scrollingElement).scrollTop`)).toBe(top);
});

test("390: settings → 메신저 → Slack, back goes up one level at a time", async () => {
	const v = await open(390);
	await tab(v, "settings");
	await until(v, `current === "settings"`, "settings not shown");
	await v.evaluate(`go("messengers")`);
	await until(v, `current === "messengers"`, "messengers not shown");
	await v.evaluate(`go("slack")`);
	await until(v, `current === "slack"`, "slack not shown");
	await back(v);
	await until(v, `current === "messengers"`, "back did not return to the messengers");
	await back(v);
	await until(v, `current === "settings"`, "back did not return to the settings");
});

test("390: tab A → B → A, back returns to B then A; the same tab again adds no entry", async () => {
	const v = await open(390);
	await tab(v, "settings");
	await until(v, `current === "settings"`, "A not shown");
	await tab(v, "monitoring");
	await until(v, `current === "monitoring"`, "B not shown");
	await tab(v, "settings");
	await until(v, `current === "settings"`, "A not shown again");
	const len = (await where(v)).len;
	await tab(v, "settings");
	await until(v, `current === "settings"`, "A still shown");
	expect((await where(v)).len).toBe(len);
	await back(v);
	await until(v, `current === "monitoring"`, "back did not return to B");
	await back(v);
	await until(v, `current === "settings"`, "back did not return to A");
	await back(v);
	await until(v, `current === "home"`, "back did not return to 홈");
});

test("390: a sheet opened after a tab switch closes on back and leaves the screen; the next back is the screen before the tab", async () => {
	const v = await open(390);
	await tab(v, "monitoring");
	await until(v, `current === "monitoring"`, "monitoring not shown");
	await tab(v, "settings");
	await until(v, `current === "settings"`, "settings not shown");
	const before = await where(v);
	await v.evaluate(`window.__sheet = fsOpen({ label: "시험", cls: "mid" })`);
	await until(v, `!!document.querySelector(".fs-card")`, "sheet not open");
	await back(v);
	await until(v, `!document.querySelector(".fs-card") && current === "settings"`, "back did not close the sheet only");
	expect((await where(v)).hash).toBe(before.hash);
	await back(v);
	await until(v, `current === "monitoring"`, "back did not return to the screen before the tab");
});

test("390: reloading on an address opens the same screen, and back from it still lands on the screen before", async () => {
	const v = await open(390);
	await tab(v, "monitoring");
	await until(v, `current === "monitoring"`, "monitoring not shown");
	await tab(v, "settings");
	await until(v, `current === "settings"`, "settings not shown");
	const href = await ev<string>(v, `location.href`);
	await v.navigate(href);
	await until(v, `typeof go === "function" && CV.loaded && current === "settings"`, "reload did not open the same screen");
});

test("installed app: back from 홈 stays on the exit guard instead of leaving", async () => {
	const v = await open(390);
	await v.evaluate(`(Object.defineProperty(navigator, "standalone", { value: true, configurable: true }), history.replaceState(null, "", "#home"), histSeed(), true)`);
	await until(v, `history.state && history.state.dz && !history.state.g`, "home entry not seeded");
	await back(v);
	await until(v, `history.state && history.state.g === 1 && current === "home"`, "back from 홈 did not stop on the guard");
});

type St = { cur: string; hash: string; tgt: string; mon: string; n: number };
const state = (v: V) => ev<St>(v, `({ cur: current, hash: location.hash, tgt: target, mon: monCtx, n: history.state.c.length })`);
const press = (sel: string) => `(document.querySelector(${JSON.stringify(sel)}).click(), true)`;
const MR = (i: number) => `(document.querySelectorAll("#mon-tl .mr")[${i}].click(), true)`;
const mailOpen = (prev: St) => `current === "chat" && monCtx.startsWith("mail:") && target === monCtx && location.hash.startsWith("#monitoring/c:") && location.hash !== ${JSON.stringify(prev.hash)}`;

// The chat list's and the mail list's rows and the 홈 tab are presses beside the view like any other: each stacks one entry on a wide screen
// too, and the conversation an entry shows is its own (a mail never shows in the chat tab's entry, nor the chat's in 모니터링's).
for (const width of [390, 1280]) test(`${width}: every press beside or below the view stacks one entry (a list's other row and the 홈 tab too), and as many backs return through each view with its own conversation`, async () => {
	const v = await open(width);
	const wide = width >= 1100;
	const steps: [string, (prev: St) => string][] = [
		...(wide ? [
			[press('#nav .ni[data-view="chat"]'), () => `current === "chat" && monCtx === "" && target === "main" && location.hash === "#chat/main" && !!document.querySelector('.cv-row[data-t="worklog"]')`],
			[press('.cv-row[data-t="worklog"]'), () => `current === "chat" && monCtx === "" && target === "worklog" && location.hash === "#chat/worklog"`],
		] as [string, (prev: St) => string][] : []),
		[press('#nav .ni[data-view="monitoring"]'), () => `current === "monitoring" && location.hash === "#monitoring"`],
		[`(go("monitoring", "i:mail"), true)`, () => `location.hash === ${JSON.stringify(MAIL_LIST)} && document.querySelectorAll("#mon-tl .mr").length > 1`],
		[MR(0), mailOpen],
		...(wide ? [[MR(1), mailOpen] as [string, (prev: St) => string]] : []),
		[press('#nav .ni[data-view="home"]'), () => `current === "home" && location.hash === "#home"`],
		[press('#nav .ni[data-view="settings"]'), () => `current === "settings"`],
		[press('#nav .ni[data-view="home"]'), () => `current === "home" && location.hash === "#home"`],
	];
	const seen = [await state(v)];
	for (const [run, cond] of steps) {
		await v.evaluate(run);
		await until(v, cond(seen[seen.length - 1]), `step ${seen.length} not reached`);
		seen.push(await state(v));
		expect(seen[seen.length - 1].n).toBe(seen.length);   // one entry for one press
	}
	for (let i = seen.length - 2; i >= 0; i--) {
		const s = seen[i];
		await back(v);
		await until(v, `current === ${JSON.stringify(s.cur)} && location.hash === ${JSON.stringify(s.hash)} && monCtx === ${JSON.stringify(s.mon)} && history.state.c.length === ${s.n}${s.cur === "chat" ? ` && target === ${JSON.stringify(s.tgt)}` : ""}`, `back ${seen.length - 1 - i} did not return to ${s.hash}`);
	}
});

// The KakaoTalk room (30-kakao.js kkOpen/kkClose, bkKkSync) is one history step on a phone, like a sheet: back closes what the app bar's arrow closes.
const KK_ITEM = "#monitoring/i%3Akakao";
const kkReady = async (v: V) => {
	await tab(v, "monitoring");
	await until(v, `current === "monitoring"`, "monitoring not shown");
	await v.evaluate(`go("monitoring", "i:kakao")`);
	await until(v, `current === "monitoring" && MON.sel === "i:kakao" && KK.loaded && !!document.querySelector('.kk-row[data-chat="100"]')`, "kakao rooms not shown");
};
const kkRoom = async (v: V, id = "100") => {
	await v.evaluate(`document.querySelector('.kk-row[data-chat="${id}"]') ? document.querySelector('.kk-row[data-chat="${id}"]').click() : kkOpen("${id}")`);
	await until(v, `KK.open === "${id}" && !KK.loading`, "room not opened");
};
const kkSettled = (v: V, ov: number) => until(v, `!H.moving && history.state.ov === ${ov} && OV.length === ${ov}`, "history not settled");

test("390: KakaoTalk room: history back closes the room to the room list, back again goes to the 모니터링 list; switching rooms stacks no second step", async () => {
	const v = await open(390);
	await kkReady(v);
	const base = (await ev<number>(v, `history.state.c.length`));
	await kkRoom(v, "100");
	await kkSettled(v, 1);
	await kkRoom(v, "200");   // a second room: still the one step
	await kkSettled(v, 1);
	expect(await ev<number>(v, `history.state.c.length`)).toBe(base);
	await back(v);
	await until(v, `!KK.open && OV.length === 0 && location.hash === ${JSON.stringify(KK_ITEM)} && MON.sel === "i:kakao" && !MON.list && !!document.querySelector('.kk-row[data-chat="100"]')`, "back did not close the room");
	await back(v);
	await until(v, `current === "monitoring" && MON.list`, "back did not reach the monitoring list");
});

test("390: KakaoTalk room: the app bar arrow closes the room with the same two history back steps and leaves no extra entry", async () => {
	const v = await open(390);
	await kkReady(v);
	await kkRoom(v, "100");
	await kkSettled(v, 1);
	await v.evaluate(`document.querySelector("#back").click()`);
	await until(v, `!KK.open && location.hash === ${JSON.stringify(KK_ITEM)}`, "arrow did not close the room");
	await kkSettled(v, 0);
	await back(v);   // one back lands on the 모니터링 list, not on the room list again
	await until(v, `current === "monitoring" && MON.list && !KK.open`, "back after the arrow did not reach the monitoring list");
});

test("390: KakaoTalk room: leaving the screen by a tab releases the room's step", async () => {
	const v = await open(390);
	await kkReady(v);
	await kkRoom(v, "100");
	await kkSettled(v, 1);
	await tab(v, "settings");
	await until(v, `current === "settings"`, "settings not shown");
	await kkSettled(v, 0);
	await back(v);
	await until(v, `current === "monitoring" && MON.sel === "i:kakao"`, "back did not return to the kakao item");
});

test("1280: KakaoTalk room: opening a room adds no history step", async () => {
	const v = await open(1280);
	await kkReady(v);
	const base = await ev<number>(v, `history.state.c.length`);
	await kkRoom(v, "100");
	expect(await ev(v, `({ ov: OV.length, st: history.state.ov, c: history.state.c.length })`)).toEqual({ ov: 0, st: 0, c: base });
	await back(v);
	await until(v, `location.hash === "#monitoring"`, "one back did not leave the kakao item");
});

// A comment post (30-monitoring-comments.js cmOpen/cmClose, bkCmSync) takes one step on a phone the same way.
const CM_ITEM = "#monitoring/i%3Ayoutube";
const cmReady = async (v: V) => {
	await tab(v, "monitoring");
	await until(v, `current === "monitoring"`, "monitoring not shown");
	await v.evaluate(`go("monitoring", "i:youtube")`);
	await until(v, `current === "monitoring" && MON.sel === "i:youtube" && CM.vis && CM.loaded && !!document.querySelector('.cv-row[data-thread="v1"]')`, "comment posts not shown");
};
const cmPost = async (v: V, t = "v1") => {
	await v.evaluate(`document.querySelector('.cv-row[data-thread="${t}"]') ? document.querySelector('.cv-row[data-thread="${t}"]').click() : cmOpen({ source: "youtube", thread: "${t}", title: "x" })`);
	await until(v, `CM.open && CM.open.thread === "${t}" && !CM.loading`, "post not opened");
};

test("390: comment post: history back closes the post to the post list, back again goes to the 모니터링 list; switching posts stacks no second step", async () => {
	const v = await open(390);
	await cmReady(v);
	const base = await ev<number>(v, `history.state.c.length`);
	await cmPost(v, "v1");
	await kkSettled(v, 1);
	await cmPost(v, "v2");
	await kkSettled(v, 1);
	expect(await ev<number>(v, `history.state.c.length`)).toBe(base);
	await back(v);
	await until(v, `!CM.open && OV.length === 0 && location.hash === ${JSON.stringify(CM_ITEM)} && !MON.list && !!document.querySelector('.cv-row[data-thread="v1"]')`, "back did not close the post");
	await back(v);
	await until(v, `current === "monitoring" && MON.list`, "back did not reach the monitoring list");
});

test("390: comment post: the app bar arrow closes the post with the same two history back steps and leaves no extra entry", async () => {
	const v = await open(390);
	await cmReady(v);
	await cmPost(v, "v1");
	await kkSettled(v, 1);
	await v.evaluate(`document.querySelector("#back").click()`);
	await until(v, `!CM.open && location.hash === ${JSON.stringify(CM_ITEM)}`, "arrow did not close the post");
	await kkSettled(v, 0);
	await back(v);
	await until(v, `current === "monitoring" && MON.list && !CM.open`, "back after the arrow did not reach the monitoring list");
});

test("1280: comment post: opening a post adds no history step", async () => {
	const v = await open(1280);
	await cmReady(v);
	const base = await ev<number>(v, `history.state.c.length`);
	await cmPost(v, "v1");
	expect(await ev(v, `({ ov: OV.length, st: history.state.ov, c: history.state.c.length })`)).toEqual({ ov: 0, st: 0, c: base });
	await back(v);
	await until(v, `location.hash === "#monitoring"`, "one back did not leave the comment item");
});
