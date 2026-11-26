import { afterEach, beforeEach, expect, test } from "bun:test";
import { ASK_PREFIX, askComponentsFor, askInteraction, setAskLearned } from "./askbuttons.ts";
import type { Interaction } from "./discord.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { setReplies } from "./reply-actions.ts";
import type { LessonScope } from "./reply-types.ts";

type Learned = { state: "remembered" | "once"; scope: LessonScope; scopes: LessonScope[] };
const CARD = (headline: string) => `[ask] ${headline}\n${draftApprovalBlock({ to: "kim@example.com", body: "확인해 보고 말씀드릴게요.", ref: "RLEARN1", question: "이 답장 보낼까요?" })}`;
const REMEMBERED: Learned = { state: "remembered", scope: "recipient", scopes: ["recipient", "channel", "everywhere"] };
const ONCE: Learned = { state: "once", scope: "channel", scopes: ["channel", "everywhere"] };
let learned: Learned | undefined;
const acts: { input: Record<string, unknown>; ctx: unknown }[] = [];

beforeEach(() => {
	learned = REMEMBERED;
	acts.length = 0;
	setAskLearned(ref => (ref === "RLEARN1" ? learned : undefined));
	setReplies({
		view: async (ref: string) => (ref === "RLEARN1" ? { draft: { text: "x", learned } } : undefined),
		act: async (input: Record<string, unknown>, ctx: unknown) => (acts.push({ input, ctx }), { status: 200, body: { ok: true, item: { draft: { learned: { ...learned, text: "이번만 반영했어요" } } } } }),
	} as never);
});
afterEach(() => {
	setAskLearned(undefined);
	setReplies(undefined);
});

const rowsOf = (text: string) => askComponentsFor("ch:1", text) as { type: number; components: { label: string; custom_id: string }[] }[];
const click = (user: string, customId: string, content: string): Interaction => ({ id: "i1", token: "t", type: 3, member: { user: { id: user } }, message: { content }, data: { custom_id: customId } });
const press = async (customId: string, user = "owner-1") => {
	const replies: { type: number; data?: any }[] = [];
	await askInteraction(click(user, customId, CARD('기억했어요: "인사는 짧게" · 범위: 이 사람')), { owner: "owner-1", reply: async (_d, type, data) => void replies.push({ type, data }), answer: () => void acts.push({ input: { answered: true }, ctx: null }) });
	return replies;
};

test("a draft card that learned something gets a second row: 범위 바꾸기 and 이번만, with ids that parse and fit Discord's limits", () => {
	const rows = rowsOf(CARD('기억했어요: "인사는 짧게" · 범위: 이 사람'));
	expect(rows).toHaveLength(2);
	expect(rows[1]!.components.map(c => [c.label, c.custom_id])).toEqual([
		["범위 바꾸기", `${ASK_PREFIX}:ch:1:learn-scope`],
		["이번만", `${ASK_PREFIX}:ch:1:learn-once`],
	]);
	for (const row of rows) expect(row.components.length).toBeLessThanOrEqual(5);
	for (const c of rows.flatMap(r => r.components)) expect(c.custom_id.length).toBeLessThanOrEqual(100);
});

test("a one-off lesson offers 앞으로도 in place of 이번만, and a card that learned nothing has no second row", () => {
	learned = ONCE;
	expect(rowsOf(CARD("이번만 반영했어요"))[1]!.components.map(c => [c.label, c.custom_id])).toEqual([
		["범위 바꾸기", `${ASK_PREFIX}:ch:1:learn-scope`],
		["앞으로도", `${ASK_PREFIX}:ch:1:learn-keep`],
	]);
	learned = undefined;
	expect(rowsOf(CARD("답장 초안을 만들었어요"))).toHaveLength(1);
});

test("a lesson the draft cannot move between scopes offers no 범위 바꾸기", () => {
	learned = { state: "remembered", scope: "everywhere", scopes: ["everywhere"] };
	expect(rowsOf(CARD('기억했어요: "인사는 짧게" · 범위: 모든 답장'))[1]!.components.map(c => c.label)).toEqual(["이번만"]);
});

test("a press goes to act as the owner's: 범위 바꾸기 takes the next scope after the current one and wraps, 이번만 and 앞으로도 flip the state", async () => {
	await press(`${ASK_PREFIX}:ch:1:learn-scope`);
	learned = { ...REMEMBERED, scope: "everywhere" };
	await press(`${ASK_PREFIX}:ch:1:learn-scope`);
	await press(`${ASK_PREFIX}:ch:1:learn-once`);
	await press(`${ASK_PREFIX}:ch:1:learn-keep`);
	const ctx = { surface: "discord", login: "owner" };
	expect(acts).toEqual([
		{ input: { ref: "RLEARN1", action: "learn-scope", scope: "channel" }, ctx },
		{ input: { ref: "RLEARN1", action: "learn-scope", scope: "recipient" }, ctx },
		{ input: { ref: "RLEARN1", action: "learn-once" }, ctx },
		{ input: { ref: "RLEARN1", action: "learn-keep" }, ctx },
	]);
});

test("a press answers the owner quietly with the line the card now says, leaves the card to its redraw, and refuses anyone else", async () => {
	const done = await press(`${ASK_PREFIX}:ch:1:learn-once`);
	expect(done.map(r => [r.type, r.data.flags, r.data.content])).toEqual([[4, 64, "이번만 반영했어요"]]);
	acts.length = 0;
	const refused = await press(`${ASK_PREFIX}:ch:1:learn-once`, "someone");
	expect(acts).toEqual([]);
	expect(refused.map(r => [r.type, r.data.flags])).toEqual([[4, 64]]);
});
