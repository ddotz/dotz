// The owner's own past replies, always the draft prompt's examples (engine.ts). The pairs are what the engine already stores: a comment and the
// owner's answer to it (his own comment under it, or a reply sent through the gate), minus a bot draft he sent without changing a word. The closest
// pairs go into the prompt verbatim; with `pastSeed: true` on a source, a model reply left empty also becomes the closest past answer with a
// 확인 필요 note, so no card is empty.
import type { ReplyStyle } from "../reply-draft.ts";
import type { Comment } from "./contract.ts";
import type { Draft, Reply } from "./store.ts";

/** `same`: the reply went to the very sender of the message being drafted (lib/pairs.ts styleWithExamples). `edited`: the owner changed the draft by hand before sending. `from`: who wrote the comment, when known. */
export type PastPair = { comment: string; reply: string; at: number; thread: string; same?: boolean; edited?: true; from?: string };

export const EXAMPLES = 8;
export const SIDE_MAX = 1500;
const MIN_HABITS = 5;
/** Usable pairs one source reads back from its platform, newest first (engine.ts refreshPast); closeness of retrieved replies flattens near 100 to 300. */
export const PAST_TARGET = 1000;
/** A pair of today counts double, one of this many days ago 1.5 times (similarPairs). */
export const RECENT_HALF_LIFE_DAYS = 90;
/** A reply the owner changed by hand counts this much more (similarPairs). */
export const EDITED_WEIGHT = 1.5;
/** Habits are measured over the newest replies only (habitsOf). */
export const HABIT_REPLIES = 300;

const words = (s: string) => s.replace(/\s+/g, " ").trim();
const norm = (s: string) => words(s).toLowerCase();

// A bot draft the owner sent unchanged: the reply is the draft, or the platform trimmed it (a prefix of most of it).
const isBot = (bots: string[], text: string): boolean => bots.some(b => text === b || (b.startsWith(text) && text.length >= b.length * 0.8));

// `rooms`: a site's private messages have no parent: a parentless reply of the owner answers the nearest earlier message of someone else in its thread.
export function pastPairs(comments: Comment[], replies: Reply[], source: string, drafts: Draft[] = [], rooms = false): PastPair[] {
	const sent = drafts.filter(d => d.status === "sent");
	const bots = sent.filter(d => !d.changes.length).map(d => words(d.text));
	const editedDrafts = new Set(sent.filter(d => d.changes.length).map(d => d.code));
	const own = comments.filter(c => c.source === source);
	const byNative = new Map(own.map(c => [c.native, c]));
	const byId = new Map(own.map(c => [c.id, c]));
	const out: PastPair[] = [];
	const pair = (parent: Comment, reply: string, at: number): PastPair => ({ comment: parent.text, reply, at, thread: parent.thread, ...(parent.author ? { from: parent.author } : {}) });
	for (const c of own) {
		if (!c.mine || !c.text.trim() || isBot(bots, words(c.text))) continue;
		const parent = c.parent ? byNative.get(c.parent) : rooms ? own.filter(x => !x.mine && x.thread === c.thread && x.at <= c.at).sort((a, b) => b.at - a.at)[0] : undefined;
		if (parent && !parent.mine) out.push(pair(parent, c.text.trim(), c.at));
	}
	for (const r of replies) {
		const c = r.state === "sent" && r.source === source && !isBot(bots, words(r.text)) ? byId.get(r.commentId) : undefined;
		if (!c) continue;
		const edited = editedDrafts.has(r.draft);
		const have = out.find(p => p.reply === r.text.trim() && p.comment === c.text);
		if (have) {
			if (edited) have.edited = true;
		} else out.push({ ...pair(c, r.text.trim(), r.at), ...(edited ? { edited: true as const } : {}) });
	}
	return out;
}

export const pairKey = (p: PastPair): string => `${norm(p.reply)}\n${norm(p.comment)}`;

// Pairs of several lists as one, no repeats (same reply and comment, ignoring spacing and case): the newest copy stays and keeps an `edited` mark or a sender any copy had.
export function mergePast(...lists: PastPair[][]): PastPair[] {
	const seen = new Map<string, PastPair>();
	for (const p of lists.flat()) {
		const k = pairKey(p);
		const old = seen.get(k);
		const [a, b] = old && old.at > p.at ? [old, p] : [p, old];
		seen.set(k, { ...a, ...(b?.edited && !a.edited ? { edited: true as const } : {}), ...(!a.from && b?.from ? { from: b.from } : {}), ...(!a.thread && b?.thread ? { thread: b.thread } : {}) });
	}
	return [...seen.values()];
}

// Character bigrams without addresses and punctuation: works for Korean and English without a tokenizer.
function grams(s: string): Set<string> {
	const t = s.replace(/[\w.+-]+@[\w.-]+/g, " ").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
	const g = new Set<string>();
	for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2));
	return g;
}

const cosine = (a: Set<string>, b: Set<string>): number => {
	if (!a.size || !b.size) return 0;
	let n = 0;
	for (const x of a) if (b.has(x)) n++;
	return n / Math.sqrt(a.size * b.size);
};

// How close `text` is to the closest of the shown pairs: plain similarity, since recency and hand edits rank pairs but do not make a situation the same.
export const closeness = (text: string, pairs: PastPair[]): number => {
	const q = grams(text);
	return Math.max(0, ...pairs.map(p => cosine(q, grams(p.comment))));
};

// The k pairs whose comment reads most like `text` (cosine of bigram sets); a recent pair counts up to double (RECENT_HALF_LIFE_DAYS), one the owner
// edited EDITED_WEIGHT times more, and a pair under the same post a bit more.
export function similarPairs(text: string, pairs: PastPair[], k = 3, thread?: string, now = Date.now()): PastPair[] {
	const q = grams(text);
	if (!q.size) return [];
	return pairs
		.map(p => {
			const g = grams(p.comment);
			const recent = 1 + 0.5 ** (Math.max(0, now - p.at) / 86_400_000 / RECENT_HALF_LIFE_DAYS);
			return { p, s: g.size ? cosine(g, q) * recent * (p.edited ? EDITED_WEIGHT : 1) + (thread && p.thread === thread ? 0.1 : 0) : 0 };
		})
		.filter(x => x.s > 0)
		.sort((a, b) => b.s - a.s || b.p.at - a.p.at)
		.slice(0, k)
		.map(x => x.p);
}

export const SEEDED_NOTE = "확인 필요: 모델이 답글을 비워서 비슷한 지난 댓글에 단 답을 옮겼어요. 이 댓글에 맞는지, 날짜·파일·약속처럼 사용자만 아는 사실이 맞는지 봐 주세요";

const top = (xs: string[], n = 4): [string, number][] => {
	const count = new Map<string, number>();
	for (const x of xs) count.set(x, (count.get(x) ?? 0) + 1);
	return [...count].sort((a, b) => b[1] - a[1]).slice(0, n);
};
const shown = (xs: [string, number][]) => xs.map(([x, n]) => `${x} x${n}`).join(", ");

// Measured lines about the replies (newest first; only the newest HABIT_REPLIES count), with no message text beyond short marks; none under MIN_HABITS replies.
export function habitsOf(replies: string[]): string[] {
	const rs = replies.slice(0, HABIT_REPLIES).map(r => r.trim()).filter(Boolean);
	if (rs.length < MIN_HABITS) return [];
	const pct = (n: number) => `${Math.round((100 * n) / rs.length)}%`;
	const share = (re: RegExp) => rs.filter(r => re.test(r)).length;
	const lens = rs.map(r => [...r].length).sort((a, b) => a - b);
	const at = (q: number) => lens[Math.min(lens.length - 1, Math.floor(q * lens.length))]!;
	const out = [`Length in characters: p25 ${at(0.25)}, median ${at(0.5)}, p90 ${at(0.9)}`];
	out.push(`Most common first words: ${shown(top(rs.map(r => r.split(/\s+/)[0]!)))}`);
	const ends = rs.map(r => /[^\p{L}\p{N}\s]+$/u.exec(r)?.[0]).filter((x): x is string => !!x);
	if (ends.length) out.push(`Most common trailing marks: ${shown(top(ends))}`);
	const emoji = rs.flatMap(r => r.match(/\p{Extended_Pictographic}/gu) ?? []);
	out.push(`Replies with an emoji: ${pct(share(/\p{Extended_Pictographic}/u))}${emoji.length ? `; most used: ${shown(top(emoji))}` : ""}`);
	out.push(`Share of replies containing: ${["^^", "~", "!", "ㅠ", "ㅎ", "ㅋ"].map(m => `${m} ${pct(rs.filter(r => r.includes(m)).length)}`).join(", ")}`);
	out.push(`Share of replies ending with a period: ${pct(share(/\.$/))}`);
	return out;
}

const clip = (s: string) => s.trim().slice(0, SIDE_MAX);

// The style with the closest past pairs as examples, how close they are to `text` and the habits of every reply; unchanged when nothing is close.
// Shared by the mail flow and the comment engine, which hands in its own pairs.
export function withExamples(style: ReplyStyle, close: PastPair[], replies: string[], text: string): ReplyStyle {
	if (!close.length) return style;
	const habits = habitsOf(replies);
	return { ...style, examples: close.map(p => ({ received: clip(p.comment), reply: clip(p.reply), ...(p.same ? { same: true as const } : {}) })), closest: closeness(text, close), ...(habits.length ? { habits } : {}) };
}
