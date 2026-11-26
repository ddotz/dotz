// One model call for a comment's reply draft or its revision, and the stored draft: what the comment engine runs on request, by its
// auto-draft rule and for a 고치기. Split out of createEngine (hub/comments/engine.ts), which hands it the store and its helpers.
import { fileSizeText } from "../draft-approval.ts";
import { generateReply, learnedOf, reviseReply, type ReplyItem, type ReplyStyle } from "../reply-draft.ts";
import { judgeAsk } from "../style-judge.ts";
import type { LearnInput, Lesson, LessonOfEdit, Part } from "../reply-types.ts";
import type { Comment, SourceConfig } from "./contract.ts";
import type { DraftModel, EngineDeps, MailLink, MailView, Step } from "./engine.ts";
import { mergePast, sameFirst, SEEDED_NOTE, similarPairs, withExamples } from "./past.ts";
import { storedPairs } from "./past-refresh.ts";
import type { Draft, Store, Tokens } from "./store.ts";
import { fixedReply, templateText } from "./template.ts";

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

/** The profiles a comment lesson may go to: the source's own (`channel`), and the author's own level of it by the platform's id (`recipient`, as hub/comments/real.ts commentStyle loads it), none for an author without an id (a website commenter, an adapter's unknown user). */
export const commentKeys = (app: string, c: Pick<Comment, "authorId"> | undefined): LearnInput["keys"] => ({ channel: { app }, ...(c?.authorId !== undefined ? { recipient: { app, to: c.authorId } } : {}) });

/** How the owner's own edits of sent drafts are learned (design 3.4): `lessonOfEdit` reads a comment reply's lesson, `learn` hands it to the one learning entry (hub/reply-mail.ts replyLearning), and `mail` learns the edit of a mail that rode on a card (hub/reply-mail.ts learnMailEdit). None of them rejects. */
export type EditLessons = { lessonOfEdit: LessonOfEdit; learn: (input: LearnInput) => Promise<void>; mail: (mailId: string) => Promise<void> };

/** What a sent comment draft the owner edited teaches, stored through `edits.learn` and awaited: its `editLearned` mark is claimed first (Store claimEditLearned), so any number of callers in any process learn it once; then `lessonOfEdit` reads his text against the model's and the comment it answers through the reply model of the source's app (`ownerOf`); the lesson goes to the source's profile, or install when it holds everywhere. Nothing before it went out, nothing once marked, and nothing without a model or `edits`. Never rejects: a failure logs one line. */
export async function learnEdited(store: Store, draftCode: string, deps: Pick<EngineDeps, "model" | "edits">, ownerOf: (src: SourceConfig) => string): Promise<void> {
	const d = store.drafts().find(x => x.code === draftCode);
	const { model, edits } = deps;
	if (d?.status !== "sent" || d.editedFrom === undefined || !model || !edits) return;
	try {
		if (!store.claimEditLearned(draftCode)) return;
		const src = store.config().sources[d.source];
		const comment = store.comments().find(c => c.id === d.commentId);
		const taught = await edits.lessonOfEdit({ before: d.editedFrom, after: d.text, received: comment?.text ?? "" }, async (system, user) => (await model(system, user, src ? ownerOf(src) : d.source)).text).catch(e => (console.error(`comments: what the edit of ${draftCode} teaches was not read: ${e instanceof Error ? e.message : "error"}`), undefined));
		await edits.learn({ source: "edit", ref: draftCode, keys: commentKeys(d.source, comment), words: taught?.lesson ?? "", ...(taught?.everywhere ? { proposal: { scope: "everywhere" } } : {}) });
	} catch (e) {
		console.error(`comments: what the edit of ${draftCode} teaches was not recorded: ${e instanceof Error ? e.message : "error"}`);
	}
}

/** What a send of `part` of comment draft `draftCode` teaches, both parts when absent: the reply's edit (`learnEdited`) and the edit of the mail it carried (`edits.mail`): the card's mail, or after 메일만 the one the draft kept (`mailKept`). A send of the whole card never reaches back to a mail an earlier 메일만 sent. Never rejects. */
export function learnSentParts(store: Store, draftCode: string, part: Part | undefined, deps: Pick<EngineDeps, "model" | "edits">, ownerOf: (src: SourceConfig) => string): Promise<unknown> {
	const d = part === "reply" ? undefined : store.drafts().find(x => x.code === draftCode);
	const mailId = part === "mail" ? (d?.mail ?? d?.mailKept) : d?.mail;
	return Promise.all([part === "mail" ? undefined : learnEdited(store, draftCode, deps, ownerOf), mailId ? deps.edits?.mail(mailId) : undefined]);
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

// What that mail's revise is told: the owner's words as written, which part of them is its own, and the reply as now rewritten (for 메일에도 반영해).
// Words that are about the reply alone leave the mail as it is: the mail's revise decides that, not a word list.
const mailAskOf = (change: string, replyText: string): string =>
	`${change}\n\n(댓글 답글과 함께 고쳐 달라는 말이에요. 이 메일의 본문과 첨부 파일에 해당하는 부분만 반영하고, 메일에 해당하는 말이 없으면 본문과 첨부를 그대로 두세요. 고친 댓글 답글: "${replyText}")`;

/** The card line that says which part of a plain 고치기 changed and which stayed: the reply, the mail's body (with its subject) and its files. */
export const CHANGED_NOTE = "고친 곳:";
const mailParts = (v: MailView | undefined) => ({ body: `${v?.subject ?? ""}\n${v?.body ?? ""}`, files: (v?.attachments ?? []).map(f => f.name).sort().join("\n") });
export function changedLine(replyChanged: boolean, before: MailView | undefined, after: MailView | undefined): string {
	const a = mailParts(before), b = mailParts(after);
	const word = (changed: boolean) => (changed ? "바뀜" : "그대로");
	return `${CHANGED_NOTE} 답글 ${word(replyChanged)} · 메일 본문 ${word(a.body !== b.body)} · 첨부 ${word(a.files !== b.files)}`;
}

// The mail is revised on whichever pending draft of the comment carries it when the revise ends: a reply revised meanwhile moved it to its new draft.
// `ask`: what the mail's revise is told when it is not the owner's `change` itself.
export async function reviseMail({ store, mail, now, posting, emit, draft, mailId, change, ask }: { store: Store; mail: MailLink; now: () => number; posting: (commentId: string) => boolean; emit: (e: Record<string, unknown>) => void; draft: Draft; mailId: string; change: string; ask?: string }): Promise<{ ok: true; draft: Draft; lesson?: Lesson } | { ok: false; reason: string }> {
	const m = await mail.revise(mailId, ask ?? change).catch((e): { ok: false; reason: string } => ({ ok: false, reason: e instanceof Error && e.message ? clip(e.message, 160) : "고친 메일을 만들지 못했어요" }));
	if (!m.ok) return { ok: false, reason: m.reason };
	const cur = store.drafts().find(x => x.commentId === draft.commentId && x.status === "pending" && x.mail === mailId);
	const busy = posting(draft.commentId);
	if (busy || !cur) {
		if (m.id !== mailId) mail.drop(m.id);
		const same = store.drafts().find(x => x.code === draft.code && x.status === "pending");
		return { ok: false, reason: busy ? POSTING_REASON : !same ? "이 초안은 이미 처리됐어요" : MAIL_MOVED_REASON };
	}
	const next: Draft = { ...cur, mail: m.id, mailAt: now(), changes: [...cur.changes, `메일: ${change}`] };
	store.putDraft(next);
	emit({ kind: "comment_draft", source: draft.source, thread: draft.thread });
	return { ok: true, draft: next, ...(m.lesson ? { lesson: m.lesson } : {}) };
}

type MailCtx = { store: Store; mail: MailLink; now: () => number; posting: (commentId: string) => boolean; emit: (e: Record<string, unknown>) => void; busy: Map<string, number> };
// While a mail is revised, its comment counts in `busy` (engine.ts mailRevising).
export async function reviseRidingMail({ busy, ...ctx }: MailCtx, d: Draft, mailId: string, change: string, ask?: string): ReturnType<typeof reviseMail> {
	busy.set(d.commentId, (busy.get(d.commentId) ?? 0) + 1);
	return reviseMail({ ...ctx, draft: d, mailId, change, ...(ask ? { ask } : {}) }).finally(() => {
		const left = (busy.get(d.commentId) ?? 1) - 1;
		if (left) busy.set(d.commentId, left);
		else busy.delete(d.commentId);
	});
}

// A plain 고치기 (no part named) of a card that carries a mail, once the reply is rewritten: the mail is always revised too, told the owner's words
// and the new reply, and it keeps what those words do not touch. The card then says which part changed and which stayed (`changedLine`, against
// the reply before, `replyBefore`). A mail that could not be revised, or that a 메일-only 고치기 still revises (a second revise of the same
// mail would only fail), is a "확인:" line on the card.
export async function mailFollowsReply(ctx: MailCtx, draft: Draft, change: string, replyBefore: string): Promise<Draft> {
	if (!draft.mail) return draft;
	if (ctx.busy.has(draft.commentId)) {
		const next = { ...draft, notes: [...draft.notes, "확인: 메일은 다른 고치기가 끝나는 중이라 이번 말은 메일에 반영하지 않았어요"] };
		ctx.store.putDraft(next);
		return next;
	}
	const before = ctx.mail.view(draft.mail);
	const m = await reviseRidingMail(ctx, draft, draft.mail, change, mailAskOf(change, draft.text));
	const now = ctx.store.drafts().find(x => x.code === (m.ok ? m.draft.code : draft.code)) ?? (m.ok ? m.draft : draft);
	const replyChanged = now.text.trim() !== replyBefore.trim();
	const lines = m.ok ? [changedLine(replyChanged, before, now.mail ? ctx.mail.view(now.mail) : undefined)] : [`확인: 메일은 고치지 못했어요 - ${m.reason}`];
	const next = { ...now, notes: [...now.notes, ...lines] };
	ctx.store.putDraft(next);
	return next;
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
	styleOf: (src: SourceConfig, authorId?: string, thread?: string) => ReplyStyle;
	contextOf: (c: Comment) => string;
	code: () => string;
	emit: (e: Record<string, unknown>) => void;
	mailView: (d: Draft) => MailView | undefined;
	mailPlanned: (c: Comment, src: SourceConfig) => boolean;
	posting: (commentId: string) => boolean;
};

export function createDraftRun({ deps, store, ownerOf, styleOf, contextOf, code, emit, mailView, mailPlanned, posting }: DraftRunCtx) {
	return async function run(c: Comment, src: SourceConfig, previous?: Draft, change?: string): Promise<Step & { lesson?: Lesson }> {
		const fixed = previous ? undefined : templateText(src, c, "reply");
		if (!deps.model && fixed === undefined) return { ok: false, reason: "초안 만들기를 쓸 수 없어요" };
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
		const marked = c.authorId === undefined ? past : past.map(p => (p.fromId === c.authorId ? { ...p, same: true } : p));
		const style = withExamples(styleOf(src, c.authorId, c.thread), sameFirst(c.text, marked, deps.now()), [...past].sort((a, b) => b.at - a.at).map(p => p.reply), c.text);
		const judgeModel = deps.judge;
		const judge = judgeModel ? judgeAsk(async (system, user) => (await judgeModel(system, user, ownerOf(src))).text) : undefined;
		const r = fixed !== undefined ? fixedReply(fixed, item, style) : previous && change !== undefined ? await reviseReply(item, style, { to: `${c.author} 댓글`, body: previous.text }, change, call, judge) : await generateReply(item, style, call, judge);
		// pastSeed: no empty card. An empty or skipped reply takes the closest past answer of the owner, marked 확인 필요.
		const seed = (r.action === "skip" || !r.draft.body.trim()) && !previous ? seeds[0] : undefined;
		if (r.action === "skip" && !seed) return { ok: false, reason: r.reason || "답할 내용이 없어서 초안을 만들지 않았어요", permanent: true };
		if (r.action === "draft" && !r.draft.body.trim() && !seed) return { ok: false, reason: "모델이 빈 답글을 돌려줘서 초안을 만들지 않았어요" };
		const measured: Tokens = tokens.reported ? { in: tokens.in, out: tokens.out } : { in: estimate(tokens.chars), out: estimate(tokens.outChars), estimated: true };
		const body = seed ? seed.reply : r.action === "draft" ? r.draft.body : "";
		if (posting(c.id)) return { ok: false, reason: POSTING_REASON };
		const stored = previous && store.drafts().find(d => d.code === previous.code);
		if (previous && stored?.status !== "pending") return { ok: false, reason: "이 초안은 이미 처리됐어요" };
		// Only a mail that still waits moves to the revised draft: one already stale or dropped could only fail after the reply is posted. It is the
		// mail the draft carries now (a mail revised while the reply was rewritten has a new id); a `previous` given without its mail keeps none.
		const mail = previous?.mail && stored && mailView(stored) ? stored.mail : undefined;
		const mailAt = mail ? stored?.mailAt : undefined;
		const notes = [...(r.action === "draft" ? [...r.warnings.map(w => `확인: ${w}`), ...r.questions.map(q => `정해 주세요: ${q}`)] : []), ...(seed ? [SEEDED_NOTE] : []), ...matched, ...(mail ? (previous?.notes ?? []).filter(n => n.startsWith(MAIL_SAME_ADDRESS_NOTE)) : [])];
		for (const d of store.drafts()) if (d.commentId === c.id && d.status === "pending") store.setDraftStatus(d.code, "stale");
		const draft: Draft = { code: code(), commentId: c.id, source: src.key, thread: c.thread, text: body, status: "pending", created: deps.now(), changes: previous ? [...previous.changes, change ?? ""] : [], clean: !notes.length && !mail, notes, tokens: measured, ...(mail ? { mail, ...(mailAt ? { mailAt } : {}) } : {}), ...(mailThread ? { mailThread } : {}), ...(previous ? { replaces: previous.code } : {}) };
		store.putDraft(draft);
		emit({ kind: "comment_draft", source: src.key, thread: c.thread });
		// Handed to the learning entry only once the new draft is stored (hub/reply-actions.ts), which says remembered or once on its card.
		const learnt = previous && change !== undefined && r.action === "draft" ? learnedOf(r, change) : undefined;
		const lesson: Lesson | undefined = learnt && previous ? { keys: commentKeys(src.key, c), words: learnt.line, proposal: { once: learnt.once, scope: learnt.scope, forbid: learnt.forbid }, evidence: { draft: previous.text, change: change ?? "" } } : undefined;
		return { ok: true, draft, ...(lesson ? { lesson } : {}) };
	};

}
