// A decision answer reaches the orchestrator with its context: each block's question with the chosen option, and the start of
// the asking message, built hub-side from reply_to (the asking message's ts), so it holds when sent from another conversation.
import { expect, test } from "bun:test";
import { emit } from "./events.ts";
import { inboxText } from "./intake.ts";

const asking = (ts: string, text: string) => emit("outbox", { ts, kind: "out", source: "orchestrator", target: "web", text, reply_to: null });

test("a multi-block decision answer carries each question, the chosen labels and the quoted asking message", () => {
	const ts = "2026-10-22T00:10:00.000Z";
	asking(ts, `[ask] 두 가지를 정해 주세요\n결정: 순서Q\n1) 앞부터\n2) 뒤부터\n결정: 범위Q\n1) 전부\n2) 일부\n${"x".repeat(400)}`);
	const picks = [{ q: "순서Q", n: 1, label: "앞부터" }, { q: "범위Q", n: 2, label: "일부" }];
	const text = inboxText({ kind: "message", source: "web", channel: "web:alert", author: "me", mid: "m1", text: "결정 답: 1) 앞부터 · 2) 일부", reply_to: ts, picks });
	for (const part of ["순서Q", "1) 앞부터", "범위Q", "2) 일부", "두 가지를 정해 주세요"]) expect(text).toContain(part);
	expect(text).not.toContain("x".repeat(250));
	expect(text).not.toContain("[ask] 두 가지");
});

test("a decision answer whose asking message is unknown still carries the question and the chosen label", () => {
	const text = inboxText({ kind: "message", source: "web", channel: "web", author: "me", mid: "m2", text: "1) 가", reply_to: "2020-01-01T00:00:00.000Z", picks: [{ q: "무엇을?", n: 1, label: "가" }] });
	expect(text).toContain("무엇을?");
	expect(text).toContain("1) 가");
});

test("an ordinary message gets no decision lines", () => {
	const plain = inboxText({ kind: "message", source: "web", channel: "web", author: "me", mid: "m3", text: "안녕" });
	const ts = "2026-10-22T00:11:00.000Z";
	asking(ts, "그냥 답이에요");
	const replied = inboxText({ kind: "message", source: "web", channel: "web", author: "me", mid: "m4", text: "안녕", reply_to: ts });
	expect(replied).toBe(plain.replace("msg=m3", "msg=m4"));
});
