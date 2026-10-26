import { expect, test } from "bun:test";
import { ASK_PREFIX, askInteraction } from "./askbuttons.ts";
import { parseChoices, parseDecisions } from "./choices.ts";
import type { Interaction } from "./discord.ts";
import { emit } from "./events.ts";
import { inboxText } from "./intake.ts";
import { answerDecision, type DecisionSend, listNotices } from "./notices.ts";

const ASK = "[ask] 확인\n결정: 확인\n**1) 확인됨** ← 추천\n잘 열려요\n**2) 안 됨**\n어디가 안 되는지 적어 주세요\n";

test("a trailing ' …' marks a needs-detail option and is not part of the label; a plain positive option is not one", () => {
	const marked = parseDecisions("[ask] 배포\n결정: 배포\n**1) 배포하기** ← 추천\n바로 올려요\n**2) 보류 …**\n이유만 남겨요\n").blocks[0]!.options;
	expect(marked.map(o => [o.label, o.detail])).toEqual([["배포하기", undefined], ["보류", true]]);
	const guessed = parseDecisions(ASK).blocks[0]!.options;
	expect(guessed.map(o => !!o.detail)).toEqual([false, false]);
	expect(parseChoices("무엇을?\n1) 확인됨\n2) 안 됨 …").options.map(o => [o.label, o.detail])).toEqual([["확인됨", undefined], ["안 됨", true]]);
});

test("the final answer line carries the typed detail after the chosen option", () => {
	const text = inboxText({ kind: "message", source: "web", channel: "web", author: "me", mid: "d1", text: "2) 안 됨 - 화면이 안 열려요", picks: [{ q: "확인", n: 2, label: "안 됨", note: "화면이 안 열려요" }] });
	expect(text).toMatch(/: 확인 (?:→|->) 2\) 안 됨 - 화면이 안 열려요/);
	const plain = inboxText({ kind: "message", source: "web", channel: "web", author: "me", mid: "d2", text: "1) 확인됨", picks: [{ q: "확인", n: 1, label: "확인됨" }] });
	expect(plain).toMatch(/: 확인 (?:→|->) 1\) 확인됨/);
	expect(plain).not.toContain("확인됨 -");
});

test("a notice option that needs detail is refused without text and answered as '2) 안 됨 - <text>'; '1) 확인됨' needs none", async () => {
	const title = `상세-${Date.now()}`;
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${title}\n결정: ${title}\n**1) 확인됨** ← 추천\n잘 열려요\n**2) 안 됨**\n어디가 안 되는지 적어 주세요\n` });
	const find = () => listNotices(300).items.find(i => i.kind === "decision" && i.title.includes(title))!;
	const sent: Parameters<DecisionSend>[0][] = [];
	const send: DecisionSend = async a => void sent.push(a);
	const id = find().id;
	expect((await answerDecision(id, { n: 2 }, send)).status).toBe(400);
	expect((await answerDecision(id, { n: 2, note: "  " }, send)).status).toBe(400);
	expect(sent).toEqual([]);
	expect((await answerDecision(id, { n: 2, note: "로그인이\n안 돼요" }, send)).status).toBe(200);
	expect(sent).toHaveLength(1);
	expect(sent[0]!.text).toBe("2) 안 됨 - 로그인이 안 돼요");
	expect(sent[0]!.picks).toEqual([{ q: title, n: 2, label: "안 됨", note: "로그인이 안 돼요" }]);
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${title}2\n결정: ${title}2\n**1) 확인됨** ← 추천\n잘 열려요\n**2) 안 됨**\n어디가 안 되는지 적어 주세요\n` });
	const other = listNotices(300).items.find(i => i.kind === "decision" && i.title.includes(`${title}2`))!;
	sent.length = 0;
	expect((await answerDecision(other.id, { n: 1 }, send)).status).toBe(200);
	expect(sent[0]!.text).toBe("1) 확인됨");
	expect(sent[0]!.picks).toEqual([{ q: `${title}2`, n: 1, label: "확인됨" }]);
});

function click(customId: string, type = 3, content = ASK, note?: string): Interaction {
	return { id: "i1", token: "t", type, member: { user: { id: "owner" } }, message: { content }, data: { custom_id: customId, ...(note === undefined ? {} : { components: [{ components: [{ custom_id: "note", value: note }] }] }) } };
}
function harness() {
	const replies: { type: number; data?: any }[] = [];
	const answers: [string, string][] = [];
	return { replies, answers, run: (d: Interaction) => askInteraction(d, { owner: "owner", reply: async (_d, type, data) => void replies.push({ type, data }), answer: (t, text) => void answers.push([t, text]) }) };
}

test("Discord: a needs-detail button opens a modal and sends nothing; the submit sends '2) 안 됨 - <text>'; '1) 확인됨' sends at once", async () => {
	const h = harness();
	await h.run(click(`${ASK_PREFIX}:chat:2`));
	expect(h.answers).toEqual([]);
	expect(h.replies.map(r => r.type)).toEqual([9]);
	expect(h.replies[0]!.data.custom_id).toBe(`${ASK_PREFIX}:chat:2`);
	expect(h.replies[0]!.data.components[0].components[0]).toMatchObject({ type: 4, custom_id: "note", style: 2, required: true });
	await h.run(click(`${ASK_PREFIX}:chat:2`, 5, ASK, "  화면이\n안 열려요 "));
	expect(h.answers).toEqual([["chat", "2) 안 됨 - 화면이 안 열려요"]]);
	expect(h.replies[1]!.type).toBe(7);
	await h.run(click(`${ASK_PREFIX}:chat:1`));
	expect(h.answers.at(-1)).toEqual(["chat", "1) 확인됨"]);
	expect(h.replies.at(-1)!.type).toBe(7);
});

test("Discord: an empty modal submit sends nothing", async () => {
	const h = harness();
	await h.run(click(`${ASK_PREFIX}:chat:2`, 5, ASK, "   "));
	expect(h.answers).toEqual([]);
	expect(h.replies[0]!.type).toBe(4);
});

test("two answers to the same decision arriving together send once; the second is told it is already being answered", async () => {
	const title = `동시-${Date.now()}`;
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${title}\n결정: ${title}\n**1) 보내기** ← 추천\n보내요\n**2) 보내지 않기**\n버려요\n` });
	const id = listNotices(300).items.find(i => i.kind === "decision" && i.title.includes(title))!.id;
	const sent: Parameters<DecisionSend>[0][] = [];
	let release = () => {};
	const gate = new Promise<void>(r => { release = r; });
	const send: DecisionSend = async a => { sent.push(a); await gate; };
	const first = answerDecision(id, { n: 1 }, send);
	const second = answerDecision(id, { n: 1 }, send);
	release();
	const [a, b] = await Promise.all([first, second]);
	expect(sent).toHaveLength(1);
	expect([a.status, b.status]).toEqual([200, 200]);
	expect(b.body.already).toBe(true);
});

