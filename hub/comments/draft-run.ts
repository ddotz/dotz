// One model call for a comment's reply draft or its revision, and the stored draft: what the comment engine runs on request, by its
// auto-draft rule and for a 고치기. Split out of createEngine (hub/comments/engine.ts), which hands it the store and its helpers.
import { generateReply, lessonOf, reviseReply, type ReplyItem, type ReplyStyle } from "../reply-draft.ts";
import type { Comment, SourceConfig } from "./contract.ts";
import type { DraftModel, EngineDeps, MailView, Step } from "./engine.ts";
import { EXAMPLES, mergePast, SEEDED_NOTE, similarPairs, withExamples } from "./past.ts";
import { storedPairs } from "./past-refresh.ts";
import type { Draft, Store, Tokens } from "./store.ts";

const MATCH_NOTE = /^(메일 대조|근거|초안 메모):/;
const CLIP = 240;
const clip = (s: string, n = CLIP) => s.replace(/\s+/g, " ").trim().slice(0, n);
const estimate = (chars: number) => Math.ceil(chars / 3);

export type DraftRunCtx = {
	deps: EngineDeps & { model?: DraftModel };
	store: Store;
	ownerOf: (src: SourceConfig) => string;
	styleOf: (src: SourceConfig) => ReplyStyle;
	contextOf: (c: Comment) => string;
	code: () => string;
	emit: (e: Record<string, unknown>) => void;
	mailView: (d: Draft) => MailView | undefined;
};

export function createDraftRun({ deps, store, ownerOf, styleOf, contextOf, code, emit, mailView }: DraftRunCtx) {
	return async function run(c: Comment, src: SourceConfig, previous?: Draft, change?: string, opts: { learn?: false } = {}): Promise<Step & { lesson?: string }> {
		if (!deps.model) return { ok: false, reason: "초안 만들기를 쓸 수 없어요" };
		const tokens = { in: 0, out: 0, reported: false, chars: 0, outChars: 0 };
		const call = async (system: string, user: string): Promise<string> => {
			const r = await deps.model!(system, user, ownerOf(src));
			tokens.in += r.inputTokens ?? 0;
			tokens.out += r.outputTokens ?? 0;
			tokens.reported ||= (r.inputTokens ?? 0) > 0 || (r.outputTokens ?? 0) > 0;
			tokens.chars += system.length + user.length;
			tokens.outChars += r.text.length;
			return r.text;
		};
		const past = mergePast(storedPairs(store, src), deps.pairs?.load(src.key) ?? []);
		const seeds = src.pastSeed ? similarPairs(c.text, past, 3, c.thread, deps.now()) : [];
		// The mail check runs once per comment (a revision keeps the lines of the draft it revises); a failure is a line on the card, not a lost draft.
		const matched = previous
			? previous.notes.filter(n => MATCH_NOTE.test(n))
			: src.mailMatch && deps.mailMatch
				? await deps.mailMatch({ author: c.author, postTitle: c.postTitle, text: c.text, at: c.at }).catch(e => [`메일 대조: 확인 실패 - ${e instanceof Error ? clip(e.message, 160) : "알 수 없는 이유"}`])
				: [];
		const item: ReplyItem = { kind: "comment", app: src.key, from: c.author, text: c.text, context: [contextOf(c), ...matched].join("\n") };
		const style = withExamples(styleOf(src), similarPairs(c.text, past, EXAMPLES, undefined, deps.now()), [...past].sort((a, b) => b.at - a.at).map(p => p.reply), c.text);
		const r = previous && change !== undefined ? await reviseReply(item, style, { to: `${c.author} 댓글`, body: previous.text }, change, call) : await generateReply(item, style, call);
		// pastSeed: no empty card. An empty or skipped reply takes the closest past answer of the owner, marked 확인 필요.
		const seed = (r.action === "skip" || !r.draft.body.trim()) && !previous ? seeds[0] : undefined;
		if (r.action === "skip" && !seed) return { ok: false, reason: r.reason || "답할 내용이 없어서 초안을 만들지 않았어요" };
		if (r.action === "draft" && !r.draft.body.trim() && !seed) return { ok: false, reason: "모델이 빈 답글을 돌려줘서 초안을 만들지 않았어요" };
		const measured: Tokens = tokens.reported ? { in: tokens.in, out: tokens.out } : { in: estimate(tokens.chars), out: estimate(tokens.outChars), estimated: true };
		const notes = [...(r.action === "draft" ? [...r.warnings.map(w => `확인: ${w}`), ...r.questions.map(q => `정해 주세요: ${q}`)] : []), ...(seed ? [SEEDED_NOTE] : []), ...matched];
		const body = seed ? seed.reply : r.action === "draft" ? r.draft.body : "";
		for (const d of store.drafts()) if (d.commentId === c.id && d.status === "pending") store.setDraftStatus(d.code, "stale");
		// Only a mail that still waits moves to the revised draft: one already stale or dropped could only fail after the reply is posted.
		const mail = previous && mailView(previous) ? previous.mail : undefined;
		const draft: Draft = { code: code(), commentId: c.id, source: src.key, thread: c.thread, text: body, status: "pending", created: deps.now(), changes: previous ? [...previous.changes, change ?? ""] : [], clean: !notes.length && !mail, notes, tokens: measured, ...(mail ? { mail, ...(previous?.mailAt ? { mailAt: previous.mailAt } : {}) } : {}), ...(previous ? { replaces: previous.code } : {}) };
		store.putDraft(draft);
		emit({ kind: "comment_draft", source: src.key, thread: c.thread });
		// Learned only once the new draft is stored (design 3.1); `learn: false` hands the lesson to the caller (hub/reply-actions.ts) instead.
		const lesson = previous && change !== undefined && r.action === "draft" ? lessonOf(r, change) : "";
		if (lesson && opts.learn !== false) deps.learn?.(src, lesson);
		return { ok: true, draft, ...(lesson ? { lesson } : {}) };
	};

}
