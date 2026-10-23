// The owner's KakaoTalk voice: style features measured from his OWN text lines only (never the other side's), written once on the first draft
// and refreshed when 200 more own lines exist. One profile per room (tone/kakao/<chatId>.md) and one global (tone/kakao.md, his recent rooms);
// settings.ts loadStyle merges both into every draft prompt. Deterministic counting, no model call, so a draft pays nothing for it.
// The source is injected (hub/kakao/web.ts builds it from the read-only database; tests use the fixture database).
import { registerOf, type Register, type VoiceSource } from "../../../hub/kakao/draft.ts";
import { HEADINGS, loadSettings, profileBullets, saveSettings, writeSections } from "./settings.ts";

export const KAKAO_APP = "kakao";
export const STALE_AFTER = 200;
const ROOM_TEXTS = 400;
const GLOBAL_TEXTS_PER_ROOM = 60;
const MAX_EXAMPLES = 30;
const MAX_LEN = 200;

export type VoiceStats = {
	n: number;
	register?: Register;
	medianLen: number;
	p80Len: number;
	endings: [string, number][];
	rates: Record<"ㅋㅋ" | "ㅎㅎ" | "ㅠㅠ" | "이모지" | "~" | "마침표" | "물음표" | "느낌표" | "띄어쓰기 생략", number>;
	replies: [string, number][];
	words: [string, number][];
};

const pct = (n: number, of: number) => Math.round((100 * n) / Math.max(1, of));
const top = (m: Map<string, number>, k: number, min: number): [string, number][] => [...m].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, k);
const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);
const EMOJI = /\p{Extended_Pictographic}/u;
const TAIL = /[\p{Extended_Pictographic}\s~!?.…,^]+$/gu;

// Own lines of one or more rooms -> counted habits. Links and e-mail addresses are not his wording and are dropped.
export function voiceStats(texts: string[]): VoiceStats {
	const lines = texts.map(t => t.replace(/\s+/g, " ").trim()).filter(t => t && [...t].length <= MAX_LEN && !/https?:\/\/|\S+@\S+\.\S+/.test(t));
	const lens = lines.map(l => [...l].length).sort((a, b) => a - b);
	const at = (q: number) => lens[Math.min(lens.length - 1, Math.floor(q * lens.length))] ?? 0;
	const endings = new Map<string, number>();
	const replies = new Map<string, number>();
	const words = new Map<string, number>();
	const count = { "ㅋㅋ": 0, "ㅎㅎ": 0, "ㅠㅠ": 0, "이모지": 0, "~": 0, "마침표": 0, "물음표": 0, "느낌표": 0, "띄어쓰기 생략": 0 };
	for (const l of lines) {
		if (/ㅋ/.test(l)) count["ㅋㅋ"]++;
		if (/ㅎ/.test(l)) count["ㅎㅎ"]++;
		if (/[ㅠㅜ]/.test(l)) count["ㅠㅠ"]++;
		if (EMOJI.test(l)) count["이모지"]++;
		if (/~$/.test(l.replace(/[\p{Extended_Pictographic}\s]+$/gu, ""))) count["~"]++;
		if (/\.(\s|$)/.test(l)) count["마침표"]++;
		if (/\?/.test(l)) count["물음표"]++;
		if (/!/.test(l)) count["느낌표"]++;
		if ([...l].length >= 10 && !l.includes(" ")) count["띄어쓰기 생략"]++;
		const core = l.replace(TAIL, "");
		const laugh = /(ㅋ+|ㅎ+|[ㅠㅜ]+)$/.exec(core)?.[1];
		const last = [...core].at(-1);
		if (laugh) bump(endings, `${laugh[0]!.repeat(2)}`);
		else if (last && /[가-힣ㄱ-ㅎ]/.test(last)) bump(endings, `~${last}`);
		if ([...core].length >= 1 && [...core].length <= 4) bump(replies, core);
		for (const w of core.split(" ")) if (w.length >= 2 && w.length <= 6 && /^[가-힣ㄱ-ㅎa-zA-Z]+$/.test(w)) bump(words, w);
	}
	const n = lines.length;
	const register = registerOf(lines);
	return {
		n,
		...(register ? { register } : {}),
		medianLen: at(0.5),
		p80Len: at(0.8),
		endings: top(endings, 6, 2),
		rates: Object.fromEntries(Object.entries(count).map(([k, v]) => [k, pct(v, n)])) as VoiceStats["rates"],
		replies: top(replies, 6, 2),
		words: top(words, 8, 3),
	};
}

const list = (xs: [string, number][], withCount = false) => xs.map(([k, c]) => (withCount ? `${k}(${c})` : k)).join(", ");

// The "## 학습한 말투" bullets. Each is one short concrete habit; the room one leads with the register.
export function voiceRules(s: VoiceStats, scope: "room" | "global", tally?: { rooms: number; casual: number; polite: number; mixed: number }): string[] {
	if (!s.n) return [];
	const out: string[] = [];
	if (scope === "room" && s.register) out.push(`이 방 말투는 ${s.register.label}: 내 글 ${s.register.casual + s.register.polite}줄 중 반말 ${s.register.casual}줄, 존댓말 ${s.register.polite}줄`);
	if (scope === "global" && tally) out.push(`최근 ${tally.rooms}개 방 말투: 반말 ${tally.casual}곳, 존댓말 ${tally.polite}곳, 혼용 ${tally.mixed}곳 (방마다 다르니 이 방 말투를 따름)`);
	out.push(`길이: 중앙값 ${s.medianLen}자, 80%가 ${s.p80Len}자 이하 (짧게, 한두 마디)`);
	if (s.endings.length) out.push(`끝맺음: ${s.endings.map(([k, c]) => `${k} ${pct(c, s.n)}%`).join(", ")}`);
	const marks = Object.entries(s.rates).filter(([k, v]) => v >= 3 && !["마침표", "물음표", "느낌표", "띄어쓰기 생략"].includes(k));
	out.push(`줄 중 ${marks.length ? marks.map(([k, v]) => `${k} ${v}%`).join(", ") : "ㅋㅋ·ㅎㅎ·이모지 거의 없음"}`);
	out.push(`부호: 마침표 ${s.rates["마침표"]}%, 물음표 ${s.rates["물음표"]}%, 느낌표 ${s.rates["느낌표"]}%, 띄어쓰기 생략 ${s.rates["띄어쓰기 생략"]}%`);
	if (s.replies.length) out.push(`자주 쓰는 짧은 답: ${list(s.replies, true)}`);
	if (s.words.length) out.push(`자주 쓰는 말: ${list(s.words)}`);
	return out;
}

// Whole own lines as examples (a short "ㅇㅇ" counts, unlike the sentence filter of the mail learner), newest first, deduped.
export function voiceExamples(texts: string[], max = MAX_EXAMPLES): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of texts) {
		const s = t.replace(/\s+/g, " ").trim();
		if (!s || [...s].length > 100 || /https?:\/\/|\S+@\S+\.\S+/.test(s) || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
		if (out.length >= max) break;
	}
	return out;
}

const learnedCount = (key: { app: string; room?: string }): number | undefined => {
	const m = /own=(\d+)/.exec(profileBullets(key, HEADINGS.record)[0] ?? "");
	return m ? Number(m[1]) : undefined;
};
const stale = (key: { app: string; room?: string }, now: number) => {
	const was = learnedCount(key);
	return was === undefined || now >= was + STALE_AFTER;
};
const record = (n: number, at: Date) => [`own=${n} at=${at.toISOString().slice(0, 10)}`];

export type VoiceResult = { room: boolean; global: boolean; roomRules: string[]; globalRules: string[] };

// First draft in a room: learns the room profile and the global one when missing; later drafts relearn a profile once 200 more own lines exist.
// Reads only the owner's own text lines (room: newest 400; global: newest 60 of each of his recent rooms) and counts; writes only tone files.
export async function ensureKakaoVoice(src: VoiceSource, at: Date = new Date()): Promise<VoiceResult> {
	const result: VoiceResult = { room: false, global: false, roomRules: [], globalRules: [] };
	const recent = await src.recentRooms();
	const ids = [...new Set([src.chatId, ...recent])];
	const counts = await src.ownCounts(ids);
	const roomKey = { app: KAKAO_APP, room: src.chatId };
	const globalKey = { app: KAKAO_APP };
	const roomN = counts.get(src.chatId) ?? 0;
	let roomTexts: string[] | undefined;
	if (roomN > 0 && stale(roomKey, roomN)) {
		roomTexts = await src.ownTexts(src.chatId, ROOM_TEXTS);
		result.roomRules = voiceRules(voiceStats(roomTexts), "room");
		if (result.roomRules.length) {
			writeSections(roomKey, [[HEADINGS.learned, result.roomRules], [HEADINGS.samples, voiceExamples(roomTexts)], [HEADINGS.record, record(roomN, at)]]);
			result.room = true;
		}
	}
	const globalN = recent.reduce((n, id) => n + (counts.get(id) ?? 0), 0);
	if (globalN > 0 && stale(globalKey, globalN)) {
		const all: string[] = [];
		const tally = { rooms: 0, casual: 0, polite: 0, mixed: 0 };
		for (const id of recent) {
			if (!(counts.get(id) ?? 0)) continue;
			const texts = id === src.chatId && roomTexts ? roomTexts.slice(0, GLOBAL_TEXTS_PER_ROOM) : await src.ownTexts(id, GLOBAL_TEXTS_PER_ROOM);
			all.push(...texts);
			const label = registerOf(texts)?.label;
			if (!label) continue;
			tally.rooms++;
			if (label === "반말") tally.casual++;
			else if (label === "존댓말") tally.polite++;
			else tally.mixed++;
		}
		result.globalRules = voiceRules(voiceStats(all), "global", tally);
		if (result.globalRules.length) {
			writeSections(globalKey, [[HEADINGS.learned, result.globalRules], [HEADINGS.record, record(globalN, at)]]);
			result.global = true;
		}
	}
	return result;
}

// First use: kakao becomes a known source of the reply-drafts config (auto off: only the web button drafts). An install whose owner never
// decided on the feature is left alone, because writing its config would switch it off.
export function enableKakaoApp(): boolean {
	const s = loadSettings();
	if (!s.decided || s.apps[KAKAO_APP]) return false;
	saveSettings({ apps: { ...s.apps, [KAKAO_APP]: { auto: false } } });
	return true;
}
