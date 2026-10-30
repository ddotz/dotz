// Drafts seeded from the owner's own past replies (off by default; a source turns it on with `pastSeed: true`). The pairs are what the engine
// already stores: a comment and the owner's answer to it (his own comment under it, or a reply sent through the gate). The closest pairs go into the
// draft prompt, and when the model leaves the reply empty the closest past answer becomes the draft with a 확인 필요 note, so no card is empty.
import type { Comment } from "./contract.ts";
import type { Reply } from "./store.ts";

export type PastPair = { comment: string; reply: string; at: number; thread: string };

export function pastPairs(comments: Comment[], replies: Reply[], source: string): PastPair[] {
	const own = comments.filter(c => c.source === source);
	const byNative = new Map(own.map(c => [c.native, c]));
	const byId = new Map(own.map(c => [c.id, c]));
	const out: PastPair[] = [];
	for (const c of own) {
		const parent = c.mine && c.parent ? byNative.get(c.parent) : undefined;
		if (parent && !parent.mine && c.text.trim()) out.push({ comment: parent.text, reply: c.text.trim(), at: c.at, thread: c.thread });
	}
	for (const r of replies) {
		const c = r.state === "sent" && r.source === source ? byId.get(r.commentId) : undefined;
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

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
export const pastContext = (pairs: PastPair[]): string[] => (pairs.length ? ["비슷한 지난 댓글과 내가 단 답(말투와 내용 참고, 사실은 이 댓글에 맞는지 따로 확인):", ...pairs.map(p => `- 댓글: ${clip(p.comment, 160)}\n  내 답: ${clip(p.reply, 240)}`)] : []);
export const SEEDED_NOTE = "확인 필요: 모델이 답글을 비워서 비슷한 지난 댓글에 단 답을 옮겼어요. 이 댓글에 맞는지, 날짜·파일·약속처럼 사용자만 아는 사실이 맞는지 봐 주세요";
