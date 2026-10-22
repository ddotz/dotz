// A web message sent as a reply (swipe / reply button) reaches the orchestrator prompt with the quoted message in the same
// format as a Discord reply: both go through inboxBody's `reply` line (msg().replyingTo).
import { expect, test } from "bun:test";
import { inboxText, parseReply, replyLine } from "./intake.ts";

const lines = (s: string) => s.split("\n");

test("a web reply prints the same quoted line as a Discord reply, just before the new text", () => {
	const quoted = { author: "땃쥐", content: "배포는 내일 오전에 할게요" };
	const discord = inboxText({ kind: "message", source: "discord", channel: "chat", message_id: "123456789012345678", author: "hyuns", text: "그럼 오늘은 테스트만요", reply: quoted });
	const web = inboxText({ kind: "message", source: "web", channel: "web", mid: "m-reply-1", author: "hyuns", text: "그럼 오늘은 테스트만요", reply: { id: "2026-10-22T01:00:00.000Z", ...quoted } });
	const lineOf = (s: string) => lines(s).find(l => l.includes(quoted.content));
	expect(lineOf(web)).toBeDefined();
	expect(lineOf(web)).toBe(lineOf(discord));
	const w = lines(web);
	expect(w[w.indexOf(lineOf(web)!) + 1]).toBe("그럼 오늘은 테스트만요");
});

test("a web message without a reply has no quoted line", () => {
	const text = inboxText({ kind: "message", source: "web", channel: "web", mid: "m-plain", author: "hyuns", text: "안녕" });
	expect(text).not.toContain("답장");
	expect(text).not.toContain("replying to");
});

test("parseReply keeps the id, cuts the quote like a Discord reply and fills the owner as the author", () => {
	const r = parseReply({ id: "m-7", author: "", content: `${"가".repeat(400)}` }, "hyuns")!;
	expect(r.id).toBe("m-7");
	expect(r.author).toBe("hyuns");
	expect(r.content.length).toBe(300);
	expect(replyLine(r)).toContain("hyuns");
	expect(parseReply({ id: "x", content: "   " }, "hyuns")).toBeUndefined();
	expect(parseReply("not an object", "hyuns")).toBeUndefined();
	expect(parseReply(undefined, "hyuns")).toBeUndefined();
});

test("a burst keeps each part's own quote", () => {
	const text = inboxText({
		kind: "message", source: "web", channel: "web", mid: "m-b2", author: "hyuns", text: "둘",
		parts: [
			{ text: "하나", reply: { id: "a", author: "땃쥐", content: "첫 인용" } },
			{ text: "둘", reply: { id: "b", author: "hyuns", content: "둘째 인용" } },
		],
	});
	expect(text).toContain("첫 인용");
	expect(text).toContain("둘째 인용");
	expect(text.indexOf("첫 인용")).toBeLessThan(text.indexOf("하나"));
});
