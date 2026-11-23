import { afterAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { now } from "./config.ts";
import { emit, onBroadcast } from "./events.ts";
import { msg } from "./i18n.ts";
import { flush, sendWeb } from "./intake.ts";
import { ASK_PREFIX, askInteraction } from "./askbuttons.ts";
import { ANSWER_WINDOW_MS, allNotices, answerDecision, clockText, dropLaneNotices, flushNotices, ignoreNotice, moreNotice, needsAnswer, nextMorning, onDecision, onHalfTime, reopenNotices, resetNoticesForTest, resolveNotices, sweepQuestions, unreadCount, type Notice } from "./notices.ts";
import { queue } from "./outbound.ts";
import { halfTimePush } from "./push.ts";
import { routeNotices } from "./routes-notices.ts";

process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => void delete process.env.DOTZ_NO_ORCHESTRATOR);

const TITLE = "SSH 복구 명령을 만들까요?";
const HOUR = 3_600_000;
const clockNow = () => Date.parse(now());
let asked = "";
const askMain = (title = TITLE, choices = true) => {
	asked = new Date(clockNow() - 60_000).toISOString();
	emit("outbox", { ts: asked, kind: "out", source: "orchestrator", target: "web", text: choices ? `[ask] ${title}\n결정: ${title}\n**1) 만들기**\n**2) 두기**` : `[ask] ${title}` });
};
const askLane = (lane: string, title: string, choices = true) =>
	emit("inbox", { ts: new Date(clockNow() - 60_000).toISOString(), kind: "lane_report", source: `lane:${lane}`, lane, text: choices ? `[ask] ${title}\n결정: ${title}\n**1) 예**\n**2) 아니요**` : `[ask] ${title}` });
const card = (title = TITLE): Notice => allNotices().find(n => n.kind === "decision" && n.title === title)!;
const at = (ms: number) => new Date(Date.parse(asked) + ms).toISOString();
const post = async (id: string, act: string, body: unknown = {}, agent = false) => {
	const url = `http://local/api/notices/${id}/${act}`;
	const res = (await routeNotices(new Request(url, { method: "POST", body: JSON.stringify(body) }), new URL(url), agent))!;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> & { item?: Notice } };
};
const gatewayLine = (line: string) => `[dotz gateway] ${line}`;
let n = 0;
const ownerPrompt = async (): Promise<string> => {
	await sendWeb({ channel: "web", text: `다른 얘기${"요".repeat(++n)}`, mode: "default", login: "local" });
	flush("web");
	const p = queue.queued().at(-1)!;
	queue.onPrompt(p.text);
	queue.onAnswer("알겠어요.");
	queue.settleTurn();
	return p.text;
};
function inFreshProcess(body: string): Record<string, unknown> {
	flushNotices();
	const run = Bun.spawnSync([process.execPath, "-e", `const m = await import("./hub/notices.ts"); ${body} process.exit(0);`], { cwd: join(import.meta.dir, ".."), env: process.env });
	expect(run.exitCode).toBe(0);
	return JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!);
}
const pushes: string[] = [];
onDecision(n => void pushes.push(n.id));
const halves: string[] = [];
onHalfTime(n => void halves.push(n.id));

const heard: Notice[] = [];
onBroadcast(e => void (e.kind === "notice" && heard.push(structuredClone(e.item) as Notice)));
beforeEach(() => {
	resetNoticesForTest();
	pushes.length = 0;
	halves.length = 0;
});

test("자세히 알려 주세요 keeps the card open with more_at and starts one gateway turn of its asker; a second press asks nothing more; the hub token is refused", async () => {
	askMain();
	const id = card().id;
	const before = queue.queued().length;
	const r = await post(id, "more");
	expect(r.status).toBe(200);
	expect(r.body.ok).toBe(true);
	const moreAt = r.body.item!.decision!.more_at;
	expect(typeof moreAt).toBe("string");
	expect(r.body.item!.decision!.state).toBe("open");
	const turns = queue.queued().slice(before);
	expect(turns.map(p => p.text)).toEqual([gatewayLine(msg().asker.more(TITLE))]);
	const again = await post(id, "more");
	expect(again.body.item!.decision!.more_at).toBe(moreAt);
	expect(queue.queued().length).toBe(before + 1);
	queue.onPrompt(turns[0]!.text);
	queue.onAnswer("다시 올릴게요.");
	queue.settleTurn();
	expect(await post(id, "later", { for: "hour" }, true)).toMatchObject({ status: 403, body: { code: "owner_only" } });
	expect(card().decision!.later_until).toBeUndefined();
});

test("자세히 알려 주세요 to an asker that cannot be reached stamps nothing and answers 502, on the web and on Discord; the button works again, and once delivered it is one-shot", async () => {
	askLane("gone-asker", "끝난 세션에게 물을까요?");
	const id = card("끝난 세션에게 물을까요?").id;
	const before = queue.queued().length;
	const r = await post(id, "more");
	expect(r).toMatchObject({ status: 502, body: { error: msg().asker.moreFailed } });
	expect(card("끝난 세션에게 물을까요?").decision!.more_at).toBeUndefined();
	expect(queue.queued().length).toBe(before);
	const replies: unknown[] = [];
	await askInteraction({ id: "i1", token: "t", type: 3, member: { user: { id: "owner-1" } }, message: { content: "[ask] 끝난 세션에게 물을까요?\n결정: 끝난 세션에게 물을까요?\n**1) 예**\n**2) 아니요**" }, data: { custom_id: `${ASK_PREFIX}:lane:gone-asker:more` } }, { owner: "owner-1", reply: async (_d, _type, data) => void replies.push(data) });
	expect(replies).toEqual([{ content: msg().asker.moreFailed, flags: 64, allowed_mentions: { parse: [] } }]);
	expect(card("끝난 세션에게 물을까요?").decision!.more_at).toBeUndefined();

	const sent: string[] = [];
	const down = () => {
		throw new Error("lane gone-asker does not exist");
	};
	expect(moreNotice(id, down).status).toBe(502);
	expect(card("끝난 세션에게 물을까요?").decision!.more_at).toBeUndefined();
	const ok = moreNotice(id, (_to, text) => void sent.push(text));
	expect(ok.status).toBe(200);
	const stamped = card("끝난 세션에게 물을까요?").decision!.more_at;
	expect(typeof stamped).toBe("string");
	expect(moreNotice(id, down).status).toBe(200);
	expect(moreNotice(id, (_to, text) => void sent.push(text)).status).toBe(200);
	expect(sent).toEqual([msg().asker.more("끝난 세션에게 물을까요?")]);
	expect(card("끝난 세션에게 물을까요?").decision!.more_at).toBe(stamped);
});

test("나중에 takes the card off the open lists until later_until, tells the asker once with its next prompt and starts no turn; at that time it comes back once with one push, also after a restart", async () => {
	askMain();
	const id = card().id, from = clockNow();
	const queued = queue.queued().length;
	expect(await post(id, "later", { for: "soon" })).toMatchObject({ status: 400 });
	const r = await post(id, "later", { for: "hour" });
	expect(r.status).toBe(200);
	const until = r.body.item!.decision!.later_until!;
	expect(Date.parse(until) - from).toBeGreaterThanOrEqual(HOUR);
	expect(Date.parse(until) - clockNow()).toBeLessThanOrEqual(HOUR);
	expect(card().decision!.state).toBe("open");
	expect(needsAnswer(card())).toBe(false);
	expect(unreadCount()).toBe(0);
	expect(queue.queued().length).toBe(queued);
	const told = gatewayLine(msg().asker.later(TITLE, clockText(Date.parse(until))));
	expect(await ownerPrompt()).toContain(told);
	expect(await ownerPrompt()).not.toContain(told);
	sweepQuestions(new Date(Date.parse(until) - 1000).toISOString());
	expect(pushes).toEqual([id]);
	const fresh = inFreshProcess(
		`let pushed = 0; m.onDecision(() => pushed++); const c = () => m.allNotices().find(n => n.id === ${JSON.stringify(id)}); const stored = c().decision.later_until; m.sweepQuestions(${JSON.stringify(new Date(Date.parse(until) + 1000).toISOString())}); const woke = { read: c().read, later: c().decision.later_until ?? null, state: c().decision.state, needs: m.needsAnswer(c()) }; m.sweepQuestions(${JSON.stringify(new Date(Date.parse(until) + 60_000).toISOString())}); console.log(JSON.stringify({ stored, woke, pushed }));`,
	);
	expect(fresh).toEqual({ stored: until, woke: { read: false, later: null, state: "open", needs: true }, pushed: 1 });
});

test("나중에 · 내일 아침 is the next 08:00 on the owner's clock, for any time of day", () => {
	for (let i = 0; i < 200; i++) {
		const from = Date.UTC(2026, 0, 1) + i * 7_919_000 + (i % 7) * 13_337;
		const next = nextMorning(from);
		expect(clockText(next)).toBe("08:00");
		expect(next).toBeGreaterThan(from);
		expect(next - from).toBeLessThanOrEqual(24 * HOUR);
	}
});

test("half of the answer time gone: one push '<title> · 답할 시간이 절반 남았어요', never twice, not while put off, and half_told survives a restart", async () => {
	askMain();
	const id = card().id;
	sweepQuestions(at(ANSWER_WINDOW_MS / 2 - 60_000));
	expect(halves).toEqual([]);
	sweepQuestions(at(ANSWER_WINDOW_MS / 2 + 60_000));
	expect(halves).toEqual([id]);
	expect(card().decision!.half_told).toBe(true);
	expect(halfTimePush(card()).body).toBe(msg().asker.half(TITLE));
	sweepQuestions(at(ANSWER_WINDOW_MS / 2 + 2 * HOUR));
	expect(halves).toEqual([id]);
	const fresh = inFreshProcess(`let halves = 0; m.onHalfTime(() => halves++); m.sweepQuestions(${JSON.stringify(at(ANSWER_WINDOW_MS / 2 + 3 * HOUR))}); console.log(JSON.stringify({ halves, told: m.allNotices().find(n => n.id === ${JSON.stringify(id)}).decision.half_told }));`);
	expect(fresh).toEqual({ halves: 0, told: true });

	resetNoticesForTest();
	askMain("나중에 볼 질문인가요?");
	const later = card("나중에 볼 질문인가요?").id;
	await post(later, "later", { for: "morning" });
	sweepQuestions(at(ANSWER_WINDOW_MS / 2 + 60_000));
	expect(halves).toEqual([id]);
});

test("a card whose time ran out closes as expired and its asker hears it once with its next prompt; a session that has ended hears nothing", async () => {
	askMain();
	askLane("ended-lane", "세션이 끝난 질문인가요?");
	const queued = queue.queued().length;
	expect(sweepQuestions(at(ANSWER_WINDOW_MS + HOUR))).toBe(2);
	expect(card().decision).toMatchObject({ state: "answered", resolved: true, expired: true, closed_how: "expired" });
	expect(card("세션이 끝난 질문인가요?").decision).toMatchObject({ closed_how: "expired" });
	expect(card("세션이 끝난 질문인가요?").decision!.tell).toBeUndefined();
	expect(queue.queued().length).toBe(queued);
	const told = gatewayLine(msg().asker.expired(TITLE));
	expect(await ownerPrompt()).toContain(told);
	expect(await ownerPrompt()).not.toContain(told);
	reopenNotices([card().id]);
	expect(card().decision).toMatchObject({ state: "open" });
	expect(card().decision!.closed_how).toBeUndefined();
});

test("무시 tells the asker once with its next prompt and starts no turn", async () => {
	askMain();
	const queued = queue.queued().length;
	expect(ignoreNotice(card().id).status).toBe(200);
	expect(queue.queued().length).toBe(queued);
	const told = gatewayLine(msg().asker.ignored(TITLE));
	expect(await ownerPrompt()).toContain(told);
	expect(await ownerPrompt()).not.toContain(told);
});

test("every close no button made says how: words with the owner's message, done when the work ended, gone when the session ended; a button answer says none", async () => {
	askMain();
	resolveNotices({ ids: [card().id] }, undefined, undefined, { ts: new Date().toISOString(), text: "  그냥   둘 다\n만들어 줘 " });
	expect(card().decision).toMatchObject({ closed_how: "words", words: "그냥 둘 다 만들어 줘" });

	askMain("오래된 말로 닫힌 질문인가요?");
	resolveNotices({ ids: [card("오래된 말로 닫힌 질문인가요?").id] }, undefined, undefined, { ts: new Date(clockNow() - HOUR).toISOString(), text: "예전 말" });
	expect(card("오래된 말로 닫힌 질문인가요?").decision).toMatchObject({ closed_how: "done" });
	expect(card("오래된 말로 닫힌 질문인가요?").decision!.words).toBeUndefined();

	askLane("done-lane", "이어서 할까요?", false);
	emit("inbox", { ts: new Date().toISOString(), kind: "lane_report", source: "lane:done-lane", lane: "done-lane", text: "[done] 다 했어요" });
	expect(card("이어서 할까요?").decision).toMatchObject({ state: "answered", closed_how: "done" });

	askLane("gone-lane", "끝난 세션이 물었나요?");
	dropLaneNotices("gone-lane");
	const gone = heard.findLast(n => n.title === "끝난 세션이 물었나요?")!;
	expect(gone.decision).toMatchObject({ state: "answered", closed_how: "gone" });
	expect(gone.decision!.tell).toBeUndefined();

	askMain("버튼으로 답한 질문인가요?");
	await answerDecision(card("버튼으로 답한 질문인가요?").id, { n: 1 }, async a => void emit("inbox", { ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", author: "local", text: a.text, decision: a.notice }));
	expect(card("버튼으로 답한 질문인가요?").decision).toMatchObject({ state: "answered", answer: "1) 만들기" });
	expect(card("버튼으로 답한 질문인가요?").decision!.closed_how).toBeUndefined();

	askMain("말로 바로 닫히는 질문인가요?", false);
	await sendWeb({ channel: "web", text: "응 그렇게 해", mode: "default", login: "local" });
	expect(card("말로 바로 닫히는 질문인가요?").decision).toMatchObject({ state: "answered", closed_how: "words", words: "응 그렇게 해" });
});

test("Discord's 나중에 and 자세히 알려 주세요 on the card go through the same hub paths as the web", async () => {
	askMain();
	const replies: unknown[] = [];
	const quiet = (content: string) => ({ content, flags: 64, allowed_mentions: { parse: [] } });
	const click = (act: string) =>
		askInteraction({ id: "i1", token: "t", type: 3, member: { user: { id: "owner-1" } }, message: { content: `[ask] ${TITLE}\n결정: ${TITLE}\n**1) 만들기**\n**2) 두기**` }, data: { custom_id: `${ASK_PREFIX}:chat:${act}` } }, { owner: "owner-1", reply: async (_d, _type, data) => void replies.push(data) });
	await click("later");
	const until = card().decision!.later_until!;
	expect(Date.parse(until) - clockNow()).toBeGreaterThan(HOUR - 60_000);
	expect(replies).toEqual([quiet(msg().asker.putOff(clockText(Date.parse(until))))]);
	const before = queue.queued().length;
	await click("more");
	expect(card().decision!.more_at).toEqual(expect.any(String));
	expect(queue.queued().slice(before).map(p => p.text)).toEqual([gatewayLine(msg().asker.more(TITLE))]);
	expect(replies[1]).toEqual(quiet(msg().asker.askedMore(clockText(Date.parse(card().decision!.more_at!)))));
	const p = queue.queued().at(-1)!;
	queue.onPrompt(p.text);
	queue.onAnswer("다시 올릴게요.");
	queue.settleTurn();
});

test("나중에 on a card whose answer time ends before later_until keeps it until then: it comes back open with one push and a full answer window", async () => {
	askMain();
	const id = card().id;
	card().decision!.expires_at = new Date(clockNow() + 30 * 60_000).toISOString();
	const r = await post(id, "later", { for: "hour" });
	const until = r.body.item!.decision!.later_until!;
	expect(sweepQuestions(new Date(Date.parse(until) - 60_000).toISOString())).toBe(0);
	sweepQuestions(new Date(Date.parse(until) + 1000).toISOString());
	expect(card().decision).toMatchObject({ state: "open" });
	expect(card().decision!.closed_how).toBeUndefined();
	expect(Date.parse(card().decision!.expires_at!) - Date.parse(until)).toBe(ANSWER_WINDOW_MS);
	expect(pushes).toEqual([id, id]);
});

test("Discord's 나중에 and 자세히 알려 주세요 on the message of a card that already closed touch no other open card", async () => {
	askMain("이미 닫힌 질문인가요?");
	askMain();
	resolveNotices({ ids: [card("이미 닫힌 질문인가요?").id] });
	const before = queue.queued().length;
	const replies: unknown[] = [];
	for (const act of ["later", "more"])
		await askInteraction({ id: "i1", token: "t", type: 3, member: { user: { id: "owner-1" } }, message: { content: "[ask] 이미 닫힌 질문인가요?\n결정: 이미 닫힌 질문인가요?\n**1) 만들기**\n**2) 두기**" }, data: { custom_id: `${ASK_PREFIX}:chat:${act}` } }, { owner: "owner-1", reply: async (_d, _type, data) => void replies.push(data) });
	expect(card().decision).toMatchObject({ state: "open" });
	expect(card().decision!.later_until).toBeUndefined();
	expect(card().decision!.more_at).toBeUndefined();
	expect(card().decision!.tell).toBeUndefined();
	expect(queue.queued().length).toBe(before);
	expect(replies).toEqual([0, 1].map(() => ({ content: msg().auth.finished, flags: 64, allowed_mentions: { parse: [] } })));
});
