import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordGatewayAnswer } from "./approval-wire.ts";
import { ASK_PREFIX, askInteraction } from "./askbuttons.ts";
import { cardBlock } from "./choices.ts";
import { paths } from "./config.ts";
import type { Interaction } from "./discord.ts";
import { createEscalations, escalations, setEscalationsForTest } from "./escalate.ts";
import { emit, onBroadcast } from "./events.ts";
import { answerDecision, resetNoticesForTest } from "./notices.ts";
import { ANSWER_HOLD_MS, SessionEnded, sendHeldNow, unholdDecision, type DecisionSend } from "./notices-answers.ts";
import { listNotices } from "./notices-bell.ts";
import { flushNotices, items } from "./notices-store.ts";
import * as stop from "./shutdown.ts";
import { watchChoice } from "./watch-ask.ts";
import { advance } from "./runtime/test-clock.ts";

const card = (subject: string) => cardBlock({ subject, question: "원인을 찾아볼까요?", options: [{ name: "찾아봐요", result: "원인부터 찾아봐요" }, { name: "이번엔 둬요", result: "그대로 둬요" }] });
const post = (subjects: string[]) => emit("outbox", { ts: new Date(Date.now()).toISOString(), kind: "out", source: "gateway", target: "alert", text: `닥터 점검: 정할 것이 ${subjects.length}가지 있어요.\n\n${subjects.map(card).join("\n\n")}` });
const cards = () => items.filter(n => n.decision);
const listed = (id: string) => listNotices(300).items.find(n => n.id === id)!.decision!;
const sent: Parameters<DecisionSend>[0][] = [];
const ok: DecisionSend = async a => void sent.push(a);
beforeEach(() => {
	resetNoticesForTest();
	sent.length = 0;
	post(["업데이트", "실패 작업", "토큰"]);
});
afterEach(() => advance(ANSWER_HOLD_MS * 3));

test("a restart that waits for an idle gateway counts a held answer as work in progress until it has gone out", async () => {
	const [a] = cards();
	await answerDecision(a!.id, { n: 1, hold: true }, ok);
	expect(stop.stopWorkBusy()).toEqual(["held answers"]);
	await advance(ANSWER_HOLD_MS);
	expect(sent.map(s => s.notice)).toEqual([a!.id]);
	expect(stop.stopWorkBusy()).toEqual([]);
});

test("an orderly stop sends every held answer once before it saves anything, and holds no answer given after it", async () => {
	const [a, b, c] = cards();
	await answerDecision(a!.id, { n: 1, hold: true }, ok);
	await answerDecision(b!.id, { n: 2, hold: true }, ok);
	const exits: (number | undefined)[] = [], seenAtSave: string[][] = [], realExit = process.exit;
	process.exit = ((code?: number) => void exits.push(code)) as typeof process.exit;
	try {
		await stop.runShutdown([{ name: "save state", run: () => void seenAtSave.push(sent.map(s => s.notice)) }], 10_000);
		expect(seenAtSave).toEqual([[a!.id, b!.id]]);
		expect([a!.decision!.state, a!.decision!.answer, b!.decision!.state, b!.decision!.answer]).toEqual(["answered", "1) 찾아봐요", "answered", "2) 이번엔 둬요"]);
		expect(sent.length).toBe(2);
		const late = await answerDecision(c!.id, { n: 1, hold: true }, ok);
		expect(late.body.held).toBeUndefined();
		expect(c!.decision!.state).toBe("answered");
		await advance(ANSWER_HOLD_MS * 2);
		expect(sent.map(s => s.notice)).toEqual([a!.id, b!.id, c!.id]);
		expect(exits[0]).toBe(0);
	} finally {
		await advance(10_001);
		process.exit = realExit;
	}
});

test("a second answer during the hold is refused as held, with the label already given; the first goes out alone", async () => {
	const [a] = cards();
	await answerDecision(a!.id, { n: 1, hold: true }, ok);
	const second = await answerDecision(a!.id, { n: 2, hold: true }, ok);
	expect(second.status).toBe(409);
	expect(second.body).toMatchObject({ code: "held", held: { state: "held", label: "1) 찾아봐요" } });
	expect(String(second.body.error)).toContain("찾아봐요");
	await advance(ANSWER_HOLD_MS);
	expect(sent.map(s => [s.notice, s.text])).toEqual([[a!.id, `${a!.title}: 1) 찾아봐요`]]);
});

test("a Discord pick on a card held on the web is refused with the held label and sends nothing; the web answer goes out once", async () => {
	const [a] = cards();
	await answerDecision(a!.id, { n: 1, hold: true }, ok);
	const r = await discordGatewayAnswer("alert", "alert", `${a!.title}: 2) 이번엔 둬요`, [{ q: a!.title, n: 2, label: "이번엔 둬요" }]);
	expect(r?.error).toContain("찾아봐요");
	expect(sent).toEqual([]);
	await advance(ANSWER_HOLD_MS);
	expect(sent.map(s => s.text)).toEqual([`${a!.title}: 1) 찾아봐요`]);
	expect(a!.decision!.answer).toBe("1) 찾아봐요");
});

test("the listed card carries its hold (label and time left) while it waits, and the hold never reaches the notices file", async () => {
	const [a] = cards();
	await answerDecision(a!.id, { n: 1, hold: true }, ok);
	await advance(2000);
	expect(listed(a!.id)).toMatchObject({ state: "open", hold: { state: "held", label: "1) 찾아봐요", left: ANSWER_HOLD_MS - 2000 } });
	flushNotices();
	expect(readFileSync(paths.notices, "utf8")).not.toContain('"hold"');
	await advance(ANSWER_HOLD_MS);
	expect(listed(a!.id).hold).toBeUndefined();
});

const failures: [string, () => Error, { code: string; error: string }][] = [
	["the asking session ended", () => new SessionEnded("gone"), { code: "session_ended", error: "이 세션은 이미 끝나서 전달하지 못했어요" }],
	["a runtime mismatch", () => Object.assign(new Error("세션 실행기가 바뀌어서 보내지 않았어요"), { code: "runtime_mismatch" }), { code: "runtime_mismatch", error: "세션 실행기가 바뀌어서 보내지 않았어요" }],
	["the mail conversation is gone", () => new Error("이 메일 대화를 찾을 수 없어요"), { code: "not_delivered", error: "이 메일 대화를 찾을 수 없어요" }],
	["any other send error", () => new Error("socket closed"), { code: "not_delivered", error: "전달하지 못했어요. 잠시 뒤에 다시 해 주세요" }],
];
for (const [why, err, said] of failures)
	test(`a held answer whose delivery fails after the window (${why}) leaves the card open with the reason, the option and the text given`, async () => {
		const [a] = cards();
		await answerDecision(a!.id, { n: 2, hold: true }, async () => { throw err(); });
		await advance(ANSWER_HOLD_MS);
		expect(listed(a!.id)).toMatchObject({ state: "open", hold: { state: "failed", n: 2, label: "2) 이번엔 둬요", ...said } });
		expect((await answerDecision(a!.id, { n: 1, hold: true }, ok)).body.held).toMatchObject({ state: "held", label: "1) 찾아봐요" });
	});

test("the monitor's 다시 연결 (an option with an action) is not held: it answers at once, and a monitor that is gone says so at once", async () => {
	emit("outbox", { ts: new Date(Date.now()).toISOString(), kind: "out", source: "gateway", target: "alert", text: `메일 모니터링 로그인이 풀렸어요.\n${watchChoice("메일", "", true)}` });
	const w = cards().find(n => n.decision!.options.some(o => o.action))!;
	const r = await answerDecision(w.id, { n: 1, hold: true }, ok);
	expect(r.body.held).toBeUndefined();
	expect(sent.map(s => s.action)).toEqual(["watch-reconnect"]);
	expect(w.decision!.state).toBe("answered");
	resetNoticesForTest();
	emit("outbox", { ts: new Date(Date.now() + 1).toISOString(), kind: "out", source: "gateway", target: "alert", text: `메일 모니터링 로그인이 풀렸어요.\n${watchChoice("메일", "", true)}` });
	const again = cards().find(n => n.decision!.options.some(o => o.action))!;
	const gone = await answerDecision(again.id, { n: 1, hold: true }, async () => { throw new Error("이 모니터링을 찾을 수 없어요"); });
	expect(gone).toMatchObject({ status: 409, body: { code: "not_delivered", error: "이 모니터링을 찾을 수 없어요" } });
});

test("되돌리기 gives back the words typed with the answer", async () => {
	const [a] = cards();
	await answerDecision(a!.id, { note: "로그부터 보내 주세요", hold: true }, ok);
	expect(unholdDecision(a!.id).body).toMatchObject({ ok: true, back: { note: "로그부터 보내 주세요" } });
	await advance(ANSWER_HOLD_MS * 2);
	expect(sent).toEqual([]);
});

const answeredBroadcasts: unknown[] = [];
onBroadcast(e => {
	const d = e.kind === "notice" && e.item && typeof e.item === "object" && "decision" in e.item ? e.item.decision : undefined;
	if (d && typeof d === "object" && "state" in d && d.state === "answered") answeredBroadcasts.push("hold" in d ? d.hold : undefined);
});
test("a held answer delivered the way the web sends it (its inbox event settles the card) is broadcast as answered with no hold left on it", async () => {
	const [a] = cards();
	const likeSendWeb: DecisionSend = async x => {
		emit("inbox", { ts: new Date(Date.now()).toISOString(), kind: "message", source: "web", channel: "web:alert", author: "local", text: x.text, decision: x.notice, picks: x.picks, reply_to: x.replyTo });
		sent.push(x);
	};
	await answerDecision(a!.id, { n: 1, hold: true }, likeSendWeb);
	answeredBroadcasts.length = 0;
	await advance(ANSWER_HOLD_MS);
	expect(sent.map(s => s.notice)).toEqual([a!.id]);
	expect(answeredBroadcasts.length).toBeGreaterThan(0);
	expect(answeredBroadcasts).toEqual(answeredBroadcasts.map(() => undefined));
});

test("a real Discord button pick (its question carries the 결정: head) on a card held on the web is refused with the held label and is not sent", async () => {
	const text = `닥터 점검: 정할 것이 1가지 있어요.\n\n${card("백업")}`;
	emit("outbox", { ts: new Date(Date.now() + 1000).toISOString(), kind: "out", source: "gateway", target: "alert", text });
	const b = cards().find(n => n.title.startsWith("백업"))!;
	await answerDecision(b.id, { n: 1, hold: true }, ok);
	const replies: [number, string | null][] = [];
	const click = { id: "i1", token: "t", type: 3, member: { user: { id: "owner-1" } }, message: { content: text }, data: { custom_id: `${ASK_PREFIX}:alert:2` } } as Interaction;
	await askInteraction(click, { owner: "owner-1", reply: async (_d, type, data) => void replies.push([type, data && typeof data === "object" && "content" in data ? String(data.content) : null]), answer: async (t, tx, picks, edit) => (await discordGatewayAnswer(t, "alert", tx, picks, edit))?.error });
	expect(replies.length).toBe(1);
	expect(replies[0]![0]).toBe(4);
	expect(replies[0]![1]).toContain("찾아봐요");
	await advance(ANSWER_HOLD_MS);
	expect(sent.map(s => [s.notice, s.text])).toEqual([[b.id, "1) 찾아봐요"]]);
	expect(b.decision!.answer).toBe("1) 찾아봐요");
});

const reask = async () => {
	await advance(1000);
	emit("outbox", { ts: new Date(Date.now()).toISOString(), kind: "out", source: "gateway", target: "alert", text: `닥터 점검: 정할 것이 4가지 있어요.\n\n${["새 일", "업데이트", "실패 작업", "토큰"].map(card).join("\n\n")}` });
};
test("a re-ask of the same question inside the window keeps the hold: a second answer is refused with the first label, and the first goes out once", async () => {
	const [a] = cards();
	await answerDecision(a!.id, { n: 1, hold: true }, ok);
	await reask();
	const second = await answerDecision(a!.id, { n: 2, hold: true }, ok);
	expect(second.status).toBe(409);
	expect(second.body).toMatchObject({ code: "held", held: { state: "held", label: "1) 찾아봐요" } });
	await advance(ANSWER_HOLD_MS * 3);
	expect(sent.map(s => [s.notice, s.text])).toEqual([[a!.id, `${a!.title}: 1) 찾아봐요`]]);
	expect(a!.decision!.answer).toBe("1) 찾아봐요");
	expect(stop.stopWorkBusy()).toEqual([]);
});

test("a re-ask of the same question inside the window keeps the hold: 되돌리기 takes the first answer back and nothing is sent", async () => {
	const [a] = cards();
	await answerDecision(a!.id, { note: "로그부터 보내 주세요", hold: true }, ok);
	await reask();
	expect(unholdDecision(a!.id)).toMatchObject({ status: 200, body: { back: { note: "로그부터 보내 주세요" } } });
	await advance(ANSWER_HOLD_MS * 3);
	expect(sent).toEqual([]);
	expect(a!.decision!.state).toBe("open");
	expect(stop.stopWorkBusy()).toEqual([]);
});

test("an orderly stop waits for a held answer whose delivery already started, and the gateway is busy until it finished", async () => {
	const [a] = cards();
	const releases: (() => void)[] = [];
	const slow: DecisionSend = x => {
		const { promise, resolve } = Promise.withResolvers<void>();
		releases.push(() => { sent.push(x); resolve(); });
		return promise;
	};
	await answerDecision(a!.id, { n: 1, hold: true }, slow);
	await advance(ANSWER_HOLD_MS);
	expect(stop.stopWorkBusy()).toEqual(["held answers"]);
	expect(unholdDecision(a!.id)).toMatchObject({ status: 409, body: { code: "gone_out" } });
	let stopped = false;
	const stopping = sendHeldNow().then(() => { stopped = true; });
	for (let i = 0; i < 5; i++) await Promise.resolve();
	expect(stopped).toBe(false);
	for (const r of releases) r();
	await stopping;
	expect(sent.map(s => s.notice)).toEqual([a!.id]);
	expect(a!.decision!.state).toBe("answered");
	expect(stop.stopWorkBusy()).toEqual([]);
});

test("a stronger-model card is not held: its answer acts on the proposal at once, so a pick elsewhere cannot act on it first", async () => {
	const dir = mkdtempSync(join(tmpdir(), "answer-hold-escalate-")), launched: string[] = [];
	setEscalationsForTest(
		createEscalations({
			file: join(dir, "escalations.json"),
			now: Date.now,
			post: (target, text, author) => void emit("outbox", { ts: new Date(Date.now() + 1000).toISOString(), kind: "out", source: author, target, text }),
			launch: async req => (launched.push(req.session), { lane: req.name }),
			tell: () => {},
			stop: () => {},
		}),
	);
	try {
		const before = new Set(cards().map(n => n.id));
		await escalations()!.propose({ cwd: "/home/user/repo", current: "acme/mid-model:medium", offer: "acme/mid-model:high", step: "rewrite the parser", reason: "three tries failed", est: 5, asker: "main" });
		const [card] = cards().filter(n => !before.has(n.id));
		const r = await answerDecision(card!.id, { n: 1, hold: true }, async a => {
			await escalations()!.answer({ to: a.to, label: a.picks![0]!.label });
			sent.push(a);
		});
		expect(r.body.held).toBeUndefined();
		expect([launched.length, sent.map(s => s.notice), card!.decision!.state]).toEqual([1, [card!.id], "answered"]);
	} finally {
		setEscalationsForTest(undefined);
		rmSync(dir, { recursive: true, force: true });
	}
});
