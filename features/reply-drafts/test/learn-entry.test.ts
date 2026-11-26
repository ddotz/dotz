import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createReplyActions, type ReplyDeps } from "../../../hub/reply-actions.ts";
import { addressesOf, type ReplyItem } from "../../../hub/reply-draft.ts";
import { mailAdapter, replyLearning } from "../../../hub/reply-mail.ts";
import type { DraftView, Lesson, ReplyAdapter } from "../../../hub/reply-types.ts";
import { runDraft } from "../bin/draft.ts";
import { dropDraft, learningSettled, learnSentEdit, reviseDraft, type FlowDeps } from "../lib/flow.ts";
import { flipLearnt, shownLearnt } from "../lib/learn.ts";
import { HEADINGS, paths, profileBullets, toneFile } from "../lib/settings.ts";
import { addDraft, type DraftRec } from "../lib/store.ts";
import { fakeModel, j, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.toneDir(), paths.drafts(), join(env.dir, "custom", "reply-drafts", "learn-log.json")]) rmSync(p, { force: true, recursive: true });
});

const NOW = new Date("2026-11-20T00:00:00.000Z");
const A = { app: "mail", to: "a@x.com" };
const A_FILE = toneFile(A);
const CHANGE = "끝인사는 짧게 써 줘";
const REMEMBERED = /^기억했어요: ".+" · 범위: .+/;
const ONCE = "이번만 반영했어요";
const calm = (extra: Partial<FlowDeps> = {}): FlowDeps => ({ now: () => NOW, learnCall: () => async () => JSON.stringify({ replaces: [] }), ...extra });

const mailItem = (from: string): ReplyItem => ({ kind: "mail", app: "mail", from, self: ["me@example.net"], subject: "일정", text: "다음 주 일정 알려 주세요" });
const mailRec = (id: string, extra: Partial<DraftRec> = {}): DraftRec => ({ id, kind: "mail", app: "mail", source: "zele", mailId: id, ref: `k-${id}`, to: "a@x.com", subject: "Re: 일정", body: "네 확인했어요", status: "pending", created: NOW.toISOString(), changes: [], questions: [], item: mailItem("Kim <a@x.com>"), ...extra });
const revised = (said: object) => j({ action: "draft", reason: "r", to: "a@x.com", subject: "Re: 일정", body: "네 다음 주 화요일이에요", questions: [], ...said });

function tree(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else out[relative(paths.toneDir(), p)] = readFileSync(p, "utf8");
		}
	};
	walk(paths.toneDir());
	return out;
}
const logRecords = (): { ref: string }[] => {
	const file = join(env.dir, "custom", "reply-drafts", "learn-log.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
};
const toneLines = (): string[] => Object.values(tree()).flatMap(md => md.split("\n").filter(l => l.includes(CHANGE)));
const seed = (key: object, text: string) => {
	const file = toneFile(key as never);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
};

const KEYS: Lesson["keys"] = { recipient: { app: "mail", to: "a@x.com" }, channel: { app: "mail" } };
const view = (ref: string): DraftView => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "m", conv: "c", at: 1, can: { send: true, revise: true, edit: true, drop: true, restore: true }, draft: { state: "pending", toLabel: "받는이", to: "a@x.com", text: "초안" } });
const sender = { enqueue: () => false, cancel: () => "none" as const, settle: () => undefined, forget: () => false, results: () => [] };

/** The gateway's act path over an adapter whose revise gives `lesson`: the headline the redrawn card was asked with. */
async function reviseOnCard(lesson: Lesson, learning: ReplyDeps["learning"], adapter?: Partial<ReplyAdapter>, ref = "R1"): Promise<{ headline: string | undefined; item: Awaited<ReturnType<ReturnType<typeof createReplyActions>["view"]>> }> {
	const asks: (string | undefined)[] = [];
	const base: ReplyAdapter = {
		kind: "mail",
		get: async ref => view(ref),
		list: async () => [],
		target: () => undefined,
		revise: async ref => ({ ok: true, ref: `${ref}-2`, replaces: ref, lesson }),
		edit: async () => ({ ok: true }),
		drop: async () => ({ ok: true }),
		restore: async () => ({ ok: true }),
		markSent: async () => ({ ok: true }),
		ask: async (_ref, headline) => (asks.push(headline), "[ask] card"),
		question: ref => `q (${ref})`,
		...adapter,
	};
	const actions = createReplyActions({ adapters: [base], sender, recordPick: () => undefined, learning, cards: { open: () => [], replace: () => undefined, rewrite: () => undefined, repost: async () => undefined, close: () => undefined }, toBot: async () => undefined, emit: () => undefined, log: () => undefined });
	expect((await actions.act({ ref, action: "revise", change: CHANGE }, { surface: "web", login: "me" })).status).toBe(202);
	await actions.idle();
	return { headline: asks[0], item: await actions.view(`${ref}-2`) };
}

test("a revise on the card ends visibly, remembered or once, whatever the model proposed or failed to", async () => {
	const learning = replyLearning(() => calm());
	for (const proposal of [{}, { once: true }, { once: false, scope: "recipient" as const }, { scope: "bogus" as never }]) {
		rmSync(paths.toneDir(), { force: true, recursive: true });
		const { headline, item } = await reviseOnCard({ keys: KEYS, words: CHANGE, proposal }, learning);
		expect(headline).toMatch(proposal.once === true ? /^고친 초안이에요\. 이번만 반영했어요$/ : /^고친 초안이에요\. 기억했어요: /);
		expect(item?.draft.learned).toMatchObject({ state: proposal.once === true ? "once" : "remembered" });
	}
});

test("a revise through flow.ts reviseDraft says the same line, for a model that proposes once and for one that proposes nothing", async () => {
	addDraft(mailRec("RV1"));
	const once = await reviseDraft("RV1", CHANGE, calm({ call: fakeModel([revised({ once: true })]).call }));
	expect(once.text).toContain(ONCE);
	expect(toneLines()).toEqual([]);
	addDraft(mailRec("RV2", { ref: "k-RV2b", mailId: "RV2b" }));
	const none = await reviseDraft("RV2", CHANGE, calm({ call: fakeModel([revised({})]).call }));
	expect(none.text).toMatch(/기억했어요: ".*끝인사는 짧게 써 줘" · 범위: 이 앱/);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2026-11-20: 끝인사는 짧게 써 줘"]);
});

test("a sent draft the owner edited ends remembered with the lesson, once with none, and once when the model throws", async () => {
	const sent = (id: string) => addDraft(mailRec(id, { status: "sent", editedFrom: "원문 문장", body: "고친 문장", sentAt: NOW.toISOString() }));
	sent("ED1");
	await learnSentEdit("ED1", calm({ learnCall: () => async () => JSON.stringify({ lesson: CHANGE, everywhere: false }) }));
	expect(shownLearnt("ED1")).toMatchObject({ state: "remembered", scope: "channel" });
	expect(shownLearnt("ED1")?.text).toMatch(REMEMBERED);
	sent("ED2");
	await learnSentEdit("ED2", calm({ learnCall: () => async () => JSON.stringify({ lesson: "", everywhere: false }) }));
	expect(shownLearnt("ED2")).toMatchObject({ state: "once", text: ONCE });
	sent("ED3");
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	await learnSentEdit("ED3", calm({ learnCall: () => async () => Promise.reject(new Error("model down")) }));
	log.mockRestore();
	expect(shownLearnt("ED3")).toMatchObject({ state: "once", text: ONCE });
});

test("a reason for not sending ends remembered at the channel, also when the model proposal fails; a model that proposes once makes it once", async () => {
	addDraft(mailRec("DR1"));
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	dropDraft("DR1", { reason: "너무 길어요", deps: calm({ learnCall: () => async () => Promise.reject(new Error("model down")) }) });
	await learningSettled();
	log.mockRestore();
	expect(shownLearnt("DR1")).toMatchObject({ state: "remembered", scope: "channel" });
	expect(shownLearnt("DR1")?.text).toMatch(/^기억했어요: "너무 길어요" · 범위: 이 앱/);
	addDraft(mailRec("DR2", { ref: "k-DR2", mailId: "DR2" }));
	dropDraft("DR2", { reason: "이 메일만 보류", deps: calm({ learnCall: () => async () => JSON.stringify({ once: true, scope: "channel" }) }) });
	await learningSettled();
	expect(shownLearnt("DR2")).toMatchObject({ state: "once", text: ONCE });
});

test("a chat request for a draft is remembered at the draft's own channel, no app or room picked by the session", async () => {
	addDraft(mailRec("CH1"));
	const out = await runDraft(["correct", "--draft", "CH1", "--change", CHANGE], "", calm());
	expect(out.code).toBe(0);
	expect(out.lines.join("\n")).toMatch(/기억했어요: ".*" · 범위: 이 앱/);
	expect(shownLearnt("CH1")).toMatchObject({ state: "remembered", scope: "channel" });
	const wide = await runDraft(["correct", "--draft", "CH1", "--change", CHANGE, "--scope", "recipient"], "", calm());
	expect(wide.lines.join("\n")).toContain("범위: 이 받는 사람");
	expect(Object.keys(tree())).toContain(join("mail", "to", "a_0040x_002ecom.md"));
});

test("words with 앞으로, 항상 or 절대 are remembered even when the model says once", async () => {
	const learning = replyLearning(() => calm());
	for (const words of ["앞으로 짧게 써 줘", "항상 존댓말로", "이 말은 절대 쓰지 마"]) {
		const { headline } = await reviseOnCard({ keys: KEYS, words, proposal: { once: true } }, learning);
		expect(headline).toMatch(/^고친 초안이에요\. 기억했어요: /);
	}
	const plain = await reviseOnCard({ keys: KEYS, words: "이번 메일만 짧게", proposal: { once: true } }, learning);
	expect(plain.headline).toContain(ONCE);
});

test("a scope flip moves the line to the other tone file and back byte for byte; once removes it; keep puts it back", async () => {
	const kept = "## 고친 점\n\n- 2030-03-01: 예전에 고친 점\n";
	seed({ app: "mail" }, kept);
	seed(A, kept);
	const learning = replyLearning(() => calm());
	await reviseOnCard({ keys: KEYS, words: CHANGE, proposal: { scope: "channel" } }, learning);
	const ref = "R1-2";
	const atChannel = tree();
	expect(atChannel["mail.md"]).toContain(CHANGE);
	expect(atChannel[join("mail", "to", "a_0040x_002ecom.md")]).toBe(kept);
	await flipLearnt(ref, { scope: "recipient" }, calm());
	expect(tree()["mail.md"]).toBe(kept);
	expect(tree()[join("mail", "to", "a_0040x_002ecom.md")]).toContain(CHANGE);
	expect(shownLearnt(ref)).toMatchObject({ state: "remembered", scope: "recipient" });
	expect(shownLearnt(ref)?.text).toContain("범위: 이 받는 사람");
	await flipLearnt(ref, { scope: "channel" }, calm());
	expect(tree()).toEqual(atChannel);
	await flipLearnt(ref, { once: true }, calm());
	expect(tree()).toEqual({ "mail.md": kept, [join("mail", "to", "a_0040x_002ecom.md")]: kept });
	expect(shownLearnt(ref)).toMatchObject({ state: "once", text: ONCE });
	await flipLearnt(ref, { keep: true }, calm());
	expect(tree()).toEqual(atChannel);
	expect(shownLearnt(ref)?.scopes).toEqual(["recipient", "channel", "everywhere"]);
});

test("once puts back the lines the curation replaced, from the journal", async () => {
	seed({ app: "mail" }, "## 고친 점\n\n- 2030-03-01: 끝인사는 길게\n");
	const learning = replyLearning(() => calm({ learnCall: () => async () => JSON.stringify({ replaces: [{ id: "C1", why: "overridden" }] }) }));
	await reviseOnCard({ keys: KEYS, words: CHANGE, proposal: { scope: "channel" } }, learning);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).not.toContain("2030-03-01: 끝인사는 길게");
	expect(profileBullets({ app: "mail" }, HEADINGS.merged)).toEqual([`2030-03-01: 끝인사는 길게 → 2026-11-20: ${CHANGE}`]);
	await flipLearnt("R1-2", { once: true }, calm());
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-01: 끝인사는 길게"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.merged)).toEqual([]);
});

test("a mail revise and a comment reply revise are learned exactly once, one log record and one tone line", async () => {
	const learning = replyLearning(() => calm());
	addDraft(mailRec("EX1"));
	const model = fakeModel([revised({ scope: "channel" })]);
	const mail = mailAdapter(() => calm({ call: model.call }));
	await reviseOnCard({ keys: KEYS, words: CHANGE, proposal: {} }, learning, mail, "EX1");
	expect(logRecords()).toHaveLength(1);
	expect(toneLines()).toHaveLength(1);
	rmSync(paths.toneDir(), { force: true, recursive: true });
	rmSync(join(env.dir, "custom", "reply-drafts", "learn-log.json"), { force: true });
	for (const part of ["reply", "mail"] as const) {
		await reviseOnCard({ keys: { channel: { app: "youtube" } }, words: CHANGE, proposal: {} }, learning, { revise: async ref => ({ ok: true, ref: `${ref}-2`, replaces: ref, lesson: { keys: { channel: { app: "youtube" } }, words: `${CHANGE} ${part}`, proposal: {} } }) });
	}
	expect(logRecords()).toHaveLength(2);
	expect(toneLines()).toHaveLength(2);
	expect(addressesOf("a@x.com")).toEqual(["a@x.com"]);
});
