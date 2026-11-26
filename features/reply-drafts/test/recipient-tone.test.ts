import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { buildPrompt, generateReply, type ReplyItem, type ReplyStyle, styleConditions } from "../../../hub/reply-draft.ts";
import { judgePrompt } from "../../../hub/style-judge.ts";
import { type CommentAdapter, commentId, type SourceConfig } from "../../../hub/comments/contract.ts";
import { createEngine, type DraftModel } from "../../../hub/comments/engine.ts";
import { commentStyle } from "../../../hub/comments/real.ts";
import { commentsDir, createStore } from "../../../hub/comments/store.ts";
import { runDraft } from "../bin/draft.ts";
import { journalEntries, profileOf } from "../lib/curate.ts";
import { keyOfScope, readLedger, scopeOfProfile } from "../lib/ledger.ts";
import { buildDraft, draftLintFailures, editDraft, withRecipient } from "../lib/flow.ts";
import { draftRules } from "../lib/draft-rules.ts";
import { addDraft, type DraftRec } from "../lib/store.ts";
import { composeMail } from "../../../hub/mail-cli.ts";
import { HEADINGS, levelsOf, loadStyle, paths, profileBullets, recipientFile, recipientOf, toneFile } from "../lib/settings.ts";
import { fakeModel, j, seedRules, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.toneDir(), paths.ledger(), commentsDir(env.dir)]) rmSync(p, { force: true, recursive: true });
});

const day = (d: string) => () => new Date(`${d}T09:00:00Z`);
const correct = (deps: object, ...args: string[]) => runDraft(["correct", ...args], "", { now: day("2030-03-04"), ...deps });
const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);
const write = (file: string, md: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, md);
};
const learner = (reply: () => string) => {
	const asked: string[] = [];
	return { asked, learnCall: () => async (_system: string, user: string) => (asked.push(user), reply()) };
};
const draftOut = j({ action: "draft", reason: "r", to: "a@x.com", subject: "Re: 일정", body: "네 확인했어요", questions: [] });
const ITEM = { kind: "mail" as const, from: "", text: "" };
const outgoing = (app: string, to: string) => draftRules({ app }, { kind: "mail", from: to, text: "자료 부탁드려요" }).style();
const mail = (from: string): ReplyItem => ({ kind: "mail", app: "mail", from, self: ["me@example.net"], subject: "일정", text: "다음 주 일정 알려 주세요" });
const meta = { source: "zele", mailId: "m1", ref: "k1" };
const promptOf = async (item: ReplyItem): Promise<string> => {
	const model = fakeModel([draftOut]);
	await buildDraft(item, meta, { call: model.call });
	return model.calls[0]!.user;
};
const RECIPIENT_HEAD = "The user's conditions for this recipient only (he set them for the person this reply goes to; where a rule or correction above says otherwise, these win):";
const normalised = (id: string) => id.normalize("NFC").trim().toLowerCase().normalize("NFC");
const CARD_HINT = '대신 그분 댓글 카드에서 답글을 "이분께는 ..."처럼 고쳐 주세요';
const seedComments = (source: string, who: { author: string; authorId?: string }[]) =>
	createStore(commentsDir(env.dir)).addComments(who.map((w, i) => ({ id: commentId(source, `s${i}`), source, native: `s${i}`, thread: "p1", ...w, text: "잘 봤어요", postTitle: "P", at: Date.parse("2030-03-01T00:00:00Z") + i, mine: false, collector: "t" })));

test("a recipient file name decodes to the normalised id, and only [a-z0-9_-] ever appear in it", () => {
	const id = fc.oneof(fc.string({ unit: "binary", maxLength: 40 }), fc.string({ unit: "grapheme", maxLength: 30 }), fc.emailAddress(), fc.constantFrom("김 선생님", "a@b.com", "a_b.com", "A_0040B.COM", " 익명 ", "Kim.Lee+x@Example.com", "\u0041\u030a", "\u00c5"));
	fc.assert(
		fc.property(id, id => {
			const name = recipientFile(id);
			if (name === undefined) return;
			expect(name).toMatch(/^[a-z0-9_-]{1,250}$/);
			expect(recipientOf(name)).toBe(normalised(id));
		}),
		{ numRuns: 2000 },
	);
	fc.assert(
		fc.property(id, id, (a, b) => {
			const [x, y] = [recipientFile(a), recipientFile(b)];
			if (x !== undefined && y !== undefined && normalised(a) !== normalised(b)) expect(x).not.toBe(y);
		}),
		{ numRuns: 2000 },
	);
	expect(new Set(["a@b.com", "a_b.com", "a_0040b.com", "A@B.COM"].map(recipientFile)).size).toBe(3);
	expect(recipientFile("\u0041\u030a")).toBe(recipientFile("\u00e5"));
	for (const name of ["A", "a.b", "_0061", "_00e", "a_0040B", "", "_d800"]) expect([name, recipientOf(name)]).toEqual([name, name === "_d800" ? "\ud800" : undefined]);
});

test("an id that is empty, too long or a nobody value gives no level, and its key reads the app's own file", () => {
	for (const id of ["", "   ", "x".repeat(121), "익명", " 알 수 없는 사용자 ", "가".repeat(51)]) {
		expect(recipientFile(id)).toBeUndefined();
		expect(levelsOf({ app: "mail", to: id }).map(([level]) => level)).toEqual(["app", "install"]);
		expect(toneFile({ app: "mail", to: id })).toBe(toneFile({ app: "mail" }));
	}
	expect(recipientFile("x".repeat(120))).toBe("x".repeat(120));
	expect(levelsOf({ app: "mail", room: "b", to: "a@x.com", base: "mail" }).map(([level, key]) => [level, toneFile(key)])).toEqual([
		["to", join(paths.toneDir(), "mail", "to", "a_0040x_002ecom.md")],
		["room", join(paths.toneDir(), "mail", "b.md")],
		["app", join(paths.toneDir(), "mail.md")],
		["install", join(paths.toneDir(), "install.md")],
	]);
});

// The scope a profile file name stands for, read back as the tone key of that profile.
const profileKey = (profile: string) => ((scope) => (scope ? keyOfScope(scope) : undefined))(scopeOfProfile(profile));
test("a mail recipient and a comment author map to their own file under the app", () => {
	expect(profileOf(draftRules({ app: "mail" }, { kind: "mail", from: "Kim <Kim.Lee+x@Example.com>", text: "" }).key)).toBe("mail/to/kim_002elee_002bx_0040example_002ecom.md");
	expect(profileOf({ app: "youtube", to: "김 선생님" })).toBe("youtube/to/_ae40_0020_c120_c0dd_b2d8.md");
	expect(profileKey("youtube/to/_ae40_0020_c120_c0dd_b2d8.md")).toEqual({ app: "youtube", to: "김 선생님" });
	expect(profileKey("mail/to/A.md")).toBeUndefined();
	expect(profileKey("install/to/a.md")).toBeUndefined();
});

test("a rule stored for a@x.com reaches the draft prompt of a mail from A@X.com and not one from b@x.com", async () => {
	const stored = await correct({}, "--app", "mail", "--to", "a@x.com", "--rule", "이분께는 반말로 쓴다");
	expect(stored).toEqual({ lines: ['기억했어요: "이분께는 반말로 쓴다" · 범위: 이 받는 사람'], code: 0 });
	expect(profileBullets({ app: "mail", to: "A@X.com" }, HEADINGS.rules)).toEqual(["이분께는 반말로 쓴다"]);
	const theirs = await promptOf(mail("Kim <A@X.com>"));
	expect(theirs).toContain(`${RECIPIENT_HEAD}\n- 이분께는 반말로 쓴다\n`);
	expect(theirs).toContain("The user's rules:\n(none)");
	const other = await promptOf(mail("Lee <b@x.com>"));
	expect(other).not.toContain("이분께는 반말로 쓴다");
	expect(other).not.toContain(RECIPIENT_HEAD);
});

test("a rule stored for a commenter by his display name is kept under his channel id and reaches his comment draft only", async () => {
	const dir = commentsDir(env.dir);
	const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const now = Date.parse("2026-10-23T00:00:00.000Z");
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [{ native: "c1", thread: "p1", author: "김 선생님", authorId: "UC_kim", text: "영상 잘 봤어요", postTitle: "Post one", at: now - 2000 }, { native: "c2", thread: "p1", author: "박 학생", authorId: "UC_park", text: "영상 잘 봤어요", postTitle: "Post one", at: now - 1000 }], cursor: "1" }),
		reply: async () => ({ ok: true, ref: "ref1" }),
		posts: async () => [{ id: "p1", title: "Post one" }],
	};
	const prompts: string[] = [];
	const model: DraftModel = async (_system, user) => (prompts.push(user), { text: j({ action: "draft", reason: "thanks", to: "", body: "고마워요", questions: [] }) });
	const engine = createEngine({ dir, now: () => now, collector: "mac-a", adapters: { youtube: adapter }, model, style: commentStyle });
	await engine.collect({ force: true });
	expect(await correct({}, "--app", "youtube", "--to", "김 선생님", "--rule", "선생님께는 존칭을 쓴다")).toEqual({ lines: ['기억했어요: "선생님께는 존칭을 쓴다" · 범위: 이 받는 사람'], code: 0 });
	expect(profileBullets({ app: "youtube", to: "UC_kim" }, HEADINGS.rules)).toEqual(["선생님께는 존칭을 쓴다"]);
	expect(readLedger().map(r => r.scope)).toEqual([{ app: "youtube", to: "uc_kim" }]);
	await engine.makeDraft(commentId("youtube", "c1"));
	await engine.makeDraft(commentId("youtube", "c2"));
	expect(prompts).toHaveLength(2);
	expect(prompts[0]).toContain(`${RECIPIENT_HEAD}\n- 선생님께는 존칭을 쓴다\n`);
	expect(prompts[1]).not.toContain("선생님께는 존칭을 쓴다");
});

test("correct and tone --to for a comment source take a stored channel id or the one stored commenter of that name, and refuse none, several and a website", async () => {
	seedComments("youtube", [{ author: "김 선생님", authorId: "UC_kimA" }, { author: "김 선생님", authorId: "UC_kimB" }, { author: "Park", authorId: "UC_park" }, { author: "옛 손님" }]);
	seedComments("site-blog", [{ author: "홍길동" }]);
	expect(await correct({}, "--app", "youtube", "--to", " park ", "--rule", "짧게 쓴다")).toEqual({ lines: ['기억했어요: "짧게 쓴다" · 범위: 이 받는 사람'], code: 0 });
	expect(profileBullets({ app: "youtube", to: "UC_park" }, HEADINGS.rules)).toEqual(["짧게 쓴다"]);
	const none = `youtube에서 모은 댓글에 '이순신'(이)라는 이름이나 아이디가 없어요. 그분 댓글이 들어오면 그 카드에서 답글을 "이분께는 ..."처럼 고쳐도 돼요`;
	expect(await correct({}, "--app", "youtube", "--to", "이순신", "--rule", "반말로 쓴다")).toEqual({ lines: [none], code: 2 });
	expect(await runDraft(["tone", "--app", "youtube", "--to", "이순신"], "")).toEqual({ lines: [none], code: 2 });
	const two = `youtube에서 모은 댓글에 '김 선생님'(이)라는 이름을 쓰는 사람이 2명이라 누구인지 알 수 없어요. ${CARD_HINT}`;
	expect(await correct({}, "--app", "youtube", "--to", "옛 손님", "--rule", "반말로 쓴다")).toEqual({ lines: ["'옛 손님'님의 댓글은 아이디 없이 모은 예전 댓글뿐이에요. 그분의 새 댓글이 들어오면 정할 수 있어요"], code: 2 });
	expect(await correct({}, "--app", "youtube", "--to", "김 선생님", "--rule", "반말로 쓴다")).toEqual({ lines: [two], code: 2 });
	expect(await runDraft(["tone", "--app", "youtube", "--to", "김 선생님"], "")).toEqual({ lines: [two], code: 2 });
	expect(await correct({}, "--app", "youtube", "--to", "UC_kimB", "--rule", "반말로 쓴다")).toEqual({ lines: ['기억했어요: "반말로 쓴다" · 범위: 이 받는 사람'], code: 0 });
	expect(profileBullets({ app: "youtube", to: "UC_kimB" }, HEADINGS.rules)).toEqual(["반말로 쓴다"]);
	expect(profileBullets({ app: "youtube", to: "UC_kimA" }, HEADINGS.rules)).toEqual([]);
	expect((await runDraft(["tone", "--app", "youtube", "--to", "UC_kimB"], "")).lines.slice(0, 3)).toEqual(["youtube · 김 선생님 답장이 따르는 것", "말투:", "- [to] 반말로 쓴다"]);
	const site = "site-blog에서 모은 댓글에는 쓴 사람을 가릴 아이디가 아직 없어요. 유튜브와 인스타그램은 새 댓글이 들어오면 정할 수 있고, 웹사이트 댓글은 아이디가 없어서 한 사람에게만 정할 수 없어요";
	expect(await correct({}, "--app", "site-blog", "--to", "홍길동", "--rule", "반말로 쓴다")).toEqual({ lines: [site], code: 2 });
	expect(await runDraft(["tone", "--app", "site-blog", "--to", "홍길동"], "")).toEqual({ lines: [site], code: 2 });
	expect(readLedger().map(r => [r.scope, r.text])).toEqual([[{ app: "youtube", to: "uc_park" }, "짧게 쓴다"], [{ app: "youtube", to: "uc_kimb" }, "반말로 쓴다"]]);
});

test("tone --journal and correct --restore name a commenter by his stored display name, not his id", async () => {
	seedComments("youtube", [{ author: "Park", authorId: "UC_park" }]);
	await correct({}, "--app", "youtube", "--to", "UC_park", "--rule", "존댓말로 쓴다");
	const replaced = await correct({ learnCall: learner(() => JSON.stringify({ replaces: [{ id: "R1", why: "overridden" }] })).learnCall }, "--app", "youtube", "--to", "Park", "--rule", "반말로 쓴다");
	expect(replaced.lines).toEqual(['기억했어요: "반말로 쓴다" · 범위: 이 받는 사람 · 기존 조건 1개를 이 조건으로 바꿨어요']);
	expect((await runDraft(["tone", "--journal"], "")).lines).toEqual(['1. [youtube · Park] 말투 "존댓말로 쓴다" → "반말로 쓴다" (2030-03-04)']);
	expect((await correct({}, "--restore", "1")).lines).toEqual(['되돌렸어요: [youtube · Park] 말투 "존댓말로 쓴다"']);
});

test("a recipient line and a contradicting app line both reach the prompt, the recipient's marked as winning, and the judge lists it after the others", async () => {
	seedRules({ app: "mail" }, { tone: ["존댓말로 쓴다"], correction: ["2030-03-01: 끝인사는 길게"] });
	seedRules({ app: "mail", to: "a@x.com" }, { tone: ["반말로 쓴다"], correction: ["2030-03-02: 끝인사는 한 줄로"], ban: ["수고하세요"] });
	const style = draftRules({ app: "mail" }, mail("a@x.com")).style();
	expect(style.forbidden).toEqual(["수고하세요"]);
	const { user } = buildPrompt(mail("a@x.com"), style);
	expect(user).toContain("The user's rules:\n- 존댓말로 쓴다\n");
	expect(user).toContain("- 2030-03-01: 끝인사는 길게\n");
	expect(user).toContain(`${RECIPIENT_HEAD}\n- 반말로 쓴다\n- 2030-03-02: 끝인사는 한 줄로\n`);
	expect(user.indexOf("- 2030-03-02: 끝인사는 한 줄로")).toBe(user.lastIndexOf("- 2030-03-02: 끝인사는 한 줄로"));
	expect(styleConditions(style)).toEqual({ standing: ["존댓말로 쓴다"], corrections: ["끝인사는 길게"], recipient: ["반말로 쓴다", "끝인사는 한 줄로"] });
	const judged: string[] = [];
	await generateReply(mail("a@x.com"), style, fakeModel([draftOut]).call, async prompt => (judged.push(prompt), '{"violations":[]}'));
	expect(judged).toHaveLength(1);
	expect(judged[0]).toContain("Standing rules (the owner set these; they always hold):\n1. 존댓말로 쓴다\n\nPast corrections, newest first:\n2. 끝인사는 길게\n\nRules for this recipient (the owner set these for the person this draft goes to; each wins over a standing rule or past correction above that says otherwise):\n3. 반말로 쓴다\n4. 끝인사는 한 줄로\n");
	const late = fakeModel([j({ action: "draft", reason: "r", to: "a@x.com", subject: "Re: 일정", body: "응 알겠어", questions: [] })]);
	const r = await generateReply(mail("a@x.com"), { ...style, standing: [], corrections: [], rules: ["반말로 쓴다"] }, late.call, async () => JSON.stringify({ violations: [{ rule: 1, about: "wording", quote: "알겠어", why: "x" }] }));
	expect(r.action === "draft" && r.warnings).toEqual(["말투 조건과 달라 보여요: 반말로 쓴다"]);
});

test("with no recipient file the mail and comment prompts, the judge prompt and the lint style equal those of a key without `to`", () => {
	write(toneFile("install"), "## 이웃별\n\n- 손으로 쓴 줄\n");
	write(toneFile({ app: "mail" }), "## 예시\n\n- 네 확인했어요\n");
	seedRules("install", { tone: ["설치 줄"] });
	seedRules({ app: "mail" }, { tone: ["존댓말로 쓴다"], correction: ["2030-03-01: 짧게"], ban: ["수고하세요"] });
	seedRules({ app: "youtube" }, { tone: ["이모지는 하나까지"] });
	seedRules({ app: "mail", to: "c@x.com" }, { tone: ["다른 분 줄"] });
	const cases: [ReplyItem, ReplyStyle, ReplyStyle][] = [
		[mail("Kim <a@x.com>"), draftRules({ app: "mail" }, mail("Kim <a@x.com>")).style(), loadStyle(draftRules({ app: "mail" }, ITEM).tone)],
		[{ kind: "comment", app: "youtube", from: "박 학생", text: "잘 봤어요" }, commentStyle({ key: "youtube", kind: "youtube", label: "유튜브", watch: ["*"], autoDraft: false }, "UC_park"), loadStyle({ app: "youtube" })],
	];
	for (const [item, withTo, without] of cases) {
		expect(withTo).toEqual(without);
		expect(buildPrompt(item, withTo)).toEqual(buildPrompt(item, without));
		expect(judgePrompt({ ...styleConditions(withTo), received: item.text, draft: "d" })).toBe(judgePrompt({ ...styleConditions(without), received: item.text, draft: "d" }));
	}
});

test("journal, --restore, --tidy and tone work on a recipient file, and --to is refused with --room, with install and for a nobody id", async () => {
	const log = quiet();
	const to = ["--app", "mail", "--to", "A@x.com"];
	await correct({}, ...to, "--rule", "존댓말로 쓴다");
	const replaced = await correct({ learnCall: learner(() => JSON.stringify({ replaces: [{ id: "R1", why: "overridden" }] })).learnCall }, ...to, "--rule", "반말로 쓴다");
	expect(replaced.lines).toEqual(['기억했어요: "반말로 쓴다" · 범위: 이 받는 사람 · 기존 조건 1개를 이 조건으로 바꿨어요']);
	expect(journalEntries().map(e => [e.n, e.profile, e.line])).toEqual([[1, "mail/to/a_0040x_002ecom.md", "존댓말로 쓴다"]]);
	expect((await runDraft(["tone", "--journal"], "")).lines).toEqual(['1. [mail · a@x.com] 말투 "존댓말로 쓴다" → "반말로 쓴다" (2030-03-04)']);
	expect((await correct({}, "--restore", "1")).lines).toEqual(['되돌렸어요: [mail · a@x.com] 말투 "존댓말로 쓴다"']);
	expect(profileBullets({ app: "mail", to: "a@x.com" }, HEADINGS.rules)).toEqual(["존댓말로 쓴다", "반말로 쓴다"]);
	await correct({ now: day("2030-03-05") }, ...to, "--change", "끝인사는 짧게");
	await correct({ now: day("2030-03-06") }, ...to, "--change", "끝인사는 한 줄로");
	const tidy = learner(() => JSON.stringify({ lines: [{ text: "끝인사는 한 줄로 짧게", sources: ["C1", "C2"] }], dropped: [] }));
	expect((await correct({ learnCall: tidy.learnCall }, ...to, "--tidy")).lines).toEqual(["고친 점 2줄을 1줄로 정리했어요 (지운 줄은 tone --journal에 남아 있어요)"]);
	expect(tidy.asked[0]).toContain("C1. 2030-03-05: 끝인사는 짧게");
	expect(profileBullets({ app: "mail", to: "a@x.com" }, HEADINGS.corrections)).toEqual(["2030-03-06: 끝인사는 한 줄로 짧게"]);
	expect(journalEntries().slice(0, 2).map(e => [e.profile, e.by, e.line])).toEqual([
		["mail/to/a_0040x_002ecom.md", "compact", "2030-03-06: 끝인사는 한 줄로"],
		["mail/to/a_0040x_002ecom.md", "compact", "2030-03-05: 끝인사는 짧게"],
	]);
	seedRules({ app: "mail" }, { tone: ["앱 줄"] });
	expect((await runDraft(["tone", ...to], "")).lines.slice(0, 5)).toEqual(["mail · a@x.com 답장이 따르는 것", "말투:", "- [app] 앱 줄", "- [to] 존댓말로 쓴다", "- [to] 반말로 쓴다"]);
	expect(await correct({}, "--app", "kakao", "--room", "r1", "--to", "a@x.com", "--rule", "x")).toEqual({ lines: ["--to(받는 사람)와 --room(대화방)은 같이 쓸 수 없어요"], code: 2 });
	expect(await runDraft(["tone", "--app", "install", "--to", "a@x.com"], "")).toEqual({ lines: ["--app install은 모든 답장에 적용돼서 --to와 같이 쓸 수 없어요"], code: 2 });
	expect((await correct({}, "--app", "youtube", "--to", "익명", "--rule", "x")).code).toBe(2);
	expect(profileBullets({ app: "youtube" }, HEADINGS.rules)).toEqual([]);
	log.mockRestore();
});

const ban = (body: string): string => `네 ${body} 확인했어요`;
const draftWith = (to: string, body: string) => j({ action: "draft", reason: "r", to, subject: "Re: 일정", body, questions: [] });
const NO_VIOLATIONS = '{"violations":[]}';

test("a mail whose Reply-To differs from From is written, judged and linted with the conditions of the address the reply goes to", async () => {
	seedRules({ app: "mail", to: "a@x.com" }, { tone: ["에이분 규칙"], ban: ["에이금지어"] });
	seedRules({ app: "mail", to: "b@y.com" }, { tone: ["비분 규칙"], ban: ["비금지어"] });
	const item: ReplyItem = { ...mail("A <a@x.com>"), replyTo: "B <b@y.com>" };
	const model = fakeModel([draftWith("b@y.com", ban("에이금지어"))]), judge = fakeModel([NO_VIOLATIONS]);
	const built = await buildDraft(item, meta, { call: model.call, judge: judge.call });
	if (built.action !== "draft") throw new Error(`no draft: ${built.action}`);
	expect(built.rec.to).toBe("b@y.com");
	expect(built.warnings).toEqual([]);
	expect(model.calls).toHaveLength(1);
	expect(model.calls[0]!.user).toContain(`${RECIPIENT_HEAD}\n- 비분 규칙\n`);
	expect(model.calls[0]!.user).toContain("Forbidden expressions:\n- 비금지어\n");
	expect(model.calls[0]!.user).not.toContain("에이분 규칙");
	expect(judge.calls).toHaveLength(1);
	expect(judge.calls[0]!.user).toContain("1. 비분 규칙");
	expect(judge.calls[0]!.user).not.toContain("에이분 규칙");
	expect(draftLintFailures(built.rec)).toEqual([]);
	expect(draftLintFailures({ ...built.rec, body: ban("비금지어") })).not.toEqual([]);
});

test("draft.ts new --kind comment has no recipient level: it reads no commenter's file, whatever its --from, --app or --room", async () => {
	for (const to of ["김 선생님", "youtube", "r9"]) seedRules({ app: "youtube", to }, { tone: [`${to}라는 분 규칙`] });
	expect(loadStyle({ app: "youtube", to: "김 선생님" }).recipient).toEqual(["김 선생님라는 분 규칙"]);
	const drafted = async (...more: string[]): Promise<string> => {
		const model = fakeModel([j({ action: "draft", reason: "thanks", to: "", body: "고마워요", questions: [] })]);
		const out = await runDraft(["new", "--mail", `c-${more.join("-")}`, "--kind", "comment", "--app", "youtube", ...more], "영상 잘 봤어요", { call: model.call, judge: fakeModel([NO_VIOLATIONS]).call });
		expect(out.lines).toEqual(["고마워요"]);
		return model.calls[0]!.user;
	};
	for (const more of [[], ["--room", "r9"], ["--from", "r9"], ["--from", "김 선생님"]]) {
		const prompt = await drafted(...more);
		expect(prompt).not.toContain("라는 분 규칙");
		expect(prompt).not.toContain(RECIPIENT_HEAD);
	}
	expect(draftRules({ app: "youtube" }, { kind: "comment", from: "김 선생님", text: "" }).key).toEqual({ app: "youtube" });
});

test("a draft whose sender is only a name is checked on edit with the file of the address its text gives, as it is at send", () => {
	seedRules({ app: "mail", to: "kim@x.com" }, { ban: ["김금지어"] });
	const item: ReplyItem = { kind: "mail", app: "mail", from: "김철수", self: ["me@example.net"], subject: "일정", text: "다음 주 일정 알려 주세요.\n\n김철수 드림\nkim@x.com" };
	const rec: DraftRec = { id: "DNAME1", kind: "mail", app: "mail", source: "zele", mailId: "m-name", ref: "k-name", to: "김철수", subject: "Re: 일정", body: "네 확인했어요", status: "pending", created: "2030-03-04T09:00:00.000Z", changes: [], questions: [], item };
	addDraft(rec);
	expect(draftLintFailures({ ...withRecipient(rec), body: "네 김금지어 확인했어요" })).not.toEqual([]);
	const edited = editDraft(rec.id, "네 김금지어 확인했어요");
	expect(edited.ok).toBe(false);
});

test("a mail in a mailbox with its own tone file gets the rule and the ban of the base app's file of its sender", async () => {
	// A mailbox reads its own profile once it has one (a learned voice); its rules are the ledger's.
	write(toneFile({ app: "mail-2", room: "inbox" }), "## 정체성\n\n- 메일함에서는 짧게 쓰는 사람이에요\n");
	seedRules({ app: "mail-2", room: "inbox" }, { tone: ["메일함 줄"] });
	seedRules({ app: "mail", to: "a@x.com" }, { tone: ["에이분 규칙"], ban: ["에이금지어"] });
	const box = { ...meta, box: "inbox", instance: "mail-2" };
	const model = fakeModel([draftWith("a@x.com", "네 확인했어요")]), judge = fakeModel([NO_VIOLATIONS]);
	const built = await buildDraft(mail("A <a@x.com>"), box, { call: model.call, judge: judge.call });
	if (built.action !== "draft") throw new Error(`no draft: ${built.action}`);
	expect(model.calls[0]!.user).toContain(`${RECIPIENT_HEAD}\n- 에이분 규칙\n`);
	expect(model.calls[0]!.user).toContain("Forbidden expressions:\n- 에이금지어\n");
	expect(judge.calls[0]!.user).toContain("Rules for this recipient (the owner set these for the person this draft goes to; each wins over a standing rule or past correction above that says otherwise):\n2. 에이분 규칙\n");
	expect(draftLintFailures(built.rec)).toEqual([]);
	expect(draftLintFailures({ ...built.rec, body: ban("에이금지어") })).not.toEqual([]);
	const key = { app: "mail-2", room: "inbox", base: "mail", to: "a@x.com" };
	expect(levelsOf(key)[0]).toEqual(["to", { app: "mail", to: "a@x.com" }]);
	expect(toneFile({ app: "mail-2", to: "a@x.com" })).toBe(toneFile({ app: "mail", to: "a@x.com" }));
	expect(toneFile({ app: "youtube", to: "a@x.com" })).not.toBe(toneFile({ app: "mail", to: "a@x.com" }));
});

test("correct and tone --to refuse KakaoTalk and keep exactly one address for a mail app", async () => {
	const kakao = "카카오톡은 대화방이 받는 사람이라 --to 대신 --room <대화방>으로 정해 주세요";
	expect(await correct({}, "--app", "kakao", "--to", "엄마", "--rule", "반말로 쓴다")).toEqual({ lines: [kakao], code: 2 });
	expect(await runDraft(["tone", "--app", "kakao", "--to", "엄마"], "")).toEqual({ lines: [kakao], code: 2 });
	expect(readLedger()).toEqual([]);
	for (const to of ["김 선생님", "a@x.com, b@y.com"]) {
		expect(await correct({}, "--app", "mail", "--to", to, "--rule", "반말로 쓴다")).toEqual({ lines: [`메일 앱의 --to는 메일 주소 하나여야 해요: ${to}`], code: 2 });
		expect((await runDraft(["tone", "--app", "mail-2", "--to", to], "")).code).toBe(2);
	}
	expect(readLedger()).toEqual([]);
	expect((await correct({}, "--app", "mail", "--to", "김 <Kim@X.com>", "--rule", "반말로 쓴다")).lines).toEqual(['기억했어요: "반말로 쓴다" · 범위: 이 받는 사람']);
	expect(profileBullets({ app: "mail", to: "kim@x.com" }, HEADINGS.rules)).toEqual(["반말로 쓴다"]);
	expect((await runDraft(["tone", "--app", "mail", "--to", "김 <Kim@X.com>"], "")).lines.slice(0, 3)).toEqual(["mail · kim@x.com 답장이 따르는 것", "말투:", "- [to] 반말로 쓴다"]);
	expect((await correct({}, "--app", "mail-2", "--to", "Lee <Lee@Y.com>", "--rule", "짧게 쓴다")).code).toBe(0);
	expect(profileBullets({ app: "mail", to: "lee@y.com" }, HEADINGS.rules)).toEqual(["짧게 쓴다"]);
	expect(draftRules({ app: "mail" }, mail("Lee <lee@y.com>")).style().recipient).toEqual(["짧게 쓴다"]);
	expect((await correct({}, "--app", "mail", "--to", "kim@x.com", "--forget", "반말")).lines).toEqual(["mail · kim@x.com에서 1줄을 지웠어요:\n- [말투] 반말로 쓴다"]);
	expect(profileBullets({ app: "mail", to: "kim@x.com" }, HEADINGS.rules)).toEqual([]);
	expect((await correct({}, "--app", "youtube", "--to", "김 <a@b.com>", "--rule", "존칭")).code).toBe(2);
	expect(readLedger().filter(r => r.scope.app === "youtube")).toEqual([]);
});

test("the recipient's corrections and the others share one 4000-character budget, the recipient's taken first", () => {
	const line = (tag: string, i: number) => `2030-01-${String(i + 1).padStart(2, "0")}: ${tag}${String(i).padStart(2, "0")}${"가".repeat(88)}`;
	const app = Array.from({ length: 30 }, (_, i) => line("앱", i)), own = Array.from({ length: 30 }, (_, i) => line("분", i));
	seedRules({ app: "mail" }, { correction: app });
	seedRules({ app: "mail", to: "a@x.com" }, { correction: own });
	const style = draftRules({ app: "mail" }, mail("a@x.com")).style();
	const { user } = buildPrompt(mail("a@x.com"), style);
	const shown = (tag: string) => user.split("\n").filter(l => l.startsWith(`- 2030-01-`) && l.includes(`: ${tag}`)).map(l => l.slice(2));
	const newestFirst = (xs: string[]) => [...xs].reverse();
	expect(shown("분")).toEqual(newestFirst(own));
	expect(shown("앱")).toEqual(newestFirst(app).slice(0, 8));
	expect([...shown("분"), ...shown("앱")].reduce((n, l) => n + [...l].length, 0)).toBeLessThanOrEqual(4000);
	const judged = styleConditions(style);
	expect(judged.recipient).toHaveLength(30);
	expect(judged.corrections).toEqual(newestFirst(app).slice(0, 8).map(l => l.slice(12)));
});

test("a mail written outside a draft on a second mail app is written and checked with one profile: the shared mail one until that app has a tone of its own, plus the recipient's file either way", async () => {
	const apps = join(env.dir, "custom", "apps.json");
	write(apps, JSON.stringify({ "mail-2": { app: "mail", label: "학교" } }));
	const checked = async (word: string): Promise<boolean> => {
		const body = `안녕하세요. ${word} 자료 보내드립니다.`;
		const made = await composeMail({ app: "mail-2", to: ["kim@x.com"], subject: "자료", body, notify: false });
		const item: ReplyItem = { kind: "mail", app: "mail-2", from: "kim@x.com", text: body };
		const sendLint = draftLintFailures({ id: "D1", kind: "mail", app: "mail-2", source: "zele", mailId: "compose-D1", ref: "compose-d1", compose: true, to: "kim@x.com", subject: "자료", body, status: "pending", created: "2030-03-04T09:00:00.000Z", changes: [], questions: [], item });
		expect(made.ok && (made.rec.check?.warn.length ?? 0) > 0).toBe(sendLint.length > 0);
		return sendLint.length > 0;
	};
	try {
		write(toneFile({ app: "mail" }), "## 예시\n\n- 네 보내드렸어요\n");
		seedRules({ app: "mail" }, { ban: ["메일금지어"] });
		seedRules({ app: "mail", to: "kim@x.com" }, { tone: ["김 선생님께는 짧게"], ban: ["김금지어"] });
		const shared = outgoing("mail-2", "Kim <kim@x.com>");
		expect(shared?.samples).toEqual(["네 보내드렸어요"]);
		expect(shared?.recipient).toEqual(["김 선생님께는 짧게"]);
		expect(shared?.forbidden).toEqual(["메일금지어", "김금지어"]);
		expect(outgoing("mail-2", "lee@y.com")?.forbidden).toEqual(["메일금지어"]);
		expect(draftRules({ app: "mail-2" }, ITEM).tone).toEqual({ app: "mail-2" });
		for (const word of shared?.forbidden ?? []) expect(await checked(word)).toBe(true);
		write(toneFile({ app: "mail-2" }), "## 예시\n\n- 자료 보내드려요\n");
		seedRules({ app: "mail-2" }, { ban: ["학교금지어"] });
		const own = outgoing("mail-2", "Kim <kim@x.com>");
		expect(own?.samples).toEqual(["자료 보내드려요"]);
		expect(own?.recipient).toEqual(["김 선생님께는 짧게"]);
		// The ban of the mail app is inherited at read time (no copy), the app's own and the recipient's follow it.
		expect(own?.forbidden).toEqual(["메일금지어", "학교금지어", "김금지어"]);
		expect(draftRules({ app: "mail-2" }, ITEM).tone).toEqual({ app: "mail-2" });
		for (const word of own?.forbidden ?? []) expect(await checked(word)).toBe(true);
		expect(await checked("메일금지어")).toBe(true);
		expect(outgoing("mail", "Kim <kim@x.com>")?.forbidden).toEqual(["메일금지어", "김금지어"]);
	} finally {
		rmSync(apps, { force: true });
	}
});
