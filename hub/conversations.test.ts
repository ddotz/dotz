import { appendFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { paths } from "./config.ts";
import { emit } from "./events.ts";
import { markRead } from "./reads.ts";

// The list is built once per module instance, from the log as it is then. Another test file that asks /api/conversations first
// would freeze it before this file writes its log lines, so this file loads its own instances: one here for the live tests and
// one inside the first-list test, after that test wrote its log lines (so no other test of this file can freeze it first).
const { conversationList, previewOf } = await import("./conversations.ts?live");

const lastOf = (target: string) => conversationList().find(c => c.target === target)?.last;

test("the first list is built from the log tail, newest real message per target wins, noise is ignored", async () => {
	const line = (e: object) => `${JSON.stringify(e)}\n`;
	appendFileSync(
		paths.outbox,
		line({ ts: "2026-10-20T01:00:00.000Z", kind: "out", source: "orchestrator", target: "ch:12", text: "[done] **첫** 답" }) +
			line({ ts: "2026-10-20T02:00:00.000Z", kind: "delivery", source: "gateway", target: "ch:12", ref: "a", state: "answered" }) +
			line({ ts: "2026-10-20T03:00:00.000Z", kind: "out", source: "orchestrator", target: "ch:12", update_key: "p", text: "진행 중: 읽는 중" }) +
			line({ ts: "2026-10-20T03:30:00.000Z", kind: "lane_start", lane: "old", text: "start" }),
	);
	appendFileSync(paths.inbox, line({ ts: "2026-10-20T00:30:00.000Z", kind: "message", source: "web", channel: "ch:12", text: "먼저 보낸 말" }));
	const first = (await import("./conversations.ts?first-list")).conversationList();
	expect(first.find(c => c.target === "ch:12")?.last).toEqual({ ts: "2026-10-20T01:00:00.000Z", text: "첫 답", from: "bot" });
	expect(first.some(c => c.target === "lane:old")).toBe(false);
});

test("the gateway's own wake is no message: not unread after a load, no preview; an owner schedule still counts", async () => {
	const line = (e: object) => `${JSON.stringify(e)}\n`;
	appendFileSync(paths.outbox, line({ ts: "2026-10-21T01:00:00.000Z", kind: "out", source: "orchestrator", target: "web", text: "마지막 답" }));
	appendFileSync(paths.inbox, line({ ts: "2026-10-21T01:30:00.000Z", kind: "schedule", source: "gateway", channel: "web", quiet: true, id: "c1", ids: ["c1"], text: "조용한 확인" }));
	markRead({ target: "main", ts: "2026-10-21T01:00:00.000Z" });
	// a count stuck from before (the wake after the read position) is gone on the next load, with nothing for the owner to do
	const fresh = await import("./conversations.ts?quiet-wake");
	expect(fresh.unreadOf("main")).toBe(0);
	expect(fresh.conversationList().find(c => c.target === "main")?.last?.ts).toBe("2026-10-21T01:00:00.000Z");
	emit("inbox", { ts: "2026-10-21T01:40:00.000Z", kind: "schedule", source: "gateway", channel: "web", quiet: true, text: "또 확인" });
	expect(fresh.unreadOf("main")).toBe(0);
	expect(fresh.conversationList().find(c => c.target === "main")?.last?.ts).toBe("2026-10-21T01:00:00.000Z");
	emit("inbox", { ts: "2026-10-21T01:50:00.000Z", kind: "schedule", source: "web", channel: "web", id: "s1", text: "예약한 일" });
	expect(fresh.unreadOf("main")).toBe(1);
	expect(fresh.conversationList().find(c => c.target === "main")?.last?.ts).toBe("2026-10-21T01:50:00.000Z");
});

test("a live message replaces the preview; progress, delivery and notice events do not", () => {
	const t = "lane:convo-a";
	emit("inbox", { ts: "2026-10-20T05:00:00.000Z", kind: "lane_message", source: "web", lane: "convo-a", text: "상태 알려줘" });
	expect(lastOf(t)).toEqual({ ts: "2026-10-20T05:00:00.000Z", text: "상태 알려줘", from: "owner" });
	emit("outbox", { ts: "2026-10-20T05:01:00.000Z", kind: "out", source: "lane:convo-a", target: t, text: "- 두 번째 줄\n다음 줄" });
	expect(lastOf(t)).toEqual({ ts: "2026-10-20T05:01:00.000Z", text: "두 번째 줄", from: "session" });
	emit("outbox", { ts: "2026-10-20T05:02:00.000Z", kind: "out", source: "gateway", target: t, update_key: "k", text: "진행 중: 빌드" });
	emit("outbox", { ts: "2026-10-20T05:03:00.000Z", kind: "delivery", source: "gateway", target: t, ref: "x", state: "answered", text: "" });
	emit("outbox", { ts: "2026-10-20T05:04:00.000Z", kind: "notice", source: "gateway", target: t, text: "알림" });
	emit("outbox", { ts: "2026-10-20T05:05:00.000Z", kind: "notice_read", source: "gateway", lane: "convo-a", text: "" });
	expect(lastOf(t)?.ts).toBe("2026-10-20T05:01:00.000Z");
});

test("a result for the main chat is a message, an older late event never replaces a newer one", () => {
	emit("outbox", { ts: "2099-01-01T06:00:00.000Z", kind: "result", source: "gateway", target: "web", text: "작업 결과예요" });
	expect(lastOf("main")).toEqual({ ts: "2099-01-01T06:00:00.000Z", text: "작업 결과예요", from: "bot" });
	emit("outbox", { ts: "2099-01-01T05:59:00.000Z", kind: "out", source: "orchestrator", target: "web", text: "늦게 온 옛 답" });
	expect(lastOf("main")?.text).toBe("작업 결과예요");
});

test("lists are sorted by latest message, live targets without messages come last", () => {
	// Later than any stamp another file leaves in the shared log (notices.test.ts writes 9999-12-31T00:00:00).
	emit("outbox", { ts: "9999-12-31T23:59:59.000Z", kind: "out", source: "orchestrator", target: "ch:11", text: "제일 최근" });
	const items = conversationList(["lane:silent", "ch:99"]);
	expect(items[0].target).toBe("ch:11");
	const tail = items.slice(-2).map(c => c.target);
	expect(tail.sort()).toEqual(["ch:99", "lane:silent"]);
	expect(items.slice(-2).every(c => c.last === null)).toBe(true);
	const stamps = items.filter(c => c.last).map(c => c.last!.ts);
	expect(stamps).toEqual([...stamps].sort().reverse());
});

test("preview: first meaningful line, handoff block, marker, fences and markdown stripped, 120 chars", () => {
	expect(previewOf("Ask: 해줘 - wanted: 끝. For you: 요약. Now: a. Next: b.\n\n실제 본문입니다")).toBe("실제 본문입니다");
	expect(previewOf("```\ncode\n```\n## [링크](http://x) `코드` 설명")).toBe("링크 코드 설명");
	expect(previewOf("   \n\n")).toBe("");
	const long = previewOf("가".repeat(300));
	expect(long.length).toBe(120);
	expect(long.endsWith("…")).toBe(true);
});
