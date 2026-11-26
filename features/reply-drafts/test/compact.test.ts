import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { promptCorrections } from "../../../hub/reply-draft.ts";
import { advance } from "../../../hub/runtime/test-clock.ts";
import { runDraft } from "../bin/draft.ts";
import { compactCorrections, compactFailures, compactForPrompt } from "../lib/compact.ts";
import { journalEntries } from "../lib/curate.ts";
import { refineAfterCorrection } from "../lib/flow.ts";
import { HEADINGS, paths, profileBullets, recordCorrection, toneFile } from "../lib/settings.ts";
import { setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	rmSync(paths.toneDir(), { force: true, recursive: true });
	rmSync(paths.compactFailed(), { force: true });
});

const ROOM = { app: "kakao", room: "r1" };
const journalFile = () => join(paths.toneDir(), "journal.jsonl");
const day = (d: string) => () => new Date(`${d}T09:00:00Z`);
const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);
const model = (reply: () => Promise<string> | string, onAsk?: () => void) => {
	const asked: { app: string; user: string }[] = [];
	return { asked, learnCall: (app: string) => async (_system: string, user: string) => (asked.push({ app, user }), onAsk?.(), reply()) };
};

const THIRTEEN = [
	"2030-01-01: 끝인사는 짧게",
	"2030-01-02: 고럼고럼❤",
	"2030-01-03: 이모지 쓰지 마",
	"2030-01-04: 끝인사 한 줄만",
	"2030-01-05: 감사합니다 빼고",
	"2030-01-06: 존댓말로",
	"2030-01-07: 이 노래 제목은 빼",
	"2030-01-08: 이모지는 하나까지 괜찮아",
	"2030-01-09: 오늘 몇 시에 보내?",
	"2030-01-10: 존댓말로 써 줘",
	"2030-01-11: 첨부 파일 이름은 빼",
	"2030-01-12: 끝인사는 한 줄로",
	"2030-01-13: 마감 날짜는 꼭 적어",
];
const md = (corrections: string[]) => `## 말투\n\n- 반말 금지\n\n## 고친 점\n\n${corrections.map(c => `- ${c}`).join("\n")}\n\n## 보낸 사람 신분별\n\n- 팀장에게는 격식체\n\n## 금지\n\n- 무조건\n`;
const write = (corrections: string[]) => {
	mkdirSync(join(paths.toneDir(), "kakao"), { recursive: true });
	writeFileSync(toneFile(ROOM), md(corrections));
};
const fileNow = () => readFileSync(toneFile(ROOM), "utf8");

type Line = { text: string; sources: string[] };
type Drop = { id: string; why: string };
const LINES: Line[] = [
	{ text: "끝인사는 한 줄로 짧게", sources: ["C1", "C4", "C12"] },
	{ text: "이모지는 하나까지", sources: ["C8"] },
	{ text: "존댓말로 쓴다", sources: ["C6", "C10"] },
	{ text: "일정 메일에는 마감 날짜를 꼭 적는다", sources: ["C13"] },
];
const DROPPED: Drop[] = [
	{ id: "C2", why: "one-off" },
	{ id: "C3", why: "duplicate" },
	{ id: "C5", why: "one-off" },
	{ id: "C7", why: "one-off" },
	{ id: "C9", why: "not a rule" },
	{ id: "C11", why: "one-off" },
];
const answer = (lines: Line[] = LINES, dropped: Drop[] = DROPPED) => JSON.stringify({ lines, dropped });
const COMPACTED = ["2030-01-08: 이모지는 하나까지", "2030-01-10: 존댓말로 쓴다", "2030-01-12: 끝인사는 한 줄로 짧게", "2030-01-13: 일정 메일에는 마감 날짜를 꼭 적는다"];

test("a correction a compaction keeps word for word is not written to the journal", async () => {
	write(THIRTEEN);
	const kept = [...LINES.slice(0, 3), { text: "마감 날짜는 꼭 적어", sources: ["C13"] }];
	await compactCorrections(ROOM, { learnCall: model(() => answer(kept, DROPPED)).learnCall, now: day("2030-02-01") }, { force: true });
	expect(profileBullets(ROOM, HEADINGS.corrections)).toContain("2030-01-13: 마감 날짜는 꼭 적어");
	expect(journalEntries().map(e => e.line)).not.toContain("2030-01-13: 마감 날짜는 꼭 적어");
	expect(journalEntries()).toHaveLength(12);
});

test("13 corrections and a valid answer leave the merged lines dated by their newest source, 13 journal entries, and a dropped line comes back with --restore", async () => {
	write(THIRTEEN);
	const m = model(() => `\`\`\`json\n${answer()}\n\`\`\``);
	const out = await runDraft(["correct", "--app", "kakao", "--room", "r1", "--tidy"], "", { learnCall: m.learnCall, now: day("2030-02-01") });
	expect(out).toEqual({ lines: ["고친 점 13줄을 4줄로 정리했어요 (지운 줄은 tone --journal에 남아 있어요)"], code: 0 });
	expect(m.asked).toHaveLength(1);
	expect(fileNow()).toBe(md(COMPACTED));
	expect(promptCorrections(profileBullets(ROOM, HEADINGS.corrections), 4000)).toEqual([...COMPACTED].reverse());
	const entries = journalEntries();
	expect(entries).toHaveLength(13);
	const byLine = new Map(entries.map(e => [e.line, [e.by, e.why, e.newLine, e.profile, e.heading, e.at]]));
	const merged = (newLine: string) => ["compact", "merged", newLine, "kakao/r1.md", HEADINGS.corrections, "2030-02-01T09:00:00.000Z"];
	const dropped = ["compact", "dropped", "", "kakao/r1.md", HEADINGS.corrections, "2030-02-01T09:00:00.000Z"];
	expect(Object.fromEntries(byLine)).toEqual({
		"2030-01-01: 끝인사는 짧게": merged("2030-01-12: 끝인사는 한 줄로 짧게"),
		"2030-01-02: 고럼고럼❤": dropped,
		"2030-01-03: 이모지 쓰지 마": dropped,
		"2030-01-04: 끝인사 한 줄만": merged("2030-01-12: 끝인사는 한 줄로 짧게"),
		"2030-01-05: 감사합니다 빼고": dropped,
		"2030-01-06: 존댓말로": merged("2030-01-10: 존댓말로 쓴다"),
		"2030-01-07: 이 노래 제목은 빼": dropped,
		"2030-01-08: 이모지는 하나까지 괜찮아": merged("2030-01-08: 이모지는 하나까지"),
		"2030-01-09: 오늘 몇 시에 보내?": dropped,
		"2030-01-10: 존댓말로 써 줘": merged("2030-01-10: 존댓말로 쓴다"),
		"2030-01-11: 첨부 파일 이름은 빼": dropped,
		"2030-01-12: 끝인사는 한 줄로": merged("2030-01-12: 끝인사는 한 줄로 짧게"),
		"2030-01-13: 마감 날짜는 꼭 적어": merged("2030-01-13: 일정 메일에는 마감 날짜를 꼭 적는다"),
	});
	const shown = (await runDraft(["tone", "--journal"], "")).lines;
	const gone = entries.find(e => e.line === "2030-01-02: 고럼고럼❤")!;
	expect(shown).toContain(`${gone.n}. [kakao 대화방] 고친 점 "2030-01-02: 고럼고럼❤" → 지움 (2030-02-01)`);
	const first = entries.find(e => e.line === "2030-01-01: 끝인사는 짧게")!;
	expect(shown).toContain(`${first.n}. [kakao 대화방] 고친 점 "2030-01-01: 끝인사는 짧게" → "2030-01-12: 끝인사는 한 줄로 짧게" (2030-02-01)`);
	expect((await runDraft(["correct", "--restore", String(gone.n)], "")).lines).toEqual(['되돌렸어요: [kakao 대화방] 고친 점 "2030-01-02: 고럼고럼❤"']);
	expect(profileBullets(ROOM, HEADINGS.corrections)).toEqual([...COMPACTED, "2030-01-02: 고럼고럼❤"]);
	expect(journalEntries().find(e => e.n === gone.n)?.restoredAt).toBeDefined();
});

test("the prompt lists only the 고친 점 lines as C1.. with their dates, fenced as data; 말투, 금지 and a hand-added section are never in it", async () => {
	write(THIRTEEN);
	const m = model(() => answer());
	await compactCorrections(ROOM, { learnCall: m.learnCall, now: day("2030-02-01") });
	const prompt = m.asked[0]!.user;
	expect(m.asked[0]!.app).toBe("kakao");
	expect(prompt).toContain(["<<<CORRECTIONS", ...THIRTEEN.map((c, i) => `C${i + 1}. ${c}`), "CORRECTIONS>>>"].join("\n"));
	for (const hidden of ["반말 금지", "팀장에게는 격식체", "무조건"]) expect(prompt).not.toContain(hidden);
	expect(prompt).toContain('{"lines":[{"text":"...","sources":["C1","C4"]}],"dropped":[{"id":"C3","why":"one-off"|"not a rule"|"duplicate"}]}');
});

const refusals: [string, string][] = [
	["nine lines", answer([...LINES, ...["C2", "C3", "C5", "C7", "C9"].map(id => ({ text: `줄 ${id}`, sources: [id] }))], [{ id: "C11", why: "one-off" }])],
	["a line break inside a text", answer([{ ...LINES[0]!, text: "끝인사는\n짧게" }, ...LINES.slice(1)])],
	["an empty text", answer([{ ...LINES[0]!, text: "  " }, ...LINES.slice(1)])],
	["a text of 289 code points", answer([{ ...LINES[0]!, text: "😀".repeat(289) }, ...LINES.slice(1)])],
	["an answer that keeps no line", JSON.stringify({ lines: [], dropped: THIRTEEN.map((_, i) => ({ id: `C${i + 1}`, why: "one-off" })) })],
	["an id that does not exist", answer(LINES, [...DROPPED, { id: "C14", why: "one-off" }])],
	["a line in neither lines nor dropped", answer(LINES.slice(0, 3), DROPPED)],
	["an id twice", answer(LINES, [...DROPPED, { id: "C1", why: "duplicate" }])],
	["a line without a source", answer([...LINES, { text: "새 조건", sources: [] }])],
	["a drop for an unknown reason", answer(LINES, [...DROPPED.slice(1), { id: "C2", why: "boring" }])],
	["no dropped list", JSON.stringify({ lines: LINES })],
	["no JSON", "C2는 지우세요"],
];

for (const [what, reply] of refusals) {
	test(`an answer with ${what} changes nothing and logs one line`, async () => {
		write(THIRTEEN);
		const log = quiet();
		const got = await compactCorrections(ROOM, { learnCall: model(() => reply).learnCall, now: day("2030-02-01") });
		const lines = log.mock.calls.map(c => String(c[0]));
		log.mockRestore();
		expect(got).toBeUndefined();
		expect(fileNow()).toBe(md(THIRTEEN));
		expect(existsSync(journalFile())).toBe(false);
		expect(lines).toEqual([expect.stringMatching(/^reply draft: corrections of kakao\/r1\.md not compacted: /)]);
	});
}

test("a 고친 점 section that holds a note or a sub-heading beside its bullets is left as it is, with no journal entry", async () => {
	const log = quiet();
	for (const extra of ["메모: 아래는 손으로 정리한 것", "### 메일", "  이어지는 줄"]) {
		rmSync(paths.toneDir(), { force: true, recursive: true });
		mkdirSync(join(paths.toneDir(), "kakao"), { recursive: true });
		const before = md(THIRTEEN).replace("- 2030-01-02: 고럼고럼❤", `- 2030-01-02: 고럼고럼❤\n${extra}`);
		writeFileSync(toneFile(ROOM), before);
		expect(await compactCorrections(ROOM, { learnCall: model(() => answer(LINES, DROPPED)).learnCall })).toBeUndefined();
		expect(fileNow()).toBe(before);
		expect(existsSync(journalFile())).toBe(false);
	}
	log.mockRestore();
});

test("a text of exactly 288 code points (300 with its date) and a leading date the model wrote are accepted; the line is dated by its sources", async () => {
	write(THIRTEEN);
	const long = "😀".repeat(288);
	const got = await compactCorrections(ROOM, { learnCall: model(() => answer([{ ...LINES[0]!, text: long }, { ...LINES[1]!, text: "1999-01-01: 이모지는 하나까지" }, ...LINES.slice(2)])).learnCall });
	expect(got).toEqual({ before: 13, after: 4 });
	expect(profileBullets(ROOM, HEADINGS.corrections)).toEqual([COMPACTED[0], COMPACTED[1], `2030-01-12: ${long}`, COMPACTED[3]]);
});

test("12 corrections make no call without force; with force they are compacted; one correction is never compacted", async () => {
	write(THIRTEEN.slice(0, 12));
	const twelve: Line[] = [{ text: "끝인사는 한 줄로", sources: ["C1", "C4", "C12"] }, { text: "존댓말로", sources: ["C6", "C10"] }, { text: "이모지는 하나까지", sources: ["C8"] }];
	const m = model(() => answer(twelve, DROPPED));
	expect(await compactCorrections(ROOM, { learnCall: m.learnCall })).toBeUndefined();
	expect(m.asked).toEqual([]);
	expect(fileNow()).toBe(md(THIRTEEN.slice(0, 12)));
	expect(await compactCorrections(ROOM, { learnCall: m.learnCall }, { force: true })).toEqual({ before: 12, after: 3 });
	expect(profileBullets(ROOM, HEADINGS.corrections)).toEqual(["2030-01-08: 이모지는 하나까지", "2030-01-10: 존댓말로", "2030-01-12: 끝인사는 한 줄로"]);
	write(THIRTEEN.slice(0, 1));
	const one = model(() => answer([{ text: "짧게", sources: ["C1"] }], []));
	expect(await compactCorrections(ROOM, { learnCall: one.learnCall }, { force: true })).toBeUndefined();
	expect(one.asked).toEqual([]);
	expect((await runDraft(["correct", "--app", "kakao", "--room", "r1", "--tidy"], "", { learnCall: one.learnCall })).lines).toEqual(["정리할 것이 없어요"]);
	expect(fileNow()).toBe(md(THIRTEEN.slice(0, 1)));
});

test("a correction stored while the model is asked wins: the compaction is skipped and nothing is journalled", async () => {
	write(THIRTEEN);
	const log = quiet();
	const m = model(() => answer(), () => recordCorrection(ROOM, "새로 배운 점", new Date("2030-01-14T09:00:00Z")));
	expect(await compactCorrections(ROOM, { learnCall: m.learnCall })).toBeUndefined();
	const lines = log.mock.calls.map(c => String(c[0]));
	log.mockRestore();
	expect(profileBullets(ROOM, HEADINGS.corrections)).toEqual([...THIRTEEN, "2030-01-14: 새로 배운 점"]);
	expect(existsSync(journalFile())).toBe(false);
	expect(lines).toEqual([expect.stringMatching(/not compacted: its lines changed while the model was asked/)]);
});

test("a thrown call, a call factory that throws and a call that never answers (30 s) change nothing; the CLI says the answer could not be used", async () => {
	const tried = async (learnCall: (app: string) => (s: string, u: string) => Promise<string>, wait?: boolean) => {
		write(THIRTEEN);
		const log = quiet();
		const running = compactCorrections(ROOM, { learnCall });
		if (wait) await advance(30_000);
		const got = await running;
		const lines = log.mock.calls.map(c => String(c[0]));
		log.mockRestore();
		expect(got).toBeUndefined();
		expect(fileNow()).toBe(md(THIRTEEN));
		expect(existsSync(journalFile())).toBe(false);
		return lines;
	};
	expect(await tried(model(() => Promise.reject(new Error("모델 없음"))).learnCall)).toEqual([expect.stringMatching(/not compacted: 모델 없음/)]);
	const factory = () => {
		throw new Error("호출 없음");
	};
	expect(await tried(factory)).toEqual([expect.stringMatching(/not compacted: 호출 없음/)]);
	expect(await tried(model(() => new Promise<string>(() => undefined)).learnCall, true)).toEqual([expect.stringMatching(/not compacted: no answer within 30s/)]);
	write(THIRTEEN);
	const log = quiet();
	const out = await runDraft(["correct", "--app", "kakao", "--room", "r1", "--tidy"], "", { learnCall: model(() => "모르겠어요").learnCall });
	log.mockRestore();
	expect(out).toEqual({ lines: ["모델의 답을 쓸 수 없어서 고친 점을 그대로 두었어요"], code: 0 });
	expect(fileNow()).toBe(md(THIRTEEN));
});

test("without learnCall nothing is asked and nothing changes, even with force", async () => {
	write(THIRTEEN);
	expect(await compactCorrections(ROOM, {}, { force: true })).toBeUndefined();
	expect(fileNow()).toBe(md(THIRTEEN));
});

test("refineAfterCorrection compacts a long 고친 점, and survives a failing compaction", async () => {
	write(THIRTEEN);
	await refineAfterCorrection(ROOM, { learnCall: model(() => answer()).learnCall });
	expect(profileBullets(ROOM, HEADINGS.corrections)).toEqual(COMPACTED);
	write(THIRTEEN);
	const log = quiet();
	await refineAfterCorrection(ROOM, { learnCall: model(() => Promise.reject(new Error("모델 없음"))).learnCall });
	await refineAfterCorrection({ app: "Not An App" }, { learnCall: model(() => answer()).learnCall });
	const lines = log.mock.calls.map(c => String(c[0]));
	log.mockRestore();
	expect(fileNow()).toBe(md(THIRTEEN));
	expect(lines).toEqual([expect.stringMatching(/not compacted: 모델 없음/), expect.stringMatching(/^reply draft: corrections of Not An App not compacted/)]);
});

describe("before a draft (compactForPrompt)", () => {
	const APP = { app: "kakao" };
	const long = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `2030-01-${String(i + 1).padStart(2, "0")}: ${tag} ${i} ${"가".repeat(280)}`);
	const writeApp = (corrections: string[]) => writeFileSync(toneFile(APP), md(corrections));
	test("a profile over 12 lines is compacted with no new correction, once; one at or under 12 that fits costs no call", async () => {
		write(THIRTEEN.slice(0, 12));
		const none = model(() => answer());
		expect(await compactForPrompt(ROOM, { learnCall: none.learnCall })).toBe(0);
		expect(none.asked).toHaveLength(0);
		write(THIRTEEN);
		const m = model(() => answer());
		expect(await compactForPrompt(ROOM, { learnCall: m.learnCall, now: day("2030-02-01") })).toBe(0);
		expect(m.asked).toHaveLength(1);
		expect(profileBullets(ROOM, HEADINGS.corrections)).toEqual(COMPACTED);
		expect(await compactForPrompt(ROOM, { learnCall: m.learnCall })).toBe(0);
		expect(m.asked).toHaveLength(1);
	});
	test("levels that together pass the prompt's budget are compacted first; what still does not fit is counted and logged", async () => {
		write(long("방", 7));
		writeApp(long("앱", 7));
		const log = quiet();
		const refused = model(() => "모르겠어요");
		expect(await compactForPrompt(ROOM, { learnCall: refused.learnCall, now: day("2030-02-01") })).toBe(1);
		expect(refused.asked).toHaveLength(2);
		expect(log.mock.calls.map(c => String(c[0])).filter(l => /left out/.test(l))).toHaveLength(1);
		log.mockRestore();
		const folds = model(() => answer([{ text: "방에서는 짧게", sources: ["C1", "C2", "C3", "C4", "C5", "C6", "C7"] }], []));
		expect(await compactForPrompt(ROOM, { learnCall: folds.learnCall, now: day("2030-02-03") })).toBe(0);
		expect(folds.asked).toHaveLength(1);
		expect(profileBullets(ROOM, HEADINGS.corrections).length + profileBullets(APP, HEADINGS.corrections).length).toBe(8);
		rmSync(toneFile(APP), { force: true });
	});
	test("a failed compaction is kept on record, waits a day before a draft tries it again, is retried by the next correction, and is cleared when one works", async () => {
		write(THIRTEEN);
		const log = quiet();
		const bad = model(() => "모르겠어요");
		await compactForPrompt(ROOM, { learnCall: bad.learnCall, now: day("2030-02-01") });
		expect(compactFailures()).toEqual([{ profile: "kakao/r1.md", at: "2030-02-01T09:00:00.000Z", lines: 13, why: expect.stringContaining("not usable") }]);
		await compactForPrompt(ROOM, { learnCall: bad.learnCall, now: () => new Date("2030-02-02T08:00:00Z") });
		expect(bad.asked).toHaveLength(1);
		await compactCorrections(ROOM, { learnCall: bad.learnCall, now: () => new Date("2030-02-02T08:00:00Z") });
		expect(bad.asked).toHaveLength(2);
		await compactForPrompt(ROOM, { learnCall: bad.learnCall, now: day("2030-02-04") });
		expect(bad.asked).toHaveLength(3);
		log.mockRestore();
		await compactForPrompt(ROOM, { learnCall: model(() => answer()).learnCall, now: day("2030-02-05") });
		expect(profileBullets(ROOM, HEADINGS.corrections)).toEqual(COMPACTED);
		expect(compactFailures()).toEqual([]);
	});
});

const TEXTS = ["끝인사는 짧게", "존댓말로 쓴다", "이모지 😀 하나", "\"따옴표\" $(rm) `x`", "", " ", "줄\n바꿈", "2030-05-05: 날짜 붙은 줄", "가".repeat(300), "가".repeat(301)];
test("property: for any answer the code applies, the original lines equal (as a multiset) the journalled lines, and every kept line is the newLine of a merged entry", async () => {
	const log = quiet();
	const bullet = fc.tuple(fc.constantFrom("2030-01-01", "2030-01-02", "2030-01-03"), fc.constantFrom("짧게", "길게", "고럼고럼❤", "감사합니다 빼고")).map(([d, t]) => `${d}: ${t}`);
	const scenario = fc.array(bullet, { minLength: 2, maxLength: 14 }).chain(bullets =>
		fc.record({
			bullets: fc.constant(bullets),
			groups: fc.array(fc.oneof({ arbitrary: fc.integer({ min: -1, max: 3 }), weight: 12 }, { arbitrary: fc.integer({ min: -1, max: 10 }), weight: 1 }), { minLength: bullets.length, maxLength: bullets.length }),
			texts: fc.array(fc.oneof({ arbitrary: fc.constantFrom(...TEXTS.slice(0, 4)), weight: 12 }, { arbitrary: fc.constantFrom(...TEXTS), weight: 1 }), { minLength: 10, maxLength: 10 }),
			why: fc.oneof({ arbitrary: fc.constantFrom("one-off", "not a rule", "duplicate"), weight: 6 }, { arbitrary: fc.constant("boring"), weight: 1 }),
			extra: fc.oneof({ arbitrary: fc.constant<(string | number)[]>([]), weight: 4 }, { arbitrary: fc.array(fc.constantFrom<string | number>("C0", "C1", "C2", "c3", " C4 ", "C15", "X1", 7), { maxLength: 2 }), weight: 1 }),
			fenced: fc.boolean(),
		}),
	);
	let applied = 0;
	await fc.assert(
		fc.asyncProperty(scenario, async ({ bullets, groups, texts, why, extra, fenced }) => {
			rmSync(paths.toneDir(), { force: true, recursive: true });
			write(bullets);
			const id = (i: number) => `C${i + 1}`;
			const lines = Array.from({ length: 10 }, (_, g) => ({ text: texts[g]!, sources: groups.flatMap((x, i) => (x === g ? [id(i)] : [])) })).filter((l, g) => l.sources.length || g === 0);
			lines[0]?.sources.push(...extra.map(String));
			const dropped = groups.flatMap((x, i) => (x === -1 ? [{ id: id(i), why }] : []));
			const json = JSON.stringify({ lines, dropped });
			const got = await compactCorrections(ROOM, { learnCall: model(() => (fenced ? `\`\`\`json\n${json}\n\`\`\`` : json)).learnCall }, { force: true });
			const section = profileBullets(ROOM, HEADINGS.corrections);
			if (!got) {
				expect(fileNow()).toBe(md(bullets));
				expect(existsSync(journalFile())).toBe(false);
				return;
			}
			applied++;
			const named = (ids: string[]) => ids.map(s => bullets[Number(/^C(\d+)$/i.exec(s.trim())?.[1] ?? 0) - 1] ?? `no line ${s}`).sort();
			expect(named([...lines.flatMap(l => l.sources), ...dropped.map(d => d.id)])).toEqual([...bullets].sort());
			expect(got).toEqual({ before: bullets.length, after: section.length });
			expect(section.length).toBeLessThanOrEqual(8);
			const journalled = journalEntries();
			if (!journalled.length) {
				expect(section).toEqual(bullets);
				return;
			}
			expect(journalled.map(e => e.line).sort()).toEqual([...bullets].sort());
			expect(journalled.flatMap(e => (e.why === "dropped" ? [e.line] : [])).sort()).toEqual(named(dropped.map(d => d.id)));
			expect([...new Set(journalled.flatMap(e => (e.why === "merged" ? [e.newLine] : [])))].sort()).toEqual([...new Set(section)].sort());
			for (const l of section) expect([...l.replace(/^\d{4}-\d{2}-\d{2}: /, "")].length).toBeLessThanOrEqual(300);
		}),
		{ numRuns: 150 },
	);
	log.mockRestore();
	expect(applied).toBeGreaterThan(30);
});
