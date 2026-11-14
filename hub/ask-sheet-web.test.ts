import { afterAll, beforeEach, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest, setDraftHandled, settleHandledDrafts, unreadCount } from "./notices.ts";
import { fakeHub, json, on } from "./test-web.ts";

// The docked question card of a conversation that asks about a draft: the draft sent from 모니터링 takes the card away for good (its notice
// settles, hub/notices.ts settleHandledDrafts), and a fold stays when the bot asks again. One send card per message: a message with two of them
// closes each at once and asks its session to post them again (issue #7, hub/draft-card-reworded.test.ts), so it never docks.
// Headless browser against a fixture history and the real notice store; nothing leaves the process.
let history: unknown[] = [];
const hub = fakeHub({
	api: (req, url) => {
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unreadCount() });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices" && req.method === "GET") return json(listNotices(300));
	},
});
const view = await hub.view({ width: 1280, height: 760 });
const handled = new Set<string>();
afterAll(() => {
	hub.stop();
	resetNoticesForTest();
	setDraftHandled(() => false);
});
beforeEach(() => {
	resetNoticesForTest();
	handled.clear();
	setDraftHandled((_d, _n, ref) => handled.has(ref));
});
const { waitFor, ev } = on(view);
const block = (ref: string) => draftApprovalBlock({ to: "유튜브 댓글", toLabel: "대상", body: `답글 ${ref}`, ref, question: "이 답글 올릴까?" });
const ask = (refs: string[]) => {
	const e = { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: `[ask] 댓글 답글 초안이에요\n\n${refs.map(block).join("\n\n")}` };
	emit("outbox", e);
	history = [...history, e];
};
const open = async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S && NT.loaded`);
	await view.evaluate(`(go("chat", "main"), 0)`);
	await waitFor(`target === "main" && ts("main").msgs.length > 0`);
	await view.evaluate(`(paintDecision(), 0)`);
};
const blocks = `(!$("#dcard").hidden && DC.cur ? DC.cur.blocks.map(b => b.title) : [])`;

test("a draft sent from 모니터링 takes the chat card away as it settles, and history does not bring it back", async () => {
	const a = `A${Date.now().toString(36)}`;
	history = [];
	ask([a]);
	await open();
	await waitFor(`${blocks}.length === 1`);
	expect(await ev<string[]>(blocks)).toEqual([`이 답글 올릴까? (${a})`]);
	expect(await settleHandledDrafts()).toBe(0);
	handled.add(a);
	expect(await settleHandledDrafts()).toBe(1);
	await waitFor(`$("#dcard").hidden`);
	// A reload reads the same [ask] message from history, with no owner message after it: its settled notice keeps the card away.
	await open();
	await waitFor(`NT.items.length >= 1`);
	expect(await ev<boolean>(`$("#dcard").hidden && decisionOf("main") === null`)).toBe(true);
}, 30_000);

test("the fold arrow lowers the card to its header and keeps it folded when the bot asks again in the same conversation", async () => {
	const id = Date.now().toString(36);
	history = [];
	ask([`C${id}`]);
	await open();
	await waitFor(`!$("#dcard").hidden && $(".dc-fold")`);
	const open1 = await ev<{ h: number; vh: number }>(`({ h: $("#dcard").getBoundingClientRect().height, vh: innerHeight })`);
	expect(open1.h).toBeLessThanOrEqual(Math.ceil(open1.vh * 0.4) + 1);
	await view.evaluate(`($(".dc-fold").click(), 0)`);
	await waitFor(`$("#dcard").classList.contains("fold") && !$("#dcard .dc-body")`);
	// The bot asks again about the next draft: a new message, so a new question key; the conversation's fold still holds.
	ask([`D${id}`]);
	await waitFor(`DC.cur && DC.cur.blocks.length === 1 && DC.cur.blocks[0].title.includes("D${id}") && DC.cur.at !== null`);
	await view.evaluate(`(paintDecision(), 0)`);
	await waitFor(`$("#dcard").classList.contains("fold") && !$("#dcard .dc-body")`);
	await view.evaluate(`($(".dc-fold").click(), 0)`);
	await waitFor(`!$("#dcard").classList.contains("fold") && $("#dcard .dc-body")`);
}, 30_000);
