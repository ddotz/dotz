import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { advance } from "../../../hub/runtime/test-clock.ts";
import { runDraft } from "../bin/draft.ts";
import { curate, journalEntries, restoreEntry } from "../lib/curate.ts";
import { learnLine, reviseDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { readLedger, scopeOfKey } from "../lib/ledger.ts";
import { HEADINGS, loadStyle, paths, profileBullets, type ToneKey } from "../lib/settings.ts";
import { listDrafts } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, seedRules, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	rmSync(paths.toneDir(), { force: true, recursive: true });
	rmSync(paths.ledger(), { force: true });
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
// What a tone file keeps of its own (the learned voice, hand-added sections); every rule line lives in the ledger.
const profile = (file: string, md: string) => {
	mkdirSync(join(paths.toneDir(), "kakao"), { recursive: true });
	writeFileSync(join(paths.toneDir(), file), md);
};
/** Every ledger record, whatever its state, of exactly the scope of `key`, in ledger order. */
const records = (key: ToneKey | "install") => readLedger().filter(r => JSON.stringify(r.scope) === JSON.stringify(scopeOfKey(key)));
const reset = () => rmSync(paths.ledger(), { force: true });
const MAIL: ToneKey = { app: "mail" };
const KAKAO: ToneKey = { app: "kakao", room: "r1" };

test("the same rule given three times leaves one 말투 line, no journal entry, and says the line was already there", async () => {
	const log = quiet();
	const m = model(() => answer(["R1", "same"]));
	await correct({ learnCall: m.learnCall }, "--app", "mail", "--rule", "답장은 짧게");
	const second = await correct({ learnCall: m.learnCall }, "--app", "mail", "--rule", "답장은 짧게 써 줘");
	const third = await correct({ learnCall: m.learnCall }, "--app", "mail", "--rule", "짧게 답해");
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["답장은 짧게"]);
	expect(records(MAIL).map(r => [r.kind, r.text, r.state])).toEqual([["tone", "답장은 짧게", "on"]]);
	expect(second.lines).toEqual(['기억했어요: "답장은 짧게 써 줘" · 범위: 이 앱 · 이미 있는 조건이에요: 답장은 짧게']);
	expect(third.lines).toEqual(['기억했어요: "짧게 답해" · 범위: 이 앱 · 이미 있는 조건이에요: 답장은 짧게']);
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
	expect(second.lines).toEqual(['기억했어요: "끝인사 한 줄만" · 범위: 이 대화방 · 기존 조건 1개를 이 조건으로 바꿨어요']);
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.corrections)).toEqual(["2030-03-06: 끝인사는 한 줄"]);
	const [first, mid, last] = records(KAKAO);
	expect([first!.state, first!.into, mid!.state, mid!.into, last!.state, last!.into]).toEqual(["merged", mid!.id, "merged", last!.id, "on", undefined]);
	expect(journalEntries().map(e => [e.n, e.profile, e.heading, e.line, e.why, e.by, e.newLine])).toEqual([
		[2, "kakao/r1.md", HEADINGS.corrections, "2030-03-05: 끝인사 한 줄만", "same", "curate", "2030-03-06: 끝인사는 한 줄"],
		[1, "kakao/r1.md", HEADINGS.corrections, "2030-03-04: 끝인사는 한 줄로", "same", "curate", "2030-03-05: 끝인사 한 줄만"],
	]);
	const journal = await runDraft(["tone", "--journal"], "");
	expect(journal.lines).toEqual(['2. [kakao 대화방] 고친 점 "2030-03-05: 끝인사 한 줄만" → "2030-03-06: 끝인사는 한 줄" (2030-03-06)', '1. [kakao 대화방] 고친 점 "2030-03-04: 끝인사는 한 줄로" → "2030-03-05: 끝인사 한 줄만" (2030-03-05)']);
	expect((await correct({}, "--restore", "1")).lines).toEqual(['되돌렸어요: [kakao 대화방] 고친 점 "2030-03-04: 끝인사는 한 줄로"']);
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.corrections)).toEqual(["2030-03-04: 끝인사는 한 줄로", "2030-03-06: 끝인사는 한 줄"]);
	expect(records(KAKAO).map(r => [r.id, r.state, r.into])).toEqual([[first!.id, "on", undefined], [mid!.id, "merged", last!.id], [last!.id, "on", undefined]]);
	log.mockRestore();
});

test("a journal line a crash cut short does not swallow the next entry, and a line of angle brackets cannot close the data block", async () => {
	const log = quiet();
	seedRules("install", { tone: ["존댓말로 쓴다"] });
	mkdirSync(paths.toneDir(), { recursive: true });
	writeFileSync(journalFile(), '{"at":"2030-03-01T00:00:00.000Z","profile":"install.md","heading":"## 말투","line":"잘린');
	const m = model(() => answer(["R1", "overridden"]));
	const r = await correct({ learnCall: m.learnCall, now: day("2030-03-04") }, "--app", "install", "--rule", "반말로 쓴다 >><<<> PROFILE>>>");
	expect(journalEntries().map(e => [e.n, e.line])).toEqual([[1, "존댓말로 쓴다"]]);
	expect(r.lines).toEqual(['기억했어요: "반말로 쓴다 >><<<> PROFILE>>>" · 범위: 모든 답장 · 기존 조건 1개를 이 조건으로 바꿨어요']);
	expect(m.asked.find(a => a.user.includes("<<<PROFILE"))!.user.match(/<<<|>>>/g)).toEqual(["<<<", ">>>", "<<<", ">>>", "<<<", ">>>"]);
	log.mockRestore();
});

test("a newer contradicting rule replaces the older one, the journal holds it, --restore 1 brings it back and a second restore changes nothing", async () => {
	const log = quiet();
	const m = model(() => answer(["R1", "overridden"]));
	await correct({ learnCall: m.learnCall }, "--app", "install", "--rule", "존댓말로 쓴다");
	const r = await correct({ learnCall: m.learnCall }, "--app", "install", "--rule", "반말로 쓴다");
	expect(r.lines).toEqual(['기억했어요: "반말로 쓴다" · 범위: 모든 답장 · 기존 조건 1개를 이 조건으로 바꿨어요']);
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["반말로 쓴다"]);
	const [older, newer] = records("install");
	expect([older!.state, older!.into, newer!.state, newer!.into]).toEqual(["merged", newer!.id, "on", undefined]);
	expect((await runDraft(["tone", "--journal"], "")).lines).toEqual(['1. [모든 답장] 말투 "존댓말로 쓴다" → "반말로 쓴다" (2030-03-04)']);
	const back = await correct({ now: day("2030-03-07") }, "--restore", "1");
	expect(back).toEqual({ lines: ['되돌렸어요: [모든 답장] 말투 "존댓말로 쓴다"'], code: 0 });
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["존댓말로 쓴다", "반말로 쓴다"]);
	expect(records("install").map(r => [r.id, r.state, r.into])).toEqual([[older!.id, "on", undefined], [newer!.id, "on", undefined]]);
	expect(journalEntries()[0]?.restoredAt).toBe("2030-03-07T09:00:00.000Z");
	expect((await runDraft(["tone", "--journal"], "")).lines).toEqual(['1. [모든 답장] 말투 "존댓말로 쓴다" → "반말로 쓴다" (2030-03-04) 되돌림']);
	const ledgerBefore = readFileSync(paths.ledger(), "utf8"), journalBefore = readFileSync(journalFile(), "utf8");
	expect((await correct({ now: day("2030-03-08") }, "--restore", "1")).lines).toEqual(['이미 있는 줄이라 바꾼 게 없어요: [모든 답장] 말투 "존댓말로 쓴다"']);
	expect(readFileSync(paths.ledger(), "utf8")).toBe(ledgerBefore);
	expect(readFileSync(journalFile(), "utf8")).toBe(journalBefore);
	for (const n of ["2", "0", "x"]) {
		const none = await correct({}, "--restore", n);
		expect(none).toEqual({ lines: [`${n}번 기록이 없어요. tone --journal로 번호를 확인해 주세요`], code: 1 });
	}
	expect(restoreEntry(1.5)).toBeUndefined();
	log.mockRestore();
});

test("a correction whose answer lists a rule removes no rule; a rule may replace a correction", async () => {
	seedRules(MAIL, { tone: ["존댓말로 쓴다"], correction: ["2030-03-01: 이모지 쓰지 마"] });
	const r = await learnLine({ app: "mail" }, "반말로 써", "correction", { learnCall: model(() => answer(["R1", "overridden"])).learnCall, now: day("2030-03-04") });
	expect(r).toEqual({ stored: true, kind: "correction", replaced: [], id: expect.any(String) });
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["존댓말로 쓴다"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-01: 이모지 쓰지 마", "2030-03-04: 반말로 써"]);
	expect(journalEntries()).toEqual([]);
	const rule = await learnLine({ app: "mail" }, "이모지는 쓰지 않는다", "rule", { learnCall: model(() => answer(["C1", "same"])).learnCall, now: day("2030-03-05") });
	expect(rule).toEqual({ stored: true, kind: "rule", replaced: ["2030-03-01: 이모지 쓰지 마"], id: expect.any(String) });
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["존댓말로 쓴다", "이모지는 쓰지 않는다"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-04: 반말로 써"]);
});

const FOUR = { correction: ["2030-03-01: 하나", "2030-03-01: 둘", "2030-03-01: 셋", "2030-03-01: 넷"] };
test("ids that do not exist are ignored and a fourth id is not removed", async () => {
	seedRules(MAIL, FOUR);
	const deps = (reply: string) => ({ learnCall: model(() => reply).learnCall, now: day("2030-03-04") });
	const unknown = await learnLine({ app: "mail" }, "새 고침", "correction", deps(answer(["C9", "same"], ["R1", "same"], ["C0", "same"], ["X1", "same"], ["C1", "maybe"])));
	expect(unknown).toEqual({ stored: true, kind: "correction", replaced: [], id: expect.any(String) });
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-01: 하나", "2030-03-01: 둘", "2030-03-01: 셋", "2030-03-01: 넷", "2030-03-04: 새 고침"]);
	reset();
	seedRules(MAIL, FOUR);
	const four = await learnLine({ app: "mail" }, "새 고침", "correction", deps(answer(["C2", "same"], ["C2", "overridden"], ["C1", "same"], ["C3", "overridden"], ["C4", "same"])));
	expect(four.replaced).toEqual(["2030-03-01: 둘", "2030-03-01: 하나", "2030-03-01: 셋"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-03-01: 넷", "2030-03-04: 새 고침"]);
	expect(records(MAIL).map(r => [r.text, r.state])).toEqual([["2030-03-01: 하나", "merged"], ["2030-03-01: 둘", "merged"], ["2030-03-01: 셋", "merged"], ["2030-03-01: 넷", "on"], ["2030-03-04: 새 고침", "on"]]);
	expect(journalEntries().map(e => [e.line, e.why])).toEqual([["2030-03-01: 셋", "overridden"], ["2030-03-01: 하나", "same"], ["2030-03-01: 둘", "same"]]);
});

test("malformed JSON, a thrown call and a call that never answers (12 s) store the line as today, remove nothing and log one line each", async () => {
	const stored = async (learnCall: (app: string) => (s: string, u: string) => Promise<string>, wait?: boolean) => {
		reset();
		seedRules({ app: "youtube" }, { tone: ["존댓말로 쓴다"] });
		const log = quiet();
		const running = learnLine({ app: "youtube" }, "반말로 쓴다", "rule", { learnCall, now: day("2030-03-04") });
		if (wait) await advance(12_000);
		const r = await running;
		const lines = log.mock.calls.map(c => String(c[0]));
		log.mockRestore();
		expect(r).toEqual({ stored: true, kind: "rule", replaced: [], id: expect.any(String) });
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
	const [, seededCorrection] = seedRules(MAIL, { tone: ["존댓말로 쓴다"], correction: ["2030-03-01: 짧게"] });
	const other = model(() => answer(["R1", "overridden"], ["C1", "overridden"]));
	expect(await learnLine({ app: "mail" }, "반말로  쓴다", "rule", { call: other.learnCall("mail"), analyze: other.learnCall("mail") })).toEqual({ stored: true, kind: "rule", replaced: [], id: expect.any(String) });
	expect(await learnLine({ app: "mail" }, " 존댓말로 쓴다 ", "rule", {})).toEqual({ stored: false, kind: "rule", replaced: [], same: "존댓말로 쓴다" });
	// A correction equal to a line that is on is not added again: the ledger keeps one record and hands back that one.
	expect(await learnLine({ app: "mail" }, "짧게", "correction", { now: day("2030-03-01") })).toEqual({ stored: false, kind: "correction", replaced: [], id: seededCorrection!.id });
	expect(await learnLine({ app: "mail" }, "짧게", "correction", { now: day("2030-03-02") })).toEqual({ stored: true, kind: "correction", replaced: [], id: expect.any(String) });
	expect(other.asked).toEqual([]);
	expect(records(MAIL).map(r => [r.kind, r.text, r.state])).toEqual([["tone", "존댓말로 쓴다", "on"], ["correction", "2030-03-01: 짧게", "on"], ["tone", "반말로 쓴다", "on"], ["correction", "2030-03-02: 짧게", "on"]]);
	expect(existsSync(journalFile())).toBe(false);
});

test("a hand-added section, 금지 and 예시 are never offered to the model; 말투 and 고친 점 are, as R and C lines with their dates, with the new line and its kind", async () => {
	profile("mail.md", "## 정체성\n\n- 교사\n\n## 보낸 사람 신분별\n\n- 팀장에게는 격식체\n\n## 예시\n\n- 안녕하세요 선생님\n");
	seedRules(MAIL, { tone: ["존댓말로 쓴다"], correction: ["2030-03-01: 이모지 쓰지 마"], ban: ["무조건"] });
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
	seedRules("install", { tone: ["끝인사는 짧게 한다"] });
	const same = byAsk(answer(["R1", "same"]));
	const r = await correct({ learnCall: same.learnCall }, "--app", "install", "--rule", "끝인사에 '행복한 하루 되세요'는 쓰지 않고 짧게 끝낸다");
	expect(r.lines).toEqual([`기억했어요: "끝인사에 '행복한 하루 되세요'는 쓰지 않고 짧게 끝낸다" · 범위: 모든 답장 · 이미 있는 조건이에요: 끝인사는 짧게 한다`]);
	expect(same.asked.toSorted()).toEqual(["curate", "pattern"]);
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["끝인사는 짧게 한다"]);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
	expect(records("install").map(r => [r.kind, r.text, r.state])).toEqual([["tone", "끝인사는 짧게 한다", "on"]]);
	const added = await correct({ learnCall: byAsk(answer()).learnCall }, "--app", "install", "--rule", "덕담에 '행복한 하루 되세요'는 쓰지 않는다");
	expect(added.lines).toEqual([expect.stringContaining("표현 규칙으로도 정해 뒀어요: '하루 보내세요'로 쓴다")]);
	expect(profileBullets("install", HEADINGS.forbidden)).toHaveLength(1);
});

const LESSON = "끝인사는 짧게 한다";
const CHANGE = "끝인사에 '행복한 하루 되세요'는 쓰지 말고 짧게 끝내 줘";
async function revisedWith(said: object, learnCall: () => (system: string) => Promise<string>) {
	rmSync(paths.drafts(), { force: true, recursive: true });
	enable(env);
	await offerMailDraft({ ...mailFixture }, { send: () => undefined, call: fakeModel([j(goodReply)]).call });
	const rec = listDrafts()[0]!;
	const model = fakeModel([j({ ...goodReply, body: "곧 알려 드릴게요.", forbid: [], once: false, ...said })]);
	return reviseDraft(rec.id, CHANGE, { call: model.call, learnCall });
}

test("draft.ts revise: a lesson the install profile already has adds no line and keeps no wording pattern, and says it was already there; on an empty profile both are kept", async () => {
	seedRules("install", { tone: [LESSON] });
	const same = byAsk(answer(["R1", "same"]));
	const step = await revisedWith({ scope: "everywhere" }, same.learnCall);
	expect(step.ok).toBe(true);
	expect(same.asked.toSorted()).toEqual(["curate", "pattern"]);
	expect(step.text).toContain(`이미 있는 조건이에요: ${LESSON}`);
	expect(step.text).not.toContain("표현 규칙으로도");
	expect(profileBullets("install", HEADINGS.rules)).toEqual([LESSON]);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
	reset();
	const fresh = await revisedWith({ scope: "everywhere" }, byAsk(answer()).learnCall);
	expect(fresh.text).toContain(`기억했어요: "${CHANGE}" · 범위: 모든 답장`);
	expect(fresh.text).toContain("표현 규칙으로도 정해 뒀어요: '하루 보내세요'로 쓴다");
	expect(profileBullets("install", HEADINGS.forbidden)).toHaveLength(1);
});

test("draft.ts revise: a correction the curation answer overrides goes to the journal, the profile keeps the new line and the note says one condition was replaced", async () => {
	seedRules(MAIL, { correction: ["2030-03-01: 끝인사는 길게 쓴다"] });
	const step = await revisedWith({ scope: "channel" }, byAsk(answer(["C1", "overridden"])).learnCall);
	expect(step.text).toContain(`기억했어요: "${CHANGE}" · 범위: 이 앱 · 기존 조건 1개를 이 조건으로 바꿨어요`);
	const kept = profileBullets({ app: "mail" }, HEADINGS.corrections);
	expect(kept).toHaveLength(1);
	expect(kept[0]).toMatch(/^\d{4}-\d{2}-\d{2}: /);
	expect(kept[0]).toEndWith(CHANGE);
	expect(journalEntries().map(e => [e.line, e.why])).toEqual([["2030-03-01: 끝인사는 길게 쓴다", "overridden"]]);
	const [gone, now] = records(MAIL);
	expect([gone!.state, gone!.into, now!.state, now!.text]).toEqual(["merged", now!.id, "on", kept[0]]);
});

test("a line curation replaces stays in the ledger as a merged record pointing at its replacement, is read as no rule, and --restore puts it back on", async () => {
	seedRules(MAIL, { tone: ["답장은 길게"], correction: ["2030-03-01: 끝인사는 길게 쓴다"] });
	const on = () => [HEADINGS.rules, HEADINGS.corrections].flatMap(h => profileBullets({ app: "mail" }, h));
	await learnLine({ app: "mail" }, "답장은 짧게", "rule", { learnCall: model(() => answer(["R1", "overridden"])).learnCall, now: day("2030-03-04") });
	await learnLine({ app: "mail" }, "인사는 뺀다", "correction", { learnCall: model(() => answer(["C1", "same"])).learnCall, now: day("2030-03-04") });
	expect(on()).toEqual(["답장은 짧게", "2030-03-04: 인사는 뺀다"]);
	const [oldRule, oldCorrection, newRule, newCorrection] = records(MAIL);
	expect([oldRule!.text, oldRule!.state, oldRule!.into, newRule!.text, newRule!.state]).toEqual(["답장은 길게", "merged", newRule!.id, "답장은 짧게", "on"]);
	expect([oldCorrection!.text, oldCorrection!.state, oldCorrection!.into, newCorrection!.text, newCorrection!.state]).toEqual(["2030-03-01: 끝인사는 길게 쓴다", "merged", newCorrection!.id, "2030-03-04: 인사는 뺀다", "on"]);
	const style = loadStyle({ app: "mail" });
	expect([...style.rules, ...style.standing, ...style.corrections].join("\n")).not.toContain("길게");
	const ids = journalEntries().map(e => [e.n, e.line]);
	expect(ids).toEqual([[2, "2030-03-01: 끝인사는 길게 쓴다"], [1, "답장은 길게"]]);
	expect(restoreEntry(1)?.put).toBe(true);
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["답장은 길게", "답장은 짧게"]);
	expect(records(MAIL).map(r => [r.state, r.into])).toEqual([["on", undefined], ["merged", newCorrection!.id], ["on", undefined], ["on", undefined]]);
});

test("a rule and a correction learned for the mail app are one record each at the mail scope that a mail app with its own tone file reads, and a contradicting line of its own is merged by curating there", async () => {
	profile("mail-beta.md", "## 정체성\n- BETA-IDENTITY\n");
	seedRules({ app: "mail-beta" }, { tone: ["답장은 길게"] });
	const m = model(() => answer());
	m.learnCall = (app: string) => async (system: string, user: string) => (m.asked.push({ app, system, user }), user.includes("답장은 길게") ? answer(["R1", "overridden"]) : answer());
	const r = await correct({ learnCall: m.learnCall }, "--app", "mail", "--rule", "답장은 짧게", "--change", "인사는 뺀다");
	expect(r.code).toBe(0);
	expect(records(MAIL).map(x => [x.kind, x.text, x.scope, x.state])).toEqual([["tone", "답장은 짧게", { app: "mail" }, "on"], ["correction", "2030-03-04: 인사는 뺀다", { app: "mail" }, "on"]]);
	expect(readLedger().filter(x => x.scope.app === "mail-beta").map(x => [x.text, x.state])).toEqual([["답장은 길게", "on"]]);
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.corrections)).toEqual([]);
	let style = loadStyle({ app: "mail-beta" });
	expect(style.identity).toEqual(["BETA-IDENTITY"]);
	expect(style.rules).toEqual(expect.arrayContaining(["답장은 짧게", "답장은 길게"]));
	expect(style.corrections).toEqual(["2030-03-04: 인사는 뺀다"]);
	expect(journalEntries()).toEqual([]);
	await correct({ learnCall: m.learnCall }, "--app", "mail-beta", "--rule", "답장은 한 줄로");
	const [own, owner] = readLedger().filter(x => x.scope.app === "mail-beta");
	expect([own!.text, own!.state, own!.into, owner!.text, owner!.state]).toEqual(["답장은 길게", "merged", owner!.id, "답장은 한 줄로", "on"]);
	style = loadStyle({ app: "mail-beta" });
	expect(style.rules).toEqual(expect.arrayContaining(["답장은 짧게", "답장은 한 줄로"]));
	expect(style.rules).not.toContain("답장은 길게");
	expect(loadStyle({ app: "mail" }).rules).not.toContain("답장은 한 줄로");
	expect(journalEntries().map(e => [e.profile, e.line, e.why])).toEqual([["mail-beta.md", "답장은 길게", "overridden"]]);
});

test("a wording forbidden for the mail app is also forbidden in a mail app with its own tone file", async () => {
	profile("mail-beta.md", "## 정체성\n- BETA-IDENTITY\n");
	const r = await correct({}, "--app", "mail", "--forbid", "확인 부탁드립니다");
	expect(r.code).toBe(0);
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual(["확인 부탁드립니다"]);
	expect(readLedger().map(x => [x.kind, x.text, x.scope, x.state])).toEqual([["ban", "확인 부탁드립니다", { app: "mail" }, "on"]]);
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.forbidden)).toEqual([]);
	expect(loadStyle({ app: "mail-beta" }).forbidden).toContain("확인 부탁드립니다");
});

test("an allowed wording and a forgotten line for the mail app are also gone for a mail app with its own tone file", async () => {
	profile("mail-beta.md", "## 정체성\n- BETA-IDENTITY\n");
	seedRules(MAIL, { tone: ["답장은 짧게"], correction: ["2030-03-01: 짧게 끝낸다"], ban: ["확인 부탁드립니다"] });
	expect(loadStyle({ app: "mail-beta" }).forbidden).toEqual(["확인 부탁드립니다"]);
	const r = await correct({}, "--app", "mail", "--allow", "확인 부탁드립니다", "--forget", "짧게");
	expect(r.code).toBe(0);
	expect(records(MAIL).map(x => x.state)).toEqual(["off", "off", "off"]);
	for (const app of ["mail", "mail-beta"]) {
		expect(profileBullets({ app }, HEADINGS.forbidden)).toEqual([]);
		expect(profileBullets({ app }, HEADINGS.rules)).toEqual([]);
		expect(profileBullets({ app }, HEADINGS.corrections)).toEqual([]);
		const style = loadStyle({ app });
		expect([style.forbidden, style.rules, style.corrections]).toEqual([[], [], []]);
	}
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.identity)).toEqual(["BETA-IDENTITY"]);
});
