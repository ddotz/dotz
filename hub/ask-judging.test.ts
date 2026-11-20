import { afterAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { now } from "./config.ts";
import { emit, onEmit } from "./events.ts";
import { flush, sendWeb } from "./intake.ts";
import { JUDGING_MS, allNotices, flushNotices, laterNotice, markJudging, openChoices, resetNoticesForTest, resolveNotices, type Notice } from "./notices.ts";
import { queue } from "./outbound.ts";

process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => {
	delete process.env.DOTZ_NO_ORCHESTRATOR;
	resetNoticesForTest();
});

const TITLE = "카톡 확인을 어디서 할까요?";
const SAID = "맥미니에서만 하자";
const clockNow = () => Date.parse(now());
const askMain = () => emit("outbox", { ts: new Date(clockNow() - 30 * 60_000).toISOString(), kind: "out", source: "orchestrator", target: "web", text: `[ask] ${TITLE}\n결정: ${TITLE}\n**1) 맥미니에서**\n**2) 노트북에서**\n**3) 둘 다**` });
const card = (title = TITLE): Notice => allNotices().find(n => n.kind === "decision" && n.title === title)!;
const followUps = () => queue.queued().filter(p => p.text.startsWith("[dotz gateway]") && p.text.includes(TITLE));
let saidAt = "";
onEmit(e => {
	if (e.kind === "message" && e.text === SAID) saidAt = e.ts;
});

async function ownerSays(): Promise<string> {
	await sendWeb({ channel: "web", text: SAID, mode: "default", login: "local" });
	flush("web");
	const p = queue.queued().at(-1)!;
	expect(p.text).toContain(TITLE);
	return p.text;
}
const endTurn = (prompt: string, answer: string) => {
	queue.onPrompt(prompt);
	queue.onAnswer(answer);
	queue.settleTurn();
};

beforeEach(() => {
	resetNoticesForTest();
	askMain();
});

test("an owner message that goes to the model with an open card marks it judging; a turn and follow-up that close nothing leave it kept_open with that message's ts", async () => {
	const prompt = await ownerSays();
	expect(card().decision!.judging).toEqual({ at: saidAt, text: SAID });
	endTurn(prompt, "반영했어요.");
	expect(followUps()).toHaveLength(1);
	expect(card().decision!.judging).toEqual({ at: saidAt, text: SAID });
	endTurn(followUps()[0]!.text, "-");
	expect(card().decision).toMatchObject({ state: "open", kept_open: { at: saidAt } });
	expect(card().decision!.judging).toBeUndefined();
});

test("a turn that closes the card with <resolves> closes it as words with the owner's message, and judging is gone", async () => {
	const prompt = await ownerSays();
	endTurn(prompt, "맥미니에서 할게요.\n<resolves>카톡 확인을 어디서</resolves>");
	expect(card().decision).toMatchObject({ state: "answered", resolved: true, closed_how: "words", words: SAID });
	expect(card().decision!.judging).toBeUndefined();
	expect(card().decision!.kept_open).toBeUndefined();
	expect(followUps()).toHaveLength(0);
});

test("judging survives a restart, and a turn that never settles leaves it kept_open once the judging window has passed", async () => {
	const prompt = await ownerSays();
	const id = card().id;
	flushNotices();
	const run = Bun.spawnSync([process.execPath, "-e", `const m = await import("./hub/notices.ts"); const c = () => m.allNotices().find(n => n.id === ${JSON.stringify(id)}).decision; const stored = c().judging; m.sweepQuestions(${JSON.stringify(new Date(Date.parse(saidAt) + JUDGING_MS - 60_000).toISOString())}); const early = c().judging ?? null; m.sweepQuestions(${JSON.stringify(new Date(Date.parse(saidAt) + JUDGING_MS + 1000).toISOString())}); console.log(JSON.stringify({ stored, early, late: c().judging ?? null, kept: c().kept_open ?? null, state: c().state })); process.exit(0);`], { cwd: join(import.meta.dir, ".."), env: process.env });
	expect(run.exitCode).toBe(0);
	expect(JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!)).toEqual({ stored: { at: saidAt, text: SAID }, early: { at: saidAt, text: SAID }, late: null, kept: { at: saidAt }, state: "open" });
	endTurn(prompt, "-");
	endTurn(followUps()[0]!.text, "-");
});

test("a session's turn-end report ends the judging of its cards: what it did not close stays open as kept_open", () => {
	const lane = "judge-lane";
	emit("inbox", { ts: new Date(clockNow() - 60_000).toISOString(), kind: "lane_report", source: `lane:${lane}`, lane, text: `[ask] 어느 쪽으로 할까요?\n결정: 어느 쪽으로 할까요?\n**1) 왼쪽**\n**2) 오른쪽**` });
	const said = { ts: new Date(clockNow() - 30_000).toISOString(), text: "그건 그렇고 빌드는 어때?" };
	markJudging(openChoices(`lane:${lane}`), said);
	expect(card("어느 쪽으로 할까요?").decision!.judging).toEqual({ at: said.ts, text: said.text });
	emit("inbox", { ts: now(), kind: "lane_report", source: `lane:${lane}`, lane, text: "빌드는 통과했어요." });
	expect(card("어느 쪽으로 할까요?").decision).toMatchObject({ state: "open", kept_open: { at: said.ts } });
	expect(card("어느 쪽으로 할까요?").decision!.judging).toBeUndefined();
});

test("a card put off until later is not listed to the model as an open question", () => {
	expect(openChoices("main").map(q => q.id)).toEqual([card().id]);
	laterNotice(card().id, { for: "hour" });
	expect(openChoices("main")).toEqual([]);
});

test("a turn of another conversation that ends before the follow-up leaves the card judging, and the follow-up that closes it records the owner's words", async () => {
	queue.onPrompt(await ownerSays());
	const other = "owner message 1000000000000077777";
	queue.deliver(other, { target: "ch:1000000000000077777", replyTo: "1000000000000077777", owner: true });
	queue.onAnswer("반영했어요.");
	queue.settleTurn();
	endTurn(queue.queued().find(p => p.text.includes(other))!.text, "다른 답이에요.");
	expect(card().decision!.judging).toEqual({ at: saidAt, text: SAID });
	expect(card().decision!.kept_open).toBeUndefined();
	queue.onPrompt(followUps()[0]!.text);
	resolveNotices({ match: "카톡 확인을 어디서" });
	queue.onAnswer("-");
	queue.settleTurn();
	expect(card().decision).toMatchObject({ state: "answered", closed_how: "words", words: SAID });
});
