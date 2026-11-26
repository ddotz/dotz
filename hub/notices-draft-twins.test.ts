// One draft can be carded in two conversations (a session's chat and the main one). The owner's answer on one card is his word on that draft:
// every other open card of the same draft ref closes with it, so no copy stays in 답변 필요 after the matter is done.
import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { answerDecision, type Notice, resetNoticesForTest } from "./notices.ts";
import { flushNotices } from "./notices-store.ts";

const stored = (): Notice[] => (flushNotices(), JSON.parse(readFileSync(paths.notices, "utf8")));
const card = (ref: string) => `[ask] 올릴 준비가 됐어요\n${draftApprovalBlock({ to: "kim@example.com", body: "본문", ref, question: "이대로 올릴까?" })}`;
const post = (target: string, ref: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target, text: card(ref) });
const cardsOf = (ref: string) => stored().filter(n => n.decision?.draft?.ref === ref);
beforeEach(() => resetNoticesForTest());

test("a button answer on one card of a draft closes its open twin in another conversation", async () => {
	post("mail:acct-1", "RAAAAAA");
	post("main", "RAAAAAA");
	post("main", "RBBBBBB");
	const [first, second] = cardsOf("RAAAAAA");
	expect([first!.decision!.state, second!.decision!.state]).toEqual(["open", "open"]);
	const r = await answerDecision(second!.id, { n: 1 }, async () => undefined);
	expect(r.status).toBe(200);
	const after = new Map(stored().map(n => [n.id, n.decision!]));
	expect(after.get(second!.id)!.state).toBe("answered");
	expect([after.get(first!.id)!.state, after.get(first!.id)!.resolved]).toEqual(["answered", true]);
	expect(cardsOf("RBBBBBB")[0]!.decision!.state).toBe("open");
});

test("a button pick arriving as a chat message (decision id) closes the twin too", () => {
	post("mail:acct-1", "RAAAAAA");
	post("main", "RAAAAAA");
	const [first, second] = cardsOf("RAAAAAA");
	emit("inbox", { ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", text: "1) 보내기", decision: second!.id });
	const after = new Map(cardsOf("RAAAAAA").map(n => [n.id, n.decision!.state]));
	expect([after.get(second!.id), after.get(first!.id)]).toEqual(["answered", "answered"]);
});
