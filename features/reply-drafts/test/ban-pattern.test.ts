import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Ban, banBullet, banHit, parseBan } from "../../../hub/ban.ts";
import type { Msg } from "../../../hub/kakao/types.ts";
import { runDraft } from "../bin/draft.ts";
import { advance, flush } from "../../../hub/runtime/test-clock.ts";
import { learnLine, ownerWarning, proposeLinePattern } from "../lib/flow.ts";
import { learn } from "../lib/learn.ts";
import { HEADINGS, loadStyle, paths, profileBullets, recordForbidden, recordRule, savePairs } from "../lib/settings.ts";
import { j, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	rmSync(paths.toneDir(), { force: true, recursive: true });
	rmSync(paths.pairs("mail"), { force: true });
});

const RULE = "'~ 되세요', '~ 되시길', '~ 되시기를'로 맺는 덕담은 비문이라 절대 쓰지 않는다. 틀린 예: '즐거운 공연 되세요', '즐거운 시간 되세요'. 맞는 예: '즐거운 공연 시간 보내세요~!', '즐거운 성탄절 보내시길 바랍니다'";
const LABEL = "덕담은 '~ 보내세요', '~ 보내시길 바랍니다'로 맺는다";
const PARTS = [{ any: ["좋은", "즐거운", "행복한", "편안한"] }, { gap: 10 }, { any: ["되세요", "되시길", "되시기를"], notAfter: ["이", "가"] }];
const PROPOSAL = { parts: PARTS, label: LABEL, bad: ["즐거운 공연 되세요", "즐거운 시간 되세요"], good: ["즐거운 공연 시간 보내세요~!", "즐거운 성탄절 보내시길 바랍니다"] };
const K1_BAN: Ban = { kind: "shape", shape: { parts: PARTS }, label: LABEL };
const K1_BULLET = `shape ${JSON.stringify({ parts: PARTS, label: LABEL })}`;
const runner = (answer: object | null) => {
	const asked: string[] = [];
	return { asked, learnCall: (app: string) => async (_system: string, user: string) => (asked.push(`${app}: ${user}`), answer === null ? "null" : j(answer)) };
};
const correct = (deps: object, ...args: string[]) => runDraft(["correct", ...args], "", { now: () => new Date("2030-03-04T00:00:00Z"), ...deps });
const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);

test("correct --rule with a fake runner stores the K1 shape bullet that tone --app install lists as a wording rule by its label", async () => {
	const fake = runner(PROPOSAL);
	const r = await correct({ learnCall: fake.learnCall }, "--app", "install", "--rule", RULE);
	expect(r.code).toBe(0);
	expect(r.lines.join("\n")).toContain(`표현 규칙으로도 정해 뒀어요: ${LABEL}`);
	expect(fake.asked).toHaveLength(1);
	expect(fake.asked[0]).toStartWith("install: ");
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([K1_BULLET]);
	expect(parseBan(K1_BULLET)).toEqual(K1_BAN);
	expect(profileBullets("install", HEADINGS.rules)).toEqual([RULE]);
	const tone = (await runDraft(["tone", "--app", "install"], "")).lines.join("\n");
	expect(tone.slice(tone.indexOf("금지:"))).toContain(`- [install] ${LABEL} (표현 규칙)`);
	expect(tone).not.toContain('"parts"');
	expect(loadStyle({ app: "youtube" }).forbidden).toEqual([K1_BULLET]);
});

test("the same pattern proposed again is stored once; --allow with its label takes it out", async () => {
	const fake = runner(PROPOSAL);
	await correct({ learnCall: fake.learnCall }, "--app", "youtube", "--rule", RULE);
	await correct({ learnCall: fake.learnCall }, "--app", "youtube", "--change", RULE);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toHaveLength(1);
	const gone = await correct({}, "--app", "youtube", "--allow", LABEL);
	expect(gone.lines).toEqual([`youtube의 금지 표현에서 뺐어요: "${LABEL}"`]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toEqual([]);
});

test("correct --change stores the pattern in the profile of the correction (a room), never in the app", async () => {
	await correct({ learnCall: runner(PROPOSAL).learnCall }, "--app", "kakao", "--room", "r1", "--change", RULE);
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.forbidden).map(parseBan)).toEqual([K1_BAN]);
	expect(profileBullets({ app: "kakao" }, HEADINGS.forbidden)).toEqual([]);
});

test("a rule that is not about a wording, or a proposal code refuses, stores the rule alone and says nothing of a pattern", async () => {
	const log = quiet();
	for (const answer of [null, { ...PROPOSAL, good: [...PROPOSAL.good, "즐거운 시간 되세요"] }, { ...PROPOSAL, bad: ["좋은 하루 되세요"] }, { source: "되세요", flags: "u", label: LABEL, bad: PROPOSAL.bad, good: [] }]) {
		rmSync(paths.toneDir(), { force: true, recursive: true });
		const r = await correct({ learnCall: runner(answer).learnCall }, "--app", "install", "--rule", RULE);
		expect(r.lines.join("\n")).not.toContain("표현 규칙으로도");
		expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
		expect(profileBullets("install", HEADINGS.rules)).toEqual([RULE]);
	}
	log.mockRestore();
});

test("without a runner correct makes no call and old literal and hand-written bans stay as they were", async () => {
	recordForbidden("install", ["행복한 하루 되세요", "/되(세요|시길)/"]);
	const r = await correct({}, "--app", "install", "--rule", RULE, "--forbid", "되세요");
	expect(r.code).toBe(0);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual(["행복한 하루 되세요", "/되(세요|시길)/", "되세요"]);
	expect((await runDraft(["tone", "--app", "install"], "")).lines).toContain("- [install] /되(세요|시길)/");
	expect((await correct({}, "--app", "install", "--allow", "되세요")).lines[0]).toContain("뺐어요");
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual(["행복한 하루 되세요", "/되(세요|시길)/"]);
});

test("a throw while learning a pattern is logged and the --forbid, --allow and --forget after it still run; an explicit --forbid is stored even when a good example uses it", async () => {
	recordForbidden("install", ["무조건"]);
	recordRule("install", "옛 규칙");
	const log = quiet();
	const broken = () => {
		throw new Error("no model");
	};
	const r = await correct({ learnCall: broken }, "--app", "install", "--rule", RULE, "--forbid", "되세요", "--allow", "무조건", "--forget", "옛 규칙");
	expect(r.code).toBe(0);
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("no model")]);
	log.mockRestore();
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual(["되세요"]);
	expect(profileBullets("install", HEADINGS.rules)).toEqual([RULE]);
	rmSync(paths.toneDir(), { force: true, recursive: true });
	await correct({ learnCall: runner(PROPOSAL).learnCall }, "--app", "install", "--rule", RULE, "--forbid", "보내세요");
	expect(profileBullets("install", HEADINGS.forbidden).map(parseBan)).toEqual([K1_BAN, { kind: "literal", text: "보내세요" }]);
});

const HITS = ["좋은 하루 되세요", "즐거운 주말 되세요", "행복한 시간 되세요", "편안한 밤 되세요"];
const own = (chatId: string, text: string, i: number): Msg => ({ logId: `${chatId}-${i}`, chatId, authorId: "me", sender: "나", text, type: 1, sentAt: i, fromMe: true });
const ROOMS: Record<string, Msg[]> = {
	r1: Array.from({ length: 20 }, (_, i) => own("r1", HITS[i % HITS.length]!, i)),
	r2: Array.from({ length: 20 }, (_, i) => own("r2", `내일 봐요 ${i}`, i)),
};
const kakaoReader = async (chatId: string) => ({ messages: async () => ROOMS[chatId] ?? [] });
const kakaoRooms = (rooms: string[]) => async () => ({ messages: async (chatId: string) => ROOMS[chatId] ?? [], rooms: async () => rooms });
const mailPairs = () => savePairs("mail", [...Array.from({ length: 19 }, (_, i) => ({ received: `문의 ${i}`, reply: `확인했습니다 ${i}`, at: i })), { received: "인사", reply: "좋은 하루 되세요", at: 99 }]);
const stored = async (deps: object, ...where: string[]): Promise<boolean> => {
	rmSync(paths.toneDir(), { force: true, recursive: true });
	await correct({ learnCall: runner(PROPOSAL).learnCall, ...deps }, ...where, "--rule", RULE);
	const key = where[1] === "install" ? "install" : { app: where[1]!, ...(where[3] ? { room: where[3] } : {}) };
	return profileBullets(key, HEADINGS.forbidden).length === 1;
};
test("the 15% check reads the replies of the pattern's own scope: a pattern that hits every line of one room but few mails is kept for mail and the other room, refused where that room counts", async () => {
	mailPairs();
	const log = quiet();
	const both = { kakaoReader, kakaoRooms: kakaoRooms(["r1", "r2"]) };
	expect(await stored(both, "--app", "mail")).toBe(true);
	expect(await stored(both, "--app", "kakao", "--room", "r1")).toBe(false);
	expect(await stored(both, "--app", "kakao", "--room", "r2")).toBe(true);
	expect(await stored(both, "--app", "kakao")).toBe(false);
	expect(await stored({ kakaoReader, kakaoRooms: kakaoRooms(["r2"]) }, "--app", "kakao")).toBe(true);
	expect(await stored(both, "--app", "install")).toBe(false);
	expect(await stored({ kakaoReader, kakaoRooms: kakaoRooms(["r2"]) }, "--app", "install")).toBe(true);
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("hits 20 of the owner's 20 past replies"), expect.stringContaining("hits 20 of the owner's 40 past replies"), expect.stringContaining("hits 21 of the owner's 60 past replies")]);
	log.mockRestore();
});

test("a lesson that holds everywhere is checked against every reply, the same as the install profile by name", async () => {
	mailPairs();
	const log = quiet();
	const deps = { learnCall: runner(PROPOSAL).learnCall, kakaoReader, kakaoRooms: kakaoRooms(["r1", "r2"]) };
	expect(await proposeLinePattern({ app: "install" }, RULE, [RULE], deps)).toBeUndefined();
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("hits 21 of the owner's 60 past replies")]);
	log.mockRestore();
});

test("a missing pairs file, reader or room list is an empty corpus, never a throw; a reader that fails is logged and counts as empty", async () => {
	const log = quiet();
	expect(await stored({}, "--app", "youtube")).toBe(true);
	expect(await stored({}, "--app", "kakao", "--room", "r1")).toBe(true);
	expect(await stored({}, "--app", "kakao")).toBe(true);
	expect(await stored({}, "--app", "install")).toBe(true);
	expect(log).not.toHaveBeenCalled();
	expect(await stored({ kakaoReader: async () => Promise.reject(new Error("카톡 연동이 꺼져 있어요")) }, "--app", "kakao", "--room", "r1")).toBe(true);
	expect(await stored({ kakaoRooms: async () => Promise.reject(new Error("카톡 연동이 꺼져 있어요")) }, "--app", "kakao")).toBe(true);
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("카톡 연동이 꺼져 있어요"), expect.stringContaining("카톡 연동이 꺼져 있어요")]);
	log.mockRestore();
});

const lessonShape = { parts: [{ any: ["하루"] }, { gap: 3 }, { any: ["되세요"] }], label: "'하루 보내세요'로 쓴다", bad: ["행복한 하루 되세요"], good: [] };
const KEYS = { channel: { app: "mail" } };
const learnWith = (words: string, evidence: { draft: string; change: string }, deps: object, proposal: { forbid?: string[]; once?: boolean } = {}) => learn({ source: "revise", ref: "R1", keys: KEYS, words, proposal, evidence }, { now: () => new Date("2030-03-04T00:00:00Z"), ...deps });
const SHAPE_BULLET = `shape {"parts":[{"any":["하루"]},{"gap":3},{"any":["되세요"]}],"label":"'하루 보내세요'로 쓴다"}`;
test("learn: a quoted change asks once with the previous draft and the change, and its proposal is written into the lesson's profile only when the line is stored", async () => {
	const fake = runner(lessonShape);
	const evidence = { draft: "오늘도 행복한 하루 되세요!", change: "'되세요' 말고 '보내세요'로" };
	const learnt = await learnWith(evidence.change, evidence, { learnCall: fake.learnCall });
	expect(learnt.text).toContain("표현 규칙으로도 정해 뒀어요: '하루 보내세요'로 쓴다");
	expect(fake.asked).toHaveLength(1);
	expect(fake.asked[0]).toContain("오늘도 행복한 하루 되세요!");
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual([SHAPE_BULLET]);
	rmSync(paths.toneDir(), { force: true, recursive: true });
	const once = await learnWith(evidence.change, evidence, { learnCall: fake.learnCall }, { once: true });
	expect(once.state).toBe("once");
	expect(fake.asked).toHaveLength(1);
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual([]);
	const unasked = await learnWith(evidence.change, evidence, {});
	expect(unasked.text).not.toContain("표현 규칙으로도");
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual([]);
});

test("learn: a bad example the draft and the change never quoted stores no pattern", async () => {
	const log = quiet();
	const fake = runner(lessonShape);
	const learnt = await learnWith("끝인사는 '보내세요'로 바꿔 줘", { draft: "확인했습니다. 감사합니다.", change: "끝인사는 '보내세요'로 바꿔 줘" }, { learnCall: fake.learnCall });
	expect(learnt.state).toBe("remembered");
	expect(learnt.text).not.toContain("표현 규칙으로도");
	expect(fake.asked).toHaveLength(1);
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual([]);
	log.mockRestore();
});

test("learn: no quote in the change and no banned word makes no pattern call", async () => {
	const fake = runner(lessonShape);
	const learnt = await learnWith("끝인사 짧게 해 줘", { draft: "오늘도 행복한 하루 되세요!", change: "끝인사 짧게 해 줘" }, { learnCall: fake.learnCall });
	expect(learnt.state).toBe("remembered");
	expect(fake.asked).toEqual([]);
});

test("learn: a banned word one of the kept good examples uses is not stored as a literal ban; a word inside the shape's own wordings is not either", async () => {
	const fake = runner({ ...lessonShape, good: ["좋은 하루 보내세요"] });
	const evidence = { draft: "오늘도 행복한 하루 되세요!", change: "'되세요' 말고 '좋은 하루 보내세요'처럼 써 줘, 감사합니다도 빼" };
	const learnt = await learnWith(evidence.change, evidence, { learnCall: fake.learnCall }, { forbid: ["되세요", "하루", "감사합니다"] });
	expect(learnt.text).toContain("쓰지 않을 표현: '되세요', '감사합니다'");
	expect(learnt.text).not.toContain("'하루'");
	expect(fake.asked[0]).toContain(evidence.change);
});

test("learn waits 12 s for a pattern at most: a later answer leaves no pattern, one log line and nothing stored when it arrives; the same answer on time is stored", async () => {
	const log = quiet();
	const answer = Promise.withResolvers<string>();
	const evidence = { draft: "오늘도 행복한 하루 되세요!", change: "'되세요' 말고" };
	let settled = false;
	const pending = learnWith(evidence.change, evidence, { learnCall: () => () => answer.promise }).finally(() => (settled = true));
	await advance(11_999);
	expect(settled).toBe(false);
	await advance(1);
	expect((await pending).state).toBe("remembered");
	answer.resolve(j(lessonShape));
	await flush();
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual([]);
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("no answer within 12000 ms")]);
	log.mockRestore();
	rmSync(paths.toneDir(), { force: true, recursive: true });
	const onTime = await learnWith(evidence.change, evidence, { learnCall: () => () => answer.promise });
	expect(onTime.text).toContain(`표현 규칙으로도 정해 뒀어요: ${lessonShape.label}`);
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toHaveLength(1);
});

test("the owner reads a broken wording rule as a rule he set, and a hand-written regex as he wrote it", () => {
	expect(ownerWarning(`it breaks the owner's wording rule '${LABEL}'`)).toBe(`정해 둔 표현 규칙과 달라요: ${LABEL}`);
	expect(ownerWarning("it uses the forbidden expression '무조건'")).toBe("쓰지 않기로 한 표현 '무조건'이(가) 있어요");
	expect(ownerWarning("it uses the forbidden expression '/되세요/'")).toBe("쓰지 않기로 한 표현 '/되세요/'이(가) 있어요");
});

test("a 금지 line with the 내용: marker is a content ban: it reads back as one, no wording finds it", () => {
	const ban = parseBan("내용: 용도를 묻지 않기");
	expect(ban).toEqual({ kind: "content", text: "용도를 묻지 않기" });
	expect(banBullet(ban)).toBe("내용: 용도를 묻지 않기");
	expect(banHit("용도를 묻지 않기", ban)).toBe(false);
	expect(parseBan("내용:").kind).toBe("literal");
});

test("a lesson phrased as a prohibition is stored as a content ban under 금지, never as a dated 고친 점", async () => {
	await learnLine({ app: "mail" }, "용도를 묻지 않기", "correction", {});
	await learnLine({ app: "mail" }, "자료 메일에는 짧게 써요", "correction", {});
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual(["내용: 용도를 묻지 않기"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toHaveLength(1);
	expect(loadStyle({ app: "mail" }).forbidden).toEqual(["내용: 용도를 묻지 않기"]);
});
