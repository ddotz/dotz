import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messages, ownTextCounts, ownTexts, sqliteDb } from "../../../hub/kakao/db.ts";
import type { DraftModel, VoiceSource } from "../../../hub/kakao/draft.ts";
import { addMessage, BASE_LOG, BASE_TIME, makeFixtureDb, OWNER, ROOM } from "../../../hub/kakao/fixture.ts";
import { cleanLines, enableKakaoApp, ensureKakaoVoice, isJunkLine, parseProfile, STALE_AFTER, voiceExamples, voiceStats } from "../lib/kakao-voice.ts";
import { loadSettings, loadStyle, paths, roomFile, toneFile } from "../lib/settings.ts";
import { enable, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.config(), paths.toneDir()]) rmSync(p, { force: true, recursive: true });
});

const DIRECT = String(ROOM.direct);
const GROUP = String(ROOM.group);
const CASUAL = ["ㅇㅇ", "아니 그건 좀ㅋㅋ", "근데 언제?", "ㅇㅋ 그래", "ㄱㄱ", "응 나도 갈게", "ㅇㅇ", "아니 몰라ㅋㅋ", "근데 뭐 먹지", "ㅇㅇ 그래~", "오 좋다ㅋㅋ", "아니 근데 진짜?"];
const JUNK = ["속도 시험 3", "01012345678", "https://example.com/a"];
const PROFILE = ["상대는 일정을 존댓말로 묻는 지인이고 주제는 약속과 일정", "이 방에서는 반말로 짧게 답하고 ㅇㅇ·ㄱㄱ를 자주 씀", "질문에는 한두 마디로 바로 답하고 마침표는 안 씀", "최근에는 ㅋㅋ를 더 자주 붙임"];

// A fixture database where the other side writes formally and the owner casually (direct room) with some junk lines among his, and the owner writes politely in a group.
function fixture() {
	const file = join(env.dir, "kakao.db");
	rmSync(file, { force: true });
	const db = makeFixtureDb(file, { messages: [] });
	let seq = 0;
	const say = (chatId: number, authorId: number, message: string) => {
		seq++;
		addMessage(db, { logId: BASE_LOG + BigInt(1000 + seq), chatId, authorId, message, sentAt: BASE_TIME + seq });
	};
	for (const t of [...CASUAL, ...JUNK]) {
		say(ROOM.direct, 2001, "안녕하세요. 내일 일정 확인 부탁드립니다.");
		say(ROOM.direct, OWNER, t);
	}
	for (const t of ["네 알겠습니다.", "확인했습니다.", "감사합니다", "넵 그렇게 하겠습니다"]) say(ROOM.group, OWNER, t);
	say(ROOM.group, 2002, "그룹 다른 사람의 말 절대 학습 금지");
	const read = sqliteDb(file);
	const asks: { system: string; user: string }[] = [];
	const state = { reply: async (): Promise<{ text: string; inputTokens: number; outputTokens: number }> => ({ text: JSON.stringify({ profile: PROFILE }), inputTokens: 1000, outputTokens: 80 }) };
	const ask: DraftModel = async (system, user) => (asks.push({ system, user }), state.reply());
	const src = (chatId: string, withAsk = true): VoiceSource => ({
		chatId,
		ownCounts: ids => ownTextCounts(read, ids, OWNER),
		ownTexts: (id, limit) => ownTexts(read, id, OWNER, limit),
		messages: (id, limit) => messages(read, id, limit, OWNER),
		...(withAsk ? { ask } : {}),
		recentRooms: async () => [GROUP, DIRECT],
	});
	return { say, src, asks, state, close: () => (read.close(), db.close()) };
}

test("junk lines never count: digits and punctuation only, numbers of 6+ digits, links, test lines and repeated test patterns", () => {
	for (const junk of ["속도 시험 3", "테스트 중", "test 2", "01012345678", "110-123-456789", "3", "...", "?!", "https://example.com", "me@example.com", "코드는 123456이야"]) expect(isJunkLine(junk)).toBe(true);
	for (const fine of ["ㅇㅇ", "그래", "2시에 봐", "ㅋㅋㅋ", "😀"]) expect(isJunkLine(fine)).toBe(false);
	expect(cleanLines(["연결 확인 1", "연결 확인 2", "연결 확인 3", "ㅇㅇ", "ㅇㅇ", "ㅇㅇ"])).toEqual(["ㅇㅇ", "ㅇㅇ", "ㅇㅇ"]);
});

test("voiceStats counts habits of the cleaned own lines; the newest 100 count double", () => {
	const s = voiceStats([...CASUAL, ...CASUAL, ...JUNK]);
	expect(s.lines).toBe(24);
	expect(s.n).toBe(48);
	expect(s.register?.label).toBe("반말");
	expect(s.endings.map(e => e[0])).toContain("ㅋㅋ");
	expect(s.replies.map(r => r[0])).toContain("ㅇㅇ");
	expect(s.words.map(w => w[0])).toContain("근데");
	expect(s.words.map(w => w[0])).not.toContain("시험");

	const word = (i: number) => String.fromCharCode(0xac00 + i * 7, 0xb000 + i);
	const recentLaugh = Array.from({ length: 100 }, (_, i) => `응 ${word(i)}ㅋㅋ`);
	const older = Array.from({ length: 100 }, (_, i) => `응 ${word(i + 100)} 그래`);
	expect(voiceStats([...recentLaugh, ...older]).rates["ㅋㅋ"]).toBe(67);
	expect(voiceStats([...older, ...recentLaugh]).rates["ㅋㅋ"]).toBe(33);
});

test("voiceExamples keeps short lines like ㅇㅇ, dedupes, and drops junk", () => {
	expect(voiceExamples(["ㅇㅇ", "ㅇㅇ", "https://example.com", "01012345678", "속도 시험 3", "그래"])).toEqual(["ㅇㅇ", "그래"]);
});

test("parseProfile keeps short Korean lines, drops lines with digit strings or links, and wants at least three", () => {
	const text = JSON.stringify({ profile: ["반말로 짧게 답함", "계좌 110123456789 로 보냄", "링크 https://x.co 를 잘 보냄", "ㅋㅋ를 자주 씀", "질문엔 바로 답함"] });
	expect(parseProfile(text)).toEqual(["반말로 짧게 답함", "ㅋㅋ를 자주 씀", "질문엔 바로 답함"]);
	expect(parseProfile(JSON.stringify({ profile: ["하나", "둘"] }))).toBeUndefined();
	expect(parseProfile("not json")).toBeUndefined();
});

test("first draft: the model reads the room as pairs once and writes the profile; the counted facts, examples and record are cached beside it", async () => {
	const f = fixture();
	const first = await ensureKakaoVoice(f.src(DIRECT), new Date("2026-10-23T00:00:00Z"));
	expect(first).toMatchObject({ room: true, global: true, mode: "learn", tokens: { in: 1000, out: 80 } });
	expect(f.asks).toHaveLength(1);
	const input = f.asks[0]!.user;
	expect(input).toContain("상대: 안녕하세요. 내일 일정 확인 부탁드립니다.\n나: 아니 그건 좀ㅋㅋ");
	for (const junk of JUNK) expect(input).not.toContain(junk);
	expect(input).not.toContain("절대 학습 금지");

	const roomFileName = toneFile({ app: "kakao", room: DIRECT });
	const room = readFileSync(roomFileName, "utf8");
	expect(room).toContain("## 대화 이해");
	for (const line of PROFILE) expect(room).toContain(`- ${line}`);
	expect(room).toMatch(/own=15 v=2 model=ok at=2026-10-23T00:00:00/);
	expect(room).toContain("- ㅇㅇ");
	for (const junk of [...JUNK, "안녕하세요"]) expect(room).not.toContain(junk);
	const global = readFileSync(toneFile({ app: "kakao" }), "utf8");
	expect(global).toMatch(/own=19 v=2/);
	expect(global).not.toContain("절대 학습 금지");
	expect(roomFileName).toBe(join(env.dir, "custom", "reply-drafts", "tone", "kakao", `${roomFile(DIRECT)}.md`));
	expect(statSync(roomFileName).mode & 0o777).toBe(0o600);

	const style = loadStyle({ app: "kakao", room: DIRECT });
	expect(style.rules).toContain(PROFILE[0]!);
	expect(style.rules.some(r => r.startsWith("최근 2개 방 말투"))).toBe(true);
	expect(style.samples).toContain("ㅇㅇ");

	const again = await ensureKakaoVoice(f.src(DIRECT), new Date("2026-10-23T05:00:00Z"));
	expect(again.room || again.global).toBe(false);
	expect(f.asks).toHaveLength(1);
	expect(readFileSync(roomFileName, "utf8")).toBe(room);
	f.close();
});

test("after the 200th new own line the model updates the old profile from only the new lines", async () => {
	const f = fixture();
	await ensureKakaoVoice(f.src(DIRECT), new Date("2026-10-23T00:00:00Z"));
	const file = toneFile({ app: "kakao", room: DIRECT });
	writeFileSync(file, `${readFileSync(file, "utf8")}\n## 말투\n\n- 내가 쓴 규칙\n\n## 고친 점\n\n- 2026-10-23: 고침\n`);

	for (let i = 0; i < STALE_AFTER - 1; i++) f.say(ROOM.direct, OWNER, "ㅇㅇ");
	expect((await ensureKakaoVoice(f.src(DIRECT))).room).toBe(false);
	expect(f.asks).toHaveLength(1);

	f.say(ROOM.direct, OWNER, "새로 쓴 말투 ㅎㅎ");
	const updated = ["상대는 일정을 존댓말로 묻는 지인", "반말로 짧게, 요즘은 ㅎㅎ도 붙임", "마침표는 안 씀"];
	f.state.reply = async () => ({ text: JSON.stringify({ profile: updated }), inputTokens: 300, outputTokens: 40 });
	const r = await ensureKakaoVoice(f.src(DIRECT), new Date("2026-11-30T00:00:00Z"));
	expect(r).toMatchObject({ room: true, mode: "refresh", tokens: { in: 300, out: 40 } });
	expect(f.asks).toHaveLength(2);
	const input = f.asks[1]!.user;
	expect(input).toContain(`- ${PROFILE[0]}`);
	expect(input).toContain("새로 쓴 말투 ㅎㅎ");
	expect(input).not.toContain("안녕하세요. 내일 일정 확인 부탁드립니다.");

	const md = readFileSync(file, "utf8");
	expect(md).toMatch(/own=215 v=2 model=ok at=2026-11-30/);
	expect(md).toContain("- 반말로 짧게, 요즘은 ㅎㅎ도 붙임");
	expect(md).not.toContain(PROFILE[3]!);
	expect(md).toContain("- 내가 쓴 규칙");
	expect(md).toContain("- 2026-10-23: 고침");
	f.close();
});

test("a failing model keeps the counted profile; it is tried again after an hour, not on every draft, and an old profile survives a failed update", async () => {
	const f = fixture();
	f.state.reply = async () => Promise.reject(new Error("boom"));
	const first = await ensureKakaoVoice(f.src(DIRECT), new Date("2026-10-23T00:00:00Z"));
	expect(first.room).toBe(true);
	const file = toneFile({ app: "kakao", room: DIRECT });
	expect(readFileSync(file, "utf8")).toMatch(/model=fail/);
	expect(readFileSync(file, "utf8")).not.toContain("## 대화 이해");
	expect(loadStyle({ app: "kakao", room: DIRECT }).rules.some(r => r.startsWith("이 방 말투는 반말"))).toBe(true);

	await ensureKakaoVoice(f.src(DIRECT), new Date("2026-10-23T00:30:00Z"));
	expect(f.asks).toHaveLength(1);

	f.state.reply = async () => ({ text: JSON.stringify({ profile: PROFILE }), inputTokens: 10, outputTokens: 5 });
	expect((await ensureKakaoVoice(f.src(DIRECT), new Date("2026-10-23T01:30:00Z"))).mode).toBe("learn");
	expect(readFileSync(file, "utf8")).toMatch(/model=ok/);

	for (let i = 0; i < STALE_AFTER; i++) f.say(ROOM.direct, OWNER, "ㅇㅇ");
	f.state.reply = async () => ({ text: "no json", inputTokens: 10, outputTokens: 5 });
	await ensureKakaoVoice(f.src(DIRECT), new Date("2026-12-01T00:00:00Z"));
	const md = readFileSync(file, "utf8");
	expect(md).toMatch(/own=215 v=2 model=ok/);
	for (const line of PROFILE) expect(md).toContain(`- ${line}`);
	f.close();
});

test("without a model the counted profile is still written, and a profile of the old format is learned again", async () => {
	const f = fixture();
	await ensureKakaoVoice(f.src(DIRECT, false), new Date("2026-10-23T00:00:00Z"));
	const file = toneFile({ app: "kakao", room: DIRECT });
	expect(readFileSync(file, "utf8")).toMatch(/model=none/);
	expect(f.asks).toHaveLength(0);

	writeFileSync(file, readFileSync(file, "utf8").replace(/own=\d+ v=2 model=none/, "own=13"));
	expect((await ensureKakaoVoice(f.src(DIRECT))).mode).toBe("learn");
	expect(readFileSync(file, "utf8")).toMatch(/v=2 model=ok/);
	f.close();
});

test("a room where the owner wrote nothing writes no profile", async () => {
	const f = fixture();
	const r = await ensureKakaoVoice({ ...f.src(String(ROOM.channel)), recentRooms: async () => [] });
	expect(r).toMatchObject({ room: false, global: false, roomRules: [], globalRules: [], profile: [] });
	expect(f.asks).toHaveLength(0);
	expect(existsSync(paths.toneDir())).toBe(false);
	f.close();
});

test("enableKakaoApp adds kakao (auto off) to a decided config and leaves mail alone; an undecided install is not touched", () => {
	expect(enableKakaoApp()).toBe(false);
	expect(existsSync(paths.config())).toBe(false);
	enable(env, { apps: { mail: { auto: true } } });
	expect(enableKakaoApp()).toBe(true);
	expect(loadSettings().apps).toEqual({ mail: { auto: true }, kakao: { auto: false } });
	expect(enableKakaoApp()).toBe(false);
});
