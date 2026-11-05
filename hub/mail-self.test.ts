// A mail the owner sent to himself stays in the list with no reply state and no draft, on any install (hub/mail-state.ts selfSent).
import { afterEach, describe, expect, test } from "bun:test";
import { mailByKey, mailCard, migrateStoredMails, postMail, recordMail, setMailNoReply, setMailReply, setMailSuggest, syncMailStates, unrepliedMails, type MailDeps } from "./mail.ts";
import { resetOwnAddresses, setOwnAddresses } from "./mail-state.ts";

let seq = 0;
const source = () => `selfmail${Date.now().toString(36)}${++seq}`;
const ME = '"redacted" <someone@corp.example>';
const ASK = { subject: "자료 보내 주세요?", body: "검토 부탁드립니다?", needsReply: true };

function fakes() {
	const calls = { events: 0, offers: 0 };
	const deps: MailDeps = {
		createThread: async () => ({ id: "143000000000000001" }),
		send: async () => undefined,
		mailChannel: async () => undefined,
		discordOn: false,
		emit: () => void calls.events++,
		wake: () => {},
		offerDraft: () => void calls.offers++,
	};
	return { deps, calls };
}
const sentCopy = (s: string, deps: MailDeps) => postMail({ source: s, id: `sent-${++seq}`, subject: "지난 메일", from: ME, to: "kim@corp.example", direction: "out", at: "2026-11-01T00:00:00Z" }, deps);
const stored = (s: string, over: Record<string, unknown> = {}) => {
	const key = `${s}-${++seq}`;
	recordMail({ key, source: s, id: String(seq), subject: "자료 보내 주세요?", from: ME, to: ME, at: new Date().toISOString(), reply: "needs", ...over });
	return key;
};

afterEach(() => resetOwnAddresses());

describe("a new mail from himself", () => {
	test("is no 답장 필요 and gets no draft, whatever the poster says, and stays an unread incoming mail", async () => {
		const s = source(), { deps, calls } = fakes();
		await sentCopy(s, deps);
		const r = await postMail({ source: s, id: "a", from: '"redacted" <someone@Corp.Example>', to: ME, ...ASK }, deps);
		const m = mailByKey(r.key)!;
		expect(m.reply).toBeUndefined();
		expect(m.dir).toBeUndefined();
		expect(calls).toEqual({ events: 1, offers: 0 });
		expect(unrepliedMails(new Set()).some(x => x.key === r.key)).toBe(false);
		const card = mailCard(m) as { reply?: string; why?: string };
		expect(card.reply).toBeUndefined();
		expect(card.why).toBeUndefined();
	});
	test("to other people too stays out of 답장 필요: he wrote it", async () => {
		const s = source(), { deps, calls } = fakes();
		await sentCopy(s, deps);
		const r = await postMail({ source: s, id: "b", from: ME, to: `${ME}, 김대리 <kim@corp.example>`, cc: "lee@corp.example", ...ASK }, deps);
		expect(mailByKey(r.key)!.reply).toBeUndefined();
		expect(calls.offers).toBe(0);
	});
	test("from the mail's own account or a configured alias", async () => {
		const { deps } = fakes();
		const a = await postMail({ source: source(), id: "c", account: "someone@corp.example", from: ME, to: "someone@corp.example", ...ASK }, deps);
		expect(mailByKey(a.key)!.reply).toBeUndefined();
		setOwnAddresses("config", ["someone@corp.example"]);
		const b = await postMail({ source: source(), id: "d", direction: "in", from: ME, to: "kim@corp.example", ...ASK }, deps);
		expect(mailByKey(b.key)!.reply).toBeUndefined();
	});
	test("with no address known, only a mail to its sender alone counts as his", async () => {
		const { deps, calls } = fakes();
		const alone = await postMail({ source: source(), id: "e", from: ME, to: "someone@corp.example", ...ASK }, deps);
		expect(mailByKey(alone.key)!.reply).toBeUndefined();
		expect(calls.offers).toBe(0);
		const shared = await postMail({ source: source(), id: "f", from: ME, to: `${ME}, kim@corp.example`, ...ASK }, deps);
		expect(mailByKey(shared.key)!.reply).toBe("needs");
		expect(calls.offers).toBe(1);
	});
	test("someone else's mail stays 답장 필요, also with his name on it or his address as a display name", async () => {
		const s = source(), { deps } = fakes();
		await sentCopy(s, deps);
		const r = await postMail({ source: s, id: "g", from: '"someone@corp.example" <kim@corp.example>', to: ME, ...ASK }, deps);
		expect(mailByKey(r.key)!.reply).toBe("needs");
	});
	test("a later sent copy of it does not make it 답장함", async () => {
		const s = source(), { deps } = fakes();
		await sentCopy(s, deps);
		const r = await postMail({ source: s, id: "h", from: ME, to: ME, subject: "메모" }, deps);
		await postMail({ source: s, id: "h-sent", from: ME, to: ME, subject: "메모", direction: "out" }, deps);
		expect(mailByKey(r.key)!.reply).toBeUndefined();
	});
	test("an automatic need never lands on it", async () => {
		const s = source(), { deps } = fakes();
		await sentCopy(s, deps);
		const key = stored(s, { reply: undefined });
		setMailReply(key, "need");
		setMailSuggest(key, { kind: "reply-draft", label: "답장", ref: "x", state: "waiting" });
		expect(mailByKey(key)!.reply).toBeUndefined();
	});
});

describe("stored mails", () => {
	test("a stored 답장 필요 clears on the stored-mail pass and on the mailbox poll, read state and record untouched", async () => {
		const s = source(), { deps } = fakes();
		await sentCopy(s, deps);
		const key = stored(s), key2 = stored(s, { needsReply: true, reply: undefined });
		expect(migrateStoredMails()).toBeGreaterThan(0);
		for (const k of [key, key2]) {
			expect(mailByKey(k)!.reply).toBeUndefined();
			expect(mailByKey(k)!.dir).toBeUndefined();
		}
		expect(migrateStoredMails()).toBe(0);
		const key3 = stored(s);
		expect(syncMailStates(s, [], () => false)).toContain(`mail:${key3}`);
		expect(mailByKey(key3)!.reply).toBeUndefined();
	});
	test("his own 답장 필요 stays", async () => {
		const s = source(), { deps } = fakes();
		await sentCopy(s, deps);
		const key = stored(s, { reply: undefined });
		setMailNoReply(key, false);
		expect(mailByKey(key)).toMatchObject({ reply: "needs", reply_by: "owner" });
		migrateStoredMails();
		syncMailStates(s, [], () => false);
		expect(mailByKey(key)).toMatchObject({ reply: "needs", reply_by: "owner" });
		setOwnAddresses("config", ["someone@corp.example"]);
		migrateStoredMails();
		expect(mailByKey(key)).toMatchObject({ reply: "needs", reply_by: "owner" });
		expect(mailByKey(key)!.dir).toBeUndefined();
	});
});
