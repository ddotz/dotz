import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { advance } from "../../../hub/runtime/test-clock.ts";
import { runDraft } from "../bin/draft.ts";
import { curate, journalEntries, restoreEntry } from "../lib/curate.ts";
import { learnLine, reviseDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { HEADINGS, loadStyle, paths, profileApp, profileBullets, toneFile } from "../lib/settings.ts";
import { listDrafts } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	rmSync(paths.toneDir(), { force: true, recursive: true });
	mkdirSync(join(env.dir, "custom"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ "mail-beta": { app: "mail" } }));
});

const journalFile = () => join(paths.toneDir(), "journal.jsonl");
const answer = (...replaces: [string, string][]) => JSON.stringify({ replaces: replaces.map(([id, why]) => ({ id, why })) });
const model = (reply: () => Promise<string> | string) => {
	const asked: { app: string; system: string; user: string }[] = [];
	return { asked, learnCall: (app: string) => async (system: string, user: string) => (asked.push({ app, system, user }), reply()) };
};
const day = (d: string) => () => new Date(`${d}T09:00:00Z`);
const correct = (deps: object, ...args: string[]) => runDraft(["correct", ...args], "", { now: day("2030-03-04"), ...deps });
const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);
const profile = (file: string, md: string) => {
	mkdirSync(join(paths.toneDir(), "kakao"), { recursive: true });
	writeFileSync(join(paths.toneDir(), file), md);
};

test("the same rule given three times leaves one 말투 line, no journal entry, and says the line was already there", async () => {
	const log = quiet();
	const m = model(() => answer(["R1", "same"]));
	await correct({ learnCall: m.learnCall }, "--app", "mail", "--rule", "답장은 짧게");
	const second = await correct({ learnCall: m.learnCall }, "--app", "mail", "--rule", "답장은 짧게 써 줘");
	const third = await correct({ learnCall: m.learnCall }, "--app", "mail", "--rule", "짧게 답해");
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["답장은 짧게"]);
	expect(second.lines).toEqual(['이미 있는 조건이라 더하지 않았어요: "답장은 짧게"']);
	expect(third.lines).toEqual(['이미 있는 조건이라 더하지 않았어요: "답장은 짧게"']);
	expect(journalEntries()).toEqual([]);
	expect(existsSync(journalFile())).toBe(false);
	log.mockRestore();
});

test("the same correction given three times leaves the newest dated line and two journal entries, each restorable by the number the CLI printed", async () => {
	const log = quiet();
	const m = model(() => answer(["C1", "same"]));
	const where = ["--app", "kakao", "--room", "r1"];
	await correct({ learnCall: m.learnCall, now: day("2030-03-04") }, ...where, "--change", "끝인사는 한 줄로");
	const second = await correct({ learnCall: m.learnCall, now: day("2030-03-05") }, ...where, "--change", "끝인사 한 줄만");
	await correct({ learnCall: m.learnCall, now: day("2030-03-06") }, ...where, "--change", "끝인사는 한 줄");
	expect(second.lines).toEqual(["고친 점을 kakao 대화방 말투에 기록했어요: 끝인사 한 줄만", '기존 조건 1개를 이 조건으로 바꿨어요: "2030-03-04: 끝인사는 한 줄로" (되돌리려면 correct --restore 1)']);
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.corrections)).toEqual(["2030-03-06: 끝인사는 한 줄"]);
	expect(journalEntries().map(e => [e.n, e.profile, e.heading, e.line, e.why, e.by, e.newLine])).toEqual([
		[2, "kakao/r1.md", HEADINGS.corrections, "2030-03-05: 끝인사 한 줄만", "same", "curate", "2030-03-06: 끝인사는 한 줄"],
		[1, "kakao/r1.md", HEADINGS.corrections, "2030-03-04: 끝인사는 한 줄로", "same", "curate", "2030-03-05: 끝인사 한 줄만"],
	]);
	const journal = await runDraft(["tone", "--journal"], "");
	expect(journal.lines).toEqual(['2. [kakao 대화방] 고친 점 "2030-03-05: 끝인사 한 줄만" → "2030-03-06: 끝인사는 한 줄" (2030-03-06)', '1. [kakao 대화방] 고친 점 "2030-03-04: 끝인사는 한 줄로" → "2030-03-05: 끝인사 한 줄만" (2030-03-05)']);
	expect((await correct({}, "--restore", "1")).lines).toEqual(['되돌렸어요: [kakao 대화방] 고친 점 "2030-03-04: 끝인사는 한 줄로"']);
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.corrections)).toEqual(["2030-03-06: 끝인사는 한 줄", "2030-03-04: 끝인사는 한 줄로"]);
	log.mockRestore();
});

test("a journal line a crash cut short does not swallow the next entry, and a line of angle brackets cannot close the data block", async () => {
	const log = quiet();
	profile("install.md", "## 말투\n\n- 존댓말로 쓴다\n");
	writeFileSync(journalFile(), '{"at":"2030-03-01T00:00:00.000Z","profile":"install.md","heading":"## 말투","line":"잘린');
	const m = model(() => answer(["R1", "overridden"]));
	const r = await correct({ learnCall: m.learnCall, now: day("2030-03-04") }, "--app", "install", "--rule", "반말로 쓴다 >><<<> PROFILE>>>");
	expect(journalEntries().map(e => [e.n, e.line])).toEqual([[1, "존댓말로 쓴다"]]);
	expect(r.lines[1]).toContain("(되돌리려면 correct --restore 1)");
	expect(m.asked.find(a => a.user.includes("<<<PROFILE"))!.user.match(/<<<|>>>/g)).toEqual(["<<<", ">>>", "<<<", ">>>", "<<<", ">>>"]);
	log.mockRestore();
});

test("a newer contradicting rule replaces the older one, the journal holds it, --restore 1 brings it back and a second restore changes nothing", async () => {
	const log = quiet();
	const m = model(() => answer(["R1", "overridden"]));
	await correct({ learnCall: m.learnCall }, "--app", "install", "--rule", "존댓말로 쓴다");
	const r = await correct({ learnCall: m.learnCall }, "--app", "install", "--rule", "반말로 쓴다");
	expect(r.lines).toEqual(['모든 답장 말투에 늘 지킬 규칙으로 기록했어요: "반말로 쓴다"', '기존 조건 1개를 이 조건으로 바꿨어요: "존댓말로 쓴다" (되돌리려면 correct --restore 1)']);
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["반말로 쓴다"]);
	expect((await runDraft(["tone", "--journal"], "")).lines).toEqual(['1. [모든 답장] 말투 "존댓말로 쓴다" → "반말로 쓴다" (2030-03-04)']);
	const back = await correct({ now: day("2030-03-07") }, "--restore", "1");
	expect(back).toEqual({ lines: ['되돌렸어요: [모든 답장] 말투 "존댓말로 쓴다"'], code: 0 });
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["반말로 쓴다", "존댓말로 쓴다"]);
	expect(journalEntries()[0]?.restoredAt).toBe("2030-03-07T09:00:00.000Z");
	expect((await runDraft(["tone", "--journal"], "")).lines).toEqual(['1. [모든 답장] 말투 "존댓말로 쓴다" → "반말로 쓴다" (2030-03-04) 되돌림']);
	const profileBefore = readFileSync(toneFile("install"), "utf8"), journalBefore = readFileSync(journalFile(), "utf8");
	expect((await correct({ now: day("2030-03-08") }, "--restore", "1")).lines).toEqual(['이미 있는 줄이라 바꾼 게 없어요: [모든 답장] 말투 "존댓말로 쓴다"']);
	expect(readFileSync(toneFile("install"), "utf8")).toBe(profileBefore);
	expect(readFileSync(journalFile(), "utf8")).toBe(journalBefore);
	for (const n of ["2", "0", "x"]) {
		const none = await correct({}, "--restore", n);
		expect(none).toEqual({ lines: [`${n}번 기록이 없어요. tone --journal로 번호를 확인해 주세요`], code: 1 });
	}
	expect(restoreEntry(1.5)).toBeUndefined();
	log.mockRestore();
});

test("a correction whose answer lists a rule removes no rule; a rule may replace a correction", async () => {
	profile("mail.md", "## 말투\n\n- 존댓말로 쓴다\n\n## 고친 점\n\n- 2030-03-01: 이모지 쓰지 마\n");
	const r = await learnLine({ app: "mail" }, "반말로 써", "correction", { learnCall: model(() => answer(["R1", "overridden"])).learnCall, now: day("2030-03-04") });
	expect(r).toEqual({ stored: true, kind: "correction", replaced: [] });
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["존댓말로 쓴다"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-01: 이모지 쓰지 마", "2030-03-04: 반말로 써"]);
	expect(journalEntries()).toEqual([]);
	const rule = await learnLine({ app: "mail" }, "이모지는 쓰지 않는다", "rule", { learnCall: model(() => answer(["C1", "same"])).learnCall, now: day("2030-03-05") });
	expect(rule).toEqual({ stored: true, kind: "rule", replaced: ["2030-03-01: 이모지 쓰지 마"] });
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["존댓말로 쓴다", "이모지는 쓰지 않는다"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-04: 반말로 써"]);
});

const FOUR = "## 고친 점\n\n- 2030-03-01: 하나\n- 2030-03-01: 둘\n- 2030-03-01: 셋\n- 2030-03-01: 넷\n";
test("ids that do not exist are ignored and a fourth id is not removed", async () => {
	profile("mail.md", FOUR);
	const deps = (reply: string) => ({ learnCall: model(() => reply).learnCall, now: day("2030-03-04") });
	const unknown = await learnLine({ app: "mail" }, "새 고침", "correction", deps(answer(["C9", "same"], ["R1", "same"], ["C0", "same"], ["X1", "same"], ["C1", "maybe"])));
	expect(unknown).toEqual({ stored: true, kind: "correction", replaced: [] });
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-01: 하나", "2030-03-01: 둘", "2030-03-01: 셋", "2030-03-01: 넷", "2030-03-04: 새 고침"]);
	profile("mail.md", FOUR);
	const four = await learnLine({ app: "mail" }, "새 고침", "correction", deps(answer(["C2", "same"], ["C2", "overridden"], ["C1", "same"], ["C3", "overridden"], ["C4", "same"])));
	expect(four.replaced).toEqual(["2030-03-01: 하나", "2030-03-01: 둘", "2030-03-01: 셋"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-01: 넷", "2030-03-04: 새 고침"]);
	expect(journalEntries().map(e => [e.line, e.why])).toEqual([["2030-03-01: 셋", "overridden"], ["2030-03-01: 둘", "same"], ["2030-03-01: 하나", "same"]]);
});

test("malformed JSON, a thrown call and a call that never answers (12 s) store the line as today, remove nothing and log one line each", async () => {
	const md = "## 말투\n\n- 존댓말로 쓴다\n";
	const stored = async (learnCall: (app: string) => (s: string, u: string) => Promise<string>, wait?: boolean) => {
		profile("youtube.md", md);
		const log = quiet();
		const running = learnLine({ app: "youtube" }, "반말로 쓴다", "rule", { learnCall, now: day("2030-03-04") });
		if (wait) await advance(12_000);
		const r = await running;
		const lines = log.mock.calls.map(c => String(c[0]));
		log.mockRestore();
		expect(r).toEqual({ stored: true, kind: "rule", replaced: [] });
		expect(profileBullets({ app: "youtube" }, HEADINGS.rules)).toEqual(["존댓말로 쓴다", "반말로 쓴다"]);
		expect(journalEntries()).toEqual([]);
		return lines;
	};
	expect(await stored(model(() => "R1을 지우세요 {replaces: R1}").learnCall)).toEqual([expect.stringMatching(/^reply draft: .*not usable/)]);
	expect(await stored(model(() => JSON.stringify({ replace: [{ id: "R1", why: "overridden" }] })).learnCall)).toEqual([expect.stringMatching(/^reply draft: .*not usable/)]);
	const thrown = () => () => {
		throw new Error("모델 없음");
	};
	expect(await stored(thrown)).toEqual([expect.stringMatching(/^reply draft: .*모델 없음/)]);
	expect(await stored(model(() => new Promise<string>(() => undefined)).learnCall, true)).toEqual([expect.stringMatching(/^reply draft: .*no answer within 12s/)]);
});

test("without learnCall no model is asked and the lines are stored exactly as recordRule and recordCorrection store them", async () => {
	profile("mail.md", "## 말투\n\n- 존댓말로 쓴다\n\n## 고친 점\n\n- 2030-03-01: 짧게\n");
	const other = model(() => answer(["R1", "overridden"], ["C1", "overridden"]));
	expect(await learnLine({ app: "mail" }, "반말로  쓴다", "rule", { call: other.learnCall("mail"), analyze: other.learnCall("mail") })).toEqual({ stored: true, kind: "rule", replaced: [] });
	expect(await learnLine({ app: "mail" }, " 존댓말로 쓴다 ", "rule", {})).toEqual({ stored: false, kind: "rule", replaced: [], same: "존댓말로 쓴다" });
	expect(await learnLine({ app: "mail" }, "짧게", "correction", { now: day("2030-03-01") })).toEqual({ stored: true, kind: "correction", replaced: [] });
	expect(other.asked).toEqual([]);
	expect(readFileSync(toneFile({ app: "mail" }), "utf8")).toBe("## 말투\n\n- 존댓말로 쓴다\n- 반말로 쓴다\n\n## 고친 점\n\n- 2030-03-01: 짧게\n- 2030-03-01: 짧게\n");
	expect(existsSync(journalFile())).toBe(false);
});

test("a hand-added section, 금지 and 예시 are never offered to the model; 말투 and 고친 점 are, as R and C lines with their dates, with the new line and its kind", async () => {
	profile("mail.md", "## 정체성\n\n- 교사\n\n## 말투\n\n- 존댓말로 쓴다\n\n## 보낸 사람 신분별\n\n- 팀장에게는 격식체\n\n## 예시\n\n- 안녕하세요 선생님\n\n## 고친 점\n\n- 2030-03-01: 이모지 쓰지 마\n\n## 금지\n\n- 무조건\n");
	const m = model(() => answer());
	await learnLine({ app: "mail" }, "끝인사는 짧게", "correction", { learnCall: m.learnCall, now: day("2030-03-04") });
	expect(m.asked).toHaveLength(1);
	const prompt = m.asked[0]!.user;
	expect(prompt).toContain("R1. 존댓말로 쓴다");
	expect(prompt).toContain("C1. 2030-03-01: 이모지 쓰지 마");
	expect(prompt).toContain("<<<NEW correction of one draft\n끝인사는 짧게\nNEW>>>");
	for (const hidden of ["팀장에게는 격식체", "무조건", "안녕하세요 선생님", "교사"]) expect(prompt).not.toContain(hidden);
	expect(prompt).toContain('{"replaces":[{"id":"C2","why":"same"|"overridden"}]}');
});

test("an empty profile makes no curation call", async () => {
	const asked: string[] = [];
	expect(await curate({ rules: [], corrections: [] }, { line: "짧게", kind: "rule" }, async p => (asked.push(p), answer(["R1", "same"])))).toEqual({ replaces: [] });
	expect(asked).toEqual([]);
});

test("property: whatever the model answers, curate keeps only existing ids, each once, at most 3, and no R id for a correction", async () => {
	const log = quiet();
	const id = fc.oneof(fc.constantFrom("R", "C", "r", "c", "X").chain(p => fc.integer({ min: -1, max: 6 }).map(n => `${p}${n}`)), fc.string());
	const item = fc.record({ id: fc.oneof(id, fc.integer()), why: fc.oneof(fc.constantFrom("same", "overridden"), fc.string()) });
	const reply = fc.oneof(fc.array(item, { maxLength: 8 }).map(rs => JSON.stringify({ replaces: rs })), fc.string(), fc.array(item).map(rs => `\`\`\`json\n${JSON.stringify({ replaces: rs })}\n\`\`\``));
	const lines = fc.array(fc.string({ minLength: 1 }), { maxLength: 4 });
	await fc.assert(
		fc.asyncProperty(lines, lines, fc.constantFrom("rule" as const, "correction" as const), reply, async (rules, corrections, kind, text) => {
			const { replaces } = await curate({ rules, corrections }, { line: "새 줄", kind }, async () => text);
			expect(replaces.length).toBeLessThanOrEqual(3);
			expect(new Set(replaces.map(r => r.id)).size).toBe(replaces.length);
			for (const r of replaces) {
				const [, side, n] = /^([RC])([1-9]\d*)$/.exec(r.id) ?? [];
				expect(side === "R" ? Number(n) <= rules.length && kind === "rule" : side === "C" && Number(n) <= corrections.length).toBe(true);
				expect(["same", "overridden"]).toContain(r.why);
			}
		}),
	);
	log.mockRestore();
});

const HARU = { parts: [{ any: ["하루"] }, { gap: 3 }, { any: ["되세요"] }], label: "'하루 보내세요'로 쓴다", bad: ["행복한 하루 되세요"], good: [] };
const byAsk = (curated: string, asked: string[] = []) => ({
	asked,
	learnCall: () => async (system: string) => {
		const what = system.includes("style conditions") ? "curate" : "pattern";
		asked.push(what);
		return what === "curate" ? curated : j(HARU);
	},
});

test("correct --rule that curation calls the same as a standing rule stores no line and no wording pattern though one was proposed beside it; a new rule keeps its pattern", async () => {
	profile("install.md", "## 말투\n\n- 끝인사는 짧게 한다\n");
	const same = byAsk(answer(["R1", "same"]));
	const r = await correct({ learnCall: same.learnCall }, "--app", "install", "--rule", "끝인사에 '행복한 하루 되세요'는 쓰지 않고 짧게 끝낸다");
	expect(r.lines).toEqual(['이미 있는 조건이라 더하지 않았어요: "끝인사는 짧게 한다"']);
	expect(same.asked.toSorted()).toEqual(["curate", "pattern"]);
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["끝인사는 짧게 한다"]);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
	const added = await correct({ learnCall: byAsk(answer()).learnCall }, "--app", "install", "--rule", "덕담에 '행복한 하루 되세요'는 쓰지 않는다");
	expect(added.lines).toContain("표현 규칙으로도 정해 뒀어요: '하루 보내세요'로 쓴다");
	expect(profileBullets("install", HEADINGS.forbidden)).toHaveLength(1);
});

const LESSON = "끝인사는 짧게 한다";
async function revisedWith(lesson: object, learnCall: () => (system: string) => Promise<string>) {
	rmSync(paths.drafts(), { force: true, recursive: true });
	enable(env);
	await offerMailDraft({ ...mailFixture }, { send: () => undefined, call: fakeModel([j(goodReply)]).call });
	const rec = listDrafts()[0]!;
	const model = fakeModel([j({ ...goodReply, body: "곧 알려 드릴게요.", forbid: [], ...lesson })]);
	return reviseDraft(rec.id, "끝인사에 '행복한 하루 되세요'는 쓰지 말고 짧게 끝내 줘", { call: model.call, learnCall });
}

test("draft.ts revise: a lesson the install profile already has adds no line and keeps no wording pattern, and says it was already there; on an empty profile both are kept", async () => {
	profile("install.md", `## 말투\n\n- ${LESSON}\n`);
	const same = byAsk(answer(["R1", "same"]));
	const step = await revisedWith({ lesson: LESSON, everywhere: true }, same.learnCall);
	expect(step.ok).toBe(true);
	expect(same.asked).toEqual(["pattern"]);
	expect(step.text).toContain(`이미 있는 조건이에요: ${LESSON}`);
	expect(step.text).not.toContain("표현 규칙으로도");
	expect(profileBullets("install", HEADINGS.rules)).toEqual([LESSON]);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
	rmSync(paths.toneDir(), { force: true, recursive: true });
	const fresh = await revisedWith({ lesson: LESSON, everywhere: true }, byAsk(answer()).learnCall);
	expect(fresh.text).toContain(`앞으로 모든 답장에 반영해요: ${LESSON}`);
	expect(fresh.text).toContain("표현 규칙으로도 정해 뒀어요: '하루 보내세요'로 쓴다");
	expect(profileBullets("install", HEADINGS.forbidden)).toHaveLength(1);
});

test("draft.ts revise: a correction the curation answer overrides goes to the journal, the profile keeps the new line and the note says one condition was replaced", async () => {
	profile("mail.md", "## 고친 점\n\n- 2030-03-01: 끝인사는 길게 쓴다\n");
	const step = await revisedWith({ lesson: LESSON, everywhere: false }, byAsk(answer(["C1", "overridden"])).learnCall);
	expect(step.text).toContain(`앞으로 이 앱 답장에 반영해요: ${LESSON} · 기존 조건 1개를 이 조건으로 바꿨어요`);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual([expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}: ${LESSON}$`))]);
	expect(journalEntries().map(e => [e.line, e.why])).toEqual([["2030-03-01: 끝인사는 길게 쓴다", "overridden"]]);
});

test("a rule and a correction for the mail app also reach a mail app with its own tone file, superseding its contradicting line there", async () => {
	profile("mail.md", "## 말투\n");
	profile("mail-beta.md", "## 정체성\n- BETA-IDENTITY\n\n## 말투\n- 답장은 길게\n");
	const m = model(() => answer());
	m.learnCall = (app: string) => async (system: string, user: string) => (m.asked.push({ app, system, user }), user.includes("답장은 길게") ? answer(["R1", "overridden"]) : answer());
	const r = await correct({ learnCall: m.learnCall }, "--app", "mail", "--rule", "답장은 짧게", "--change", "인사는 뺀다");
	expect(r.code).toBe(0);
	const style = loadStyle({ app: profileApp("mail-beta") });
	expect(profileApp("mail-beta")).toBe("mail-beta");
	expect(style.rules).toContain("답장은 짧게");
	expect(style.rules).not.toContain("답장은 길게");
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.corrections)).toEqual(["2030-03-04: 인사는 뺀다"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["답장은 짧게"]);
	expect(journalEntries().map(e => [e.profile, e.line, e.why])).toEqual([["mail-beta.md", "답장은 길게", "overridden"]]);
});

test("a wording forbidden for the mail app is also forbidden in a mail app with its own tone file", async () => {
	profile("mail.md", "## 말투\n");
	profile("mail-beta.md", "## 정체성\n- BETA-IDENTITY\n");
	const r = await correct({}, "--app", "mail", "--forbid", "확인 부탁드립니다");
	expect(r.code).toBe(0);
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual(["확인 부탁드립니다"]);
	expect(loadStyle({ app: profileApp("mail-beta") }).forbidden).toContain("확인 부탁드립니다");
});

test("an allowed wording and a forgotten line for the mail app are also taken out of a mail app with its own tone file", async () => {
	const md = "## 말투\n- 답장은 짧게\n\n## 고친 점\n- 2030-03-01: 짧게 끝낸다\n\n## 금지\n- 확인 부탁드립니다\n";
	profile("mail.md", md);
	profile("mail-beta.md", `## 정체성\n- BETA-IDENTITY\n\n${md}`);
	const r = await correct({}, "--app", "mail", "--allow", "확인 부탁드립니다", "--forget", "짧게");
	expect(r.code).toBe(0);
	for (const app of ["mail", "mail-beta"]) {
		expect(profileBullets({ app }, HEADINGS.forbidden)).toEqual([]);
		expect(profileBullets({ app }, HEADINGS.rules)).toEqual([]);
		expect(profileBullets({ app }, HEADINGS.corrections)).toEqual([]);
	}
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.identity)).toEqual(["BETA-IDENTITY"]);
});
