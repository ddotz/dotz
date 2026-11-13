// The bot judges what the owner writes right after an open choice question and closes it at once (hub/intake.ts openQuestionLines, hub/outbound.ts
// settleResolves): dotz_send's `resolves` on a progress note, or a closing `<resolves>` line on the final answer that the gateway strips before anyone reads it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { HUB_TOKEN, paths } from "./config.ts";
import { emit } from "./events.ts";
import { inboxText } from "./intake.ts";
import { out } from "./outbound.ts";
import { resetNoticesForTest, type Notice } from "./notices.ts";
import { makeRoute } from "./routes.ts";
import { previewSource, stripHandoff } from "./tone.ts";

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const PROJECT = "ch:1500000000000000001";
const stored = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));
const state = (title: string) => stored().find(n => n.kind === "decision" && n.title === title)!.decision!.state;
const TITLE_MAIN = "사이트 배포 인증을 어떻게 할까요?";
const TITLE_PROJECT = "폴더 이름을 무엇으로 할까요?";
// An hour ago, not a fixed day: a question older than its answer window (ANSWER_WINDOW_MS, 72 h) is expired and nothing answers it. On the clock
// config.ts now() reads (new Date(), the real one), not the fake Date.now of test-clock.ts: an answer only closes a question asked before it.
const minutesAgo = (m: number) => new Date(new Date().getTime() - m * 60_000).toISOString();
const T1 = minutesAgo(60);
const T2 = minutesAgo(55);
const block = (q: string) => `결정: ${q}\n**1) 첫째**\n**2) 둘째**`;
const ask = (ts: string, q: string, target: string) => emit("outbox", { ts, kind: "out", source: "orchestrator", target, text: `[ask] ${q}\n${block(q)}` });
const sizeOf = (f: string) => (existsSync(f) ? statSync(f).size : 0);
const gained = (f: string, from: number) => readFileSync(f).subarray(from).toString("utf8");
/** The final answer of session `session`, posted the way the prompt queue posts it. */
const answer = (target: string, text: string, session: string) => out(target, text, undefined, { auto: true, session });
const LINE = (words: string) => `<resolves>${words}</resolves>`;

beforeEach(() => {
	resetNoticesForTest();
	ask(T1, TITLE_MAIN, "web");
	ask(T2, TITLE_PROJECT, PROJECT);
});
afterEach(() => resetNoticesForTest());

test("a closing line on the final answer closes the question it names and is gone from what is posted and stored", async () => {
	const before = sizeOf(paths.outbox);
	await answer("web", `배포 방식은 기존대로 할게요.\n\n${LINE("사이트 배포 인증")}`, "main");
	expect(state(TITLE_MAIN)).not.toBe("open");
	expect(state(TITLE_PROJECT)).toBe("open");
	const written = gained(paths.outbox, before);
	expect(written).toContain("배포 방식은 기존대로 할게요.");
	expect(written).not.toContain("resolves");
});

test("a line alone on an answer posts nothing and still closes the question", async () => {
	const before = sizeOf(paths.outbox);
	await answer("web", LINE("사이트 배포 인증"), "main");
	expect(state(TITLE_MAIN)).not.toBe("open");
	expect(gained(paths.outbox, before)).not.toContain("resolves");
});

test("conversations never mix: a project's line closes only the project's question, and main's line only main's", async () => {
	await answer(PROJECT, `이름은 정했어요.\n${LINE("사이트 배포 인증")}`, PROJECT);
	expect([state(TITLE_MAIN), state(TITLE_PROJECT)]).toEqual(["open", "open"]);
	await answer("web", `이름은 정했어요.\n${LINE("폴더 이름")}`, "main");
	expect([state(TITLE_MAIN), state(TITLE_PROJECT)]).toEqual(["open", "open"]);
	await answer(PROJECT, `이름은 정했어요.\n${LINE("폴더 이름")}`, PROJECT);
	expect([state(TITLE_MAIN), state(TITLE_PROJECT)]).toEqual(["open", expect.not.stringMatching(/^open$/)]);
	await answer("web", `배포는 기존대로요.\n${LINE("사이트 배포 인증")}`, "main");
	expect(state(TITLE_MAIN)).not.toBe("open");
});

test("a line that matches no question is stripped, closes nothing and leaves one log line", async () => {
	const [log0, out0] = [sizeOf(paths.log), sizeOf(paths.outbox)];
	await answer("web", `다른 일을 했어요.\n${LINE("전혀 다른 말")}`, "main");
	expect([state(TITLE_MAIN), state(TITLE_PROJECT)]).toEqual(["open", "open"]);
	expect(gained(paths.outbox, out0)).not.toContain("resolves");
	expect(gained(paths.outbox, out0)).toContain("다른 일을 했어요.");
	expect(gained(paths.log, log0).split("\n").filter(l => l.includes("matched no open question"))).toHaveLength(1);
});

test("an answer without the line reads exactly as before and closes nothing", async () => {
	const text = "다른 일을 했어요.\n\n- 하나\n- 둘";
	expect(stripHandoff(text)).toBe(text);
	const [log0, out0] = [sizeOf(paths.log), sizeOf(paths.outbox)];
	await answer("web", text, "main");
	expect([state(TITLE_MAIN), state(TITLE_PROJECT)]).toEqual(["open", "open"]);
	expect(gained(paths.outbox, out0)).toContain(JSON.stringify(text).slice(1, -1));
	expect(gained(paths.log, log0)).not.toContain("matched no open question");
});

test("every reader of an answer drops the line: previews and handoff stripping alike", () => {
	const text = `고쳤어요.\n${LINE("사이트 배포 인증")}`;
	expect(stripHandoff(text)).toBe("고쳤어요.");
	expect(previewSource(text)).toBe("고쳤어요.");
});

test("a dotz_send resolves on a progress note (update_key progress) closes the question, in its own session's scope only", async () => {
	const send = (body: object) => route(new Request("http://127.0.0.1/api/send", { method: "POST", headers: { "x-dotz-token": HUB_TOKEN }, body: JSON.stringify({ text: "배포 방식을 확인하는 중이에요.", update_key: "progress", ...body }) }));
	await send({ target: PROJECT, session: PROJECT, resolves: "사이트 배포 인증" });
	expect([state(TITLE_MAIN), state(TITLE_PROJECT)]).toEqual(["open", "open"]);
	await send({ target: "web", session: "main", resolves: "사이트 배포 인증" });
	expect(state(TITLE_MAIN)).not.toBe("open");
	expect(state(TITLE_PROJECT)).toBe("open");
});

test("the open-question line is the one place that names the closing line, and only while a choice question is open there", () => {
	const msg = (channel: string) => ({ kind: "message", source: "web", channel, mid: "m-judge", author: "owner", text: "기존 방식으로 해" });
	expect(inboxText(msg("web"))).toContain("<resolves>");
	expect(inboxText(msg(PROJECT))).toContain("<resolves>");
	resetNoticesForTest();
	expect(inboxText(msg("web"))).not.toContain("<resolves>");
});
