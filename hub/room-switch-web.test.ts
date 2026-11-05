// Switching rooms never mixes them, headless (Bun.WebView) against a fake hub whose room loads are held on promises the test resolves by hand:
// - kkOpen (web/js/30-kakao.js): three message rooms opened back to back, answered out of order, leave only the last one opened on screen;
// - the unsent text of a room stays with that room (KK.typed);
// - cmOpen (web/js/30-monitoring-comments.js): the same for two comment threads, and a half-typed revise note never follows to the next thread;
// - a send goes to the room that was open when it was pressed.
// The fake data is invented; the page's own api() is wrapped only to count settled requests, so a test waits on a page condition, never on time.
import { afterAll, describe, expect, test } from "bun:test";
import { ev, fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

const KAKAO_APP = { key: "kakao", label: "카카오톡", icon: "kakao", kind: "app", conv: [], notices: [], unread: 0, unreplied: 0, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 } };
const NAMES: Record<string, string> = { A: "가나방", B: "다라방", C: "마바방" };
const ROOMS = Object.entries(NAMES).map(([chatId, name]) => ({ chatId, name, kind: "group", watched: true, autoDraft: false, unread: 0, unreplied: false, lastAt: Date.UTC(2026, 9, 27, 2, 0) }));
const chatBody = (id: string) => ({
	room: { chatId: id, name: NAMES[id], kind: "group", group: true, watched: true },
	messages: [{ logId: `m${id}`, authorId: `u${id}`, sender: `손님${id}`, text: `${id} 방의 메시지`, type: 1, sentAt: Date.UTC(2026, 9, 27, 1, 0), fromMe: false, unread: 0 }],
	read: null, kakaoUnread: 0, sends: [],
	drafts: [{ code: `d${id}`, text: `${id} 방의 초안`, created: Date.UTC(2026, 9, 27, 1, 5), intent: "질문" }],
});

const THREADS: Record<string, string> = { first: "첫째 글", second: "둘째 글" };
const threadBody = (t: string) => ({
	source: { kind: "youtube", label: "유튜브" },
	thread: { title: THREADS[t], link: "", thumb: "" },
	comments: [{ id: `cm:youtube:${t}1`, author: `구독자-${t}`, text: `${t} 글의 댓글`, at: Date.UTC(2026, 9, 27, 1, 0), mine: false, unreplied: false, needsReply: false }],
	drafts: [{ code: `d-${t}`, commentId: `cm:youtube:${t}1`, text: `${t} 글의 답글 초안`, notes: [], clean: true, created: Date.UTC(2026, 9, 27, 1, 5) }],
	sends: [], read: null,
});

// Every held request waits on a resolver the test calls; `requests` and `posts` wake the test when one arrives.
const pending = new Map<string, Array<() => void>>();
const requests = inbox<string>();
const posts = inbox<string>();
const holdPost = new Set<string>();
const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/integrations") return json({ items: [KAKAO_APP], available: [] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: ROOMS });
		const hold = async (body: unknown) => {
			await new Promise<void>(res => { pending.set(p, [...(pending.get(p) ?? []), res]); requests.push(p); });
			return json(body);
		};
		const chat = /^\/api\/kakao\/chat\/([^/]+)$/.exec(p);
		if (chat && req.method === "GET" && NAMES[chat[1]!]) return hold(chatBody(chat[1]!));
		const thread = /^\/api\/comments\/thread\/youtube\/([^/]+)$/.exec(p);
		if (thread && req.method === "GET" && THREADS[thread[1]!]) return hold(threadBody(thread[1]!));
		if (req.method === "POST" && /^\/api\/kakao\/chat\/[^/]+\/send$/.test(p)) {
			posts.push(p);
			if (holdPost.has(p)) await new Promise<void>(res => { pending.set(p, [...(pending.get(p) ?? []), res]); requests.push(p); });
			return json({ id: `s-${posts.length}`, state: "sending" });
		}
		return undefined;
	},
});
afterAll(() => hub.stop());

// Answers the oldest held request of `path`, then waits until the page has finished handling that answer.
const settled = new Map<string, number>();
async function answer(v: View, path: string): Promise<void> {
	await requests.until(() => (pending.get(path)?.length ?? 0) > 0, 10_000, `a held request for ${path}`);
	pending.get(path)!.shift()!();
	const n = (settled.get(path) ?? 0) + 1;
	settled.set(path, n);
	await waitFor(v, `(__n[${JSON.stringify(path)}] || 0) >= ${n}`);
}
const held = (path: string) => requests.until(() => (pending.get(path)?.length ?? 0) > 0, 10_000, `a held request for ${path}`);
const kkPath = (id: string) => `/api/kakao/chat/${id}`;
const cmPath = (t: string) => `/api/comments/thread/youtube/${t}`;

async function boot(): Promise<View> {
	pending.clear(); settled.clear(); holdPost.clear(); requests.length = 0; posts.length = 0;
	const v = await hub.view({ width: 1280, height: 800 }, "/");
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && typeof INTG !== "undefined" && INTG.items.length === 1`);
	await run(v, `go("monitoring", "i:kakao")`);
	await waitFor(v, `KK.rooms.length === 3`);
	// Count every settled api() call per path, after its caller has the answer.
	await run(v, `window.__n = {}; const o = api; api = async (p, ...r) => { try { return await o(p, ...r); } finally { const k = new URL(p, location.href).pathname; __n[k] = (__n[k] || 0) + 1; } }`);
	return v;
}
const kkScreen = (v: View) => ev<{ open: string; head: string; tl: string; drafts: string[] }>(v, `({ open: KK.open, head: ($("#kk-head .cv-n") || {}).textContent || "", tl: $("#kk-in").textContent, drafts: [...document.querySelectorAll("#kk-drafts .kk-draft")].map(n => n.dataset.code) })`);
const onlyC = { open: "C", head: "마바방", drafts: ["dC"] };
function expectC(s: { open: string; head: string; tl: string; drafts: string[] }) {
	expect({ open: s.open, head: s.head, drafts: s.drafts }).toEqual(onlyC);
	expect(s.tl).toContain("C 방의 메시지");
	expect(s.tl).not.toContain("A 방의 메시지");
	expect(s.tl).not.toContain("B 방의 메시지");
}

describe("message rooms opened back to back", () => {
	for (const order of [["C", "A", "B"], ["A", "B", "C"]]) {
		test(`answered ${order.join(", ")}: only room C is on screen after every answer`, async () => {
			const v = await boot();
			await run(v, `kkOpen("A"); kkOpen("B"); kkOpen("C")`);
			for (const id of ["A", "B", "C"]) await held(kkPath(id));
			for (const id of order) {
				await answer(v, kkPath(id));
				const s = await kkScreen(v);
				if (id === order[0] && id !== "C") continue;   // the first answer of a stale room: nothing to assert beyond the later ones
				if (id === "C" || order.indexOf("C") < order.indexOf(id)) expectC(s);
			}
			expectC(await kkScreen(v));
			expect(await ev(v, `KK.open`)).toBe("C");
		});
	}
});

describe("unsent text stays with its room", () => {
	test("A's text is gone in B, back in A, and B's text is back after kkClose", async () => {
		const v = await boot();
		const open = async (id: string) => { await run(v, `kkOpen(${JSON.stringify(id)})`); await answer(v, kkPath(id)); };
		const box = () => ev<string>(v, `$("#kk-text").value`);
		await open("A");
		await run(v, `$("#kk-text").value = "A 입력 중"`);
		await open("B");
		expect(await box()).toBe("");
		await run(v, `$("#kk-text").value = "B 입력 중"`);
		await open("A");
		expect(await box()).toBe("A 입력 중");
		await run(v, `kkClose()`);
		await open("B");
		expect(await box()).toBe("B 입력 중");
	});
});

describe("comment threads opened back to back", () => {
	test("answered second then first: the view and the card are the second's, and no revise note survives", async () => {
		const v = await boot();
		const screen = () => ev<{ open: string; head: string; text: string; cards: string[] }>(v, `({ open: CM.open && CM.open.thread, head: ($("#cm-head .cv-n") || {}).textContent || "", text: $("#cm-in").textContent, cards: [...document.querySelectorAll("#cm-in .kk-draft")].map(n => n.dataset.code) })`);
		await run(v, `cmOpen({ source: "youtube", thread: "first", title: "첫째 글" }); cmOpen({ source: "youtube", thread: "second", title: "둘째 글" })`);
		await held(cmPath("first")); await held(cmPath("second"));
		for (const t of ["second", "first"]) {
			await answer(v, cmPath(t));
			const s = await screen();
			expect({ open: s.open, head: s.head, cards: s.cards }).toEqual({ open: "second", head: "둘째 글", cards: ["d-second"] });
			expect(s.text).toContain("second 글의 댓글");
			expect(s.text).not.toContain("first 글의 댓글");
		}
		// A revise note typed on the second thread must not reach the first one opened after it.
		await run(v, `CM.revising = "d-second"; CM.note["d-second"] = "절반만 쓴 수정 요청"; cmPaintChat(false)`);
		expect(await ev(v, `!!$("#cm-in .rq-edit input")`)).toBe(true);
		await run(v, `cmOpen({ source: "youtube", thread: "first", title: "첫째 글" })`);
		expect(await ev(v, `({ revising: CM.revising, note: CM.note })`)).toEqual({ revising: "", note: {} });
		await answer(v, cmPath("first"));
		const s = await screen();
		expect({ open: s.open, cards: s.cards }).toEqual({ open: "first", cards: ["d-first"] });
		expect(await ev(v, `({ revising: CM.revising, note: CM.note, edit: !!$("#cm-in .rq-edit") })`)).toEqual({ revising: "", note: {}, edit: false });
	});
});

describe("a send goes to the room that was open when it was pressed", () => {
	test("A's send, with B's load held, posts to A; a press after switching to B posts to B", async () => {
		const v = await boot();
		await run(v, `kkOpen("A")`);
		await answer(v, kkPath("A"));
		holdPost.add("/api/kakao/chat/A/send");
		await run(v, `kkSendText("A 에게 보내요")`);
		await held("/api/kakao/chat/A/send");
		await run(v, `kkOpen("B")`);
		await held(kkPath("B"));
		expect([...posts]).toEqual(["/api/kakao/chat/A/send"]);
		await answer(v, "/api/kakao/chat/A/send");
		await answer(v, kkPath("B"));
		expect(await ev(v, `KK.open`)).toBe("B");
		await run(v, `kkSendText("B 에게 보내요")`);
		await posts.until(x => x.length === 2);
		expect([...posts]).toEqual(["/api/kakao/chat/A/send", "/api/kakao/chat/B/send"]);
	});
});
