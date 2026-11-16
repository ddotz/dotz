// The typed path and the model's marker path of the reply intent design (2026-11-16) on the real intake and outbound: a typed card option acts at once,
// every other word reaches the model with the card note, and the model's markers act through the reply flow: a send only as a confirm card.
import { afterEach, expect, test } from "bun:test";
import { CARDS_LEAD } from "./approval-queue.ts";
import { convs } from "./convsessions.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit, onEmit, type HubEvent } from "./events.ts";
import { bursts, flush, intake } from "./intake.ts";
import { createReplyActions, setReplies, type ActCtx, type ActResult, type OpenCard, type ReplyDeps } from "./reply-actions.ts";
import { awaiting, convOfTarget, out, queue } from "./outbound.ts";

type Replies = ReturnType<typeof createReplyActions>;
const iso = (ms: number) => new Date(ms).toISOString();
const openIn = (ref: string, conv: string, asked = iso(0)): OpenCard[] => [{ ref, conv, notice: `n-${ref}`, title: `이 답장 보낼까요? (${ref})`, asked }];
const item = (ref: string, conv: string, at: number) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv, at, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "", to: "", text: "x" } });

// A fake reply flow over the cards the test gives: each act and confirm is kept with its context. The typed path never lists replies.
function fake(cards: OpenCard[], o: { confirm?: ActResult } = {}) {
	const acts: { input: Record<string, unknown>; ctx: ActCtx }[] = [], confirms: { input: { ref: string }; ctx: ActCtx }[] = [];
	let acted!: (a: Record<string, unknown>) => void;
	const actedOnce = new Promise<Record<string, unknown>>(r => (acted = r));
	setReplies({
		open: (conv: string) => cards.filter(c => c.conv === conv),
		act: async (input: Record<string, unknown>, ctx: ActCtx) => (acts.push({ input, ctx }), acted(input), { status: 200, body: { ok: true } }),
		confirm: async (input: { ref: string }, ctx: ActCtx) => (confirms.push({ input, ctx }), o.confirm ?? { status: 200, body: { ok: true } }),
		revising: () => false,
		list: async () => Promise.reject(new Error("the typed path lists no replies")),
	} as unknown as Replies);
	return { acts, confirms, actedOnce };
}
const say = (target: string, text: string, mid = "m1", reply?: string) => {
	intake({ ts: new Date().toISOString(), kind: "message", source: "web", channel: target, author: "local", text, mid, ...(reply ? { reply: { id: reply, author: "", content: "카드" } } : {}) }, target, mid);
	flush(target);
};
// The owner's message `mid` in `target` as the inbox keeps it: what the model's answer names.
const owner = (target: string, mid: string, text: string) => emit("inbox", { ts: new Date().toISOString(), kind: "message", source: "web", channel: target, author: "local", text, mid });
const lineIn = (target: string, source: string) => new Promise<string>(r => onEmit(e => void (e.kind === "out" && e.target === target && e.source === source && !e.update_key && r(String(e.text)))));
afterEach(() => setReplies(undefined));

test("a typed 1) 보내기 with one open card in the conversation sends it, with no model turn and no reply list", async () => {
	const f = fake(openIn("RA00001", "ch:91001"));
	say("ch:91001", "1) 보내기");
	expect(await f.actedOnce).toEqual({ ref: "RA00001", action: "send" });
	expect([bursts.has("ch:91001"), f.acts[0]!.ctx]).toEqual([false, { surface: "chat" }]);
});

test("a typed 2) 고치기 - <change> revises that card", async () => {
	const f = fake(openIn("RA00002", "ch:91002"));
	say("ch:91002", "2) 고치기 - 금요일을 목요일로");
	expect(await f.actedOnce).toEqual({ ref: "RA00002", action: "revise", change: "금요일을 목요일로" });
});

test("two open cards and no quote: a typed option changes nothing and reaches the model as an ordinary turn", () => {
	const f = fake([...openIn("RA00003", "ch:91003"), ...openIn("RA00004", "ch:91003")]);
	say("ch:91003", "1) 보내기");
	expect([f.acts, awaiting.get("ch:91003")?.map(w => w.ref)]).toEqual([[], ["m1"]]);
});

// The owner's real lines a keyword reader acted on (server.md S2, the 안내문 inbox): each reaches the model; no card acts.
test("보내 / 응 / 좋아 / 보내지 마 / 답장 좀 더 짧게 under the newest card act on nothing: each is the model's turn", () => {
	for (const [k, text] of ["보내", "응", "좋아", "보내지 마", "답장 좀 더 짧게 해줘", "아 빌드 그만해. 좀 한번에.빌드하자", "회의 취소됐어"].entries()) {
		const target = `ch:9102${k}`;
		const f = fake(openIn(`RC0000${k}`, target, iso(Date.now())));
		say(target, text);
		expect([text, f.acts, awaiting.get(target)?.map(w => w.ref)]).toEqual([text, [], ["m1"]]);
	}
});

// S2: a bare 응 two posts after the card answers what came after it; the model tells which from the note, never a keyword rule.
test("the model's turn carries the card note: recipient, start of the draft, not the newest post, and the three markers", () => {
	const target = "ch:91061", ref = "RN00001";
	fake([]);
	emit("outbox", { ts: iso(Date.now() - 2000), kind: "out", source: "orchestrator", target, text: `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "kim@example.com", toLabel: "받는이", body: "선생님 안녕하세요:) 요청하신 자료를 보내드려요", ref, question: "이 메일 보낼까요?" })}` });
	emit("outbox", { ts: iso(Date.now() - 1000), kind: "out", source: "orchestrator", target, text: "해시태그도 이렇게 바꿀까요?" });
	say(target, "응", "m-note");
	const prompt = (convs.forTarget(target)?.queue ?? queue).queued().find(p => p.replyTo === "m-note")?.text ?? "";
	const row = prompt.split("\n").find(l => l.startsWith("- ") && l.includes(`(${ref})`)) ?? "";
	for (const want of ["to kim@example.com", "\"선생님 안녕하세요:) 요청하신 자료를 보내드려요\"", "not the newest post"]) expect([want, row.includes(want)]).toEqual([want, true]);
	for (const want of [CARDS_LEAD, "[send <ref>]", "[drop <ref>]", "[revise <ref>]"]) expect([want, prompt.includes(want)]).toEqual([want, true]);
});

// B2 next to B1: the store keeps the draft in mail:abc, its card was posted in the main chat; a typed 1) 보내기 there acts on it and one gateway line says so.
test("a store draft carded in the web chat: a typed 1) 보내기 there sends it and posts the gateway line", async () => {
	const said = new Promise<HubEvent>(r => onEmit(e => void (e.kind === "out" && e.target === "web" && e.source === "gateway" && r(e))));
	const view = item("RE00001", "mail:abc", 1);
	const adapter = { kind: "mail", list: async () => [view], get: async (ref: string) => (ref === view.ref ? view : undefined) };
	const real = createReplyActions({ adapters: [adapter], sender: { results: () => [] }, cards: { open: () => [{ ...openIn("RE00001", convOfTarget("web"))[0]!, asked: iso(Date.now() - 1000) }] }, log: () => undefined } as unknown as ReplyDeps);
	const acts: unknown[] = [];
	setReplies({ ...real, act: async (input: Record<string, unknown>) => (acts.push(input), { status: 200, body: { ok: true } }) } as unknown as Replies);
	say("web", "1) 보내기");
	const line = await said;
	expect([acts, line.text]).toEqual([[{ ref: "RE00001", action: "send" }], "보낼게요"]);
});

// S10: a quote of the card's own post names it, though a later post pushed it up.
test("a typed 1) 보내기 quoting an older card's post sends that card when two are open", async () => {
	const asked = iso(Date.now() - 2000);
	const f = fake([...openIn("RD00001", "ch:91031", asked), ...openIn("RD00002", "ch:91031", iso(Date.now() - 1000))]);
	say("ch:91031", "1) 보내기", "m1", asked);
	expect(await f.actedOnce).toEqual({ ref: "RD00001", action: "send" });
});

test("a marker line in the orchestrator's answer runs the revise and is not shown", async () => {
	const f = fake(openIn("RA00006", "ch:91041"));
	const r = await out("ch:91041", "[revise RA00006] 금요일을 목요일로");
	expect(r.delivered).toBe(true);
	expect(await f.actedOnce).toEqual({ ref: "RA00006", action: "revise", change: "금요일을 목요일로" });
});

test("[send] in the answer to the owner's message posts the confirm card and sends nothing; the marker line is not shown", async () => {
	const target = "ch:91071";
	const f = fake(openIn("RA00071", target));
	owner(target, "m-71", "보내");
	const shown = lineIn(target, "orchestrator");
	await out(target, "보낼게요\n[send RA00071]", "m-71", { source: "orchestrator" });
	expect([await shown, f.confirms.map(c => [c.input, c.ctx.owner?.mid, c.ctx.agent]), f.acts]).toEqual(["보낼게요", [[{ ref: "RA00071" }, "m-71", undefined]], []]);
});

test("[drop] in the answer to the owner's message is his word (his message named, no agent flag) and one gateway line says so", async () => {
	const target = "ch:91072";
	const f = fake(openIn("RA00072", target));
	owner(target, "m-72", "메일 안 보내도 돼");
	const line = lineIn(target, "gateway");
	await out(target, "[drop RA00072]", "m-72", { source: "orchestrator" });
	expect([await line, f.acts.map(a => [a.input, a.ctx.owner?.mid, a.ctx.agent])]).toEqual(["이 답장은 보내지 않을게요", [[{ ref: "RA00072", action: "drop" }, "m-72", undefined]]]);
});

test("[revise] answering the owner is his word; in a progress note it stays the agent's own", async () => {
	const target = "ch:91073";
	const f = fake(openIn("RA00073", target));
	owner(target, "m-73", "답장 좀 더 짧게. 화요일 얘기는 빼");
	await out(target, "[revise RA00073] 답장 좀 더 짧게. 화요일 얘기는 빼", "m-73", { source: "orchestrator" });
	await out(target, "[revise RA00073] 더 짧게", undefined, { source: "orchestrator", update_key: "progress" });
	expect(f.acts.map(a => [a.input.change, a.ctx.owner?.mid, a.ctx.agent])).toEqual([["답장 좀 더 짧게. 화요일 얘기는 빼", "m-73", undefined], ["더 짧게", undefined, true]]);
});

test("[send] in a progress note, a lane's post or an answer to another conversation's message confirms nothing", async () => {
	const target = "ch:91074";
	const f = fake(openIn("RA00074", target));
	owner(target, "m-74", "보내");
	owner("ch:91099", "m-74b", "보내");
	await out(target, "[send RA00074]", "m-74", { source: "orchestrator", update_key: "progress" });
	await out(target, "보낼게요\n[send RA00074]", "m-74", { source: "lane:x" });
	await out(target, "[send RA00074]", "m-74b", { source: "orchestrator" });
	expect(f.confirms).toEqual([]);
});

test("[send] for a card that is not open confirms nothing and the owner is pointed to the card's 보내기", async () => {
	const target = "ch:91076";
	const f = fake(openIn("RA00076", target));
	owner(target, "m-76", "보내");
	const line = lineIn(target, "gateway");
	await out(target, "[send RGONE00]", "m-76", { source: "orchestrator" });
	expect([await line, f.confirms.length]).toEqual(["보낼 카드를 찾지 못했어요. 카드의 보내기를 눌러 주세요", 0]);
});

test("[send] on a draft being revised: refused, and the owner hears the revised card will carry its own 보내기", async () => {
	const target = "ch:91077";
	fake(openIn("RA00077", target), { confirm: { status: 409, body: { ok: false, code: "revising", error: "고치는 중" } } });
	owner(target, "m-77", "보내");
	const line = lineIn(target, "gateway");
	await out(target, "[send RA00077]", "m-77", { source: "orchestrator" });
	expect(await line).toBe("고치는 중이에요. 고친 카드가 올라오면 거기서 보내기를 눌러 주세요");
});

// B4 (server.md S5): an answer that is only the marker settles the owner's message as a posted answer would.
test("a marker-only answer marks the waiting owner message answered", async () => {
	const target = "ch:91042";
	fake(openIn("RE00002", target));
	const answered = new Promise<HubEvent>(r => onEmit(e => void (e.kind === "delivery" && e.target === target && e.ref === "m-b4" && e.state === "answered" && r(e))));
	awaiting.set(target, [{ ref: "m-b4" }]);
	expect(await out(target, "[revise RE00002] 짧게")).toEqual({ delivered: true });
	expect((await answered).state).toBe("answered");
	expect(awaiting.get(target)).toEqual([]);
});

// B3 (server.md S4): a marker no open card takes runs nothing and its line is not stored or shown.
test("a marker for a ref that is not open runs nothing and is not shown", async () => {
	const f = fake([]);
	const stored = new Promise<HubEvent>(r => onEmit(e => void (e.kind === "out" && e.target === "ch:91043" && r(e))));
	await out("ch:91043", "알겠어요\n[revise RZ99999] 짧게");
	expect([f.acts, (await stored).text]).toEqual([[], "알겠어요"]);
});
