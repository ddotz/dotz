// A mail the owner wrote himself never becomes a new mail, and a thread he answered is 답장함: the zele watch (tick) fed with zele-shaped
// thread lists, postMail, the unread count of the conversation, the mail card the web draws, and the one-time migration of stored mails.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { unreadOf } from "./conversations.ts";
import { emit, type HubEvent } from "./events.ts";
import { mailByKey, mailCard, mailTarget, migrateStoredMails, postMail, recordMail, setMailFyi, setMailNoReply, setMailReply, setMailSuggest, sentReplyRefs, unrepliedMails, type MailDeps, type MailRecord } from "./mail.ts";
import { resetOwnAddresses, setOwnAddresses } from "./mail-state.ts";
import { markRead } from "./reads.ts";
import { tick } from "./zele.ts";

let seq = 0;
let clock = Date.parse("2030-01-01T00:00:00Z");
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;
const stamp = () => new Date((clock += 60_000)).toISOString();

function fakes() {
	const calls = { events: [] as Record<string, any>[], wakes: 0, offers: 0, threads: 0 };
	const deps: MailDeps = {
		createThread: async () => (calls.threads++, { id: "143000000000000001" }),
		send: async () => undefined,
		mailChannel: async () => "1561565203714408448",
		discordOn: true,
		threadOn: () => true,
		emit: e => (calls.events.push(e), emit("inbox", e as Parameters<typeof emit>[1])),
		wake: () => void calls.wakes++,
		offerDraft: () => void calls.offers++,
		now: stamp,
	};
	return { deps, calls };
}

// What `zele mail list` prints per thread: id is the thread id, from is the sender of the newest message.
type Thread = { id: string; from: string; to?: string; subject: string; snippet?: string; account?: string; flags?: string; labels?: string; messages?: number; date?: string };
const thread = (t: Thread) => ({ flags: "unread", to: "Owner <owner@example.com>", snippet: "본문 일부", date: "10월 25일, 오전 9:00", messages: 1, ...t });

// One watch pass: the unread list, the sent-folder list and an empty calendar, wired to postMail like hub/main.ts does.
async function pass(unread: Thread[], sent: Thread[], deps: MailDeps, needsReply = false) {
	const seen = { mail: [] as string[], sent: [] as string[] };
	const list = async (args: string[]) => {
		if (args[0] === "cal") return [];
		return (args.includes("sent") ? sent : unread).map(thread) as Record<string, string | number | undefined>[];
	};
	await tick(
		{
			alert: () => {},
			brief: () => {},
			mail: async m => {
				seen.mail.push(m.id);
				await postMail({ source: "zele", id: m.id, messageId: m.message, from: m.from, to: m.to, subject: m.subject, summary: m.snippet, wake: true, ...(needsReply ? { needsReply: true } : {}) }, deps);
			},
			sent: async m => {
				seen.sent.push(m.id);
				await postMail({ source: "zele", id: m.id, from: m.from, to: m.to, subject: m.subject, summary: m.snippet, direction: "out" }, deps);
			},
		},
		new Date(clock),
		list,
		async () => Promise.reject(new Error("threads are not read in this test")),
	);
	return seen;
}

beforeEach(() => {
	rmSync(join(DATA_DIR, "zele-state.json"), { force: true });
	setOwnAddresses("zele", ["owner@example.com"]);
});
afterEach(() => resetOwnAddresses());

describe("the watch", () => {
	test("a thread whose newest message is the owner's own mail is not a new mail: no event, no wake, no draft offer, no unread", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const id = uid("t");
		const seen = await pass([{ id, from: "Owner <owner@example.com>", to: "Kim <kim@example.com>", subject: "견적 보냅니다" }], [], deps);
		expect(seen.mail).toEqual([]);
		expect(seen.sent).toEqual([id]);
		expect(calls.events).toEqual([]);
		expect(calls.wakes + calls.offers + calls.threads).toBe(0);
		const key = `zele-${id}`;
		expect(mailByKey(key)).toMatchObject({ dir: "out", subject: "견적 보냅니다" });
		expect(unreadOf(mailTarget(key))).toBe(0);
		expect(mailCard(mailByKey(key)!)).toMatchObject({ dir: "out" });
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(false);
	});

	test("an alias of the owner (plus-tag, Gmail dots, the account field of the list) counts as the owner", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		setOwnAddresses("zele", []);
		const a = uid("a");
		const b = uid("b");
		const seen = await pass(
			[
				{ id: a, from: "Owner <owner+shop@example.com>", subject: "별칭 주소로 보냄", account: "owner+shop@example.com" },
				{ id: b, from: "Kim <kim@example.com>", subject: "받은 메일" },
			],
			[],
			deps,
			true,
		);
		expect(seen.sent).toEqual([a]);
		expect(seen.mail).toEqual([b]);
		expect(calls.events.map(e => e.mail)).toEqual([`zele-${b}`]);
		expect(calls.offers).toBe(1);
	});

	test("an incoming thread is still a new mail, with an unread count", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const id = uid("in");
		await pass([{ id, from: "Kim <kim@example.com>", subject: "자료 공유드립니다" }], [], deps);
		const key = `zele-${id}`;
		expect(calls.wakes).toBe(1);
		expect(unreadOf(mailTarget(key))).toBe(1);
		expect(mailByKey(key)!.dir).toBeUndefined();
		expect(mailCard(mailByKey(key)!).reply).toBeUndefined();
	});

	test("the owner's reply found later in the sent folder makes the thread 답장함, without any new mail", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const id = uid("re");
		const key = `zele-${id}`;
		await pass([{ id, from: "Kim <kim@example.com>", subject: "일정 문의" }], [], deps);
		setMailSuggest(key, { kind: "reply-draft", label: "답장 초안", ref: "d1" });
		expect(mailByKey(key)!.reply).toBe("draft");
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(true);
		const events = calls.events.length;
		await pass([], [{ id, from: "Owner <owner@example.com>", to: "Kim <kim@example.com>", subject: "Re: 일정 문의", flags: "sent" }], deps);
		const rec = mailByKey(key)!;
		expect(rec.reply).toBe("replied");
		expect(rec.sentAt).toBeTruthy();
		expect(rec.suggest).toBeUndefined();
		expect(rec.dir).toBeUndefined();
		expect(calls.events.length).toBe(events);
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(false);
		expect(mailCard(rec)).toMatchObject({ reply: "replied" });
	});

	test("a mail drafted by a 자동 초안 규칙 keeps the rule's name as its badge after the draft's suggestion is gone", async () => {
		const { deps } = fakes();
		await pass([], [], deps);
		const id = uid("rule");
		const key = `zele-${id}`;
		await pass([{ id, from: "Kim <kim@example.com>", subject: "자료 문의" }], [], deps);
		setMailSuggest(key, { kind: "reply-draft", label: "답장 초안", ref: "d9", rule: "자료 요청" });
		expect(mailCard(mailByKey(key)!)).toMatchObject({ rule: "자료 요청", suggest: { rule: "자료 요청" } });
		await pass([], [{ id, from: "Owner <owner@example.com>", to: "Kim <kim@example.com>", subject: "Re: 자료 문의", flags: "sent" }], deps);
		const rec = mailByKey(key)!;
		expect(rec.suggest).toBeUndefined();
		expect(mailCard(rec)).toMatchObject({ reply: "replied", rule: "자료 요청" });
	});

	test("a thread the other side answered after the owner's own mail is a new mail again", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const id = uid("flip");
		const key = `zele-${id}`;
		await pass([], [{ id, from: "Owner <owner@example.com>", to: "Kim <kim@example.com>", subject: "제안드립니다" }], deps);
		expect(mailByKey(key)!.dir).toBe("out");
		await pass([{ id, from: "Kim <kim@example.com>", subject: "Re: 제안드립니다" }], [], deps);
		expect(mailByKey(key)!.dir).toBeUndefined();
		expect(calls.events.map(e => e.mail)).toEqual([key]);
		expect(calls.wakes).toBe(1);
		expect(unreadOf(mailTarget(key))).toBe(1);
	});

	test("the sent folder list failing does not stop the watch", async () => {
		const { deps } = fakes();
		const id = uid("fail");
		const hooks = { alert: () => {}, brief: () => {}, mail: async () => {} };
		await tick(hooks, new Date(clock), async () => []);
		const list = async (args: string[]) => {
			if (args.includes("sent")) throw new Error("zele mail list: no such folder");
			return args[0] === "cal" ? [] : [thread({ id, from: "Kim <kim@example.com>", subject: "x" })];
		};
		let got = 0;
		await tick({ ...hooks, mail: async () => void got++ }, new Date(clock), list as never);
		expect(got).toBe(1);
		void deps;
	});
});

// Every thread below is listed the way zele does: the sender and the date/count are those of the newest message of the thread.
describe("a newer message in a thread decides its state again", () => {
	const KIM = "Kim <kim@example.com>";
	const OWNER = "Owner <owner@example.com>";
	const d = (n: number) => `10월 25일, 오전 ${9 + n}:00`;
	const kim = (id: string, n: number, flags = "unread"): Thread => ({ id, from: KIM, subject: "일정 공유", messages: n, date: d(n), flags });
	const owner = (id: string, n: number): Thread => ({ id, from: OWNER, to: KIM, subject: "Re: 일정 공유", messages: n, date: d(n), flags: "sent" });

	test("owner replied -> the other side replies again -> new mail and 답장 필요 once; owner replies again -> 답장함", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const id = uid("rr");
		const key = `zele-${id}`;
		await pass([kim(id, 1)], [], deps, true);
		expect(calls.wakes).toBe(1);
		expect(mailByKey(key)!.reply).toBe("needs");
		await pass([], [owner(id, 2)], deps);
		expect(mailByKey(key)).toMatchObject({ reply: "replied" });
		expect(mailByKey(key)!.sentAt).toBeTruthy();
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(false);
		// He read the thread; the other side answers: not unread in zele any more, still seen.
		markRead({ target: mailTarget(key), ts: new Date(clock).toISOString() });
		expect(unreadOf(mailTarget(key))).toBe(0);
		const events = calls.events.length;
		const seen = await pass([kim(id, 3, "")], [], deps, true);
		expect(seen.mail).toEqual([id]);
		expect(calls.events.length).toBe(events + 1);
		expect(calls.wakes).toBe(2);
		expect(calls.offers).toBe(2);
		expect(mailByKey(key)).toMatchObject({ reply: "needs", msg: expect.any(String) });
		expect(mailByKey(key)!.sentAt).toBeUndefined();
		expect(mailByKey(key)!.dir).toBeUndefined();
		expect(mailCard(mailByKey(key)!)).toMatchObject({ reply: "needs" });
		expect(unreadOf(mailTarget(key))).toBe(1);
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(true);
		// The same list again: the same message is not a new one.
		await pass([kim(id, 3, "")], [], deps, true);
		expect(calls.wakes).toBe(2);
		expect(calls.offers).toBe(2);
		// He answers again.
		await pass([], [owner(id, 4)], deps);
		expect(mailByKey(key)).toMatchObject({ reply: "replied" });
		expect(calls.wakes).toBe(2);
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(false);
	});

	test("the owner's old reply in the sent folder does not close the thread again after the other side answered", async () => {
		const { deps } = fakes();
		await pass([], [], deps);
		const id = uid("old");
		const key = `zele-${id}`;
		await pass([kim(id, 1)], [], deps);
		await pass([], [owner(id, 2)], deps);
		await pass([kim(id, 3)], [], deps);
		await pass([kim(id, 3)], [owner(id, 2)], deps);
		expect(mailByKey(key)!.reply).toBeUndefined();
	});

	test("답장 안 함 and 답장 불필요 (fyi) are reopened by a newer incoming message", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const a = uid("skip");
		const b = uid("fyi");
		await pass([kim(a, 1), kim(b, 1)], [], deps);
		setMailNoReply(`zele-${a}`, true);
		setMailFyi(`zele-${b}`, true);
		expect([mailByKey(`zele-${a}`)!.reply, mailByKey(`zele-${b}`)!.reply]).toEqual(["skipped", "fyi"]);
		const events = calls.events.length;
		const seen = await pass([kim(a, 2, ""), kim(b, 2)], [], deps, true);
		expect(seen.mail.sort()).toEqual([a, b].sort());
		expect(calls.events.length).toBe(events + 2);
		expect([mailByKey(`zele-${a}`)!.reply, mailByKey(`zele-${b}`)!.reply]).toEqual(["needs", "needs"]);
	});

	test("a mail without a reply need comes back as a plain new mail", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const id = uid("plain");
		const key = `zele-${id}`;
		await pass([kim(id, 1)], [], deps);
		setMailReply(key, "sent");
		await pass([kim(id, 2)], [], deps);
		expect(calls.wakes).toBe(2);
		expect(mailByKey(key)!.reply).toBeUndefined();
		expect(mailCard(mailByKey(key)!)).not.toHaveProperty("reply");
	});

	test("the same message seen twice (twice in the list, in two passes, or posted twice) is one wake", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const id = uid("twice");
		const key = `zele-${id}`;
		await pass([kim(id, 1)], [], deps, true);
		await pass([kim(id, 2), kim(id, 2)], [], deps, true);
		await pass([kim(id, 2)], [], deps, true);
		expect(calls.wakes).toBe(2);
		expect(calls.offers).toBe(2);
		const post = { source: "zele", id, messageId: mailByKey(key)!.msg, subject: "일정 공유", from: KIM, wake: true };
		expect((await postMail(post, deps)).duplicate).toBe(true);
		expect(calls.wakes).toBe(2);
		expect((await postMail({ ...post, messageId: "another" }, deps)).duplicate).toBeUndefined();
		expect(calls.wakes).toBe(3);
	});

	test("a thread never seen before that is already read is not new mail; a known one is seen even when read", async () => {
		const { deps, calls } = fakes();
		await pass([], [], deps);
		const id = uid("readfirst");
		await pass([kim(id, 1, "")], [], deps);
		expect(calls.wakes).toBe(0);
		await pass([kim(id, 2, "")], [], deps);
		expect(calls.wakes).toBe(1);
	});

	test("a reply draft sent before the thread was reopened does not make the new message 답장함", async () => {
		const { deps } = fakes();
		await pass([], [], deps);
		const id = uid("dr");
		const key = `zele-${id}`;
		await pass([kim(id, 1)], [], deps);
		const before = new Date(0).toISOString();
		await pass([kim(id, 2)], [], deps);
		const after = new Date(clock + 3_600_000).toISOString();
		expect([...sentReplyRefs([{ ref: key, status: "sent", created: before }])]).toEqual([]);
		expect([...sentReplyRefs([{ ref: key, status: "sent", created: after }])]).toEqual([key]);
	});
});

describe("reply state", () => {
	async function incoming(extra: Record<string, unknown> = {}) {
		const { deps } = fakes();
		const id = uid("st");
		await postMail({ source: "zele", id, subject: "확인 부탁드립니다", from: "Kim <kim@example.com>", ...extra }, deps);
		return `zele-${id}`;
	}

	test("읽음 and 답장 필요 are independent: reading never clears it, sending does", async () => {
		const key = await incoming({ needsReply: true });
		expect(mailByKey(key)!.reply).toBe("needs");
		expect(unreadOf(mailTarget(key))).toBe(1);
		expect(markRead({ target: mailTarget(key), ts: new Date(clock + 3_600_000).toISOString() }).ok).toBe(true);
		expect(unreadOf(mailTarget(key))).toBe(0);
		expect(mailByKey(key)!.reply).toBe("needs");
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(true);
		setMailReply(key, "sent");
		expect(mailByKey(key)!.reply).toBe("replied");
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(false);
	});

	test("초안 있음 -> 답장함 (sent through dotz) takes the waiting draft off the mail", async () => {
		const key = await incoming();
		setMailSuggest(key, { kind: "reply-draft", label: "답장 초안", ref: "d2" });
		expect(mailCard(mailByKey(key)!)).toMatchObject({ reply: "draft", suggest: { ref: "d2" } });
		setMailReply(key, "sent");
		const card = mailCard(mailByKey(key)!);
		expect(card.reply).toBe("replied");
		expect("suggest" in card).toBe(false);
	});

	test("a draft that was sent shows 답장함 on the card even before the record is updated", async () => {
		const key = await incoming();
		setMailSuggest(key, { kind: "reply-draft", label: "답장 초안", ref: "d3" });
		expect(mailCard(mailByKey(key)!, false, true).reply).toBe("replied");
	});

	test("답장 안 함 and 답장 불필요 (fyi) close it, and taking the mark back reopens it", async () => {
		const key = await incoming({ needsReply: true });
		setMailNoReply(key, true);
		expect(mailByKey(key)!.reply).toBe("skipped");
		setMailNoReply(key, false);
		expect(mailByKey(key)!.reply).toBe("needs");
		setMailFyi(key, true);
		expect(mailByKey(key)!.reply).toBe("fyi");
		expect(unrepliedMails(new Set()).some(m => m.key === key)).toBe(false);
		setMailFyi(key, false);
		expect(mailByKey(key)!.reply).toBe("needs");
	});

	test("an answered thread stays 답장함 when a mark or a late draft arrives", async () => {
		const key = await incoming({ needsReply: true });
		setMailReply(key, "sent");
		setMailNoReply(key, true);
		setMailSuggest(key, { kind: "reply-draft", label: "답장 초안", ref: "d4" });
		expect(mailByKey(key)!.reply).toBe("replied");
	});

	test("an outgoing mail has no reply state to change", async () => {
		const { deps } = fakes();
		const id = uid("o");
		await postMail({ source: "zele", id, subject: "내가 보낸 것", from: "Owner <owner@example.com>", needsReply: true }, deps);
		const key = `zele-${id}`;
		expect(setMailReply(key, "skip")).toBe(true);
		expect(mailByKey(key)!.reply).toBeUndefined();
	});

	test("a poster that says folder 보낸편지함 or direction out gets the same treatment as the owner's address", async () => {
		const { deps, calls } = fakes();
		const a = await postMail({ source: "naver", id: uid("f"), subject: "보낸 메일", from: "Kim <kim@example.com>", folder: "보낸편지함", wake: true }, deps);
		const b = await postMail({ source: "naver", id: uid("l"), subject: "라벨", from: "Kim <kim@example.com>", labels: ["SENT"], wake: true }, deps);
		expect([a.direction, b.direction]).toEqual(["out", "out"]);
		expect(calls.events).toEqual([]);
		expect(calls.wakes + calls.offers).toBe(0);
	});
});

describe("migration of stored mails", () => {
	test("his mails turn outgoing and lose their unread, the old flags become a reply state, a thread with his reply becomes 답장함, and a second run changes nothing", () => {
		const base = { source: "zele", at: "2026-10-24T01:00:00.000Z" };
		const id = uid("mg");
		const old: MailRecord[] = [
			{ ...base, key: `zele-${id}-in`, id: `${id}-in`, subject: "계약 문의", from: "Kim <kim@example.com>", needsReply: true },
			{ ...base, key: `zele-${id}-out`, id: `${id}-out`, subject: "Re: 계약 문의", from: "Owner <owner@example.com>", to: "Kim <kim@example.com>", at: "2026-10-24T02:00:00.000Z" },
			{ ...base, key: `zele-${id}-skip`, id: `${id}-skip`, subject: "광고", from: "Shop <shop@example.com>", noReply: true },
		];
		for (const r of old) recordMail(r);
		const unreadEvent = { ts: "2030-06-01T00:00:00.000Z", kind: "mail", source: "zele", channel: mailTarget(`zele-${id}-out`), conv: mailTarget(`zele-${id}-out`), mail: `zele-${id}-out`, subject: "Re: 계약 문의", from: "Owner <owner@example.com>", text: "Owner · Re: 계약 문의" };
		emit("inbox", unreadEvent as unknown as Omit<HubEvent, "ts">);
		expect(unreadOf(mailTarget(`zele-${id}-out`))).toBe(1);

		expect(migrateStoredMails(new Set())).toBeGreaterThan(0);
		expect(mailByKey(`zele-${id}-out`)).toMatchObject({ dir: "out" });
		expect(unreadOf(mailTarget(`zele-${id}-out`))).toBe(0);
		expect(mailByKey(`zele-${id}-in`)).toMatchObject({ reply: "replied", sentAt: "2026-10-24T02:00:00.000Z" });
		expect("needsReply" in mailByKey(`zele-${id}-in`)!).toBe(false);
		expect(mailByKey(`zele-${id}-skip`)!.reply).toBe("skipped");
		const once = JSON.stringify(old.map(r => mailByKey(r.key)));
		expect(migrateStoredMails(new Set())).toBe(0);
		expect(JSON.stringify(old.map(r => mailByKey(r.key)))).toBe(once);
	});

	test("a mail whose draft was sent through dotz is 답장함", () => {
		const id = uid("sd");
		recordMail({ key: `zele-${id}`, source: "zele", id, subject: "회신 요청", from: "Lee <lee@example.com>", at: "2026-10-24T01:00:00.000Z", suggest: { kind: "reply-draft", label: "답장 초안", ref: "d9" } });
		migrateStoredMails(new Set([`zele-${id}`]));
		expect(mailByKey(`zele-${id}`)!.reply).toBe("replied");
	});
});
