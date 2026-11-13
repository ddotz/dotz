// A choice question the owner answers in his own words (2026-11-10 19:05 KST: "사이트 배포는 기존에 하던 방식으로 해") does not stay open in 답변 필요:
// quoting the one-question message settles it (hub/notices-store.ts ownerReplied), and any other message that lands in a conversation with
// open choice questions carries their titles to the bot (hub/intake.ts inboxBody), which closes them with dotz_send's `resolves`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { emit } from "./events.ts";
import { flush, inboxText, sendWeb } from "./intake.ts";
import { answerDecision, type DecisionSend, resetNoticesForTest, type Notice } from "./notices.ts";
import { putDecision } from "./notices-store.ts";
import { orch } from "./orchestrator.ts";
import { setUpdateNow, type UpdateNow } from "./update-now.ts";

const stored = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));
const decisions = () => stored().filter(n => n.kind === "decision");
const byTitle = (title: string) => decisions().find(n => n.title === title)!.decision!;
// An hour ago, not a fixed day: a question older than its answer window (ANSWER_WINDOW_MS, 72 h) is expired and nothing answers it. On the clock
// config.ts now() reads (new Date(), the real one), not the fake Date.now of test-clock.ts: an answer only closes a question asked before it.
const minutesAgo = (m: number) => new Date(new Date().getTime() - m * 60_000).toISOString();
const T1 = minutesAgo(60);
const T2 = minutesAgo(55);
const TITLE_A = "사이트 배포 인증을 어떻게 할까요?";
const TITLE_B = "백업은 언제 돌릴까요?";
const TITLE_C = "폴더 이름을 무엇으로 할까요?";

const block = (q: string) => `결정: ${q}\n**1) 첫째**\n**2) 둘째**`;
/** The bot asks `qs` in one message to `target`; the message's ts is the decisions' reply_to. */
const ask = (ts: string, qs: string[], target = "web") => emit("outbox", { ts, kind: "out", source: "orchestrator", target, text: `[ask] ${qs[0]}\n${qs.map(block).join("\n")}` });
const owner = (text: string, extra: Record<string, unknown> = {}) => emit("inbox", { ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", text, ...extra });
const quoting = (ts: string) => ({ reply: { id: ts, author: "", content: "질문" } });
const event = (text: string, channel = "web", extra: Record<string, unknown> = {}) => ({ kind: "message", source: "web", channel, mid: "m-own", author: "owner", text, ...extra });

// What the real intake path would hand the bot: the update hold keeps the prompt text instead of starting a turn.
const held: string[] = [];
beforeEach(() => {
	resetNoticesForTest();
	held.length = 0;
	setUpdateNow({ hold: (text: string) => (held.push(text), true), holding: () => false } as unknown as UpdateNow);
});
afterEach(() => setUpdateNow(undefined));

test("quoting a one-question message settles that question with the owner's words, even matching no option", () => {
	ask(T1, [TITLE_A]);
	ask(T2, [TITLE_B]);
	owner("사이트 배포는 기존에 하던 방식으로 해", quoting(T1));
	expect(byTitle(TITLE_A)).toMatchObject({ state: "answered", answer: "사이트 배포는 기존에 하던 방식으로 해" });
	expect(byTitle(TITLE_B).state).toBe("open");
});

test("quoting a message that asked several questions settles none of them", () => {
	ask(T1, [TITLE_A, TITLE_B]);
	owner("그냥 알아서 해", quoting(T1));
	expect([byTitle(TITLE_A).state, byTitle(TITLE_B).state]).toEqual(["open", "open"]);
});

test("a quote of another message, or of a send-approval card's message, settles nothing", () => {
	ask(T1, [TITLE_A]);
	owner("알아서 해", quoting(T2));
	expect(byTitle(TITLE_A).state).toBe("open");
	putDecision({ key: "draft:own", title: "답장 보내도 될까요?", detail: "", to: "main", options: [{ n: 1, label: "보내기" }], group: 1, replyTo: T2, draft: { toLabel: "x", to: "a@example.com", body: "안녕" } as never }, T2);
	owner("알아서 해", quoting(T2));
	expect(byTitle("답장 보내도 될까요?").state).toBe("open");
});

test("through intake: an own-words message to an open question carries its title, a quoted one settles it and carries nothing", async () => {
	ask(T1, [TITLE_A]);
	ask(T2, [TITLE_B]);
	await sendWeb({ channel: "web", text: "기존 방식으로 해", mode: "default", login: "local" });
	flush("web");
	expect(held).toHaveLength(1);
	expect(held[0]).toContain(TITLE_A);
	expect(held[0]).toContain(TITLE_B);
	expect(byTitle(TITLE_A).state).toBe("open");

	held.length = 0;
	await sendWeb({ channel: "web", text: "기존 방식으로 해", mode: "default", login: "local", reply: { id: T1, author: "", content: "질문" } });
	flush("web");
	expect(byTitle(TITLE_A).state).toBe("answered");
	expect(held[0]).not.toContain(TITLE_A);
	expect(held[0]).toContain(TITLE_B);
});

test("a message steered into a running turn carries the open titles too", async () => {
	ask(T1, [TITLE_A]);
	const was = orch.status;
	orch.status = "working";
	try {
		await sendWeb({ channel: "web", text: "기존 방식으로 해", mode: "steer", sendNow: true, login: "local" });
	} finally {
		orch.status = was;
	}
	expect(held).toHaveLength(1);
	expect(held[0]).toContain(TITLE_A);
});

test("a message asking several questions at once lists them all in the prompt of a quoting reply", async () => {
	ask(T1, [TITLE_A, TITLE_B]);
	await sendWeb({ channel: "web", text: "알아서 해", mode: "default", login: "local", reply: { id: T1, author: "", content: "질문" } });
	flush("web");
	expect(held[0]).toContain(TITLE_A);
	expect(held[0]).toContain(TITLE_B);
});

test("at most three titles, each cut to 60 characters", () => {
	const long = `${"가".repeat(80)}?`;
	ask(T1, [long, "둘째 질문?", "셋째 질문?"]);
	ask(T2, ["넷째 질문?"]);
	const text = inboxText(event("알아서 해"));
	expect(text).toContain("가".repeat(60));
	expect(text).not.toContain("가".repeat(61));
	expect(["둘째 질문?", "셋째 질문?", "넷째 질문?"].filter(t => text.includes(t))).toHaveLength(2);
});

test("no extra line when the owner picked an option, when nothing is open, or when only a send-approval card is open", () => {
	const msg = event("2");
	const plain = inboxText(msg);
	ask(T1, [TITLE_A]);
	owner("2");
	expect(byTitle(TITLE_A).state).toBe("answered");
	expect(inboxText(msg)).toBe(plain);

	resetNoticesForTest();
	putDecision({ key: "draft:own2", title: "답장 보내도 될까요?", detail: "", to: "main", options: [{ n: 1, label: "보내기" }], group: 1, replyTo: T2, draft: { toLabel: "x", to: "a@example.com", body: "안녕" } as never }, T2);
	expect(inboxText(msg)).toBe(plain);
});

test("conversations never mix: a project's question reaches only that project's messages", () => {
	const plain = inboxText(event("기존 방식으로 해"));
	const plainProject = inboxText(event("기존 방식으로 해", "ch:1500000000000000001"));
	ask(T1, [TITLE_A], "ch:1500000000000000001");
	ask(T2, [TITLE_B]);
	const main = inboxText(event("기존 방식으로 해"));
	const project = inboxText(event("기존 방식으로 해", "ch:1500000000000000001"));
	expect(main).toContain(TITLE_B);
	expect(main).not.toContain(TITLE_A);
	expect(project).toContain(TITLE_A);
	expect(project).not.toContain(TITLE_B);
	resetNoticesForTest();
	ask(T1, [TITLE_C], "ch:1500000000000000001");
	expect(inboxText(event("기존 방식으로 해"))).toBe(plain);
	expect(inboxText(event("기존 방식으로 해", "ch:1500000000000000001"))).toContain(TITLE_C);
	expect(plainProject).not.toContain(TITLE_C);
});

// "직접 답하기" on a question asked in the 알림 conversation (no composer there): the sheet's text field answers with no option picked.
const askIn = (to: string, title: string, group = 1, replyTo = T1) => putDecision({ key: `own:${title}`, title, detail: "", to, options: [{ n: 1, label: "첫째" }, { n: 2, label: "둘째" }], group, replyTo }, T1);
const idOf = (title: string) => stored().find(n => n.title === title)!.id;

test("the owner's words alone answer a question: they are sent to where it was asked with the asking message, and settle only that question", async () => {
	ask(T1, [TITLE_A], "alert");
	const sent: Parameters<DecisionSend>[0][] = [];
	const r = await answerDecision(idOf(TITLE_A), { note: "  기존 방식으로 해  " }, async a => void sent.push(a));
	expect(r.status).toBe(200);
	expect(sent).toEqual([{ to: "alert", text: "기존 방식으로 해", replyTo: T1, notice: idOf(TITLE_A) }]);
	expect(byTitle(TITLE_A)).toMatchObject({ state: "answered", answer: "기존 방식으로 해" });
	// the line the asking chat gets names the question the words answer
	const line = inboxText(event(sent[0]!.text, "web:alert", { reply_to: sent[0]!.replyTo, decision: sent[0]!.notice }));
	expect(line).toContain(TITLE_A);
});

test("words alone need text, are refused for a send approval and a login request, and a failed send leaves the question open", async () => {
	askIn("alert", TITLE_B);
	expect(await answerDecision(idOf(TITLE_B), { note: "   " }, async () => {})).toMatchObject({ status: 400 });
	putDecision({ key: "draft:words", title: "답장 보내도 될까요?", detail: "", to: "main", options: [{ n: 1, label: "보내기" }], group: 1, replyTo: T2, draft: { toLabel: "x", to: "a@example.com", body: "안녕" } as never }, T2);
	expect(await answerDecision(idOf("답장 보내도 될까요?"), { note: "알아서" }, async () => {})).toMatchObject({ status: 400 });
	const failed = await answerDecision(idOf(TITLE_B), { note: "나중에" }, async () => { throw new Error("전달하지 못했어요"); });
	expect(failed).toMatchObject({ status: 409 });
	expect(byTitle(TITLE_B).state).toBe("open");
});

test("a question of a several-question message carries its title with the words, so the bot knows which one they answer", async () => {
	ask(T1, [TITLE_A, TITLE_C], "alert");
	const sent: Parameters<DecisionSend>[0][] = [];
	await answerDecision(idOf(TITLE_C), { note: "새 이름" }, async a => void sent.push(a));
	expect(sent[0]!.text).toBe(`${TITLE_C}: 새 이름`);
	expect(byTitle(TITLE_A).state).toBe("open");
});
