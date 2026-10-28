// 답장 | 전체 답장 and the 받는 사람·참조 of a mail reply draft: the address math (features/reply-drafts/lib/recipients.ts) and what each
// sender gets of it (lib/senders.ts): zele --to / --cc, a webmail-no-api site refusing a 참조 or several recipients in Korean, a plugin's
// to / cc / all. No mail is sent: the runner is a fake.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sendDraft } from "../lib/flow.ts";
import { replyArgv, sendArgv, sendWith } from "../lib/senders.ts";
import { parseRecipients, recipientList, recipientText, replyRecipients } from "../lib/recipients.ts";
import { paths } from "../lib/settings.ts";
import { addDraft, type DraftRec } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { enable, pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
	enable(env);
});

const MAIL = { sender: "Kim <kim@example.com>", to: "Me <me@example.net>, Lee <lee@example.com>", cc: "Park <park@example.com>, Me <me@example.net>", self: ["me@example.net"] };

describe("답장 and 전체 답장", () => {
	test("답장 goes to the sender alone, with no 참조", () => {
		expect(replyRecipients(MAIL).reply).toEqual({ to: ["kim@example.com"], cc: [] });
	});

	test("전체 답장 adds the original's 받는 사람·참조 and leaves the owner's own addresses out", () => {
		expect(replyRecipients(MAIL).all).toEqual({ to: ["kim@example.com", "lee@example.com"], cc: ["park@example.com"] });
	});

	test("a 참조 that is already a 받는 사람 is not sent twice", () => {
		expect(replyRecipients({ sender: "kim@example.com", to: "lee@example.com", cc: "Lee <LEE@example.com>", self: [] }).all).toEqual({ to: ["kim@example.com", "lee@example.com"], cc: [] });
	});

	test("a sender the source names without an address stays as it is; a mail with no other people is the same answer either way", () => {
		expect(replyRecipients({ sender: "Kim", self: [] }).all).toEqual(replyRecipients({ sender: "Kim", self: [] }).reply);
		expect(recipientList("Kim")).toEqual(["Kim"]);
	});

	test("the stored form is the comma list every sender already takes", () => {
		expect(recipientText(["kim@example.com", "lee@example.com"])).toBe("kim@example.com, lee@example.com");
	});
});

describe("the addresses the owner types", () => {
	test("every entry must carry an address; a name with an address in it is read as the address", () => {
		expect(parseRecipients(["kim@example.com", "Lee <lee@example.com>"])).toEqual({ ok: true, list: ["kim@example.com", "lee@example.com"] });
		expect(parseRecipients(["lee"])).toEqual({ ok: false, error: "'lee'은(는) 메일 주소가 아니에요" });
	});

	test("the owner's own address is refused here, not at send time", () => {
		expect(parseRecipients(["Me <me@example.net>"], ["me@example.net"])).toEqual({ ok: false, error: "me@example.net은(는) 내 주소라서 받는 사람이 될 수 없어요" });
	});

	test("more than the cap is refused; nothing sent is an empty list", () => {
		expect(parseRecipients(Array.from({ length: 21 }, (_, i) => `a${i}@example.com`)).ok).toBe(false);
		expect(parseRecipients(undefined)).toEqual({ ok: true, list: [] });
	});
});

let seq = 0;
const rec = (patch: Partial<DraftRec> = {}): DraftRec => ({
	id: `R${++seq}`, kind: "mail", app: "mail", source: "zele", mailId: "42", ref: "zele-42", to: "kim@example.com", subject: "Re: 회의", body: "네, 확인했습니다.", status: "pending", created: new Date().toISOString(),
	changes: [], questions: [], item: { kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "회의", text: "회의 일정 문의" }, mode: "reply", ...patch,
});
const fake = () => {
	const calls: string[][] = [];
	const run: Runner = async argv => (calls.push(argv), { code: 0, stdout: "ok", stderr: "" });
	return { calls, run };
};

describe("senders", () => {
	test("zele 답장 passes --to, and --cc only when the draft has 참조", () => {
		expect(replyArgv("42", "kim@example.com", "body")).toEqual(["zele", "mail", "reply", "42", "--to", "kim@example.com", "--body", "body"]);
		expect(replyArgv("42", "kim@example.com, lee@example.com", "body", [], ["park@example.com"])).toEqual(["zele", "mail", "reply", "42", "--to", "kim@example.com, lee@example.com", "--cc", "park@example.com", "--body", "body"]);
		expect(sendArgv("a@example.com", "제목", "body")).not.toContain("--cc");
	});

	test("전체 답장 reaches zele as the comma 받는 사람 list plus --cc", async () => {
		const f = fake();
		const out = await sendWith(rec({ to: "kim@example.com, lee@example.com", cc: ["park@example.com"], mode: "all" }), f.run);
		expect(out.ok).toBe(true);
		expect(f.calls.at(-1)).toEqual(["zele", "mail", "reply", "42", "--to", "kim@example.com, lee@example.com", "--cc", "park@example.com", "--body", "네, 확인했습니다."]);
	});

	test("a webmail-no-api site refuses 참조 and several 받는 사람 with a Korean line instead of dropping them", async () => {
		const f = fake();
		const cc = await sendWith(rec({ source: "webmail:corp", cc: ["park@example.com"] }), f.run);
		expect(cc).toEqual({ ok: false, message: "이 웹메일은 참조나 여러 받는 사람에게 보낼 수 없어요. 받는 사람을 한 명만 남기고 참조를 비우면 보내요" });
		const many = await sendWith(rec({ source: "webmail:corp", to: "kim@example.com, lee@example.com" }), f.run);
		expect(many.ok).toBe(false);
		expect(f.calls).toEqual([]);
	});
});

describe("sending what the card chose", () => {
	test("전체 답장 sends: a co-recipient of the original is not mistaken for the owner's own address", async () => {
		const f = fake();
		const d = rec({ to: "kim@example.com, lee@example.com", cc: ["park@example.com"], mode: "all", item: { kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], to: ["me@example.net", "lee@example.com"], cc: ["park@example.com"], subject: "회의", text: "회의 일정 문의" } });
		addDraft(d);
		pick(env, d.id, 1);
		expect(await sendDraft(d.id, { run: f.run })).toEqual({ ok: true, text: "kim@example.com, lee@example.com에게 답장을 보냈어요" });
	});

	test("an address the owner added himself is sent, though the original never named it", async () => {
		const f = fake();
		const d = rec({ to: "kim@example.com, new@example.org", ownerRecipients: true });
		addDraft(d);
		pick(env, d.id, 1);
		expect((await sendDraft(d.id, { run: f.run })).ok).toBe(true);
		// Without his own edit the same address is still refused: the rule keeps the model from inventing people.
		const guessed = rec({ to: "kim@example.com, stranger@example.org" });
		addDraft(guessed);
		pick(env, guessed.id, 1);
		const refused = await sendDraft(guessed.id, { run: f.run });
		expect(refused.ok).toBe(false);
		expect(refused.text).toContain("stranger@example.org");
	});
});
