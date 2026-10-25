// Mail direction and reply state (hub/mail-state.ts): addresses and aliases, folders and labels, every reply transition, the old flags, and the one-time migration.
import { describe, expect, test } from "bun:test";
import { addressKey, directionOf, isOwnAddress, mailLabel, migrateMails, nextReply, replyOf, type MailReply, type MailReplyEvent, type StoredMail } from "./mail-state.ts";
import { mailUnreplied } from "./unreplied.ts";

const own = new Set(["owner@example.com", "owner@gmail.com"]);
const NOW = Date.parse("2026-10-25T00:00:00Z");

describe("addresses", () => {
	test("a display name, case, a plus-tag and the dots of a Gmail address do not matter", () => {
		expect(addressKey("Owner Kim <Owner@Example.com>")).toBe("owner@example.com");
		expect(addressKey("owner+shop@example.com")).toBe("owner@example.com");
		expect(addressKey("o.w.n.e.r+news@googlemail.com")).toBe("owner@gmail.com");
		expect(addressKey("owner.kim@example.com")).toBe("owner.kim@example.com");
		expect(addressKey("(제목 없음)")).toBe("");
	});
	test("an alias is the owner's, a lookalike is not", () => {
		expect(isOwnAddress("나 <owner+alias@example.com>", own)).toBe(true);
		expect(isOwnAddress("Owner <o.wner@gmail.com>", own)).toBe(true);
		expect(isOwnAddress("Kim <kim@example.com>", own)).toBe(false);
		expect(isOwnAddress("owner@example.org", own)).toBe(false);
		expect(isOwnAddress("", own)).toBe(false);
	});
});

describe("directionOf", () => {
	test("the owner's own address, an alias, a sent folder or a SENT label make a mail outgoing", () => {
		expect(directionOf({ from: "Owner <owner@example.com>" }, own)).toBe("out");
		expect(directionOf({ from: "owner+invoice@example.com" }, own)).toBe("out");
		expect(directionOf({ from: "Kim <kim@example.com>", folder: "보낸편지함" }, own)).toBe("out");
		expect(directionOf({ from: "Kim <kim@example.com>", folder: "Sent Items" }, own)).toBe("out");
		expect(directionOf({ from: "Kim <kim@example.com>", labels: ["INBOX", "SENT"] }, own)).toBe("out");
	});
	test("everything else is incoming, and the poster's own word wins", () => {
		expect(directionOf({ from: "Kim <kim@example.com>", folder: "INBOX", labels: ["UNREAD"] }, own)).toBe("in");
		expect(directionOf({ from: "Kim <kim@example.com>", direction: "out" }, own)).toBe("out");
		expect(directionOf({ from: "Owner <owner@example.com>", direction: "in" }, own)).toBe("in");
	});
});

describe("reply transitions", () => {
	const table: [MailReply | undefined, MailReplyEvent, MailReply | undefined][] = [
		[undefined, "need", "needs"],
		[undefined, "draft", "draft"],
		[undefined, "sent", "replied"],
		[undefined, "skip", "skipped"],
		[undefined, "fyi", "fyi"],
		[undefined, "reopen", undefined],
		["needs", "draft", "draft"],
		["needs", "need", "needs"],
		["needs", "sent", "replied"],
		["needs", "skip", "skipped"],
		["needs", "fyi", "fyi"],
		["draft", "need", "draft"],
		["draft", "draft", "draft"],
		["draft", "sent", "replied"],
		["draft", "skip", "skipped"],
		["replied", "need", "replied"],
		["replied", "draft", "replied"],
		["replied", "skip", "replied"],
		["replied", "fyi", "replied"],
		["replied", "reopen", "replied"],
		["skipped", "need", "skipped"],
		["skipped", "draft", "skipped"],
		["skipped", "reopen", "needs"],
		["skipped", "sent", "replied"],
		["fyi", "reopen", "needs"],
		["fyi", "skip", "skipped"],
		["fyi", "sent", "replied"],
	];
	for (const [from, ev, to] of table) test(`${from ?? "(none)"} + ${ev} -> ${to ?? "(none)"}`, () => expect(nextReply(from, ev)).toBe(to));
});

describe("labels", () => {
	test("outgoing is 내가 보냄; incoming shows the reply state, else read or unread", () => {
		expect(mailLabel("out", false)).toBe("내가 보냄");
		expect(mailLabel("in", false)).toBe("새 메일");
		expect(mailLabel("in", true)).toBe("읽음");
		expect(mailLabel("in", true, "needs")).toBe("답장 필요");
		expect(mailLabel("in", false, "needs")).toBe("답장 필요");
		expect(mailLabel("in", true, "draft")).toBe("초안 있음");
		expect(mailLabel("in", true, "replied")).toBe("답장함");
		expect(mailLabel("in", true, "skipped")).toBe("답장 안 함");
		expect(mailLabel("in", true, "fyi")).toBe("참고만");
	});
});

describe("older records", () => {
	test("the flags and the suggested draft still read as a reply state", () => {
		expect(replyOf({ needsReply: true })).toBe("needs");
		expect(replyOf({ suggest: {} })).toBe("draft");
		expect(replyOf({ suggest: { state: "waiting" } })).toBe("needs");
		expect(replyOf({ suggest: { state: "sent" }, needsReply: true })).toBe("replied");
		expect(replyOf({ noReply: true, needsReply: true })).toBe("skipped");
		expect(replyOf({ reply: "fyi", noReply: true })).toBe("fyi");
		expect(replyOf({})).toBeUndefined();
	});
	test("미답장 is an incoming mail in 답장 필요 or 초안 있음, fresh, with no sent draft", () => {
		const base = { key: "zele-1", at: "2026-10-24T00:00:00Z" };
		expect(mailUnreplied({ ...base, reply: "needs" }, new Set(), NOW)).toBe(true);
		expect(mailUnreplied({ ...base, reply: "draft" }, new Set(), NOW)).toBe(true);
		for (const reply of ["replied", "skipped", "fyi"] as const) expect(mailUnreplied({ ...base, reply }, new Set(), NOW)).toBe(false);
		expect(mailUnreplied({ ...base, reply: "needs", dir: "out" }, new Set(), NOW)).toBe(false);
		expect(mailUnreplied({ ...base, reply: "needs" }, new Set(["zele-1"]), NOW)).toBe(false);
		expect(mailUnreplied({ ...base, at: "2026-08-01T00:00:00Z", reply: "needs" }, new Set(), NOW)).toBe(false);
		expect(mailUnreplied({ ...base, needsReply: true }, new Set(), NOW)).toBe(true);
	});
});

describe("migration", () => {
	const stored = (): StoredMail[] => [
		{ key: "zele-in1", subject: "견적 문의", from: "Kim <kim@example.com>", to: "owner@example.com", at: "2026-10-24T01:00:00Z", needsReply: true },
		{ key: "zele-sent1", subject: "Re: 견적 문의", from: "Owner <owner@example.com>", to: "Kim <kim@example.com>", at: "2026-10-24T02:00:00Z", needsReply: true },
		{ key: "zele-in2", subject: "일정 확인", from: "Lee <lee@example.com>", at: "2026-10-24T03:00:00Z", noReply: true },
		{ key: "zele-in3", subject: "자료 요청", from: "Park <park@example.com>", at: "2026-10-24T04:00:00Z", suggest: { state: "draft" } },
		{ key: "zele-in4", subject: "계약서 확인", from: "Choi <choi@example.com>", at: "2026-10-24T05:00:00Z", suggest: { state: "draft" } },
		{ key: "zele-in5", subject: "안내", from: "Han <han@example.com>", at: "2026-10-24T06:00:00Z" },
		{ key: "zele-sent2", subject: "혼자 보낸 메모", from: "owner+memo@example.com", at: "2026-10-24T07:00:00Z" },
	];

	test("his own mails become outgoing without unread state; flags become one reply state; a thread with his reply becomes 답장함", () => {
		const rows = stored();
		const changed = migrateMails(rows, { own, sentRefs: new Set(["zele-in4"]) });
		const by = Object.fromEntries(rows.map(r => [r.key, r]));
		expect(changed).toBeGreaterThan(0);
		expect(by["zele-sent1"]).toMatchObject({ dir: "out" });
		expect(by["zele-sent1"]!.reply).toBeUndefined();
		expect("needsReply" in by["zele-sent1"]!).toBe(false);
		expect(by["zele-sent2"]).toMatchObject({ dir: "out" });
		expect(by["zele-in1"]).toMatchObject({ reply: "replied", sentAt: "2026-10-24T02:00:00Z" });
		expect("needsReply" in by["zele-in1"]!).toBe(false);
		expect(by["zele-in2"]!.reply).toBe("skipped");
		expect("noReply" in by["zele-in2"]!).toBe(false);
		expect(by["zele-in3"]!.reply).toBe("draft");
		expect(by["zele-in4"]!.reply).toBe("replied");
		expect(by["zele-in5"]!.reply).toBeUndefined();
		expect(by["zele-in5"]!.dir).toBeUndefined();
	});
	test("a reply before the mail, to someone else or under another subject does not count", () => {
		const rows: StoredMail[] = [
			{ key: "a", subject: "견적", from: "Kim <kim@example.com>", at: "2026-10-24T05:00:00Z", needsReply: true },
			{ key: "early", subject: "Re: 견적", from: "owner@example.com", to: "kim@example.com", at: "2026-10-24T01:00:00Z" },
			{ key: "other", subject: "Re: 견적", from: "owner@example.com", to: "lee@example.com", at: "2026-10-24T06:00:00Z" },
			{ key: "topic", subject: "다른 주제", from: "owner@example.com", to: "kim@example.com", at: "2026-10-24T06:00:00Z" },
		];
		migrateMails(rows, { own });
		expect(rows[0]!.reply).toBe("needs");
	});
	test("running it again changes nothing", () => {
		const rows = stored();
		migrateMails(rows, { own, sentRefs: new Set(["zele-in4"]) });
		const once = JSON.stringify(rows);
		expect(migrateMails(rows, { own, sentRefs: new Set(["zele-in4"]) })).toBe(0);
		expect(JSON.stringify(rows)).toBe(once);
	});
});
