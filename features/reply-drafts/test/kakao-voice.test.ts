import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownTextCounts, ownTexts, sqliteDb } from "../../../hub/kakao/db.ts";
import type { VoiceSource } from "../../../hub/kakao/draft.ts";
import { addMessage, BASE_LOG, BASE_TIME, makeFixtureDb, OWNER, ROOM } from "../../../hub/kakao/fixture.ts";
import { enableKakaoApp, ensureKakaoVoice, STALE_AFTER, voiceExamples, voiceStats } from "../lib/kakao-voice.ts";
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

// A fixture database where the other side writes formally and the owner casually (direct room), and the owner writes politely in a group.
function fixture() {
	const file = join(env.dir, "kakao.db");
	rmSync(file, { force: true });
	const db = makeFixtureDb(file, { messages: [] });
	let seq = 0;
	const say = (chatId: number, authorId: number, message: string) => {
		seq++;
		addMessage(db, { logId: BASE_LOG + BigInt(1000 + seq), chatId, authorId, message, sentAt: BASE_TIME + seq });
	};
	for (const t of CASUAL) {
		say(ROOM.direct, 2001, "안녕하세요. 내일 일정 확인 부탁드립니다.");
		say(ROOM.direct, OWNER, t);
	}
	for (const t of ["네 알겠습니다.", "확인했습니다.", "감사합니다", "넵 그렇게 하겠습니다"]) say(ROOM.group, OWNER, t);
	say(ROOM.group, 2002, "그룹 다른 사람의 말 절대 학습 금지");
	const read = sqliteDb(file);
	const src = (chatId: string): VoiceSource => ({
		chatId,
		ownCounts: ids => ownTextCounts(read, ids, OWNER),
		ownTexts: (id, limit) => ownTexts(read, id, OWNER, limit),
		recentRooms: async () => [GROUP, DIRECT],
	});
	return { say, src, close: () => (read.close(), db.close()) };
}

test("voiceStats counts habits of the own lines only: length, endings, ㅋ use, short replies and common words", () => {
	const s = voiceStats([...CASUAL, ...CASUAL]);
	expect(s.n).toBe(24);
	expect(s.register?.label).toBe("반말");
	expect(s.endings.map(e => e[0])).toContain("ㅋㅋ");
	expect(s.rates["ㅋㅋ"]).toBeGreaterThan(20);
	expect(s.replies.map(r => r[0])).toContain("ㅇㅇ");
	expect(s.words.map(w => w[0])).toContain("근데");
	expect(voiceStats(["see https://example.com/x", "mail a@b.co"]).n).toBe(0);
});

test("voiceExamples keeps short lines like ㅇㅇ, dedupes, and drops links", () => {
	expect(voiceExamples(["ㅇㅇ", "ㅇㅇ", "https://example.com", "그래"])).toEqual(["ㅇㅇ", "그래"]);
});

test("first draft learns the room and the global profile from the owner's own lines; the next draft reuses them with no rewrite", async () => {
	const f = fixture();
	const first = await ensureKakaoVoice(f.src(DIRECT), new Date("2026-10-23T00:00:00Z"));
	expect(first.room && first.global).toBe(true);

	const roomFileName = toneFile({ app: "kakao", room: DIRECT });
	const room = readFileSync(roomFileName, "utf8");
	expect(room).toContain("이 방 말투는 반말");
	expect(room).toContain("- ㅇㅇ");
	expect(room).toContain("own=12 at=2026-10-23");
	expect(room).not.toContain("안녕하세요");
	const global = readFileSync(toneFile({ app: "kakao" }), "utf8");
	expect(global).toContain("최근 2개 방 말투: 반말 1곳, 존댓말 1곳");
	expect(global).toContain("own=16 at=2026-10-23");
	expect(global).not.toContain("절대 학습 금지");
	expect(roomFileName).toBe(join(env.dir, "custom", "reply-drafts", "tone", "kakao", `${roomFile(DIRECT)}.md`));
	expect(statSync(roomFileName).mode & 0o777).toBe(0o600);

	const style = loadStyle({ app: "kakao", room: DIRECT });
	expect(style.rules.some(r => r.startsWith("최근 2개 방 말투"))).toBe(true);
	expect(style.rules.some(r => r.startsWith("이 방 말투는 반말"))).toBe(true);
	expect(style.samples).toContain("ㅇㅇ");

	const again = await ensureKakaoVoice(f.src(DIRECT));
	expect(again.room || again.global).toBe(false);
	expect(readFileSync(roomFileName, "utf8")).toBe(room);
	f.close();
});

test("a profile is relearned only after the 200th new own line, and the owner's hand-written rules and corrections survive", async () => {
	const f = fixture();
	await ensureKakaoVoice(f.src(DIRECT), new Date("2026-10-23T00:00:00Z"));
	const file = toneFile({ app: "kakao", room: DIRECT });
	writeFileSync(file, `${readFileSync(file, "utf8")}\n## 말투\n\n- 내가 쓴 규칙\n\n## 고친 점\n\n- 2026-10-23: 고침\n`);

	for (let i = 0; i < STALE_AFTER - 1; i++) f.say(ROOM.direct, OWNER, "ㅇㅇ");
	expect((await ensureKakaoVoice(f.src(DIRECT))).room).toBe(false);

	f.say(ROOM.direct, OWNER, "ㅇㅇ 하나 더");
	expect((await ensureKakaoVoice(f.src(DIRECT), new Date("2026-11-30T00:00:00Z"))).room).toBe(true);
	const md = readFileSync(file, "utf8");
	expect(md).toContain("own=212 at=2026-11-30");
	expect(md).toContain("- 내가 쓴 규칙");
	expect(md).toContain("- 2026-10-23: 고침");
	f.close();
});

test("a room where the owner wrote nothing writes no profile", async () => {
	const f = fixture();
	const r = await ensureKakaoVoice({ ...f.src(String(ROOM.channel)), recentRooms: async () => [] });
	expect(r).toEqual({ room: false, global: false, roomRules: [], globalRules: [] });
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
