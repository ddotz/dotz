// Mail read / replied / 답장 필요 follow the real state (hub/mail.ts syncMailStates, hub/mail-state.ts replyExclusion, hub/zele.ts tick states):
// read in the mailbox is read in dotz on the next poll, a reply sent outside dotz is 답장함, and a mail he is not a main recipient of is never 답장 필요.
import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { replyExclusion, replyExpected, setOwnAddresses } from "./mail-state.ts";
import { mailByKey, mailCard, postMail, setMailReply, syncMailStates, type MailDeps } from "./mail.ts";
import { markRead, readOf } from "./reads.ts";
import { tick } from "./zele.ts";

const own = new Set(["me@example.com"]);
const ME = "Me <me@example.com>";
const deps: MailDeps = { createThread: async () => ({ id: "1" }), send: async () => {}, mailChannel: async () => undefined, discordOn: false, emit: () => {}, wake: () => {} };
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;
const realRead = (target: string, ts: string) => {
	const r = markRead({ target, ts });
	return r.ok && r.moved;
};

describe("main recipient", () => {
	const ask = { from: "Kim <kim@example.com>", subject: "견적 요청", text: "견적서 보내 주세요" };
	test("To me with a request is 답장 필요", () => {
		expect(replyExclusion({ ...ask, to: ME }, own)).toBeUndefined();
		expect(replyExpected({ ...ask, to: `${ME}, Lee <lee@example.com>` }, own)).toBe(true);
		expect(replyExpected({ ...ask, to: "Me <m.e+work@example.com>" }, new Set(["m.e@example.com"]))).toBe(true);
	});
	test("only in Cc is 참조로 받음", () => {
		expect(replyExclusion({ ...ask, to: "Lee <lee@example.com>", cc: "Me <me+x@example.com>" }, own)).toBe("cc");
		expect(replyExpected({ ...ask, to: "Lee <lee@example.com>", cc: ME }, own)).toBe(false);
	});
	test("a list or group mail, and a machine sender, are not 답장 필요", () => {
		expect(replyExclusion({ ...ask, to: ME, list: true }, own)).toBe("list");
		expect(replyExclusion({ ...ask, to: "All Staff <all-staff@example.com>" }, own)).toBe("list");
		expect(replyExclusion({ ...ask, to: "dev-team@googlegroups.com" }, own)).toBe("list");
		expect(replyExclusion({ ...ask, from: "GitHub <notifications@github.com>", to: ME }, own)).toBe("bulk");
	});
	test("one of many To recipients while the mail greets another by name; greeting him or nobody keeps it", () => {
		const to = `${ME}, 이영희 <lee@example.com>, Park <park@example.com>`;
		expect(replyExclusion({ ...ask, to, text: "이영희님,\n견적서 보내 주세요" }, own)).toBe("other");
		expect(replyExclusion({ ...ask, to, text: "Hi Park,\nplease send the quote" }, own)).toBe("other");
		expect(replyExclusion({ ...ask, to: `나철수 <me@example.com>, 이영희 <lee@example.com>, Park <park@example.com>`, text: "철수님,\n견적서 보내 주세요" }, own)).toBeUndefined();
		expect(replyExclusion({ ...ask, to, text: "안녕하세요,\n견적서 보내 주세요" }, own)).toBeUndefined();
		expect(replyExclusion({ ...ask, to: `${ME}, 이영희 <lee@example.com>`, text: "이영희님,\n견적서 보내 주세요" }, own)).toBeUndefined();
	});
});

describe("syncMailStates", () => {
	beforeEach(() => setOwnAddresses("zele", ["me@example.com"]));
	test("read in the mailbox becomes read in dotz on the next poll; unread there never unreads it", async () => {
		const id = uid("r");
		const { key, target } = await postMail({ source: "fxs", id, subject: "회의", from: "Kim <kim@example.com>", to: ME, body: "회의 일정 문의" }, deps);
		expect(readOf(target)).toBeNull();
		syncMailStates("fxs", [{ id }], realRead);
		expect(readOf(target)).toBeNull();
		expect(syncMailStates("fxs", [{ id, read: true }], realRead)).toEqual([target]);
		expect(readOf(target)).toBe(mailByKey(key)!.at);
		expect(syncMailStates("fxs", [{ id, read: true }], realRead)).toEqual([]);
	});
	test("a reply he sent outside dotz makes the mail 답장함", async () => {
		const id = uid("p");
		const { key } = await postMail({ source: "fxs", id, subject: "견적 요청", from: "Kim <kim@example.com>", to: ME, body: "견적서 보내 주세요" }, deps);
		expect(mailByKey(key)!.reply).toBe("needs");
		syncMailStates("fxs", [{ id, replied: true }], () => false);
		expect(mailByKey(key)!.reply).toBe("replied");
	});
	test("Cc-only and list mail are not 답장 필요 even when the poster says so, and show why; an older 답장 필요 goes on the next poll", async () => {
		const cc = await postMail({ source: "fxs", id: uid("c"), subject: "견적 요청", from: "Kim <kim@example.com>", to: "Lee <lee@example.com>", cc: ME, body: "견적서 보내 주세요", needsReply: true }, deps);
		const list = await postMail({ source: "fxs", id: uid("l"), subject: "견적 요청", from: "Kim <kim@example.com>", to: ME, body: "견적서 보내 주세요", listId: "<news.example.com>" }, deps);
		expect(mailByKey(cc.key)!.reply).toBeUndefined();
		expect(mailByKey(list.key)!.reply).toBeUndefined();
		expect(mailCard(mailByKey(cc.key)!).why).toBe("참조로 받음");
		expect(mailCard(mailByKey(list.key)!).why).toBe("단체 메일");
		setMailReply(cc.key, "need");   // what older code left
		expect(mailByKey(cc.key)!.reply).toBe("needs");
		expect(syncMailStates("fxs", [], () => false)).toContain(cc.target);
		expect(mailByKey(cc.key)!.reply).toBeUndefined();
		setMailReply(cc.key, "reopen", undefined, "owner");   // his own 답장 필요로 표시 stays
		syncMailStates("fxs", [], () => false);
		expect(mailByKey(cc.key)!.reply).toBe("needs");
	});
});

describe("zele poll", () => {
	beforeEach(() => {
		rmSync(join(DATA_DIR, "zele-state.json"), { force: true });
		setOwnAddresses("zele", ["me@example.com"]);
	});
	test("each poll reports every listed thread's read flag and whether its newest message is his, with no extra zele call", async () => {
		const got: { id: string; read?: boolean; replied?: boolean }[][] = [];
		let reads = 0;
		const rows = (flags: string, from: string) => async (args: string[]) => (args[0] === "cal" ? [] : args.includes("sent") ? [{ id: "t-2", from: ME, subject: "답장", messages: 2, date: "x" }] : [{ id: "t-1", from, subject: "회의", messages: 1, date: "y", flags }]);
		const hooks = { alert: () => {}, brief: () => {}, mail: async () => {}, sent: async () => {}, states: (s: { id: string; read?: boolean; replied?: boolean }[]) => void got.push(s) };
		await tick(hooks, new Date(), rows("unread", "Kim <kim@example.com>"), async () => (reads++, ""));
		await tick(hooks, new Date(), rows("", "Kim <kim@example.com>"), async () => (reads++, ""));
		expect(got).toEqual([
			[{ id: "t-1", read: false }, { id: "t-2", replied: true }],
			[{ id: "t-1", read: true }, { id: "t-2", replied: true }],
		]);
		expect(reads).toBe(0);
	});
});
