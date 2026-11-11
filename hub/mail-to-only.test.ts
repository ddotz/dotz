// The 받는 사람 rule as one install setting (custom/apps.json mail.to_only, hub/app-settings.ts): the default keeps a Cc-only mail out of 답장 필요,
// turned off through the settings write path it takes the normal path (reply state, wake decision, automatic draft), and nothing but that rule moves.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "./app-settings.ts";
import { DATA_DIR } from "./config.ts";
import { mailByKey, mailCard, postMail, type MailDeps } from "./mail.ts";
import { migrateMails, replyExclusion, replyExpected, resetOwnAddresses, setOwnAddresses, setToOnlyDir, type ReplyCue, type StoredMail } from "./mail-state.ts";

const own = new Set(["owner@example.com"]);
const ask = { from: "Kim <kim@example.com>", subject: "검토 요청", text: "검토 부탁드립니다" };
const ccOnly: ReplyCue = { ...ask, to: "Lee <lee@example.com>", cc: "Owner <owner@example.com>" };
const group: ReplyCue = { ...ask, to: "team@example.com" };
let dir: string, seq = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-to-only-"));
	setToOnlyDir(dir);
	setOwnAddresses("config", [...own]);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetOwnAddresses();
	setToOnlyDir(DATA_DIR);
});

function post(id: string) {
	const offers: boolean[] = [];
	const deps: MailDeps = { createThread: async () => ({ id: "143000000000000002" }), send: async () => undefined, mailChannel: async () => "1500000000001908449", discordOn: false, threadOn: () => false, emit: () => undefined, wake: () => undefined, offerDraft: m => void offers.push(m.needs!) };
	return postMail({ source: "to-only", id, from: ccOnly.from!, to: ccOnly.to!, cc: ccOnly.cc!, subject: ccOnly.subject, body: ccOnly.text! }, deps).then(r => ({ key: r.key, offers }));
}

describe("답장 필요는 받는 사람이 나인 메일만", () => {
	test("default: a Cc-only or group mail is not 답장 필요, and the switch reads on", async () => {
		expect(readSettings(dir, "mail").find(f => f.key === "to_only")?.value).toBe(true);
		expect(replyExpected(ccOnly, own)).toBe(false);
		expect(replyExclusion(ccOnly, own)).toBe("cc");
		expect(replyExclusion(group, own)).toBe("list");
		const { key, offers } = await post(`d${++seq}-${Date.now()}`);
		expect(mailByKey(key)?.reply).toBeUndefined();
		expect(offers).toEqual([false]);
		expect(mailCard(mailByKey(key)!).why).toBe("참조로 받음");
	});
	test("off: the same mails read as a mail in To, at once, for every mail instance", async () => {
		writeSettings(dir, "mail-2", { to_only: false });
		expect(readSettings(dir, "mail").find(f => f.key === "to_only")?.value).toBe(false);
		expect(replyExpected(ccOnly, own)).toBe(true);
		expect(replyExpected(group, own)).toBe(true);
		expect(replyExpected({ ...ccOnly, text: "참고만 하세요", subject: "자료 공유" }, own)).toBe(false);
		const { key, offers } = await post(`o${++seq}-${Date.now()}`);
		expect(mailByKey(key)?.reply).toBe("needs");
		expect(offers).toEqual([true]);
		expect(mailCard(mailByKey(key)!).why).toBeUndefined();
	});
	test("off: every other exclusion stays", () => {
		writeSettings(dir, "mail", { to_only: false });
		expect(replyExclusion({ ...ccOnly, list: true }, own)).toBe("list");
		expect(replyExclusion({ ...ccOnly, from: "no-reply@example.com" }, own)).toBe("bulk");
		expect(replyExclusion({ ...ccOnly, subject: "[공지] 검토 요청" }, own)).toBe("list");
		expect(replyExclusion({ ...ccOnly, text: "검토 부탁드립니다. 수신 거부는 여기로" }, own)).toBe("list");
		expect(replyExclusion({ ...ccOnly, from: "Owner <owner@example.com>" }, own)).toBe("self");
		expect(replyExclusion({ ...ask, to: "Owner <owner@example.com>, Lee <lee@example.com>, Park <park@example.com>", text: "Lee님, 검토 부탁드립니다" }, own)).toBe("other");
		expect(replyExclusion({ ...ccOnly, to: "Lee <lee@example.com>, Park <park@example.com>", text: "Lee님, 검토 부탁드립니다" }, own)).toBe("other");
	});
	test("off: stored 답장 필요 on a Cc-only mail survives a migration; on again it goes", () => {
		writeSettings(dir, "mail", { to_only: false });
		const stored = [{ key: "k", at: "2030-01-01T00:00:00.000Z", subject: ccOnly.subject, from: ccOnly.from!, to: ccOnly.to, cc: ccOnly.cc, reply: "needs" }] as unknown as StoredMail[];
		migrateMails(stored, { own });
		expect(stored[0]!.reply).toBe("needs");
		writeSettings(dir, "mail", { to_only: true });
		migrateMails(stored, { own });
		expect(stored[0]!.reply).toBeUndefined();
	});
});
