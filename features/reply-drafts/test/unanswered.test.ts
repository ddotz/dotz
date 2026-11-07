import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fieldsOf, unansweredSettings, writeSettings } from "../../../hub/app-settings.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import type { MailRecord } from "../../../hub/mail.ts";
import { createUnansweredWatch } from "../../../hub/mail-unanswered.ts";
import { requestMailDraft } from "../lib/offer.ts";
import { addDraft, listDrafts, setStatus } from "../lib/store.ts";
import { enable, fakeModel, j, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
const DAY = 86_400_000;
const START = Date.parse("2030-01-10T00:00:00.000Z");
const STATE = () => join(env.dir, "mail-unanswered.json");
const ME = "me@example.net", PEER = "Kim <kim@example.com>";
const follow = { action: "draft", reason: "no answer yet", to: "kim@example.com", subject: "Re: 자료 확인 요청", body: "지난번 자료 확인 부탁드린 건, 시간 되실 때 알려 주세요.", questions: [] };

const sentMail = (over: Partial<MailRecord> = {}): MailRecord => ({ key: "zele-t1", source: "zele", id: "t1", account: ME, subject: "자료 확인 요청", from: ME, to: PEER, at: new Date(START + 1000).toISOString(), dir: "out", html: true, ...over }) as MailRecord;
const incoming = (over: Partial<MailRecord> = {}): MailRecord => ({ key: "zele-in", source: "zele", id: "t9", subject: "Re: 자료 확인 요청", from: PEER, to: ME, at: new Date(START + 2 * DAY).toISOString(), ...over }) as MailRecord;

// The real draft engine with a fake model; `sent` = the cards, `runs` = every command it ran (a send would show here).
function harness(mails: MailRecord[], over: { text?: string; noBody?: true; read?: (id: string) => Promise<string>; requestDraft?: (m: Parameters<typeof requestMailDraft>[0]) => Promise<string> } = {}) {
	let now = START;
	const sent: string[] = [], runs: string[][] = [];
	const model = fakeModel([j(follow)]);
	const run = async (argv: string[]) => (runs.push(argv), { code: 0, stdout: "", stderr: "" });
	const watch = createUnansweredWatch({
		settings: () => unansweredSettings(env.dir),
		mails: () => mails,
		body: () => (over.noBody ? undefined : over.text ?? "지난주 보낸 자료 확인 부탁드립니다. 회신 부탁드려요."),
		accounts: async () => [ME],
		read: over.read ?? (async () => `From: ${ME}\nTo: ${PEER}\nDate: 2030-01-10\n\n확인 부탁드립니다`),
		own: () => new Set([ME]),
		openDraft: key => listDrafts().findLast(d => d.ref === key && (d.status === "pending" || d.status === "held"))?.id,
		closeDraft: id => setStatus(id, "answered"),
		clearChip: () => {},
		requestDraft: over.requestDraft ?? (m => requestMailDraft(m, { send: (_t, text) => void sent.push(text), call: model.call, run, log: () => {} })),
		target: key => `mail:${key}`,
		log: () => {},
		now: () => now,
	}, { file: STATE(), everyMs: 0 });
	return { watch, sent, runs, model, at: (days: number) => (now = START + days * DAY) };
}
const turnOn = (days = 3) => writeSettings(env.dir, "mail", { unanswered_days: days });

beforeEach(() => {
	rmSync(STATE(), { force: true });
	rmSync(join(env.dir, "custom"), { recursive: true, force: true });
		enable(env);
});

describe("off by default", () => {
	test("a default install tracks nothing: no state file, no card, no model call, even for a mail that would be due", async () => {
		const mails = [sentMail()];
		const h = harness(mails);
		expect(fieldsOf("mail").find(f => f.key === "unanswered_days")?.def).toBe(0);
		await h.watch.tick();
		h.at(30);
		await h.watch.tick();
		expect(existsSync(STATE())).toBe(false);
		expect(h.sent).toEqual([]);
		expect(h.model.calls).toHaveLength(0);
		expect(listDrafts()).toEqual([]);
	});

	test("the setting belongs to one mail app", () => {
		expect(fieldsOf("mail-work").find(f => f.key === "unanswered_days")?.path).toBe("mail-work.unanswered_days");
		expect(fieldsOf("kakao").find(f => f.key === "unanswered_days")).toBeUndefined();
	});
});

describe("a sent mail with no answer", () => {
	test("makes no model call before its day, then exactly one approval card, and nothing is sent", async () => {
		turnOn();
		const h = harness([sentMail()]);
		await h.watch.tick();
		h.at(2);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(0);
		h.at(3.1);
		await h.watch.tick();
		h.at(4);
		await h.watch.tick();
		h.at(20);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(1);
		expect(h.sent).toHaveLength(1);
		expect(parseDraftApproval(h.sent[0]!)?.to).toBe("kim@example.com");
		expect(h.sent[0]).toContain("3일째");
		expect(listDrafts().map(d => [d.ref, d.status])).toEqual([["zele-t1", "pending"]]);
		expect(h.runs.filter(a => a.includes("reply") || a.includes("send"))).toEqual([]);
	});

	test("a mail sent before the setting was turned on, one that asks nothing, and one to himself are not tracked", async () => {
		turnOn();
		const mails = [sentMail({ key: "old", at: new Date(START - DAY).toISOString() }), sentMail({ key: "self", to: ME })];
		const h = harness(mails);
		await h.watch.tick();
		h.at(10);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(0);

		const plain = harness([sentMail({ key: "plain", subject: "오늘 점심" })], { text: "내일 뵙겠습니다." });
		await plain.watch.tick();
		plain.at(10);
		await plain.watch.tick();
		expect(plain.model.calls).toHaveLength(0);
	});

	test("a mail the sent-folder poll reported without its body is judged on the body the mailbox holds, read once", async () => {
		turnOn();
		let reads = 0;
		const body = (text: string) => async () => (reads++, `From: ${ME}\nTo: ${PEER}\nDate: 2030-01-10\n\n${text}`);
		const polled = { html: undefined, subject: "지난주 건", summary: "지난주 건 관련" };
		const asks = harness([sentMail(polled)], { noBody: true, read: body("검토 부탁드립니다. 회신 부탁드려요.") });
		await asks.watch.tick();
		asks.at(4);
		await asks.watch.tick();
		expect(asks.model.calls).toHaveLength(1);

		rmSync(STATE(), { force: true });
		reads = 0;
		const says = harness([sentMail({ ...polled, key: "fyi" })], { noBody: true, read: body("잘 도착했습니다.") });
		await says.watch.tick();
		says.at(4);
		await says.watch.tick();
		says.at(5);
		await says.watch.tick();
		expect(reads).toBe(1);
		expect(says.model.calls).toHaveLength(0);
	});

	test("one draft that fails is tried again, three failures end it", async () => {
		turnOn();
		let calls = 0;
		const h = harness([sentMail()], { requestDraft: async () => (calls++, "failed") });
		await h.watch.tick();
		h.at(4);
		for (let n = 0; n < 6; n++) await h.watch.tick();
		expect(calls).toBe(3);
	});
});

describe("tracking ends", () => {
	test("a reply on record before the day: no draft at all", async () => {
		turnOn();
		const mails = [sentMail()];
		const h = harness(mails);
		await h.watch.tick();
		mails.push(incoming());
		h.at(4);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(0);
		expect(h.sent).toEqual([]);
	});

	test("a reply in the real thread that dotz never posted: no draft", async () => {
		turnOn();
		const thread = `From: ${ME}\nTo: ${PEER}\nDate: 2030-01-10\n\n확인 부탁드립니다\n──────\nFrom: ${PEER}\nTo: ${ME}\nDate: 2030-01-12\n\n확인했어요`;
		const h = harness([sentMail()], { read: async () => thread });
		await h.watch.tick();
		h.at(4);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(0);
		expect(h.sent).toEqual([]);
	});

	test("a reply while the card waits closes the draft, and nothing comes back", async () => {
		turnOn();
		const mails = [sentMail()];
		const h = harness(mails);
		await h.watch.tick();
		h.at(4);
		await h.watch.tick();
		expect(listDrafts()[0]!.status).toBe("pending");
		mails.push(incoming({ at: new Date(START + 5 * DAY).toISOString() }));
		h.at(5.5);
		await h.watch.tick();
		expect(listDrafts()[0]!.status).toBe("answered");
		h.at(30);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(1);
		expect(h.sent).toHaveLength(1);
	});

	test("the answer's own reply draft under the same mail key is left alone", async () => {
		turnOn();
		const mails = [sentMail()];
		const h = harness(mails);
		await h.watch.tick();
		h.at(4);
		await h.watch.tick();
		const card = listDrafts()[0]!;
		addDraft({ ...card, id: "reply-to-answer", created: new Date(START + 5 * DAY).toISOString() });
		mails[0] = incoming({ key: "zele-t1", id: "t1", at: new Date(START + 5 * DAY).toISOString() });
		h.at(5.5);
		await h.watch.tick();
		expect(listDrafts().map(d => [d.id, d.status])).toEqual([[card.id, "stale"], ["reply-to-answer", "pending"]]);
	});

	test("a card over a reply that only the real thread shows is closed", async () => {
		turnOn();
		let answer = "";
		const h = harness([sentMail()], { read: async () => `From: ${ME}\nTo: ${PEER}\nDate: 2030-01-10\n\n확인 부탁드립니다${answer}` });
		await h.watch.tick();
		h.at(4);
		await h.watch.tick();
		answer = `\n──────\nFrom: ${PEER}\nTo: ${ME}\nDate: 2030-01-15\n\n확인했어요`;
		h.at(5);
		await h.watch.tick();
		expect(listDrafts()[0]!.status).toBe("answered");
	});

	test("open cards cost a bounded number of thread reads per round, and each gets its turn", async () => {
		turnOn();
		const mails = [1, 2, 3, 4, 5, 6, 7].map(n => sentMail({ key: `k${n}`, id: `i${n}`, subject: `확인 요청 ${n}` }));
		const seen: string[] = [];
		const h = harness(mails, { read: async () => `From: ${ME}\nTo: ${PEER}\nDate: 2030-01-10\n\n확인 부탁드립니다` });
		await h.watch.tick();
		h.at(4);
		await h.watch.tick();
		await h.watch.tick();
		const logged = harness(mails, { read: async id => (seen.push(id), `From: ${ME}\nTo: ${PEER}\nDate: 2030-01-10\n\n확인 부탁드립니다`) });
		logged.at(5);
		await logged.watch.tick();
		expect(seen.length).toBeLessThanOrEqual(5);
		await logged.watch.tick();
		expect(new Set(seen).size).toBe(7);
	});

	test("dropping the card ends it, for good even after the state ages out", async () => {
		turnOn();
		const h = harness([sentMail()]);
		await h.watch.tick();
		h.at(4);
		await h.watch.tick();
		setStatus(listDrafts()[0]!.id, "dropped");
		h.at(5);
		await h.watch.tick();
		h.at(120);
		await h.watch.tick();
		h.at(121);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(1);
	});

	test("the follow-up itself is never tracked: no loop", async () => {
		turnOn();
		const mails = [sentMail()];
		const h = harness(mails);
		await h.watch.tick();
		h.at(4);
		await h.watch.tick();
		// The sent follow-up as a mailbox reports it: a new id, the same conversation.
		mails.push(sentMail({ key: "zele-t2", id: "t2", subject: "Re: 자료 확인 요청", at: new Date(START + 4.5 * DAY).toISOString() }));
		// And as dotz records it.
		mails.push(sentMail({ key: "zele-sent-d1", id: "sent-d1", subject: "다른 확인 요청", at: new Date(START + 4.5 * DAY).toISOString() }));
		h.at(5);
		await h.watch.tick();
		h.at(30);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(1);
	});

	test("turning it off forgets the watch; turning it on again starts from then", async () => {
		turnOn();
		const h = harness([sentMail()]);
		await h.watch.tick();
		turnOn(0);
		await h.watch.tick();
		expect(existsSync(STATE())).toBe(false);
		h.at(10);
		turnOn();
		await h.watch.tick();
		h.at(30);
		await h.watch.tick();
		expect(h.model.calls).toHaveLength(0);
	});
});
