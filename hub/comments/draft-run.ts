// One model call for a comment's reply draft or its revision, and the stored draft: what the comment engine runs on request, by its
// auto-draft rule and for a 고치기. Split out of createEngine (hub/comments/engine.ts), which hands it the store and its helpers.
import { fileSizeText } from "../draft-approval.ts";
import { editLesson, generateReply, learnedOf, reviseReply, type ReplyItem, type ReplyStyle } from "../reply-draft.ts";
import { judgeAsk } from "../style-judge.ts";
import type { Lesson } from "../reply-types.ts";
import type { Comment, SourceConfig } from "./contract.ts";
import type { DraftModel, EngineDeps, MailLink, MailView, Step } from "./engine.ts";
import { EXAMPLES, mergePast, SEEDED_NOTE, similarPairs, withExamples } from "./past.ts";
import { storedPairs } from "./past-refresh.ts";
import type { Draft, Store, Tokens } from "./store.ts";

const MATCH_NOTE = /^(메일 대조|근거|초안 메모):/;
const MATCHED_THREAD = / 스레드 (\S+) \(답장: ([^)]*)\)$/;
const FOUND_NOTE = /^(메일 대조: 있음|근거:)/;
type MatchRun = { kind: "lines"; lines: string[] } | { kind: "failed"; line: string };
export const POSTING_REASON = "답글을 올리는 중이라 지금은 고치거나 버릴 수 없어요. 끝난 뒤에 다시 해 주세요";
export const MAIL_SAME_ADDRESS_NOTE = "확인: 같은 주소로 이미 메일이 있어요";
const MAIL_MOVED_REASON = "그사이 이 카드의 메일이 바뀌었어요. 지금 메일을 보고 다시 고쳐 주세요";
const CLIP = 240;
const clip = (s: string, n = CLIP) => s.replace(/\s+/g, " ").trim().slice(0, n);
const MAIL_REPEAT_MS = 14 * 24 * 3600_000;

/** What a sent comment draft the owner edited teaches (design 3.4): his text against the model's, in the source's profile; nothing before it went out. */
export function editedLesson(store: Store, draftCode: string): Lesson | undefined {
	const d = store.drafts().find(x => x.code === draftCode);
	const line = d?.status === "sent" && d.editedFrom !== undefined ? editLesson(d.editedFrom, d.text) : undefined;
	return d && line ? { key: { app: d.source }, line } : undefined;
}

export function earlierMailTo({ store, mail, now, to, commentId, mailId }: { store: Store; mail: MailLink | undefined; now: number; to: string; commentId: string; mailId: string }): string | undefined {
	const key = to.toLowerCase();
	for (const x of store.drafts()) {
		if (x.commentId === commentId || (x.mailAt ?? x.created) < now - MAIL_REPEAT_MS) continue;
		for (const id of [x.mail, x.mailKept]) {
			if (!id || id === mailId) continue;
			const state = mail?.state?.(id) ?? (mail?.view(id) ? "pending" : undefined);
			if (state !== "pending" && state !== "sent") continue;
			if ((mail?.record?.(id) ?? mail?.view(id))?.to.toLowerCase().split(/[,;\s]+/).includes(key)) return id;
		}
	}
	return undefined;
}

export async function reviseMail({ store, mail, now, posting, emit, draft, mailId, change }: { store: Store; mail: MailLink; now: () => number; posting: (commentId: string) => boolean; emit: (e: Record<string, unknown>) => void; draft: Draft; mailId: string; change: string }): Promise<{ ok: true; draft: Draft; lesson?: Lesson } | { ok: false; reason: string }> {
	const m = await mail.revise(mailId, change).catch((e): { ok: false; reason: string } => ({ ok: false, reason: e instanceof Error && e.message ? clip(e.message, 160) : "고친 메일을 만들지 못했어요" }));
	if (!m.ok) return { ok: false, reason: m.reason };
	const cur = store.drafts().find(x => x.code === draft.code && x.status === "pending");
	const busy = posting(draft.commentId);
	if (busy || !cur || cur.mail !== mailId) {
		if (m.id !== mailId) mail.drop(m.id);
		return { ok: false, reason: busy ? POSTING_REASON : !cur ? "이 초안은 이미 처리됐어요" : MAIL_MOVED_REASON };
	}
	const next: Draft = { ...cur, mail: m.id, mailAt: now(), changes: [...cur.changes, `메일: ${change}`] };
	store.putDraft(next);
	emit({ kind: "comment_draft", source: draft.source, thread: draft.thread });
	return { ok: true, draft: next, ...(m.lesson ? { lesson: m.lesson } : {}) };
}

export function mailJson(d: Draft, view: (d: Draft) => MailView | undefined): { mail?: { id: string; to: string; subject?: string; body: string; attachments: { name: string; size?: string }[]; notes?: string[] } } {
	const m = view(d);
	return m ? { mail: { id: m.id, to: m.to, ...(m.subject ? { subject: m.subject } : {}), body: m.body, attachments: m.attachments.map(f => ({ name: f.name, ...(f.size !== undefined ? { size: fileSizeText(f.size) } : {}) })), ...(m.notes?.length ? { notes: m.notes } : {}) } } : {};
}

export function tokenStats(store: Store): { drafts: number; avgIn: number; avgOut: number } {
	const measured = store.drafts().filter(d => d.tokens);
	const n = measured.length || 1;
	return { drafts: measured.length, avgIn: Math.round(measured.reduce((s, d) => s + d.tokens!.in, 0) / n), avgOut: Math.round(measured.reduce((s, d) => s + d.tokens!.out, 0) / n) };
}
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
	mailPlanned: (c: Comment, src: SourceConfig) => boolean;
	posting: (commentId: string) => boolean;
};

export function createDraftRun({ deps, store, ownerOf, styleOf, contextOf, code, emit, mailView, mailPlanned, posting }: DraftRunCtx) {
	return async function run(c: Comment, src: SourceConfig, previous?: Draft, change?: string, opts: { learn?: false } = {}): Promise<Step & { lesson?: Lesson }> {
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
		const matching = src.mailMatch && deps.mailMatch;
		const reuse = previous && (previous.mailThread?.answered === true || !matching);
		const search = reuse || !matching
			? undefined
			: await deps.mailMatch!({ author: c.author, postTitle: c.postTitle, text: c.text, at: c.at }).then(
					(lines): MatchRun => ({ kind: "lines", lines }),
					(e: unknown): MatchRun => ({ kind: "failed", line: `메일 대조: 확인 실패 - ${e instanceof Error ? clip(e.message, 160) : "알 수 없는 이유"}` }),
				);
		const matched = reuse
			? previous.notes.filter(n => MATCH_NOTE.test(n))
			: search?.kind === "lines"
				? search.lines
				: search?.kind === "failed"
					? [...(previous?.mailThread ? previous.notes.filter(n => FOUND_NOTE.test(n)) : []), search.line]
					: [];
		const found = matched.find(n => n.startsWith("메일 대조: 있음"))?.match(MATCHED_THREAD);
		const mailThread = reuse || search?.kind === "failed" ? previous?.mailThread : found ? { id: found[1]!, ...(found[2] === "보냄" ? { answered: true } : found[2] === "안 보냄" ? { answered: false } : {}) } : undefined;
		const mailLine = (previous ? !!mailView(previous) : mailPlanned(c, src)) ? "함께 보내는 메일: 있어요 (답글과 같은 카드로 나가요)" : "함께 보내는 메일: 없어요 (메일이나 파일을 보내 준다고 약속하지 마세요)";
		const item: ReplyItem = { kind: "comment", app: src.key, from: c.author, text: c.text, context: [contextOf(c), mailLine, ...matched].join("\n") };
		const style = withExamples(styleOf(src), similarPairs(c.text, past, EXAMPLES, undefined, deps.now()), [...past].sort((a, b) => b.at - a.at).map(p => p.reply), c.text);
		const judgeModel = deps.judge;
		const judge = judgeModel ? judgeAsk(async (system, user) => (await judgeModel(system, user, ownerOf(src))).text) : undefined;
		const r = previous && change !== undefined ? await reviseReply(item, style, { to: `${c.author} 댓글`, body: previous.text }, change, call, judge) : await generateReply(item, style, call, judge);
		// pastSeed: no empty card. An empty or skipped reply takes the closest past answer of the owner, marked 확인 필요.
		const seed = (r.action === "skip" || !r.draft.body.trim()) && !previous ? seeds[0] : undefined;
		if (r.action === "skip" && !seed) return { ok: false, reason: r.reason || "답할 내용이 없어서 초안을 만들지 않았어요", permanent: true };
		if (r.action === "draft" && !r.draft.body.trim() && !seed) return { ok: false, reason: "모델이 빈 답글을 돌려줘서 초안을 만들지 않았어요" };
		const measured: Tokens = tokens.reported ? { in: tokens.in, out: tokens.out } : { in: estimate(tokens.chars), out: estimate(tokens.outChars), estimated: true };
		// Only a mail that still waits moves to the revised draft: one already stale or dropped could only fail after the reply is posted.
		const mail = previous && mailView(previous) ? previous.mail : undefined;
		const notes = [...(r.action === "draft" ? [...r.warnings.map(w => `확인: ${w}`), ...r.questions.map(q => `정해 주세요: ${q}`)] : []), ...(seed ? [SEEDED_NOTE] : []), ...matched, ...(mail ? (previous?.notes ?? []).filter(n => n.startsWith(MAIL_SAME_ADDRESS_NOTE)) : [])];
		const body = seed ? seed.reply : r.action === "draft" ? r.draft.body : "";
		if (posting(c.id)) return { ok: false, reason: POSTING_REASON };
		if (previous && store.drafts().find(d => d.code === previous.code)?.status !== "pending") return { ok: false, reason: "이 초안은 이미 처리됐어요" };
		for (const d of store.drafts()) if (d.commentId === c.id && d.status === "pending") store.setDraftStatus(d.code, "stale");
		const draft: Draft = { code: code(), commentId: c.id, source: src.key, thread: c.thread, text: body, status: "pending", created: deps.now(), changes: previous ? [...previous.changes, change ?? ""] : [], clean: !notes.length && !mail, notes, tokens: measured, ...(mail ? { mail, ...(previous?.mailAt ? { mailAt: previous.mailAt } : {}) } : {}), ...(mailThread ? { mailThread } : {}), ...(previous ? { replaces: previous.code } : {}) };
		store.putDraft(draft);
		emit({ kind: "comment_draft", source: src.key, thread: c.thread });
		// Learned only once the new draft is stored (design 3.1); `learn: false` hands the lesson to the caller (hub/reply-actions.ts) instead.
		const learnt = previous && change !== undefined && r.action === "draft" ? learnedOf(r, change) : undefined;
		const lesson: Lesson | undefined = learnt && (learnt.line.trim() || learnt.forbid.length) ? { key: { app: learnt.everywhere ? "install" : src.key }, line: learnt.line, forbid: learnt.forbid } : undefined;
		if (lesson && opts.learn !== false) deps.learn?.(lesson);
		return { ok: true, draft, ...(lesson ? { lesson } : {}) };
	};

}
