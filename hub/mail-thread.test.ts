// Reply state of a mail thread (hub/mail-thread.ts): the `zele mail read` parser on a synthetic thread, the quote-stripping
// acknowledgement check and the own / ack / action decision.
import { describe, expect, test } from "bun:test";
import { isAck, newText, parseThread, triage, type ThreadMessage } from "./mail-thread.ts";

const RULE = "─".repeat(60);
const threadText = (...msgs: { from: string; body: string; unread?: boolean }[]) =>
	[
		"Subject: Project schedule",
		"Messages: " + msgs.length,
		...msgs.flatMap((m, i) => [RULE, `From: ${m.from}${m.unread ? " [unread]" : ""}`, "  To: Someone <someone@example.com>", `Date: Oct ${20 + i}, 10:00 AM`, "Auth: pass", "", m.body]),
	].join("\n");

const OWNER = new Set(["me@example.com"]);
const msg = (addr: string, body: string): ThreadMessage => ({ from: addr, addr, date: "", unread: false, body });

describe("parseThread", () => {
	test("one message per block after the header, address, unread flag, date and body", () => {
		const text = threadText({ from: "Kim Partner <partner@example.com>", body: "Hello,\n\nCould we meet on Friday?" }, { from: "Me <me@example.com>", body: "Friday works." }, { from: "partner@example.com", body: "Thanks!", unread: true });
		const msgs = parseThread(text);
		expect(msgs.map(m => m.addr)).toEqual(["partner@example.com", "me@example.com", "partner@example.com"]);
		expect(msgs[0]).toEqual({ from: "Kim Partner <partner@example.com>", addr: "partner@example.com", date: "Oct 20, 10:00 AM", unread: false, body: "Hello,\n\nCould we meet on Friday?" });
		expect(msgs[2].unread).toBe(true);
		expect(msgs[2].from).toBe("partner@example.com");
	});
	test("a block without a From: line is not a message; CRLF is fine", () => {
		expect(parseThread("Subject: x\r\n" + RULE + "\r\nnothing here")).toEqual([]);
		expect(parseThread(threadText({ from: "A <A@Example.com>", body: "hi" }).replace(/\n/g, "\r\n"))[0].addr).toBe("a@example.com");
	});
});

describe("acknowledgement", () => {
	test("quoted text and signature are not new text", () => {
		expect(newText("Thanks, got it.\n\nOn Oct 20, 2026, Me <me@example.com> wrote:\n> Can you send the file?")).toBe("Thanks, got it.");
		expect(newText("잘 받았습니다.\n> 확인 부탁드립니다\n-- \nKim")).toBe("잘 받았습니다.");
	});
	test("a short thank-you is an ack even when the quote asks something", () => {
		expect(isAck("감사합니다!")).toBe(true);
		expect(isAck("Received, thanks.\n\nOn Oct 20, 2026, Me <me@example.com> wrote:\n> Could you confirm?")).toBe(true);
	});
	test("a question, a request word, no thanks word, a long note or an empty note is not an ack", () => {
		expect(isAck("Thanks. When is the next meeting?")).toBe(false);
		expect(isAck("감사합니다. 자료 공유도 가능할까요")).toBe(false);
		expect(isAck("확인 부탁드립니다")).toBe(false);
		expect(isAck("Thanks, please also check the draft.")).toBe(false);
		expect(isAck("Thanks.\nline\nline\nline\nline")).toBe(false);
		expect(isAck("Thanks " + "a".repeat(400))).toBe(false);
		expect(isAck("")).toBe(false);
		expect(isAck("See the attached file.")).toBe(false);
		expect(isAck("내일 3시에 뵙겠습니다")).toBe(false);
	});
});

describe("triage", () => {
	test("the owner wrote last: own", () => {
		expect(triage([msg("partner@example.com", "Question?"), msg("me@example.com", "Answer.")], OWNER)).toEqual({ kind: "own" });
	});
	test("no owner reply yet: action, not answered", () => {
		expect(triage([msg("partner@example.com", "Hi"), msg("partner@example.com", "Thanks")], OWNER)).toEqual({ kind: "action", answered: false });
		expect(triage([], OWNER)).toEqual({ kind: "action", answered: false });
	});
	test("after the owner's reply: only acks is ack, anything else is action on an answered thread", () => {
		expect(triage([msg("partner@example.com", "Can you?"), msg("me@example.com", "Yes."), msg("partner@example.com", "감사합니다")], OWNER)).toEqual({ kind: "ack" });
		expect(triage([msg("partner@example.com", "Can you?"), msg("me@example.com", "Yes."), msg("partner@example.com", "Thanks"), msg("other@example.com", "Can I join?")], OWNER)).toEqual({ kind: "action", answered: true });
	});
});
