// Mail reconcile (hub/mail-reconcile.ts): a mail that waits and was answered outside dotz becomes 답장함 and its drafts close; zele is never really called.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mailDraftHandled } from "./draft-handled.ts";
import { createReconciler, reconcileMails, resetReconcile, type ReconcileDeps, type ReconcileMail } from "./mail-reconcile.ts";
import { resetOwnAddresses, setOwnAddresses } from "./mail-state.ts";
import { mailByKey, postMail, setMailReply, type MailDeps } from "./mail.ts";
import { HUB_TOKEN } from "./config.ts";
import { makeRoute } from "./routes.ts";
import { addDraft, answerDrafts, getDraft, listDrafts, type DraftRec } from "../features/reply-drafts/lib/store.ts";

const ME = "me@example.com";
const KIM = "Kim <kim@example.com>";
const A1 = "ddotz";
const A2 = "sara1468@snu.ac.kr";

// `zele mail read` output: a header, then one block per message split by a line of ─.
const thread = (...messages: [from: string, date: string][]) => ["Thread: x", ...messages.map(([from, date]) => `From: ${from}\nTo: x\nDate: ${date}\n\n본문`)].join("\n──────────\n");

type Mem = ReconcileMail & { reply?: "needs" | "draft" | "replied" };
function setup(mails: Mem[], opts: { accounts?: string[]; threads?: Record<string, string>; drafts?: string[] } = {}) {
	const reads: [string, string][] = [];
	const marked: string[] = [];
	const answered: string[] = [];
	const deps: ReconcileDeps = {
		mails: () => mails,
		draftRefs: () => new Set(opts.drafts ?? []),
		accounts: async () => opts.accounts ?? [A1, A2],
		read: async (id, account) => (reads.push([id, account]), opts.threads?.[id] ?? thread([KIM, "2026-10-30T00:00:00Z"])),
		own: accounts => new Set([ME, ...accounts]),
		markReplied: (key) => {
			const m = mails.find(x => x.key === key);
			if (!m) return false;
			m.reply = "replied";
			marked.push(key);
			return true;
		},
		answerDrafts: key => (answered.push(key), []),
	};
	return { deps, reads, marked, answered };
}
const mail = (id: string, over: Partial<Mem> = {}): Mem => ({ key: `zele-${id}`, source: "zele", id, at: "2026-10-30T01:00:00.000Z", account: A1, reply: "needs", ...over });
const gmailReply = thread([KIM, "2026-10-30T00:59:00Z"], [`Me <${ME}>`, "2026-10-30T05:00:00Z"]);

beforeEach(resetReconcile);

describe("reconcile", () => {
	test("a mail answered from Gmail becomes replied; the second run changes nothing and reads nothing", async () => {
		const mails = [mail("T1")];
		const s = setup(mails, { threads: { T1: gmailReply } });
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 1, replied: 1, notChecked: 0 });
		expect(mails[0]!.reply).toBe("replied");
		expect(s.answered).toEqual(["zele-T1"]);
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 0 });
		expect(s.reads).toEqual([["T1", A1]]);
	});

	test("zele is asked with the mail's own account, never without one", async () => {
		const s = setup([mail("T1", { account: A2 }), mail("T2", { account: A1 })]);
		await reconcileMails(s.deps, { limit: 10 });
		expect(s.reads.map(r => r[1]).sort()).toEqual([A1, A2]);
	});

	test("a mail with no recorded account uses the install's only account; with several accounts it is not guessed", async () => {
		const one = setup([mail("T1", { account: undefined })], { accounts: [A1] });
		expect(await reconcileMails(one.deps, { limit: 10 })).toEqual({ checked: 1, replied: 0, notChecked: 0 });
		expect(one.reads).toEqual([["T1", A1]]);
		const two = setup([mail("T2", { account: undefined })], { accounts: [A1, A2] });
		expect(await reconcileMails(two.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 1 });
		expect(two.reads).toEqual([]);
	});

	test("a thread that cannot be read is counted as not checked and changes nothing", async () => {
		const s = setup([mail("T1")]);
		s.deps.read = async () => {
			throw new Error("Multiple accounts matched");
		};
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 1 });
	});

	test("only an answer after the incoming message counts: someone else's message, or his reply before a newer incoming one, does not", async () => {
		const others = thread([KIM, "2026-10-30T00:59:00Z"], ["Lee <lee@example.com>", "2026-10-30T05:00:00Z"]);
		const reopened = thread([KIM, "2026-10-29T00:00:00Z"], [`Me <${ME}>`, "2026-10-29T05:00:00Z"], [KIM, "2026-10-30T00:59:00Z"]);
		const s = setup([mail("T1"), mail("T2")], { threads: { T1: others, T2: reopened } });
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 2, replied: 0, notChecked: 0 });
	});

	test("a replied mail is never reopened; its waiting draft is closed without reading the thread", async () => {
		const s = setup([mail("T1", { reply: "replied" })], { drafts: ["zele-T1"] });
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 0 });
		expect(s.answered).toEqual(["zele-T1"]);
		expect(s.reads).toEqual([]);
	});

	test("a mail whose reply draft waits is checked even when its state is not 답장 필요", async () => {
		const s = setup([mail("T1", { reply: undefined })], { drafts: ["zele-T1"], threads: { T1: gmailReply } });
		expect(await reconcileMails(s.deps, { limit: 10 })).toMatchObject({ replied: 1 });
	});

	test("at most `limit` threads per round, the ones looked at longest ago first, so every waiting mail is reached", async () => {
		const mails = [mail("T1", { at: "2026-10-30T01:00:00.000Z" }), mail("T2", { at: "2026-10-30T02:00:00.000Z" }), mail("T3", { at: "2026-10-30T03:00:00.000Z" })];
		const s = setup(mails);
		await reconcileMails(s.deps, { limit: 2 });
		await reconcileMails(s.deps, { limit: 2 });
		expect(s.reads.map(r => r[0])).toEqual(["T1", "T2", "T3", "T1"]);
	});

	test("the timer round runs at most once per interval and never beside another round", async () => {
		const s = setup([mail("T1")]);
		const rec = createReconciler(s.deps, { perRun: 5, everyMs: 600_000 });
		expect(await rec.tick(1_000_000)).toMatchObject({ checked: 1 });
		expect(await rec.tick(1_000_000 + 599_000)).toBeUndefined();
		expect(await rec.tick(1_000_000 + 600_000)).toMatchObject({ checked: 1 });
	});
});

describe("with the real stores", () => {
	const deps: MailDeps = { createThread: async () => ({ id: "1" }), send: async () => {}, mailChannel: async () => undefined, discordOn: false, emit: () => {}, wake: () => {} };
	beforeEach(() => setOwnAddresses("zele", [ME]));
	afterEach(() => resetOwnAddresses());

	test("an incoming mail answered from Gmail: replied, its pending draft is answered, its card is handled; again = same", async () => {
		const id = `rc${Date.now().toString(36)}`;
		const { key } = await postMail({ source: "zele", id, account: A1, subject: "견적 요청", from: KIM, to: ME, body: "견적서 보내 주세요", needsReply: true }, deps);
		expect(mailByKey(key)!.reply).toBe("needs");
		const rec: DraftRec = { id: "RAAAAAAA", kind: "mail", app: "mail", source: "zele", mailId: id, ref: key, to: "kim@example.com", subject: "Re: 견적 요청", body: "확인했습니다.", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: KIM, self: [ME], subject: "견적 요청", text: "견적서 보내 주세요" } };
		addDraft(rec);
		const read: string[] = [];
		const real: ReconcileDeps = {
			mails: () => [mailByKey(key)!],
			draftRefs: () => new Set(listDrafts().filter(d => d.status === "pending").map(d => d.ref)),
			accounts: async () => [A1, A2],
			read: async (threadId, account) => (read.push(`${threadId} ${account}`), thread([KIM, new Date(Date.parse(mailByKey(key)!.at) - 60_000).toISOString()], [`Me <${ME}>`, new Date(Date.now() + 60_000).toISOString()])),
			own: accounts => new Set([ME, ...accounts]),
			markReplied: (k, at) => setMailReply(k, "sent", at),
			answerDrafts,
		};
		expect(await reconcileMails(real, { limit: 10 })).toEqual({ checked: 1, replied: 1, notChecked: 0 });
		expect(read).toEqual([`${id} ${A1}`]);
		expect(mailByKey(key)!.reply).toBe("replied");
		expect(getDraft("RAAAAAAA")!.status).toBe("answered");
		const facts = { drafts: listDrafts, record: mailByKey };
		expect(mailDraftHandled("RAAAAAAA", facts)).toBe(true);
		const before = JSON.stringify(mailByKey(key));
		expect(await reconcileMails(real, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 0 });
		expect(JSON.stringify(mailByKey(key))).toBe(before);
	});
});

describe("POST /api/mail/reconcile", () => {
	const post = (route: ReturnType<typeof makeRoute>, q = "", auth = true) => route(new Request(`http://hub.test/api/mail/reconcile${q}`, { method: "POST", headers: auth ? { "x-dotz-token": HUB_TOKEN } : {} }));

	test("runs one round with the asked limit (clamped) and answers its counts; owner token only", async () => {
		const limits: number[] = [];
		const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailReconcile: async limit => (limits.push(limit), { checked: 2, replied: 1, notChecked: 1 }) });
		const res = await post(route, "?limit=9999");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ checked: 2, replied: 1, notChecked: 1 });
		await post(route);
		expect(limits).toEqual([500, 200]);
		expect((await post(route, "", false)).status).toBe(403);
		expect(limits).toHaveLength(2);
	});

	test("without mail wired in the process it says so", async () => {
		const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
		expect((await post(route)).status).toBe(503);
	});
});
