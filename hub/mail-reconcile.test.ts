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
const A1 = "first.account@example.com";
const A2 = "second.account@school.example";

// `zele mail read` output: a header, then one block per message split by a line of ─.
const thread = (...messages: [from: string, date: string][]) => ["Thread: x", ...messages.map(([from, date]) => `From: ${from}\nTo: x\nDate: ${date}\n\n본문`)].join("\n──────────\n");

type Mem = ReconcileMail & { reply?: "needs" | "draft" | "replied" };
function setup(mails: Mem[], opts: { accounts?: string[]; threads?: Record<string, string>; drafts?: string[]; owner?: string[]; pluginThreads?: Record<string, Record<string, { from: string; date: string }[]>> } = {}) {
	const reads: [string, string][] = [];
	const asked: string[] = [];
	const marked: string[] = [];
	const answered: string[] = [];
	const deps: ReconcileDeps = {
		mails: () => mails,
		draftRefs: () => new Set(opts.drafts ?? []),
		accounts: async () => opts.accounts ?? [A1, A2],
		read: async (id, account) => (reads.push([id, account]), opts.threads?.[id] ?? thread([KIM, "2026-10-30T00:00:00Z"])),
		own: accounts => new Set([ME, ...accounts]),
		ownOf: () => new Set(opts.owner ?? [ME]),
		pluginThread: async m => (asked.push(m.id), opts.pluginThreads?.[m.source]?.[m.id]),
		markReplied: (key) => {
			const m = mails.find(x => x.key === key);
			if (!m) return false;
			m.reply = "replied";
			marked.push(key);
			return true;
		},
		answerDrafts: key => (answered.push(key), []),
	};
	return { deps, reads, marked, answered, asked };
}
const mail = (id: string, over: Partial<Mem> = {}): Mem => ({ key: `zele-${id}`, source: "zele", id, at: "2026-10-30T01:00:00.000Z", account: A1, reply: "needs", ...over });
const pluginMail = (id: string, over: Partial<Mem> = {}): Mem => mail(id, { key: `work-${id}`, source: "work", account: undefined, ...over });
const gmailReply = thread([KIM, "2026-10-30T00:59:00Z"], [`Me <${ME}>`, "2026-10-30T05:00:00Z"]);

beforeEach(resetReconcile);

describe("reconcile", () => {
	test("a mail answered from Gmail becomes replied; the second run changes nothing and reads nothing", async () => {
		const mails = [mail("T1")];
		const s = setup(mails, { threads: { T1: gmailReply } });
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 1, replied: 1, notChecked: 0, skipped: 0 });
		expect(mails[0]!.reply).toBe("replied");
		expect(s.answered).toEqual(["zele-T1"]);
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 0, skipped: 0 });
		expect(s.reads).toEqual([["T1", A1]]);
	});

	test("zele is asked with the mail's own account, never without one", async () => {
		const s = setup([mail("T1", { account: A2 }), mail("T2", { account: A1 })]);
		await reconcileMails(s.deps, { limit: 10 });
		expect(s.reads.map(r => r[1]).sort()).toEqual([A1, A2]);
	});

	test("a mail with no recorded account uses the install's only account; with several accounts it is not guessed", async () => {
		const one = setup([mail("T1", { account: undefined })], { accounts: [A1] });
		expect(await reconcileMails(one.deps, { limit: 10 })).toEqual({ checked: 1, replied: 0, notChecked: 0, skipped: 0 });
		expect(one.reads).toEqual([["T1", A1]]);
		const two = setup([mail("T2", { account: undefined })], { accounts: [A1, A2] });
		expect(await reconcileMails(two.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 1, skipped: 0 });
		expect(two.reads).toEqual([]);
	});

	test("a thread that cannot be read is counted as not checked and changes nothing", async () => {
		const s = setup([mail("T1")]);
		s.deps.read = async () => {
			throw new Error("Multiple accounts matched");
		};
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 1, skipped: 0 });
	});

	test("only an answer after the incoming message counts: someone else's message, or his reply before a newer incoming one, does not", async () => {
		const others = thread([KIM, "2026-10-30T00:59:00Z"], ["Lee <lee@example.com>", "2026-10-30T05:00:00Z"]);
		const reopened = thread([KIM, "2026-10-29T00:00:00Z"], [`Me <${ME}>`, "2026-10-29T05:00:00Z"], [KIM, "2026-10-30T00:59:00Z"]);
		const s = setup([mail("T1"), mail("T2")], { threads: { T1: others, T2: reopened } });
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 2, replied: 0, notChecked: 0, skipped: 0 });
	});

	test("a replied mail is never reopened; its waiting draft is closed without reading the thread", async () => {
		const s = setup([mail("T1", { reply: "replied" })], { drafts: ["zele-T1"] });
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 0, skipped: 0 });
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

describe("reconcile of a plugin's mail", () => {
	const answered = [{ from: KIM, date: "2026-10-30T00:59:00Z" }, { from: `Me <${ME}>`, date: "2026-10-30T05:00:00Z" }];

	test("a reply sent outside dotz is read through the plugin and closes the mail and its draft; zele is not asked and the second run reads nothing", async () => {
		const mails = [pluginMail("P1")];
		const s = setup(mails, { drafts: ["work-P1"], pluginThreads: { work: { P1: answered } } });
		s.deps.accounts = async () => {
			throw new Error("zele must not run for a plugin's mail");
		};
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 1, replied: 1, notChecked: 0, skipped: 0 });
		expect(mails[0]!.reply).toBe("replied");
		expect(s.answered).toEqual(["work-P1"]);
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 0, skipped: 0 });
		expect(s.asked).toEqual(["P1"]);
		expect(s.reads).toEqual([]);
	});

	test("a thread whose last word is not the owner's stays waiting", async () => {
		const mails = [pluginMail("P1")];
		const s = setup(mails, { pluginThreads: { work: { P1: [{ from: KIM, date: "2026-10-30T00:59:00Z" }] } } });
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 1, replied: 0, notChecked: 0, skipped: 0 });
		expect(mails[0]!.reply).toBe("needs");
	});

	test("a source no plugin reads is skipped: asked once a round, counted, and it takes no read from the zele mails behind it", async () => {
		const mails = [pluginMail("P1", { at: "2026-10-30T01:00:00.000Z" }), pluginMail("P2", { at: "2026-10-30T02:00:00.000Z" }), mail("T1", { at: "2026-10-30T03:00:00.000Z" })];
		const s = setup(mails, { threads: { T1: gmailReply } });
		expect(await reconcileMails(s.deps, { limit: 1 })).toEqual({ checked: 1, replied: 1, notChecked: 0, skipped: 2 });
		expect(s.asked).toEqual(["P1"]);
		expect(s.reads).toEqual([["T1", A1]]);
	});

	test("skipped mails alone never start zele", async () => {
		const s = setup([pluginMail("P1")]);
		let zele = 0;
		s.deps.accounts = async () => (zele++, []);
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 0, skipped: 1 });
		expect(zele).toBe(0);
	});

	test("a plugin that fails, or no address known as the owner's, is not checked and changes nothing", async () => {
		const failing = setup([pluginMail("P1")]);
		failing.deps.pluginThread = async () => {
			throw new Error("mailbox down");
		};
		expect(await reconcileMails(failing.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 1, skipped: 0 });
		const mails = [pluginMail("P1")];
		const nobody = setup(mails, { owner: [], pluginThreads: { work: { P1: answered } } });
		expect(await reconcileMails(nobody.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 1, skipped: 0 });
		expect(mails[0]!.reply).toBe("needs");
	});

	test("a replied mail's waiting draft is closed for a plugin's source too, without asking the plugin", async () => {
		const s = setup([pluginMail("P1", { reply: "replied" })], { drafts: ["work-P1"] });
		await reconcileMails(s.deps, { limit: 10 });
		expect(s.answered).toEqual(["work-P1"]);
		expect(s.asked).toEqual([]);
	});

	test("a mailbox that fails or answers nonsense costs one question a round; the mail it failed on goes last next round", async () => {
		const mails = [pluginMail("P1", { at: "2026-10-30T01:00:00.000Z" }), pluginMail("P2", { at: "2026-10-30T02:00:00.000Z" })];
		const s = setup(mails);
		const asked: string[] = [];
		s.deps.pluginThread = async m => {
			asked.push(m.id);
			if (m.id === "P1") return "not a thread" as unknown as [];
			return answered;
		};
		expect(await reconcileMails(s.deps, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 2, skipped: 0 });
		expect(asked).toEqual(["P1"]);
		expect(await reconcileMails(s.deps, { limit: 10 })).toMatchObject({ checked: 1, replied: 1 });
		expect(asked).toEqual(["P1", "P2", "P1"]);
	});

	test("the limit counts plugin reads too", async () => {
		const threads = { P1: answered, P2: answered, P3: answered };
		const s = setup([pluginMail("P1"), pluginMail("P2"), pluginMail("P3")], { pluginThreads: { work: threads } });
		expect(await reconcileMails(s.deps, { limit: 2 })).toMatchObject({ checked: 2 });
		expect(s.asked).toHaveLength(2);
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
			ownOf: () => new Set(),
			pluginThread: async () => undefined,
			markReplied: (k, at) => setMailReply(k, "sent", at),
			answerDrafts,
		};
		expect(await reconcileMails(real, { limit: 10 })).toEqual({ checked: 1, replied: 1, notChecked: 0, skipped: 0 });
		expect(read).toEqual([`${id} ${A1}`]);
		expect(mailByKey(key)!.reply).toBe("replied");
		expect(getDraft("RAAAAAAA")!.status).toBe("answered");
		const facts = { drafts: listDrafts, record: mailByKey };
		expect(mailDraftHandled("RAAAAAAA", facts)).toBe(true);
		const before = JSON.stringify(mailByKey(key));
		expect(await reconcileMails(real, { limit: 10 })).toEqual({ checked: 0, replied: 0, notChecked: 0, skipped: 0 });
		expect(JSON.stringify(mailByKey(key))).toBe(before);
	});
});

describe("POST /api/mail/reconcile", () => {
	const post = (route: ReturnType<typeof makeRoute>, q = "", auth = true) => route(new Request(`http://hub.test/api/mail/reconcile${q}`, { method: "POST", headers: auth ? { "x-dotz-token": HUB_TOKEN } : {} }));

	test("runs one round with the asked limit (clamped) and answers its counts; owner token only", async () => {
		const limits: number[] = [];
		const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailReconcile: async limit => (limits.push(limit), { checked: 2, replied: 1, notChecked: 1, skipped: 0 }) });
		const res = await post(route, "?limit=9999");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ checked: 2, replied: 1, notChecked: 1, skipped: 0 });
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
