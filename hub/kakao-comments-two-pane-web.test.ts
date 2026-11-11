import { afterAll, describe, expect, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The app frame of KakaoTalk and the comment apps (web/css/20-monitoring.css .app-two with .kk-on; web/js/30-kakao.js, 30-monitoring-comments.js) in a headless browser against a fake hub:
// on a wide window the rooms (posts) are the left panel at the 채팅 list's column and an open room (post) stands at the 채팅 content column, with the same insets; on a phone one column, and back
// leaves the room first, then the app. Names and texts are placeholders.
const at = (d: number, h: number, m: number) => Date.UTC(2026, 9, d, h, m);
const ROOMS = [
	{ chatId: "100", name: "가나다 모임", kind: "group", watched: true, autoDraft: false, unread: 2, lastAt: at(22, 1, 29) },
	{ chatId: "300", name: "라마바", kind: "direct", watched: true, autoDraft: false, unread: 0, lastAt: at(21, 5, 0) },
];
const MSGS = Array.from({ length: 12 }, (_, i) => ({ logId: String(3001 + i), authorId: i % 3 ? "u1" : "me", sender: i % 3 ? "가나" : "나", text: `대화 ${i}`, type: 1, sentAt: at(21, 3, i), fromMe: i % 3 === 0, unread: 0 }));
const COMMENTS = [{ id: "cm:youtube:c1", parent: null, author: "가나", text: "영상 잘 봤어요", at: at(22, 1, 0), mine: false, needsReply: true }];
let hits: Record<string, number> = {};

const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		const p = url.pathname;
		hits[p] = (hits[p] ?? 0) + 1;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/integrations") return json({ items: [
			{ key: "kakao", label: "카카오톡", icon: "chat", kind: "app", conv: [], notices: [], needs: { drafts: 0, unread: 2, sentToday: 0 } },
			{ key: "youtube", label: "유튜브", icon: "youtube", kind: "app", conv: [], notices: [], unread: 1, needs: { drafts: 0, unread: 1, sentToday: 0 } },
		] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: ROOMS });
		const chat = /^\/api\/kakao\/chat\/(\w+)$/.exec(p);
		if (chat) { const room = ROOMS.find(r => r.chatId === chat[1]); return room ? json({ room: { chatId: room.chatId, name: room.name, kind: room.kind, group: room.kind === "group", watched: true }, messages: MSGS, read: "3012", kakaoUnread: 0, drafts: [], sends: [] }) : json({ error: "no" }, 404); }
		if (p === "/api/comments/sources") return json({ on: true, sources: [{ key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, autoSend: false, error: null, ranAt: at(22, 3, 0) }] });
		if (p === "/api/comments/threads") return json({ threads: [{ source: "youtube", thread: "v1", title: "첫 번째 영상", link: "https://video.example/v1", lastAt: at(22, 2, 0), lastText: "영상 잘 봤어요", lastAuthor: "가나", unread: 1, drafts: 0 }] });
		if (p === "/api/integrations/youtube/settings") return json({ fields: [] });
		if (p === "/api/comments/thread/youtube/v1") return json({ source: { key: "youtube", kind: "youtube", label: "유튜브 댓글" }, thread: { id: "v1", title: "첫 번째 영상", link: "https://video.example/v1" }, comments: COMMENTS, read: null, drafts: [], sends: [] });
		if (p === "/api/comments/thread/youtube/v1/read") return json({ ok: true });
		return undefined;
	},
});
afterAll(() => hub.stop());

type Box = { x: number; w: number; r: number; y: number };
const box = (v: View, sel: string) => ev<Box>(v, `(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right), y: Math.round(b.top) }; })()`);
const still = (v: View) => waitFor(v, `document.getAnimations().length === 0`);
const visible = (v: View, sel: string) => ev<boolean>(v, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`);
const hash = (v: View) => ev<string>(v, `decodeURIComponent(location.hash)`);

async function boot(width: number): Promise<View> {
	const v = await hub.view({ width, height: 900 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && INTG.items.length === 2`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	return v;
}
const openApp = async (v: View, app: "kakao" | "youtube") => {
	await run(v, `go("monitoring", "i:${app}")`);
	await waitFor(v, app === "kakao" ? `!$("#kk").hidden && KK.loaded && document.querySelector("#kk-rooms .kk-row")` : `typeof CM !== "undefined" && !$("#cm").hidden && CM.loaded && document.querySelector("#cm-rooms .kk-row")`);
};
const openItem = async (v: View, app: "kakao" | "youtube") => {
	if (app === "kakao") { await run(v, `document.querySelector('#kk-rooms .kk-row[data-chat="100"]').click()`); await waitFor(v, `KK.open === "100" && !KK.loading && KK.placed`); }
	else { await run(v, `document.querySelector("#cm-rooms .kk-row").click()`); await waitFor(v, `CM.open && !CM.loading && document.querySelector("#cm-in .kk-m, #cm-in .cm-c")`); }
};
const PANEL = { kakao: "#kk-rooms", youtube: "#cm-rooms" } as const;
const CHAT = { kakao: "#kk-chat", youtube: "#cm-chat" } as const;
const HEAD = { kakao: "#kk-head", youtube: "#cm-head" } as const;
const TL = { kakao: "#kk-tl", youtube: "#cm-tl" } as const;

describe.each(["kakao", "youtube"] as const)("%s on a wide window", app => {
	test.each([1280, 1920])("at %d the rooms and the open item stand in the 채팅 tab's list and content boxes", async width => {
		const v = await boot(width);
		await run(v, `go("chat")`);
		await waitFor(v, `current === "chat" && !monCtx && document.querySelector("#chat-convo")`);
		await still(v);
		const chat = { panel: await box(v, "#chat-convo"), main: await box(v, "#v-chat .chatbox") };
		await openApp(v, app);
		await still(v);
		const listing = { panel: await box(v, PANEL[app]), main: await box(v, "#mon-head") };
		expect({ x: listing.panel.x, w: listing.panel.w }).toEqual({ x: chat.panel.x, w: chat.panel.w });
		expect({ x: listing.main.x, r: listing.main.r }).toEqual({ x: chat.main.x, r: chat.main.r });
		await openItem(v, app);
		await still(v);
		const open = { panel: await box(v, PANEL[app]), main: await box(v, CHAT[app]) };
		expect({ x: open.panel.x, w: open.panel.w }).toEqual({ x: chat.panel.x, w: chat.panel.w });
		expect({ x: open.main.x, r: open.main.r }).toEqual({ x: chat.main.x, r: chat.main.r });
		expect(await visible(v, PANEL[app])).toBe(true);
	}, 40_000);

	test("the head and the timeline have the insets of the 채팅 tab's", async () => {
		const v = await boot(1280);
		await run(v, `go("chat")`);
		await waitFor(v, `current === "chat" && !monCtx && document.querySelector("#chat-convo")`);
		await still(v);
		const pad = (sel: string) => ev<string>(v, `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).padding`);
		const chatTl = await pad("#v-chat .chatbox .timeline, #v-chat #timeline");
		await openApp(v, app);
		await openItem(v, app);
		await still(v);
		expect(await pad(TL[app])).toBe(chatTl);
		expect(await pad(HEAD[app])).toBe("12px 16px");
	}, 40_000);

	test("back leaves the item for the app, then the app for 모니터링; the panel stays while it is open", async () => {
		const v = await boot(1280);
		await openApp(v, app);
		await openItem(v, app);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, app === "kakao" ? `!KK.open` : `!CM.open`);
		expect(await visible(v, PANEL[app])).toBe(true);
		expect(await ev<boolean>(v, `current === "monitoring" && !MON.list`)).toBe(true);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `current === "monitoring" && MON.list`);
	}, 40_000);

	test("opening the item, going back and opening it again asks for each only once", async () => {
		const v = await boot(1280);
		await openApp(v, app);
		await openItem(v, app);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, app === "kakao" ? `!KK.open` : `!CM.open`);
		const before = { ...hits };
		await openItem(v, app);
		const key = app === "kakao" ? "/api/kakao/chat/100" : "/api/comments/thread/youtube/v1";
		expect((hits[key] ?? 0) - (before[key] ?? 0)).toBeLessThanOrEqual(1);
		expect(hits["/api/kakao/rooms"]).toBe(before["/api/kakao/rooms"]);
	}, 40_000);
});

describe.each(["kakao", "youtube"] as const)("%s on a phone", app => {
	test("one column: the item replaces the rooms, and back returns to them", async () => {
		const v = await boot(390);
		await openApp(v, app);
		expect(await ev<boolean>(v, `$("#v-monitoring").classList.contains("app-two")`)).toBe(false);
		await openItem(v, app);
		expect(await visible(v, PANEL[app])).toBe(false);
		expect(await visible(v, CHAT[app])).toBe(true);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, app === "kakao" ? `!KK.open` : `!CM.open`);
		expect(await visible(v, PANEL[app])).toBe(true);
		expect(await hash(v)).toBe(`#monitoring/i:${app}`);
	}, 40_000);
});
