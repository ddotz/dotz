import { beforeEach, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { LOAD_QA_ASK, PEER_STATUS } from "./ask-normalize.fixture.ts";

// An [ask] sent through dotz_send to "chat" waits in the owner's main conversation until the owner answers it (2026-11-05: a line from the other
// computer's gateway answered both of its decisions, so the card was gone 3 minutes later).
const ts = () => new Date().toISOString();
const send = (text: string, target = "chat") => emit("outbox", { ts: ts(), kind: "out", source: "orchestrator", target, text });
const asks = () => listNotices().items.filter(n => n.decision);
const states = () => asks().map(n => n.decision!.state);

beforeEach(resetNoticesForTest);

test("a dotz_send [ask] with two 결정 blocks makes one open decision per block in the main conversation", () => {
	send(LOAD_QA_ASK);
	expect(asks().map(n => [n.title, n.decision!.to, n.decision!.group, n.decision!.options.length]).sort()).toEqual([
		["메일 계정이 여러 개일 때 말투는 어떻게 배울까요?", "main", 2, 2],
		["메일이 폭주할 때 초안 비용은 어떻게 할까요?", "main", 2, 2],
	]);
});

test("later bot messages and a peer gateway's message leave the [ask] open; the owner's own message answers it", () => {
	send(LOAD_QA_ASK);
	send("맥북도 재시작했어요.", "web");
	emit("inbox", { ts: ts(), source: "web", ...PEER_STATUS });
	send("[done] 진행 메시지를 고쳤어요.", "web");
	expect(states()).toEqual(["open", "open"]);
	emit("inbox", { ts: ts(), kind: "message", source: "web", channel: "web", author: "owner@github", text: "1번으로 해" });
	expect(states()).toEqual(["answered", "answered"]);
});

test("the fixture's account is a neutral sample, not a login of a real install", () => {
	expect(PEER_STATUS.author).toBe("owner@github");
});
