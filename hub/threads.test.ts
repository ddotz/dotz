// Thread routing decisions (threads.ts) and the Discord-mobile layout of an answer (discord.ts readable).
import { expect, test } from "bun:test";
import { readable } from "./discord.ts";
import { buildPayloads } from "./discord.ts";
import { answerMovesToLane, lanePlace, replyRef, threadForReply, THREAD_NAME_MAX, threadTitle } from "./threads.ts";

const work = (id: string) => id === "500";
const parents: Record<string, string> = { "700": "500" };
const place = (a: { home?: string; asking?: string; askingMessage?: string }) => lanePlace({ ...a, isWork: work, threadParent: id => parents[id] });

test("the launching turn's answer moves into the lane thread only for an ask from that Discord channel or thread", () => {
	expect(answerMovesToLane(place({ asking: "ch:500", askingMessage: "m1" }), "ch:500")).toBe(true);
	expect(answerMovesToLane(place({ asking: "th:700" }), "th:700")).toBe(true);
	for (const asking of ["web", "terminal", "chat", "dm"]) expect(answerMovesToLane(place({ home: "ch:500", asking }), asking)).toBe(false);
	expect(answerMovesToLane(place({ asking: "chat" }), "chat")).toBe(false);
});

test("lane place: from a work channel a thread on the owner's message, from a thread that thread, from chat a channel", () => {
	expect(place({ asking: "ch:500", askingMessage: "m1" })).toEqual({ kind: "thread", parent: "500", fromMessage: "m1" });
	expect(place({ asking: "th:700", askingMessage: "m2" })).toEqual({ kind: "adopt", thread: "700", parent: "500" });
	expect(place({ asking: "chat", askingMessage: "m3" })).toEqual({ kind: "channel" });
	expect(place({ asking: "th:999" })).toEqual({ kind: "channel" }); // unknown thread: nothing to adopt
});

test("lane place: an explicit home wins; it hangs from the owner's message only when asked in that channel", () => {
	expect(place({ home: "ch:500", asking: "chat", askingMessage: "m1" })).toEqual({ kind: "thread", parent: "500" });
	expect(place({ home: "ch:500", asking: "ch:500", askingMessage: "m1" })).toEqual({ kind: "thread", parent: "500", fromMessage: "m1" });
});

test("reply reference: always at top level, in a thread only when the owner wrote something newer", () => {
	expect(replyRef("chat", "111111111111111111", "111111111111111111")).toBe("111111111111111111");
	expect(replyRef("ch:500", "111111111111111111", undefined)).toBe("111111111111111111");
	expect(replyRef("th:700", "111111111111111111", "111111111111111111")).toBeUndefined();
	expect(replyRef("lane:x", "111111111111111111", "222222222222222222")).toBe("111111111111111111");
	expect(replyRef("chat", undefined, "111111111111111111")).toBeUndefined();
});

test("a web message id (hex) as reply_to is never a Discord message_reference", () => {
	expect(replyRef("ch:1561565203714408448", "5eeba27e", undefined)).toBeUndefined();
	expect(replyRef("chat", "5eeba27e", undefined)).toBeUndefined();
	expect(replyRef("ch:500", "1561565203714408448", undefined)).toBe("1561565203714408448");
	expect(JSON.stringify(buildPayloads("hi", "5eeba27e"))).not.toContain("message_reference");
	expect(JSON.stringify(buildPayloads("hi", "1561565203714408448"))).toContain("message_reference");
});

test("a reply to a thread's starter message goes into that thread, other replies stay", () => {
	expect(threadForReply("700", "500", parents)).toBe("700");
	expect(threadForReply("700", "501", parents)).toBeUndefined();
	expect(threadForReply("123", "500", parents)).toBeUndefined();
	expect(threadForReply(undefined, "500", parents)).toBeUndefined();
});

test("thread titles are plain words: no [kind], emoji or pipes; a code name gives way to the goal; cut at a word", () => {
	expect(threadTitle("[점검] 스레드 표시 시험")).toBe("스레드 표시 시험");
	expect(threadTitle("[done] [점검] 스레드 표시 시험")).toBe("스레드 표시 시험");
	expect(threadTitle("🔧 빌드 | 정리")).toBe("빌드 정리");
	expect(threadTitle("dinobot-rea", "공룡봇 재구성. 자세한 내용은 아래")).toBe("공룡봇 재구성");
	expect(threadTitle("", "")).toBe("work");
	const long = threadTitle("word ".repeat(30));
	expect(long.length).toBeLessThanOrEqual(THREAD_NAME_MAX);
	expect(long.endsWith("word")).toBe(true);
});

test("readable: headings become bold lines, tables become lines, raw ids become links, code fences untouched", () => {
	const text = ["## 결과", "| 항목 | 값 |", "|---|---|", "| 테스트 | 120 |", "자세한 건 th:1561607538401615902 참고", "```", "# not a heading", "| a | b |", "```", "-# 작은 글씨"].join("\n");
	expect(readable(text)).toBe(["**결과**", "항목 · 값", "테스트 · 120", "자세한 건 <#1561607538401615902> 참고", "```", "# not a heading", "| a | b |", "```", "-# 작은 글씨"].join("\n"));
});
