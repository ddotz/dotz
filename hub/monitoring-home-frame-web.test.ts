import { afterAll, describe, expect, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The frame of 모니터링's own screens (docs/web-app-design.md 앱 틀; web/css/10-conversations.css, 20-monitoring.css, 20-apps.css) in a headless browser against a fake hub: on a wide window the
// home (item list + 답장 대기), an open reply card, a watch feed, an app's settings and the #apps view stand in the 채팅 tab's list box and content box, measured in the same run.
// Names and texts are placeholders.
const at = (d: number, h: number, m: number) => Date.UTC(2026, 9, d, h, m);
// The reply queue (GET /api/reply/queue): two replies sent today (rows that open their card) and one failed send (a card in the list).
const qItem = (n: number, send: object) => ({ item: `kakao:R${n}`, ref: `R${n}`, kind: "chat", app: "kakao", label: "카카오톡", conv: "i:kakao", at: Date.now() - n * 6e4, can: { send: false, revise: true, edit: true, drop: true, restore: false },
	draft: { state: "pending", toLabel: "대화방", to: `가나${n}`, text: `답장 ${n}` }, original: { who: `가나${n}`, text: "대화방" }, send });
const QUEUE = [qItem(1, { state: "sent", at: Date.now() - 6e4, how: "owner", actions: [] }), qItem(2, { state: "sent", at: Date.now() - 12e4, how: "owner", actions: [] }), qItem(3, { state: "failed", at: Date.now() - 18e4, reason: { code: "offline", text: "연결이 끊겼어요" }, actions: ["retry"] })];
const ROOMS = [{ chatId: "100", name: "가나다 모임", kind: "group", watched: true, autoDraft: false, unread: 0, lastAt: at(22, 1, 29) }];
let hits: Record<string, number> = {};
let repliesFail = false;

const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		const p = url.pathname;
		hits[p] = (hits[p] ?? 0) + 1;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [{ target: "web", name: "웹", preview: "안녕하세요", ts: new Date(at(22, 1, 0)).toISOString() }] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [{ name: "디스크 점검", watch: "disk-check", kind: "watch", every: "10분마다", last_run: new Date(at(22, 1, 0)).toISOString(), last_result: "ok", fails: 0 }] });
		if (p === "/api/integrations") return json({ items: [{ key: "kakao", label: "카카오톡", icon: "chat", kind: "app", conv: [], notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } }] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: ROOMS });
		if (p === "/api/integrations/kakao/settings") return json({ key: "kakao", fields: [] });
		if (p === "/api/reply/queue") return repliesFail ? json({ error: "no" }, 500) : json({ items: QUEUE, counts: {}, triageMin: 1, undoSec: 10 });
		if (p === "/api/apps") return json({ items: [{ id: "memo", label: "메모", icon: "file", source: "manifest", status: "ok", kind: "tool" }, { id: "todo", label: "할 일", icon: "file", source: "manifest", status: "ok", kind: "tool" }], errors: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

type Box = { x: number; w: number; r: number; y: number };
const box = (v: View, sel: string) => ev<Box>(v, `(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right), y: Math.round(b.top) }; })()`);
const still = (v: View) => waitFor(v, `document.getAnimations().length === 0`);

async function boot(width: number): Promise<View> {
	const v = await hub.view({ width, height: 900 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && RQ.loaded && INTG.loaded`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	return v;
}
async function chatBoxes(v: View) {
	await run(v, `go("chat")`);
	await waitFor(v, `current === "chat" && !monCtx && document.querySelector("#chat-convo")`);
	await still(v);
	return { list: await box(v, "#chat-convo"), main: await box(v, "#v-chat .chatbox") };
}
const sameList = (a: Box, b: Box) => expect({ x: a.x, w: a.w }).toEqual({ x: b.x, w: b.w });
const sameMain = (a: Box, b: Box) => expect({ x: a.x, r: a.r }).toEqual({ x: b.x, r: b.r });
const home = async (v: View) => {
	await run(v, `go("monitoring")`);
	await waitFor(v, `current === "monitoring" && MON.list && document.querySelector("#mon-side .cv-row") && document.querySelector("#v-monitoring .rq-r")`);
	await still(v);
};

describe.each([1280, 1920])("모니터링 at %d", width => {
	test("the home: the item list at the chat list's box, 답장 대기 at the chat content box", async () => {
		const v = await boot(width);
		const chat = await chatBoxes(v);
		await home(v);
		sameList(await box(v, "#v-monitoring > .cv-side"), chat.list);
		sameMain(await box(v, "#v-monitoring > .chatbox"), chat.main);
		expect(await ev<boolean>(v, `location.hash === "#monitoring"`)).toBe(true);
	}, 40_000);

	test("a queue row opens its card in the right column, and back returns to the queue with the row marked", async () => {
		const v = await boot(width);
		const chat = await chatBoxes(v);
		await home(v);
		await run(v, `document.querySelector('.rq-r[data-qr] .tx').click()`);
		await waitFor(v, `RQ.sheet && RQ.sheet.pane && document.querySelector(".rq-pane .ra-card")`);
		await still(v);
		sameList(await box(v, "#v-monitoring > .cv-side"), chat.list);
		sameMain(await box(v, ".rq-pane"), chat.main);
		expect(await ev<number>(v, `document.querySelectorAll(".fs-bd .ra-card, .fs-card .ra-card").length`)).toBe(0);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `!RQ.sheet && !document.querySelector(".rq-pane") && document.querySelector(".rq-r.on")`);
		sameMain(await box(v, "#v-monitoring > .chatbox"), chat.main);
	}, 40_000);

	test("a watch feed and a watch log stand in the same content box", async () => {
		const v = await boot(width);
		const chat = await chatBoxes(v);
		await home(v);
		const keys = await ev<string[]>(v, `monItems().filter(i => !i.rq && !i.app).map(i => i.key)`);
		expect(keys.length).toBeGreaterThan(1);
		for (const k of keys) {
			await run(v, `go("monitoring", ${JSON.stringify(k)})`);
			await waitFor(v, `current === "monitoring" && MON.sel === ${JSON.stringify(k)} && !MON.list && document.querySelector("#mon-head > *")`);
			await still(v);
			sameList(await box(v, "#v-monitoring > .cv-side"), chat.list);
			sameMain(await box(v, "#v-monitoring > .chatbox"), chat.main);
		}
	}, 40_000);

	test("an app's settings open in the right column beside the app's panel", async () => {
		const v = await boot(width);
		const chat = await chatBoxes(v);
		await run(v, `go("monitoring", "i:kakao")`);
		await waitFor(v, `!$("#kk").hidden && KK.loaded && document.querySelector("#kk-rooms .kk-row")`);
		await still(v);
		const panel = await box(v, "#kk-rooms");
		await run(v, `asScreen("kakao")`);
		await waitFor(v, `document.querySelector("#as-pane .as-card #app-sw")`);
		await still(v);
		sameList(await box(v, "#kk-rooms"), chat.list);
		expect((await box(v, "#kk-rooms")).x).toBe(panel.x);
		sameMain(await box(v, "#as-pane .as-card"), chat.main);
		expect(await ev<boolean>(v, `!document.querySelector(".fs-bd")`)).toBe(true);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `!document.querySelector("#as-pane .as-card") && current === "monitoring" && !MON.list`);
	}, 40_000);

	test("#apps: the list at the chat list's box, the app at the chat content box, and a pick does not stack history", async () => {
		const v = await boot(width);
		const chat = await chatBoxes(v);
		await run(v, `APPS_ON = true; go("apps")`);
		await waitFor(v, `current === "apps" && APPS.loaded && document.querySelector("#apps-side .cv-row")`);
		await still(v);
		sameList(await box(v, "#apps-side"), chat.list);
		sameMain(await box(v, "#apps-pane"), chat.main);
		const rows = await ev<number>(v, `document.querySelectorAll("#apps-side .cv-row").length`);
		expect(rows).toBeGreaterThan(1);
		await run(v, `document.querySelectorAll("#apps-side .cv-row")[0].click()`);
		await waitFor(v, `location.hash.startsWith("#apps/")`);
		const len = await ev<number>(v, `history.length`);
		await run(v, `document.querySelectorAll("#apps-side .cv-row")[1].click()`);
		await waitFor(v, `location.hash.startsWith("#apps/") && APPS.sel`);
		expect(await ev<number>(v, `history.length`)).toBe(len);
		sameMain(await box(v, "#apps-pane"), chat.main);
	}, 40_000);
});

describe("모니터링 on a phone and on failure", () => {
	test("a phone keeps one column: the sheet for a queue row, no right column", async () => {
		const v = await boot(390);
		await run(v, `go("monitoring")`);
		await waitFor(v, `current === "monitoring" && MON.list`);
		expect(await ev<boolean>(v, `!$("#v-monitoring").classList.contains("mon-home")`)).toBe(true);
		await run(v, `go("monitoring", "replies")`);
		await waitFor(v, `MON.sel === "replies" && document.querySelector(".rq-r[data-qr] .tx")`);
		await run(v, `document.querySelector('.rq-r[data-qr] .tx').click()`);
		await waitFor(v, `RQ.sheet && !RQ.sheet.pane && document.querySelector(".fs-bd .ra-card")`);
		// the reach of the failed card's buttons in the list: the drawn box plus the invisible ::after above and below it (ui-spec 버튼: a small control keeps its box and widens what a finger reaches)
		const hit = await ev<number[]>(v, `[...document.querySelectorAll("#v-monitoring .rq-c .rq-acts .btn")].map(b => { const a = getComputedStyle(b, "::after"), out = a.content !== "none" && a.position === "absolute" ? -(parseFloat(a.top) || 0) - (parseFloat(a.bottom) || 0) : 0; return Math.round(b.getBoundingClientRect().height + Math.max(0, out)); })`);
		const need = await ev<number>(v, `parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--btn-hit"))`);
		expect(hit.length).toBeGreaterThan(0);
		for (const h of hit) expect(h).toBeGreaterThanOrEqual(need);
	}, 40_000);

	test("a failed queue load says so and offers 다시 시도", async () => {
		repliesFail = true;
		try {
			const v = await boot(1280);
			await run(v, `go("monitoring", "replies")`);
			await waitFor(v, `document.querySelector("#v-monitoring .rq-empty")`);
			const t = await ev<string>(v, `document.querySelector("#v-monitoring .rq-empty").innerText`);
			expect(t).toContain("다시 시도");
			repliesFail = false;
			await run(v, `[...document.querySelectorAll("#v-monitoring .rq-empty button")].find(b => /다시 시도/.test(b.innerText)).click()`);
			await waitFor(v, `document.querySelector("#v-monitoring .rq-r")`);
		} finally { repliesFail = false; }
	}, 40_000);
});
