import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commentAdapter } from "../../../hub/comments/reply-adapter.ts";
import type { CommentAdapter, RawComment, SourceConfig } from "../../../hub/comments/contract.ts";
import { createEngine } from "../../../hub/comments/engine.ts";
import { realMailLink } from "../../../hub/comments/mail-link.ts";
import { kakaoAdapter } from "../../../hub/kakao/reply-adapter.ts";
import { createDraft } from "../../../hub/kakao/send.ts";
import { kakaoPaths } from "../../../hub/kakao/types.ts";
import { createReplyActions, type ReplyDeps } from "../../../hub/reply-actions.ts";
import { addressesOf, type ReplyItem } from "../../../hub/reply-draft.ts";
import { mailAdapter, replyLearning } from "../../../hub/reply-mail.ts";
import type { DraftView, Lesson, ReplyAdapter } from "../../../hub/reply-types.ts";
import { runDraft } from "../bin/draft.ts";
import { dropDraft, learningSettled, learnSentEdit, reviseDraft, type FlowDeps } from "../lib/flow.ts";
import { compactCorrections } from "../lib/compact.ts";
import { flipLearnt, learn, shownLearnt } from "../lib/learn.ts";
import { type LedgerRecord, readLedger, scopeOfKey, setState } from "../lib/ledger.ts";
import { HEADINGS, paths, profileBullets, type ToneKey } from "../lib/settings.ts";
import { addDraft, type DraftRec } from "../lib/store.ts";
import { fakeModel, j, seedRules, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.toneDir(), paths.ledger(), paths.drafts(), join(env.dir, "custom", "reply-drafts", "learn-log.json")]) rmSync(p, { force: true, recursive: true });
});

const NOW = new Date("2026-11-20T00:00:00.000Z");
const A = { app: "mail", to: "a@x.com" };
const CHANGE = "끝인사는 짧게 써 줘";
const REMEMBERED = /^기억했어요: ".+" · 범위: .+/;
const ONCE = "이번만 반영했어요";
const calm = (extra: Partial<FlowDeps> = {}): FlowDeps => ({ now: () => NOW, learnCall: () => async () => JSON.stringify({ replaces: [] }), ...extra });

const mailItem = (from: string): ReplyItem => ({ kind: "mail", app: "mail", from, self: ["me@example.net"], subject: "일정", text: "다음 주 일정 알려 주세요" });
const mailRec = (id: string, extra: Partial<DraftRec> = {}): DraftRec => ({ id, kind: "mail", app: "mail", source: "zele", mailId: id, ref: `k-${id}`, to: "a@x.com", subject: "Re: 일정", body: "네 확인했어요", status: "pending", created: NOW.toISOString(), changes: [], questions: [], item: mailItem("Kim <a@x.com>"), ...extra });
const revised = (said: object) => j({ action: "draft", reason: "r", to: "a@x.com", subject: "Re: 일정", body: "네 다음 주 화요일이에요", questions: [], ...said });

const onRecords = (): LedgerRecord[] => readLedger().filter(r => r.state === "on");
/** The ledger as the lessons leave it, apart from record ids and their order: one JSON line per record that is on. */
const onState = (): string[] => onRecords().map(({ kind, text, scope }) => JSON.stringify({ kind, text, scope })).sort();
/** What a profile holds at its own scope, per section. */
const linesOf = (key: ToneKey | "install") => ({ rules: profileBullets(key, HEADINGS.rules), corrections: profileBullets(key, HEADINGS.corrections), forbidden: profileBullets(key, HEADINGS.forbidden) });
const logRecords = (): { ref: string }[] => {
	const file = join(env.dir, "custom", "reply-drafts", "learn-log.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
};
const toneLines = (): string[] => onRecords().filter(r => r.text.includes(CHANGE)).map(r => r.text);

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
	expect(onRecords().filter(r => r.text.includes(CHANGE)).map(r => r.scope)).toEqual([{ app: "mail" }, { app: "mail", to: scopeOfKey(A).to }]);
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
	const kept = "2030-03-01: 예전에 고친 점", dated = `2026-11-20: ${CHANGE}`;
	seedRules({ app: "mail" }, { correction: [kept] });
	seedRules(A, { correction: [kept] });
	const snapshot = () => ({ channel: linesOf({ app: "mail" }).corrections, recipient: linesOf(A).corrections });
	const learning = replyLearning(() => calm());
	await reviseOnCard({ keys: KEYS, words: CHANGE, proposal: { scope: "channel" } }, learning);
	const ref = "R1-2";
	const atChannel = snapshot();
	expect(atChannel).toEqual({ channel: [kept, dated], recipient: [kept] });
	await flipLearnt(ref, { scope: "recipient" }, calm());
	expect(snapshot()).toEqual({ channel: [kept], recipient: [kept, dated] });
	expect(shownLearnt(ref)).toMatchObject({ state: "remembered", scope: "recipient" });
	expect(shownLearnt(ref)?.text).toContain("범위: 이 받는 사람");
	await flipLearnt(ref, { scope: "channel" }, calm());
	expect(snapshot()).toEqual(atChannel);
	await flipLearnt(ref, { once: true }, calm());
	expect(snapshot()).toEqual({ channel: [kept], recipient: [kept] });
	expect(shownLearnt(ref)).toMatchObject({ state: "once", text: ONCE });
	await flipLearnt(ref, { keep: true }, calm());
	expect(snapshot()).toEqual(atChannel);
	expect(shownLearnt(ref)?.scopes).toEqual(["recipient", "channel", "everywhere"]);
});

test("a line flipped to everywhere and back comes back as the kind the owner asked for, every tone file byte for byte", async () => {
	const learning = replyLearning(() => calm());
	for (const [scope, kind] of [["channel", undefined], ["recipient", undefined], ["channel", "rule"]] as const) {
		rmSync(paths.ledger(), { force: true });
		for (const key of [{ app: "mail" }, A]) seedRules(key, { tone: ["예전 규칙"], correction: ["2030-03-01: 예전에 고친 점"] });
		const ref = `K-${scope}-${kind ?? "correction"}`;
		await learning.learn({ source: "chat", ref, keys: KEYS, words: CHANGE, proposal: { scope, ...(kind ? { kind } : {}) } });
		const first = onState();
		expect(onRecords().filter(r => r.text.includes(CHANGE))).toMatchObject([{ kind: kind ? "tone" : "correction" }]);
		await flipLearnt(ref, { scope: "everywhere" }, calm());
		expect(profileBullets("install", HEADINGS.rules)).toEqual([CHANGE]);
		await flipLearnt(ref, { scope }, calm());
		expect(onState()).toEqual(first);
		expect(profileBullets("install", HEADINGS.rules)).toEqual([]);
	}
});

test("once puts back the lines the curation replaced, from the journal", async () => {
	const [old] = seedRules({ app: "mail" }, { correction: ["2030-03-01: 끝인사는 길게"] });
	const learning = replyLearning(() => calm({ learnCall: () => async () => JSON.stringify({ replaces: [{ id: "C1", why: "overridden" }] }) }));
	await reviseOnCard({ keys: KEYS, words: CHANGE, proposal: { scope: "channel" } }, learning);
	const newer = readLedger().find(r => r.text === `2026-11-20: ${CHANGE}`)!;
	expect(newer.state).toBe("on");
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual([newer.text]);
	expect(readLedger().find(r => r.id === old!.id)).toMatchObject({ state: "merged", into: newer.id });
	await flipLearnt("R1-2", { once: true }, calm());
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-01: 끝인사는 길게"]);
	expect(readLedger().find(r => r.id === old!.id)?.state).toBe("on");
	expect(readLedger().find(r => r.id === old!.id)?.into).toBeUndefined();
	expect(readLedger().find(r => r.id === newer.id)?.state).toBe("off");
});

/** The gateway's revise act over the real adapter `a`: the headline the redrawn card was asked with, once the learning behind it settled. */
async function reviseWith(a: ReplyAdapter, ref: string, part?: "mail"): Promise<string | undefined> {
	const asks: (string | undefined)[] = [];
	const actions = createReplyActions({ adapters: [{ ...a, ask: async (r, headline) => (asks.push(headline), a.ask(r, headline)) }], sender, recordPick: () => undefined, learning: replyLearning(() => calm()), cards: { open: () => [], replace: () => undefined, rewrite: () => undefined, repost: async () => undefined, close: () => undefined }, toBot: async () => undefined, emit: () => undefined, log: () => undefined });
	expect((await actions.act({ ref, action: "revise", change: CHANGE, ...(part ? { part } : {}) }, { surface: "web", login: "me" })).status).toBe(202);
	await actions.idle();
	await learningSettled();
	return asks[0];
}

const youtube: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const fan: RawComment = { native: "c1", thread: "p1", author: "팬", text: "다음 편 언제 올라와요?", postTitle: "Post one", at: Date.now() - 1000 };

/** A pending draft of a real comment engine (over a fake platform) and, with `withMail`, a real mail draft riding on it; every model answers with `lesson`. */
async function commentCard(lesson: object, withMail: boolean): Promise<{ adapter: ReplyAdapter; ref: string }> {
	const dir = mkdtempSync(join(env.dir, "comments-"));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube } }));
	const platform: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [fan], cursor: "1" }), reply: async () => ({ ok: true, ref: "r1" }), posts: async () => [] };
	const say = (body: string) => j({ action: "draft", reason: "asks", to: "", body, questions: [], ...lesson });
	const answers = [say("이번 주말이에요!"), say("토요일에 올라가요")];
	let n = 0;
	const engine = createEngine({ dir, now: Date.now, collector: "mac", adapters: { youtube: platform }, model: async () => ({ text: answers[Math.min(n++, 1)]! }), mail: realMailLink({ call: async () => revised({ to: "fan@example.com", ...lesson }) }), style: () => ({ rules: [], corrections: [], forbidden: [], samples: [] }) });
	await engine.collect();
	const step = await engine.makeDraft(engine.store.comments()[0]!.id);
	if (!step.ok) throw new Error(step.reason);
	if (withMail) {
		addDraft(mailRec("RMAIL01", { to: "fan@example.com", item: mailItem("fan@example.com") }));
		engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === step.draft.code)!, mail: "RMAIL01", mailAt: Date.now() });
	}
	return { adapter: commentAdapter(engine), ref: step.draft.code };
}

async function kakaoCard(once: boolean): Promise<{ adapter: ReplyAdapter; ref: string }> {
	const dir = mkdtempSync(join(env.dir, "kakao-"));
	const kp = kakaoPaths(dir, dir), runner = async () => ({ code: 0, stdout: "", stderr: "" });
	const adapter = kakaoAdapter({
		paths: kp,
		sendDeps: async () => ({ paths: kp, runner }),
		revise: async (chatId, r) => ({ ok: true as const, code: (await createDraft({ chatId, roomName: "Alex", text: "3시", basisLogId: "9", replaces: r.code }, { paths: kp, runner })).code, learned: { line: CHANGE, once, forbid: [], scope: "channel" as const } }),
	});
	return { adapter, ref: (await createDraft({ chatId: "1", roomName: "Alex", text: "내일 3시에 봐요", basisLogId: "9" }, { paths: kp, runner })).code };
}

test("a mail revise is learned exactly once, one log record and one tone line", async () => {
	addDraft(mailRec("EX1"));
	const mail = mailAdapter(() => calm({ call: fakeModel([revised({ scope: "channel" })]).call }));
	expect(await reviseWith(mail, "EX1")).toMatch(/^고친 초안이에요\. 기억했어요: /);
	expect(logRecords()).toHaveLength(1);
	expect(toneLines()).toHaveLength(1);
	expect(addressesOf("a@x.com")).toEqual(["a@x.com"]);
});

test("a comment reply revise, the mail riding on a comment card and a KakaoTalk revise, each through its real adapter, are learned exactly once and the card says remembered or once", async () => {
	for (const once of [false, true]) {
		const lesson = { once, scope: "channel" };
		const paths3: [string, () => Promise<{ adapter: ReplyAdapter; ref: string }>, "mail"?][] = [
			["comment reply", () => commentCard(lesson, false)],
			["comment mail", () => commentCard(lesson, true), "mail"],
			["kakao", () => kakaoCard(once)],
		];
		for (const [name, make, part] of paths3) {
			for (const p of [paths.toneDir(), paths.ledger(), paths.drafts(), join(env.dir, "custom", "reply-drafts", "learn-log.json")]) rmSync(p, { force: true, recursive: true });
			const { adapter, ref } = await make();
			const headline = await reviseWith(adapter, ref, part);
			expect([name, headline]).toEqual([name, expect.stringMatching(once ? /^고친 초안이에요\. 이번만 반영했어요$/ : /^고친 초안이에요\. 기억했어요: /)]);
			expect([name, logRecords().length, toneLines().length]).toEqual([name, 1, once ? 0 : 1]);
		}
	}
});

const MAIL = { channel: { app: "mail" } };
const SHAPE = { parts: [{ any: ["하루"] }, { gap: 3 }, { any: ["되세요"] }], label: "'하루 보내세요'로 쓴다", bad: ["행복한 하루 되세요"], good: [] as string[] };
const EVIDENCE = { draft: "오늘도 행복한 하루 되세요!", change: "'되세요' 말고 '좋은 하루 보내세요'로" };
const SHAPE_BULLET = `shape ${JSON.stringify({ parts: SHAPE.parts, label: SHAPE.label })}`;
const literals = (key: ToneKey | "install") => profileBullets(key, HEADINGS.forbidden).filter(b => !b.startsWith("shape "));
const learnWith = (words: string, deps: Partial<FlowDeps>, proposal: { forbid?: string[]; scope?: "everywhere" } = {}) => learn({ source: "revise", ref: "R9", keys: MAIL, words, proposal, evidence: EVIDENCE }, { now: () => NOW, ...deps });
/** A learnCall answering the line's curation and the wording pattern apart; `asked` collects what the pattern call was told. */
const answering = (curate: () => Promise<string>, pattern: () => Promise<string>, asked: string[] = []) => ({ asked, learnCall: () => (system: string, user: string) => (system.includes("style conditions") ? curate() : (asked.push(user), pattern())) });
const NO_REPLACES = async () => JSON.stringify({ replaces: [] });
const shape = (good: string[] = []) => async () => j({ ...SHAPE, good });

test("learn stores the banned wordings once in the lesson's profile and names them on the card line; the pattern is proposed with the previous draft and the change, kept with the line, its label on the line", async () => {
	const fake = answering(NO_REPLACES, shape());
	const learnt = await learnWith("끝인사는 짧게", fake, { forbid: ["되세요"] });
	expect(fake.asked).toHaveLength(1);
	expect(fake.asked[0]).toContain(EVIDENCE.draft);
	expect(fake.asked[0]).toContain(EVIDENCE.change);
	expect(literals({ app: "mail" })).toHaveLength(1);
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toContain(SHAPE_BULLET);
	expect(literals("install")).toEqual([]);
	expect(learnt.text).toContain("쓰지 않을 표현: '되세요'");
	expect(learnt.text).toContain(`표현 규칙으로도 정해 뒀어요: ${SHAPE.label}`);
});

test("learn does not store a banned word a kept pattern's good example uses as a literal, and stores any other", async () => {
	const fake = answering(NO_REPLACES, shape(["좋은 하루 보내세요"]));
	const learnt = await learnWith("끝인사는 짧게", fake, { forbid: ["되세요", "하루", "감사합니다"] });
	expect(literals({ app: "mail" }).join("|")).toContain("되세요");
	expect(literals({ app: "mail" }).join("|")).toContain("감사합니다");
	expect(literals({ app: "mail" }).join("|")).not.toContain("하루");
	expect(learnt.text).toContain("쓰지 않을 표현: '되세요', '감사합니다'");
});

test("learn with a pattern call that throws still stores the banned words and claims no pattern", async () => {
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	const learnt = await learnWith("끝인사는 짧게", answering(NO_REPLACES, () => Promise.reject(new Error("model down"))), { forbid: ["되세요"] });
	log.mockRestore();
	expect(literals({ app: "mail" })).toHaveLength(1);
	expect(learnt.text).toContain("쓰지 않을 표현: '되세요'");
	expect(learnt.text).not.toContain("표현 규칙으로도");
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).not.toContain(SHAPE_BULLET);
});

test("learn does not add a line an existing rule already says, keeps no pattern for it, and the line says so", async () => {
	seedRules("install", { tone: ["끝인사는 짧게 한다"] });
	const learnt = await learnWith("끝인사는 짧게 한다", answering(NO_REPLACES, shape()), { scope: "everywhere" });
	expect(learnt.text).toContain("이미 있는 조건이에요: 끝인사는 짧게 한다");
	expect(learnt.text).not.toContain("표현 규칙으로도");
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["끝인사는 짧게 한다"]);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
});

test("learn records the line and proposes the pattern side by side: both calls start before either answers", async () => {
	seedRules({ app: "mail" }, { correction: ["2030-03-01: 예전에 고친 점"] });
	const line = Promise.withResolvers<string>(), pattern = Promise.withResolvers<string>();
	const started = { line: Promise.withResolvers<void>(), pattern: Promise.withResolvers<void>() };
	const fake = answering(() => (started.line.resolve(), line.promise), () => (started.pattern.resolve(), pattern.promise));
	const done = learnWith("끝인사는 짧게", fake, { forbid: ["되세요"] });
	await Promise.all([started.line.promise, started.pattern.promise]);
	pattern.resolve(j(SHAPE));
	line.resolve(JSON.stringify({ replaces: [] }));
	expect((await done).text).toContain(`끝인사는 짧게" · 범위: 이 앱 · 표현 규칙으로도 정해 뒀어요: ${SHAPE.label}`);
});

test("a compaction leaves every line on before on or marked after, and marks exactly the lines no longer on", async () => {
	const before = Array.from({ length: 13 }, (_, i) => `2030-01-${String(i + 1).padStart(2, "0")}: 고친 점 ${i + 1}`);
	const [marked] = seedRules({ app: "mail" }, { correction: ["2029-12-31: 아주 옛 고친 점"] });
	setState([marked!.id], "off");
	const seeded = seedRules({ app: "mail" }, { correction: before });
	const answer = JSON.stringify({ lines: [{ text: "고친 점 1부터 6까지", sources: ["C1", "C2", "C3", "C4", "C5", "C6"] }, { text: "고친 점 7부터 12까지", sources: ["C7", "C8", "C9", "C10", "C11", "C12"] }], dropped: [{ id: "C13", why: "one-off" }] });
	expect(await compactCorrections({ app: "mail" }, { now: () => NOW, learnCall: () => async () => answer })).toMatchObject({ before: 13 });
	const on = profileBullets({ app: "mail" }, HEADINGS.corrections), ledger = readLedger();
	const now = (r: LedgerRecord) => ledger.find(x => x.id === r.id)!;
	for (const r of seeded) {
		expect(now(r).state === "on").toBe(on.includes(r.text));
		if (now(r).state === "merged") expect(ledger.find(x => x.id === now(r).into)?.state).toBe("on");
		else if (now(r).state === "off") expect(now(r).into).toBeUndefined();
	}
	const gone = seeded.filter(r => now(r).state !== "on");
	expect(gone.length).toBeGreaterThan(0);
	expect(now(marked!).state).toBe("off");
	expect(ledger.filter(r => r.kind === "correction" && r.state !== "on")).toHaveLength(1 + gone.length);
});
