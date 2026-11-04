// The owner's own past replies, always the draft prompt's examples (engine.ts). The pairs are what the engine already stores: a comment and the
// owner's answer to it (his own comment under it, or a reply sent through the gate), minus a bot draft he sent without changing a word. The closest
// pairs go into the prompt verbatim; with `pastSeed: true` on a source, a model reply left empty also becomes the closest past answer with a
// 확인 필요 note, so no card is empty.
import type { ReplyStyle } from "../reply-draft.ts";
import type { Comment } from "./contract.ts";
import type { Draft, Reply } from "./store.ts";

export type PastPair = { comment: string; reply: string; at: number; thread: string };

export const EXAMPLES = 8;
export const SIDE_MAX = 1500;
const MIN_HABITS = 5;

const words = (s: string) => s.replace(/\s+/g, " ").trim();

export function pastPairs(comments: Comment[], replies: Reply[], source: string, drafts: Draft[] = []): PastPair[] {
	const bots = new Set(drafts.filter(d => d.status === "sent" && !d.changes.length).map(d => words(d.text)));
	const own = comments.filter(c => c.source === source);
	const byNative = new Map(own.map(c => [c.native, c]));
	const byId = new Map(own.map(c => [c.id, c]));
	const out: PastPair[] = [];
	for (const c of own) {
		const parent = c.mine && c.parent ? byNative.get(c.parent) : undefined;
		if (parent && !parent.mine && c.text.trim() && !bots.has(words(c.text))) out.push({ comment: parent.text, reply: c.text.trim(), at: c.at, thread: c.thread });
	}
	for (const r of replies) {
		const c = r.state === "sent" && r.source === source && !bots.has(words(r.text)) ? byId.get(r.commentId) : undefined;
		if (c && !out.some(p => p.reply === r.text.trim() && p.comment === c.text)) out.push({ comment: c.text, reply: r.text.trim(), at: r.at, thread: c.thread });
	}
	return out;
}

// Character bigrams without addresses and punctuation: works for Korean and English without a tokenizer.
function grams(s: string): Set<string> {
	const t = s.replace(/[\w.+-]+@[\w.-]+/g, " ").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
	const g = new Set<string>();
	for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2));
	return g;
}

// The k pairs whose comment reads most like `text` (cosine of bigram sets); a pair under the same post counts a bit more.
export function similarPairs(text: string, pairs: PastPair[], k = 3, thread?: string): PastPair[] {
	const q = grams(text);
	if (!q.size) return [];
	return pairs
		.map(p => {
			const g = grams(p.comment);
			let n = 0;
			for (const x of g) if (q.has(x)) n++;
			return { p, s: g.size ? n / Math.sqrt(g.size * q.size) + (thread && p.thread === thread ? 0.1 : 0) : 0 };
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

// Measured lines about the replies, with no message text beyond short marks; none under MIN_HABITS replies.
export function habitsOf(replies: string[]): string[] {
	const rs = replies.map(r => r.trim()).filter(Boolean);
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

// The style with the closest past pairs as examples and the habits of every reply; unchanged when nothing is close.
// Shared by the mail flow and the comment engine, which hands in its own pairs.
export function withExamples(style: ReplyStyle, close: PastPair[], replies: string[]): ReplyStyle {
	if (!close.length) return style;
	const habits = habitsOf(replies);
	return { ...style, examples: close.map(p => ({ received: clip(p.comment), reply: clip(p.reply) })), ...(habits.length ? { habits } : {}) };
}
