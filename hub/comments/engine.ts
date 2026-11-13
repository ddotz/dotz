// The comment engine: collect (script only, no model), draft (a model call only on request or per-source auto-draft), send (only through
// the gate in contract.ts). Everything is injected (adapters, model, clock, tone, broadcast) so tests run without a network.
import { editLesson, ownerLint, type ReplyStyle } from "../reply-draft.ts";
import { absorbComments, mergeIgTwins } from "./absorb.ts";
import { createDraftRun } from "./draft-run.ts";
import { createSendRecovery } from "./recover.ts";
import { type Comment, type CommentAdapter, dispatchReply, type GateResult, isUntitled, type Post, ruleAllows, type SourceConfig, type SourceKind, threadKey, watches } from "./contract.ts";
import { UNKNOWN_USER } from "../../features/youtube-instagram/lib/ig-owner.ts";
import { ATTACH_AS_IS_HINT, ATTACH_REFUSED, LINT_REFUSED, asksForFile, fileSizeText, recipientCheck } from "../draft-approval.ts";
import { type ClosedReason, createStore, type Draft, type MailOutcome, type Reply, type Store } from "./store.ts";
import { unrepliedFresh } from "../unreplied.ts";
import type { MailQuery } from "./mail-match.ts";
import { createPastRefresh, type PastDeps } from "./past-refresh.ts";

// The mail that rides on a comment reply (hub/comments/mail-link.ts is the real one): written with the draft, shown in the same card, sent right
// after the reply is posted, revised or dropped with it.
// `request`: the writer's own words, for the install's narrow rule (hub/auto-attach.ts; see hub/mail-cli.ts composeMail).
export type MailSpec = { app: string; to: string; subject: string; body: string; attach?: string[]; fromLibrary?: string; request?: string };
export type MailView = { id: string; to: string; subject?: string; body: string; attachments: { name: string; size?: number }[]; asksFile?: boolean; libraryMiss?: boolean; /** Warnings the owner reads before approving, shown with the mail. */ notes?: string[]; /** Where the mail's words and files disagree (flow.ts draftAttachIssues): the card's `첨부 확인` line. */ attachIssues?: string[] };
/** What the mail text is written from: the comment, its author and post, the mail app of the source and the address the mail goes to. */
export type MailWrite = { app: string; to: string; author: string; text: string; postTitle: string };
export type MailLink = {
	/** The mail text in the owner's voice; undefined = none (the fixed text is used). */
	write?: (spec: MailWrite) => Promise<string | undefined>;
	/** `notes` (owner-facing "확인: ..." lines) and `libraryMiss` (no file of the library fits) are what composing said besides the id. */
	compose: (spec: MailSpec) => Promise<{ ok: true; id: string; notes?: string[]; libraryMiss?: boolean } | { ok: false; reason: string }>;
	/** The status of a mail draft whatever it is ("pending", "sent", ...); missing = only pending drafts are known (`view`). */
	state?: (id: string) => string | undefined;
	/** Sends the mail draft; the reply was just posted by the owner's pick, so no second pick is asked. A mail whose files disagree with its words is refused unless `asIs` (the owner picked 이대로 보내기). */
	send: (id: string, opts?: { asIs?: true; retry?: true }) => Promise<{ ok: boolean; text: string }>;
	/** Where the mail draft's words and files disagree; checked before the reply is posted. Missing = nothing to check. */
	issues?: (id: string) => string[];
	/** What the mail's send-time lint would refuse (placeholder, forbidden expression, recipient), as the owner reads it; checked before the reply is posted, also for 이대로 보내기. Missing = nothing to check. */
	lint?: (id: string) => string[];
	drop: (id: string) => void;
	revise: (id: string, change: string) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
	/** The owner's own text for the mail, saved as written (직접 수정); refused with the lint's lines. Missing = the mail cannot be edited here. */
	edit?: (id: string, text: string) => { ok: true } | { ok: false; reason: string; code?: string; lint?: string[] };
	view: (id: string) => MailView | undefined;
};
export type ModelReply = { text: string; inputTokens?: number; outputTokens?: number };
export type DraftModel = (system: string, user: string, app?: string) => Promise<ModelReply>;
export type EngineDeps = {
	dir: string;
	now: () => number;
	collector: string;
	adapters: Partial<Record<SourceKind, CommentAdapter>>;
	model?: DraftModel;
	style?: (src: SourceConfig) => ReplyStyle;
	learn?: (src: SourceConfig, change: string) => void;
	broadcast?: (event: Record<string, unknown>) => void;
	/** A reply was posted (owner's 보내기 or an owner-enabled rule): the app instance and the send record. hub/followup.ts wakes the bot from here. */
	sent?: (app: string, reply: Reply) => void;
	/** The app instance (custom/apps.json id) a source belongs to: its threads, needs and reply model are the instance's. Default = the app (`appOf`). */
	owner?: (src: SourceConfig) => string;
	/** Whether an app feature is on (hub/app-feature-flags.ts featureEnabled); off = the engine drafts nothing for that app. Missing = on. */
	featureOn?: (app: string, id: string) => boolean;
	/** The mail that can ride on a reply. Missing = a draft with a mail is refused. */
	mail?: MailLink;
	/** Comment <-> mail matching for sources with `mailMatch` on (hub/comments/mail-match.ts): card lines `메일 대조:` / `근거:` / `초안 메모:`. Missing = no matching. */
	mailMatch?: (q: MailQuery) => Promise<string[]>;
} & PastDeps;

export const appOf = (src: Pick<SourceConfig, "kind">): string => (src.kind === "website" ? "site" : src.kind);
// A mail whose files disagree with its words is refused before the reply is posted: a reply posted ahead of a refused mail would say it was sent.
function mailRefusal(mail: MailLink | undefined, mailId: string): GateResult | undefined {
	const issues = mail?.issues?.(mailId) ?? [];
	return issues.length ? { ok: false, reason: `${ATTACH_REFUSED} ${issues.join(" · ")}. 답글도 올리지 않았어요. ${ATTACH_AS_IS_HINT}` } : undefined;
}
// The mail's own send-time lint runs before the reply is posted too: a hit there would leave a posted reply and an unsent mail.
function mailLintRefusal(mail: MailLink | undefined, mailId: string): GateResult | undefined {
	const found = mail?.lint?.(mailId) ?? [];
	return found.length ? { ok: false, reason: `${LINT_REFUSED} ${found.join(" · ")}. 답글도 올리지 않았어요.` } : undefined;
}
// Approved with a mail that has since gone: nothing goes, and the card without it needs a pick of its own (`mailAt`).
function mailGoneRefusal(store: { putDraft: (d: Draft) => void }, d: Draft, now: number): GateResult {
	const { mail: _gone, ...rest } = d;
	store.putDraft({ ...rest, mailAt: now });
	return { ok: false, reason: "이 답글에 붙어 있던 메일 초안이 더 이상 없어요. 답글도 올리지 않았어요. 답글만 올리려면 다시 승인해 주세요." };
}
export const OFF_REASON = "댓글 답글이 꺼져 있어요. 앱 설정에서 켜 주세요";
const MAX_AUTO_PER_RUN = 5;
const RECHECK_CAP = 200;
const RECHECK_EVERY_MS = 30 * 60_000;
export const MAIL_KEPT_NOTE = "확인: 댓글은 이미 답했어요. 메일은 따로 확인해 주세요";
export const MAIL_NO_APP_NOTE = "확인: 메일 앱이 정해지지 않아 메일 초안은 만들지 않았어요";
const LIBRARY_MISS_NOTE = "확인: 첨부 파일 폴더에서 맞는 파일을 찾지 못했어요";
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
/** The linked mail of a comment as the item shows it: 메일 초안 작성됨 / 메일 보냄 / 메일 실패: <이유>. */
export type MailMark = { state: "drafted" | "sent" | "failed"; label: string };
// `merged`: Instagram reply rows stored twice that became one (issue #31); only when there were any.
export type ReconcileResult = { answered: number; gone: number; draftsClosed: number; merged?: number; errors?: Record<string, string> };
const DEFAULT_EVERY_MIN = 5;
const SAMPLES = 5;
const CONTEXT_COMMENTS = 6;
const CLIP = 240;
const BASE32 = "abcdefghjkmnpqrstvwxyz23456789";
const clip = (s: string, n = CLIP) => s.replace(/\s+/g, " ").trim().slice(0, n);

// Only comments that ever carried a mail are looked up: a thread list runs on every comment watched.
function threadMailCounts(replies: Reply[], drafts: Draft[], stateOf: (commentId: string) => MailMark["state"] | undefined) {
	const mailed = new Set([...replies.filter(r => r.mail), ...drafts.filter(d => d.mail || d.mailKept)].map(x => x.commentId));
	return (list: Comment[]) => {
		const states = list.flatMap(c => (mailed.has(c.id) ? [stateOf(c.id)] : [])).filter(s => s);
		const n = (s: MailMark["state"]) => states.filter(x => x === s).length;
		return states.length ? { mails: { drafted: n("drafted"), sent: n("sent"), failed: n("failed") } } : {};
	};
}

export type Step = { ok: true; draft: Draft } | { ok: false; reason: string };

// The options MailLink.send gets: only what is set, so a plain send stays a plain call.
const sendOpts = (o: { retry?: true; asIs?: true }): { asIs?: true; retry?: true } | undefined => (o.asIs || o.retry ? { ...(o.asIs ? { asIs: true as const } : {}), ...(o.retry ? { retry: true as const } : {}) } : undefined);

/**
 * 다시 보내기 of a combined card whose reply is posted while its mail failed (Reply.mail): that mail alone goes out, the reply is never posted twice.
 * Refused once the mail went out or its draft is gone.
 */
async function resendPostedMail(store: Store, mail: MailLink | undefined, d: Draft, opts: { retry?: true; asIs?: true }, emit: (e: Record<string, unknown>) => void): Promise<{ ok: boolean; text: string }> {
	const rep = store.replies().filter(r => r.draft === d.code && r.state === "sent").at(-1);
	if (!d.mail || !mail) return { ok: false, text: "이 초안에는 함께 보낼 메일이 없어요" };
	if (rep?.mail?.state !== "failed" || (mail.state?.(d.mail) ?? (mail.view(d.mail) ? "pending" : undefined)) !== "pending") return { ok: false, text: "함께 보낼 메일은 이미 나갔거나 초안이 없어요" };
	const m = await mail.send(d.mail, sendOpts(opts)).catch(e => ({ ok: false, text: e instanceof Error && e.message ? e.message.slice(0, 160) : "메일을 보내는 중 오류가 났어요" }));
	if (m.ok) {
		store.putReply({ ...rep, mail: { state: "sent", text: m.text } });
		emit({ kind: "comment_send", source: rep.source, thread: rep.thread, id: rep.id, state: rep.state, mail: "sent" });
	}
	return m;
}

export function createEngine(deps: EngineDeps) {
	const store = createStore(deps.dir);
	const inflight = new Set<string>();
	const pending = new Set<Promise<unknown>>();
	const emit = (e: Record<string, unknown>) => deps.broadcast?.(e);
	const replyOn = (src: SourceConfig): boolean => deps.featureOn?.(ownerOf(src), "comment_reply") ?? true;
	const gate = { store, adapters: deps.adapters, now: deps.now, collector: deps.collector, inflight, onState: (r: Reply) => {
		emit({ kind: "comment_send", source: r.source, thread: r.thread, id: r.id, state: r.state, ...(r.reason ? { reason: r.reason } : {}) });
		const src = store.config().sources[r.source];
		// A reply that carries a mail wakes no 이어서 할 일 rule: the mail it would draft is already in the card.
		if (r.state === "sent" && src && !store.drafts().find(d => d.code === r.draft)?.mail) deps.sent?.(ownerOf(src), r);
	} };

	const ownerOf = (src: SourceConfig): string => deps.owner?.(src) ?? appOf(src);
	const sourceOf = (id: string): SourceConfig | undefined => store.config().sources[id];
	const find = (id: string): Comment | undefined => store.comments().find(c => c.id === id);
	const stream = (c: Comment): Comment[] => {
		const top = c.parent ?? c.native;
		return store.comments().filter(x => x.source === c.source && x.thread === c.thread && (x.native === top || x.parent === top));
	};
	const answeredOnPlatform = (c: Comment): boolean => {
		const src = sourceOf(c.source);
		const check = src && deps.adapters[src.kind]?.answered;
		return check ? check(c, store.comments().filter(x => x.mine && x.source === c.source && x.thread === c.thread)) : false;
	};
	// A comment needs the owner's reply when it starts a stream, is not his own, and nobody of his (or a sent reply) answered it yet.
	const needsReply = (c: Comment): boolean =>
		!c.mine && !c.gone && !c.parent && !stream(c).some(x => x.mine && x.parent === c.native) && !store.replies().some(r => r.commentId === c.id && r.state !== "failed") && !store.drafts().some(d => d.commentId === c.id && d.status === "pending") && !answeredOnPlatform(c);

	// 미답장 (hub/unreplied.ts): someone else's comment stays open until a reply was sent for it, a comment of his own came after it in the same
	// stream (he answered on the platform), or he tapped 답장 안 함. Reading it changes nothing.
	const unrepliedWith = (c: Comment, replies: Reply[], dismissed: Record<string, number>): boolean =>
		!c.mine && !c.gone && unrepliedFresh(c.at, deps.now()) && !dismissed[c.id] && !replies.some(r => r.commentId === c.id && r.state !== "failed") && !stream(c).some(x => x.mine && x.at >= c.at) && !answeredOnPlatform(c);
	const unreplied = (c: Comment): boolean => unrepliedWith(c, store.replies(), store.dismissed());

	const contextOf = (c: Comment): string => {
		const lines = stream(c).slice(-CONTEXT_COMMENTS).map(x => `- ${x.mine ? "나" : x.author}: ${clip(x.text)}`);
		return [`글: ${clip(c.postTitle, 120)}${c.postLink ? ` (${c.postLink})` : ""}`, "같은 댓글 줄기:", ...lines].join("\n");
	};
	const styleOf = (src: SourceConfig): ReplyStyle => {
		const s = deps.style?.(src) ?? { rules: [], corrections: [], forbidden: [], samples: [] };
		return { ...s, samples: s.samples.slice(0, SAMPLES) };
	};
	const code = (): string => {
		const taken = new Set(store.drafts().map(d => d.code));
		for (;;) {
			const c = `D${Array.from({ length: 6 }, () => BASE32[Math.floor(Math.random() * BASE32.length)]).join("")}`;
			if (!taken.has(c)) return c;
		}
	};

	const run = createDraftRun({ deps, store, ownerOf, styleOf, contextOf, code, emit, mailView: d => mailView(d) });

	function makeDraft(commentId: string): Promise<Step> {
		const c = find(commentId);
		const src = c && sourceOf(c.source);
		if (!c || !src) return Promise.resolve({ ok: false, reason: "원댓글을 찾지 못했어요" });
		if (!replyOn(src)) return Promise.resolve({ ok: false, reason: OFF_REASON });
		if (c.mine) return Promise.resolve({ ok: false, reason: "내가 쓴 댓글에는 답글 초안을 만들지 않아요" });
		return run(c, src).then(async (step): Promise<Step> => {
			if (!step.ok || !src.autoMail) return step;
			await linkMail(step.draft.code);
			return { ok: true, draft: store.drafts().find(d => d.code === step.draft.code) ?? step.draft };
		}).catch(e => ({ ok: false as const, reason: e instanceof Error && e.message ? clip(e.message, 160) : "초안을 만들지 못했어요. 잠시 뒤에 다시 눌러 주세요" }));
	}

	// Linked mail for a comment that asks for a file and names an address: the pending reply draft `code` gets a compose mail draft (template text, files
	// chosen from the library by the post title + comment words), shown in the same card and sent only with the owner's 보내기. Idempotent: a draft that
	// already has its pending mail keeps it. A skip is told back as the reason; a missing mail app or a failed compose is also a "확인:" line on the card.
	const linking = new Set<string>();
	async function linkMail(code: string): Promise<{ ok: true; mail: string; existing?: true } | { ok: false; reason: string }> {
		const d = store.drafts().find(x => x.code === code);
		const c = d && find(d.commentId);
		const src = d && sourceOf(d.source);
		if (!d || !c || !src) return { ok: false, reason: "그 초안을 찾지 못했어요" };
		if (d.status !== "pending") return { ok: false, reason: "이 초안은 이미 처리됐어요" };
		if (d.mail && mailView(d)) return { ok: true, mail: d.mail, existing: true };
		if (!deps.mail) return { ok: false, reason: "메일 초안을 쓸 수 없어요" };
		if (!asksForFile(c.text)) return { ok: false, reason: "파일을 요청한 댓글이 아니에요" };
		const to = ADDRESS.exec(c.text)?.[0];
		if (!to) return { ok: false, reason: "댓글에 메일 주소가 없어요" };
		if (linking.has(code)) return { ok: false, reason: "메일 초안을 만드는 중이에요" };
		const addNote = (note: string): void => {
			const cur = store.drafts().find(x => x.code === code)!;
			if (!cur.notes.includes(note)) store.putDraft({ ...cur, clean: false, notes: [...cur.notes, note] });
			emit({ kind: "comment_draft", source: d.source, thread: d.thread });
		};
		if (!src.mailApp) {
			addNote(MAIL_NO_APP_NOTE);
			return { ok: false, reason: "이 출처에 메일 앱이 정해져 있지 않아요" };
		}
		linking.add(code);
		try {
			const title = isUntitled(c) ? "" : clip(c.postTitle, 60);
			const made = await deps.mail.compose({
				app: src.mailApp,
				to,
				subject: title ? `${title} 자료 보내드립니다` : "요청하신 자료 보내드립니다",
				body: (await deps.mail.write?.({ app: src.mailApp, to, author: c.author, text: c.text, postTitle: title }).catch(e => (addNote(`확인: 메일 본문을 쓰지 못해 기본 문구로 했어요 - ${e instanceof Error && e.message ? clip(e.message, 160) : "알 수 없는 이유"}`), undefined)))?.trim() || `안녕하세요, ${c.author}님.\n\n댓글로 요청하신 자료를 보내드립니다. 확인 후 부족한 점이 있으면 편하게 말씀해 주세요.\n\n감사합니다.`,
				fromLibrary: clip(`${title} ${c.text.replace(to, " ")}`, 200),
				request: c.text,
			}).catch((e): { ok: false; reason: string } => ({ ok: false, reason: e instanceof Error && e.message ? clip(e.message, 160) : "메일 초안을 만들지 못했어요" }));
			if (!made.ok) {
				addNote(`확인: 메일 초안을 만들지 못했어요 - ${made.reason}`);
				return { ok: false, reason: made.reason };
			}
			// The draft may have changed while the mail was written (revised, dropped): the mail rides on the draft as it is now, or is dropped again.
			const cur = store.drafts().find(x => x.code === code);
			if (!cur || cur.status !== "pending") {
				deps.mail.drop(made.id);
				return { ok: false, reason: "이 초안은 이미 처리됐어요" };
			}
			if (cur.mail && cur.mail !== made.id) deps.mail.drop(cur.mail);
			const check = recipientCheck(to, c.text);
			const found = [...(made.notes ?? []), ...(made.libraryMiss && !made.notes?.some(n => n.includes("찾지 못했어요")) ? [LIBRARY_MISS_NOTE] : []), ...(check ? [`확인: ${check}`] : [])];
			const notes = [...cur.notes.filter(n => n !== MAIL_NO_APP_NOTE), ...found.filter((n, i) => !cur.notes.includes(n) && found.indexOf(n) === i)];
			store.putDraft({ ...cur, mail: made.id, mailAt: deps.now(), clean: false, notes });
			emit({ kind: "comment_draft", source: d.source, thread: d.thread });
			return { ok: true, mail: made.id };
		} finally {
			linking.delete(code);
		}
	}

	// A draft written outside the model (an old script of the owner): same pending draft, same gate. `extra` is what else the script does when it is
	// approved (e.g. a mail with attachments); it is shown to the owner as a note, so the draft is never "clean" and no rule sends it alone.
	// `mail`: a mail that goes out right after the reply, approved by the same pick (the mail draft is made here, the card shows both).
	async function addDraft(commentId: string, text: string, extra?: string, mail?: MailSpec): Promise<Step> {
		const c = find(commentId);
		const src = c && sourceOf(c.source);
		if (!c || !src) return { ok: false, reason: "원댓글을 찾지 못했어요" };
		if (c.mine) return { ok: false, reason: "내가 쓴 댓글에는 답글 초안을 만들지 않아요" };
		if (mail && !deps.mail) return { ok: false, reason: "메일 초안을 쓸 수 없어요" };
		const made = mail ? await deps.mail!.compose(mail).catch((e): { ok: false; reason: string } => ({ ok: false, reason: e instanceof Error && e.message ? clip(e.message, 160) : "메일 초안을 만들지 못했어요" })) : undefined;
		if (made && !made.ok) return { ok: false, reason: made.reason };
		// The mail goes to the address the comment wrote, as written: one that differs (or looks like the writer's typo) is a line on the card.
		const toCheck = mail ? recipientCheck(mail.to, c.text) : undefined;
		const notes = [...(extra ? [`함께 할 일: ${extra}`] : []), ...(toCheck ? [`확인: ${toCheck}`] : [])];
		for (const d of store.drafts()) if (d.commentId === c.id && d.status === "pending") store.setDraftStatus(d.code, "stale");
		const draft: Draft = { code: code(), commentId: c.id, source: src.key, thread: c.thread, text, status: "pending", created: deps.now(), changes: [], clean: !notes.length && !made, notes, ...(made ? { mail: made.id, mailAt: deps.now() } : {}) };
		store.putDraft(draft);
		emit({ kind: "comment_draft", source: src.key, thread: c.thread });
		return { ok: true, draft };
	}

	// The reply goes through the gate (contract.ts); only when it was posted does the mail of the same card go out, so a refused or failed reply
	// sends no mail. A failed mail leaves the reply posted and says so in the send record (Reply.mail) and the event.
	// `only: "reply"` posts the reply and leaves the mail draft on its own (no longer linked once the reply draft is sent, so it is asked and sent
	// by itself: hub/mail-cli.ts ask/send).
	function send(codeOrId: string, opts: { text?: string; by: "owner" | "rule"; only?: "reply"; asIs?: true; resend?: true }): GateResult {
		const linked = opts.by === "owner" && opts.only !== "reply" ? store.drafts().find(d => d.code === codeOrId) : undefined;
		if (linked?.status === "pending" && linked.mail && !mailView(linked)) return mailGoneRefusal(store, linked, deps.now());
		const mailId = linked?.mail;
		const r = (mailId ? mailLintRefusal(deps.mail, mailId) : undefined) ?? (mailId && !opts.asIs ? mailRefusal(deps.mail, mailId) : undefined) ?? dispatchReply({ code: codeOrId, approval: { by: opts.by }, ...(opts.text !== undefined ? { text: opts.text } : {}), ...(opts.resend ? { resend: true as const } : {}) }, gate);
		if (!r.ok) return r;
		const done = mailId ? r.done.then(rep => sendMail(rep, mailId, opts.asIs)) : r.done;
		pending.add(done);
		void done.finally(() => pending.delete(done));
		return { ...r, done };
	}

	async function sendMail(rep: Reply, mailId: string, asIs?: true): Promise<Reply> {
		if (rep.state !== "sent") return rep;
		let mail: MailOutcome;
		try {
			const m = deps.mail ? await deps.mail.send(mailId, asIs ? { asIs } : undefined) : { ok: false, text: "메일 보내기를 쓸 수 없어요" };
			mail = { state: m.ok ? "sent" : "failed", text: m.text };
		} catch (e) {
			mail = { state: "failed", text: e instanceof Error && e.message ? clip(e.message, 160) : "메일을 보내는 중 오류가 났어요" };
		}
		const final: Reply = { ...rep, mail };
		store.putReply(final);
		emit({ kind: "comment_send", source: rep.source, thread: rep.thread, id: rep.id, state: rep.state, mail: mail.state, ...(mail.state === "failed" ? { mailReason: mail.text } : {}) });
		return final;
	}

	// 메일만 보내기 (owner only): the mail of a reply + mail card goes out now; the reply draft stays pending alone and is asked again.
	async function sendMailOnly(draftCode: string, opts: { retry?: true; asIs?: true } = {}): Promise<{ ok: boolean; text: string }> {
		const d = store.drafts().find(x => x.code === draftCode);
		if (!d || d.status !== "pending") return d?.status === "sent" ? resendPostedMail(store, deps.mail, d, opts, emit) : { ok: false, text: "그 초안을 찾지 못했거나 이미 처리됐어요" };
		if (!d.mail || !deps.mail) return { ok: false, text: "이 초안에는 함께 보낼 메일이 없어요" };
		const m = await deps.mail.send(d.mail, sendOpts(opts)).catch(e => ({ ok: false, text: e instanceof Error && e.message ? clip(e.message, 160) : "메일을 보내는 중 오류가 났어요" }));
		if (m.ok) {
			const { mail: _mail, mailAt: _mailAt, ...rest } = d;
			store.putDraft({ ...rest, clean: !rest.notes.length, mailKept: d.mail });
			emit({ kind: "comment_draft", source: d.source, thread: d.thread });
		}
		return m;
	}

	const mailView = (d: Draft): MailView | undefined => (d.mail ? deps.mail?.view(d.mail) : undefined);

	// The linked mail of a comment, from the send record (the mail went out or failed after the reply) or from its draft: the mail draft that rides on a
	// pending reply, or one left on its own (reply answered elsewhere, 답글만/메일만 보내기). A mail draft that is gone shows nothing.
	function mailMarkOf(commentId: string, replies: Reply[] = store.replies(), drafts: Draft[] = store.drafts()): MailMark | undefined {
		const rep = replies.filter(r => r.commentId === commentId && r.mail).at(-1);
		if (rep?.mail) return rep.mail.state === "sent" ? { state: "sent", label: "메일 보냄" } : { state: "failed", label: `메일 실패: ${clip(rep.mail.text, 80)}` };
		for (const d of drafts.filter(x => x.commentId === commentId).reverse()) {
			const id = d.status === "pending" ? d.mail : d.mailKept ?? (d.status === "sent" ? d.mail : undefined);
			if (!id) continue;
			const st = deps.mail?.state?.(id) ?? (deps.mail?.view(id) ? "pending" : undefined);
			if (st === "pending") return { state: "drafted", label: "메일 초안 작성됨" };
			if (st === "sent") return { state: "sent", label: "메일 보냄" };
		}
		return undefined;
	}

	// Whether the owner has answered a comment, whatever the platform or the app was the place: a comment of his under it, a reply sent from here, or the
	// adapter's own sign (Instagram: he @mentioned the author).
	const answeredBy = (c: Comment, replies: Reply[]): boolean => stream(c).some(x => x.mine && x.at >= c.at) || answeredOnPlatform(c) || replies.some(r => r.commentId === c.id && r.state === "sent");

	// Why a pending draft of comment `c` no longer waits (settle closes it; needs never counts it), or undefined while it still waits.
	const closing = (c: Comment, replies: Reply[], dismissed: Record<string, unknown>): ClosedReason | undefined => (c.gone ? "deleted" : dismissed[c.id] ? "dismissed" : answeredBy(c, replies) ? "answered-on-platform" : undefined);

	// A pending draft whose comment stopped waiting (answered on the platform, deleted, 답장 안 함) is closed as "answered" with the reason. A mail that rode
	// on it is detached, as 메일만 보내기 does: it stays a pending mail draft of its own, and the closed draft says so. Closed drafts are never reopened.

	function settle(): number {
		const replies = store.replies(), dismissed = store.dismissed();
		let closed = 0;
		for (const d of store.drafts()) {
			if (d.status !== "pending") continue;
			const c = find(d.commentId);
			if (!c || replies.some(r => r.commentId === c.id && (r.state === "sending" || r.state === "unsure"))) continue;
			const reason = closing(c, replies, dismissed);
			if (!reason) continue;
			const { mail, mailAt: _mailAt, ...rest } = d;
			store.putDraft({ ...rest, status: "answered", closedReason: reason, ...(mail ? { notes: [...rest.notes, MAIL_KEPT_NOTE], mailKept: mail } : {}) });
			emit({ kind: "comment_draft", source: d.source, thread: d.thread });
			closed++;
		}
		return closed;
	}

	// The still-open comments of a source, for adapter.recheck: top-level comments that wait for a reply or hold a pending draft, and stored replies whose author
	// the adapter could not name yet (so it can resolve them). Oldest first, so a capped run rotates through them (cursor `<source>#recheck`).
	function recheckBatch(src: SourceConfig): Comment[] {
		const drafted = new Set(store.drafts().filter(d => d.status === "pending").map(d => d.commentId));
		const all = store.comments().filter(c => c.source === src.key && !c.mine && !c.gone && watches(src, c.thread) && (c.parent ? c.author === UNKNOWN_USER : unreplied(c) || drafted.has(c.id))).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
		if (all.length <= RECHECK_CAP) return all;
		const key = `${src.key}#recheck`;
		const from = Number(store.cursors()[key]?.cursor) || 0;
		const start = from < all.length ? from : 0;
		store.setCursor(key, { cursor: String((start + RECHECK_CAP) % all.length) });
		return [...all, ...all].slice(start, start + RECHECK_CAP);
	}

	// Makes the stored comments match the platforms, and is safe to run again and again: with `recheck` each adapter that can re-reads the still-open comments
	// (owner's replies found later, deleted comments); then every pending draft whose comment no longer waits is closed (settle). Never posts anything.
	async function reconcile(opts: { recheck?: boolean } = {}): Promise<ReconcileResult> {
		const out: ReconcileResult = { answered: 0, gone: 0, draftsClosed: 0 };
		const cfg = store.config();
		if (!cfg.enabled) return out;
		// A reply can have two copies (`k.0` and `k.1` of one reply, read twice with a shifted index): each pass merges one copy per real row, so it runs
		// until nothing is left to merge.
		let merged = 0;
		for (let i = 0, n = mergeIgTwins(store, UNKNOWN_USER); n && i < 5; i++, n = mergeIgTwins(store, UNKNOWN_USER)) merged += n;
		if (merged) out.merged = merged;
		if (opts.recheck)
			for (const src of Object.values(cfg.sources)) {
				const adapter = deps.adapters[src.kind];
				if (!adapter?.recheck || !src.watch.length) continue;
				// Once per Instagram source (issue #31): his rows stored top-level although they may be replies are read again so they find their comment.
				const parentsKey = `${src.key}#parents`;
				const orphans = src.kind === "instagram" && !store.cursors()[parentsKey] ? store.comments().filter(c => c.source === src.key && c.mine && !c.parent && !c.gone && watches(src, c.thread)) : [];
				const open = recheckBatch(src);
				const batch = [...open, ...orphans.filter(o => !open.some(c => c.id === o.id))];
				if (!batch.length) continue;
				const replies = store.replies();
				const waiting = batch.filter(c => !c.parent && !c.mine && !answeredBy(c, replies));
				try {
					const res = await adapter.recheck(src, batch);
					absorbComments(store, deps.collector, UNKNOWN_USER, src, res.comments);
					const at = deps.now();
					const gone = new Set(res.gone);
					if (orphans.length) store.setCursor(parentsKey, { ranAt: at });
					const marks = Object.fromEntries(batch.filter(c => !c.parent && !c.mine && gone.has(c.native)).map(c => [c.id, { gone: at }]));
					store.patchComments(marks);
					out.gone += Object.keys(marks).length;
					const now = store.replies();
					out.answered += waiting.filter(c => { const cur = find(c.id); return !!cur && !cur.gone && answeredBy(cur, now); }).length;
				} catch (e) {
					(out.errors ??= {})[src.key] = e instanceof Error ? clip(e.message, 160) : "다시 확인하지 못했어요";
				}
			}
		out.draftsClosed = settle();
		return out;
	}

	// The script part of the watch: reads new comments of every source the owner chose, stores the new ids, then (only for sources with
	// auto-draft on) drafts, and (only with the owner's rule) sends through the gate. Nothing is read for a source with nothing chosen.
	// New comments that need an auto-draft go to the source's queue (cursors.json) before any model call; a run drafts at most
	// MAX_AUTO_PER_RUN of them and starts nothing after `deadline` (the watch's run budget), so the rest waits for the next run. A comment
	// leaves the queue only after its draft is stored, and one that already has a draft is skipped: a run killed mid-draft loses nothing and
	// drafts nothing twice.
	async function collect(opts: { force?: boolean; deadline?: number } = {}): Promise<{ added: Comment[]; drafted: Draft[]; sent: Reply[]; errors: Record<string, string> }> {
		const out = { added: [] as Comment[], drafted: [] as Draft[], sent: [] as Reply[], errors: {} as Record<string, string> };
		const cfg = store.config();
		if (!cfg.enabled) return out;
		const late = () => opts.deadline !== undefined && deps.now() >= opts.deadline;
		for (const src of Object.values(cfg.sources)) {
			const adapter = deps.adapters[src.kind];
			if (!adapter || !src.watch.length) continue;
			if (late()) break;
			const prior = store.cursors()[src.key] ?? {};
			if (!opts.force && prior.ranAt && deps.now() - prior.ranAt < (src.everyMin ?? DEFAULT_EVERY_MIN) * 60_000) {
				await autoDrafts(src, out, late);
				continue;
			}
			let fresh: Comment[];
			try {
				const res = await adapter.list(src, prior.cursor);
				// A time after the read (a source's clock or a misparsed stamp, issue #31) is the read time: a comment from the future would sort above
				// everything that comes later and never age out of the unreplied list.
				const now = deps.now();
				fresh = absorbComments(store, deps.collector, UNKNOWN_USER, src, res.comments.map(r => (r.at > now ? { ...r, at: now } : r)));
				const wanted = src.autoDraft && replyOn(src) ? fresh.filter(c => c.at >= (src.autoSince ?? 0) && needsReply(c)).map(c => c.id) : [];
				// Not capped: a waiting comment is never dropped silently. It is bounded anyway: only stored comments (MAX_COMMENTS) are queued, and a queue entry whose comment is gone or answered is settled without a model call.
				const queue = [...new Set([...(prior.queue ?? []), ...wanted])];
				store.setCursor(src.key, { cursor: res.cursor ?? prior.cursor, ranAt: deps.now(), ...(res.error ? { error: clip(res.error, 160) } : {}), ...(queue.length ? { queue } : {}) });
				if (res.error) out.errors[src.key] = clip(res.error, 160);
			} catch (e) {
				const reason = e instanceof Error ? clip(e.message, 160) : "읽지 못했어요";
				out.errors[src.key] = reason;
				store.setCursor(src.key, { ...prior, ranAt: deps.now(), error: reason });
				continue;
			}
			await retitle(src, adapter);
			out.added.push(...fresh);
			for (const t of new Set(fresh.map(c => c.thread))) emit({ kind: "comment", source: src.key, thread: t });
			await autoDrafts(src, out, late);
		}
		// Settle what the reads showed; the slow part (re-reading open comments on the platforms) runs at most every RECHECK_EVERY_MS unless forced.
		const last = store.cursors().reconcile?.ranAt ?? 0;
		const due = opts.force === true || deps.now() - last >= RECHECK_EVERY_MS;
		if (due) store.setCursor("reconcile", { ranAt: deps.now() });
		const rec = await reconcile({ recheck: due });
		for (const [k, v] of Object.entries(rec.errors ?? {})) out.errors[`${k}#recheck`] = v;
		return out;
	}

	async function autoDrafts(src: SourceConfig, out: { drafted: Draft[]; sent: Reply[] }, late: () => boolean): Promise<void> {
		if (!src.autoDraft || !replyOn(src)) return;
		const done = (id: string) => {
			const cur = store.cursors()[src.key] ?? {};
			const queue = (cur.queue ?? []).filter(x => x !== id);
			const { queue: _q, ...rest } = cur;
			store.setCursor(src.key, { ...rest, ...(queue.length ? { queue } : {}) });
		};
		let made = 0;
		for (const id of store.cursors()[src.key]?.queue ?? []) {
			if (made >= MAX_AUTO_PER_RUN || late()) break;
			const c = find(id);
			if (!c || store.drafts().some(d => d.commentId === id) || !needsReply(c)) {
				done(id);
				continue;
			}
			made++;
			const step = await makeDraft(c.id);
			done(id);
			if (!step.ok) continue;
			out.drafted.push(step.draft);
			if (ruleAllows(src, c.text)) {
				const r = send(step.draft.code, { by: "rule" });
				if (r.ok) out.sent.push(await r.done);
			}
		}
	}

	// Stored comments that were collected without a post title (the title was not readable then) get it now; a failure leaves them for the next poll.
	async function retitle(src: SourceConfig, adapter: CommentAdapter): Promise<void> {
		if (!adapter.retitle) return;
		const stale = [...new Set(store.comments().filter(c => c.source === src.key && isUntitled(c)).map(c => c.thread))];
		if (!stale.length) return;
		try {
			for (const [thread, p] of Object.entries(await adapter.retitle(src, stale))) store.retitle(src.key, thread, { postTitle: p.title, postLink: p.link, thumb: p.thumb });
		} catch {}
	}

	function drop(draftCode: string): { ok: boolean; reason?: string } {
		const d = store.drafts().find(x => x.code === draftCode);
		if (!d) return { ok: false, reason: "그 초안을 찾지 못했어요" };
		if (d.status !== "pending") return { ok: false, reason: "이 초안은 이미 처리됐어요" };
		store.setDraftStatus(draftCode, "dropped");
		if (d.mail) deps.mail?.drop(d.mail);
		emit({ kind: "comment_draft", source: d.source, thread: d.thread });
		return { ok: true };
	}

	// 되돌리기 after 보내지 않기: the dropped draft waits again, unless a newer draft of the same comment came meanwhile. A draft whose mail was dropped
	// with it cannot come back (the mail draft is gone).
	function restore(draftCode: string): { ok: boolean; reason?: string } {
		const d = store.drafts().find(x => x.code === draftCode);
		if (!d) return { ok: false, reason: "그 초안을 찾지 못했어요" };
		if (d.status !== "dropped") return { ok: false, reason: "보내지 않기로 한 초안만 되돌릴 수 있어요" };
		if (d.mail) return { ok: false, reason: "함께 보낼 메일이 있는 초안은 되돌릴 수 없어요" };
		if (store.drafts().some(x => x.commentId === d.commentId && x.code !== d.code && x.status === "pending")) return { ok: false, reason: "그사이 새 초안이 와서 되돌리지 않았어요" };
		store.setDraftStatus(draftCode, "pending");
		emit({ kind: "comment_draft", source: d.source, thread: d.thread });
		return { ok: true };
	}

	// A failed send: 다시 보내기 sends the same text through the gate again (its draft is still pending after a failure, contract.ts), 지우기 forgets the
	// record (the draft stays, so the reply can still be sent or dropped from its card).
	function retrySend(id: string): GateResult {
		const r = store.replies().find(x => x.id === id);
		if (!r) return { ok: false, reason: "그 보낸 기록을 찾지 못했어요" };
		if (r.state !== "failed" && r.state !== "unsure") return { ok: false, reason: "실패한 답글만 다시 보낼 수 있어요" };
		return send(r.draft, { by: "owner", text: r.text, ...(r.state === "unsure" ? { resend: true as const } : {}) });
	}
	function dismissSend(id: string): { ok: boolean; reason?: string } {
		const r = store.replies().find(x => x.id === id);
		if (!r) return { ok: false, reason: "그 보낸 기록을 찾지 못했어요" };
		if (r.state !== "failed") return { ok: false, reason: "실패한 답글만 지울 수 있어요" };
		store.removeReply(id);
		emit({ kind: "comment_send", source: r.source, thread: r.thread, id: r.id, state: "removed" });
		return { ok: true };
	}

	// Every pending reply draft of the sources he chose, for the one 답장 확인 queue (GET /api/comments/drafts): the draft, where it goes and the comment it answers.
	function pendingDrafts() {
		const cfg = store.config();
		if (!cfg.enabled) return [];
		const comments = store.comments(), replies = store.replies(), all = store.drafts();
		return all.filter(d => d.status === "pending" && cfg.sources[d.source]).map(d => {
			const src = cfg.sources[d.source]!, c = comments.find(x => x.id === d.commentId);
			// A comment reply goes out as text only, so its card always says so (첨부: 없음 · 파일을 붙일 수 없는 곳): a file goes only with the mail that rides along,
			// and those files are the mail's own (mailJson).
			return { code: d.code, app: ownerOf(src), kind: src.kind, source: src.key, sourceLabel: src.label, thread: d.thread, commentId: d.commentId, title: c?.postTitle ?? "", link: c?.postLink ?? null, to: c?.author ?? "", text: d.text, notes: d.notes, created: d.created, attachmentsNone: true, cannotAttach: [],
				...(c ? { original: { who: c.author, text: clip(c.text, 200), at: c.at } } : {}), ...mailJson(d), ...(d.mail && mailView(d) ? { mailMark: mailMarkOf(d.commentId, replies, all) } : {}) };
		});
	}

	// `part` "mail" changes only the mail of the card (the reply stays, same code); "reply" (default) rewrites the reply and the mail stays attached,
	// or with `noMail` is dropped once the new reply draft exists, so the card is the reply alone.
	async function revise(draftCode: string, change: string, part: "reply" | "mail" = "reply", noMail = false, opts: { learn?: false } = {}): Promise<Step & { lesson?: string }> {
		const d = store.drafts().find(x => x.code === draftCode);
		const c = d && find(d.commentId);
		const src = d && sourceOf(d.source);
		if (!d || !c || !src) return { ok: false, reason: "그 초안을 찾지 못했어요" };
		if (!replyOn(src)) return { ok: false, reason: OFF_REASON };
		if (d.status !== "pending") return { ok: false, reason: "이 초안은 이미 처리됐어요" };
		if (!change.trim()) return { ok: false, reason: "무엇을 고칠지 적어 주세요" };
		if (part === "mail") {
			if (!d.mail || !deps.mail) return { ok: false, reason: "이 초안에는 함께 보낼 메일이 없어요" };
			const m = await deps.mail.revise(d.mail, change.trim()).catch((e): { ok: false; reason: string } => ({ ok: false, reason: e instanceof Error && e.message ? clip(e.message, 160) : "고친 메일을 만들지 못했어요" }));
			if (!m.ok) return { ok: false, reason: m.reason };
			const next: Draft = { ...d, mail: m.id, mailAt: deps.now(), changes: [...d.changes, `메일: ${change.trim()}`] };
			store.putDraft(next);
			emit({ kind: "comment_draft", source: d.source, thread: d.thread });
			return { ok: true, draft: next };
		}
		const { mail: _mail, mailAt: _mailAt, ...replyOnly } = d;
		return run(c, src, noMail ? replyOnly : d, change.trim(), opts)
			.then(step => {
				if (step.ok && noMail && d.mail) deps.mail?.drop(d.mail);
				return step;
			})
			.catch(e => ({ ok: false as const, reason: e instanceof Error && e.message ? clip(e.message, 160) : "고친 초안을 만들지 못했어요" }));
	}

	// 직접 수정 (design 3.3): the owner's text under the same code, no model call. An edited draft is never `clean`, so no rule sends it by itself.
	function edit(draftCode: string, text: string, part: "reply" | "mail" = "reply"): { ok: true } | { ok: false; reason: string; code?: string; lint?: string[] } {
		const d = store.drafts().find(x => x.code === draftCode);
		const src = d && sourceOf(d.source);
		if (!d || !src) return { ok: false, reason: "그 초안을 찾지 못했어요", code: "gone" };
		if (d.status !== "pending") return { ok: false, reason: "이 초안은 이미 처리됐어요", code: "not_pending" };
		if (part === "mail") return d.mail && deps.mail?.edit ? deps.mail.edit(d.mail, text) : { ok: false, reason: "이 초안에는 함께 보낼 메일이 없어요", code: "not_supported" };
		const body = text.replace(/\r\n?/g, "\n").trim();
		const found = ownerLint({ body }, { kind: "comment", app: src.key, from: find(d.commentId)?.author ?? "", text: "" }, styleOf(src));
		if (found.length) return { ok: false, reason: `${LINT_REFUSED} ${found.join(" · ")}`, code: found[0]!.startsWith("it uses the forbidden") ? "forbidden_word" : found[0]!.startsWith("the body is empty") ? "empty" : found[0]!.startsWith("the body is") ? "too_long" : "placeholder", lint: found };
		store.putDraft({ ...d, text: body, clean: false, ...(d.editedFrom === undefined ? { editedFrom: d.text } : {}) });
		emit({ kind: "comment_draft", source: d.source, thread: d.thread });
		return { ok: true };
	}
	// What a sent draft the owner edited teaches (design 3.4): his text against the model's, in the source's profile; nothing before it went out.
	function learned(draftCode: string): { key: { app: string }; line: string } | undefined {
		const d = store.drafts().find(x => x.code === draftCode);
		if (d?.status !== "sent" || d.editedFrom === undefined) return undefined;
		const line = editLesson(d.editedFrom, d.text);
		return line ? { key: { app: d.source }, line } : undefined;
	}

	function update(key: string, patch: { watch?: string[]; autoDraft?: boolean; autoSend?: SourceConfig["autoSend"]; autoMail?: boolean; mailApp?: string }): SourceConfig | undefined {
		const src = sourceOf(key);
		if (!src) return undefined;
		const next: SourceConfig = { ...src };
		if (patch.watch) next.watch = [...new Set(patch.watch)];
		if (patch.autoDraft !== undefined) {
			next.autoDraft = patch.autoDraft;
			if (patch.autoDraft) next.autoSince = deps.now();
		}
		if (patch.autoSend) next.autoSend = patch.autoSend;
		if (patch.autoMail !== undefined) next.autoMail = patch.autoMail;
		if (patch.mailApp !== undefined) {
			if (patch.mailApp) next.mailApp = patch.mailApp;
			else delete next.mailApp;
		}
		if (!next.watch.length) next.autoDraft = false;
		store.setSource(next);
		emit({ kind: "comment_sources" });
		return next;
	}

	// A comment he already answered on the platform (his reply came after it) is not unread, even when a read stores it only now.
	const unreadOf = (c: Comment, reads: Record<string, number>) => !c.mine && !c.gone && c.at > (reads[threadKey(c.source, c.thread)] ?? 0) && !stream(c).some(x => x.mine && x.at >= c.at);

	function threads(app: string) {
		const cfg = store.config();
		const mine = new Set(Object.values(cfg.sources).filter(s => ownerOf(s) === app).map(s => s.key));
		const reads = store.reads();
		const pendingDrafts = store.drafts().filter(d => d.status === "pending");
		const replies = store.replies(), dismissed = store.dismissed(), allDrafts = store.drafts();
		const mailCounts = threadMailCounts(replies, allDrafts, id => mailMarkOf(id, replies, allDrafts)?.state);
		const by = new Map<string, Comment[]>();
		for (const c of store.comments()) if (mine.has(c.source) && watches(cfg.sources[c.source]!, c.thread)) by.set(threadKey(c.source, c.thread), [...(by.get(threadKey(c.source, c.thread)) ?? []), c]);
		return [...by.values()]
			.map(list => {
				const last = list[list.length - 1]!;
				return { source: last.source, thread: last.thread, kind: cfg.sources[last.source]!.kind, title: last.postTitle, link: last.postLink ?? null, thumb: last.thumb ?? null, lastAt: last.at, lastText: clip(last.text, 80), lastAuthor: last.mine ? "나" : last.author, unread: list.filter(c => unreadOf(c, reads)).length, drafts: pendingDrafts.filter(d => d.source === last.source && d.thread === last.thread).length, unreplied: list.filter(c => unrepliedWith(c, replies, dismissed)).length, ...mailCounts(list) };
			})
			.sort((a, b) => b.lastAt - a.lastAt);
	}

	function threadView(source: string, thread: string) {
		const src = sourceOf(source);
		if (!src || !watches(src, thread)) return undefined;
		const list = store.comments().filter(c => c.source === source && c.thread === thread);
		if (!list.length) return undefined;
		const since = deps.now() - 24 * 3600 * 1000;
		const first = list[0]!;
		const replies = store.replies(), allDrafts = store.drafts();
		const mailMarks = new Map(list.map(c => [c.id, mailMarkOf(c.id, replies, allDrafts)] as const));
		return {
			source: { key: src.key, kind: src.kind, label: src.label },
			thread: { id: thread, title: list[list.length - 1]!.postTitle, link: list[list.length - 1]!.postLink ?? first.postLink ?? null, thumb: list[list.length - 1]!.thumb ?? first.thumb ?? null },
			comments: list.map(c => ({ id: c.id, parent: c.parent ?? null, author: c.author, text: c.text, at: c.at, mine: c.mine, ...(c.gone ? { gone: true } : {}), needsReply: needsReply(c), unreplied: unreplied(c), ...(mailMarks.get(c.id) ? { mail: mailMarks.get(c.id) } : {}) })),
			read: store.reads()[threadKey(source, thread)] ?? null,
			drafts: store.drafts().filter(d => d.source === source && d.thread === thread && d.status === "pending").map(d => ({ code: d.code, commentId: d.commentId, text: d.text, notes: d.notes, clean: d.clean, created: d.created, ...(d.tokens ? { tokens: d.tokens } : {}), ...mailJson(d), ...(mailMarks.get(d.commentId) ? { mailMark: mailMarks.get(d.commentId) } : {}) })),
			sends: replies.filter(r => r.source === source && r.thread === thread && r.at >= since).map(({ id, commentId, text, state, reason, at, via, mail }) => ({ id, commentId, text, state, ...(reason ? { reason } : {}), at, via, ...(mail ? { mail } : {}) })),
		};
	}

	// The mail of a draft as the web sheet shows it (sizes as text, like the files of a mail card).
	function mailJson(d: Draft): { mail?: { id: string; to: string; subject?: string; body: string; attachments: { name: string; size?: string }[]; notes?: string[] } } {
		const m = mailView(d);
		return m ? { mail: { id: m.id, to: m.to, ...(m.subject ? { subject: m.subject } : {}), body: m.body, attachments: m.attachments.map(f => ({ name: f.name, ...(f.size !== undefined ? { size: fileSizeText(f.size) } : {}) })), ...(m.notes?.length ? { notes: m.notes } : {}) } } : {};
	}

	function markRead(source: string, thread: string): void {
		const at = Math.max(0, ...store.comments().filter(c => c.source === source && c.thread === thread).map(c => c.at));
		if (at) store.markRead(threadKey(source, thread), at);
	}

	// What waits on the owner per app (the 모니터링 status line): pending drafts and unread comments of the sources he chose.
	function needs(): Record<string, { drafts: number; unread: number; unreplied: number }> {
		const cfg = store.config();
		const out: Record<string, { drafts: number; unread: number; unreplied: number }> = {};
		if (!cfg.enabled) return out;
		const reads = store.reads(), replies = store.replies(), dismissed = store.dismissed();
		for (const src of Object.values(cfg.sources)) out[ownerOf(src)] ??= { drafts: 0, unread: 0, unreplied: 0 };
		// The badge counts drafts by the comment's state as it is now: a pending draft on an answered, deleted or dismissed comment is not one (settle closes it).
		const all = store.comments();
		// One read of comments.json for every draft's lookup (needs runs on each status refresh).
		const byId = new Map(all.map(c => [c.id, c]));
		for (const d of store.drafts()) {
			const s = cfg.sources[d.source];
			const c = s && d.status === "pending" ? byId.get(d.commentId) : undefined;
			if (s && c && !closing(c, replies, dismissed)) out[ownerOf(s)]!.drafts++;
		}
		for (const c of all) {
			const s = cfg.sources[c.source];
			if (s && watches(s, c.thread) && unreadOf(c, reads)) out[ownerOf(s)]!.unread++;
			if (s && watches(s, c.thread) && unrepliedWith(c, replies, dismissed)) out[ownerOf(s)]!.unreplied++;
		}
		return out;
	}

	// 답장 안 함 (or undone with `on` false): the owner's mark that this comment needs no reply. false = no such comment.
	function noReply(id: string, on = true): boolean {
		const c = find(id);
		if (!c || !sourceOf(c.source)) return false;
		store.dismiss(id, deps.now(), on);
		emit({ kind: "comment", source: c.source, thread: c.thread });
		return true;
	}

	function tokenStats(): { drafts: number; avgIn: number; avgOut: number } {
		const measured = store.drafts().filter(d => d.tokens);
		const n = measured.length || 1;
		return { drafts: measured.length, avgIn: Math.round(measured.reduce((s, d) => s + d.tokens!.in, 0) / n), avgOut: Math.round(measured.reduce((s, d) => s + d.tokens!.out, 0) / n) };
	}

	const posts = async (key: string): Promise<Post[]> => {
		const src = sourceOf(key);
		const adapter = src && deps.adapters[src.kind];
		return src && adapter?.posts ? adapter.posts(src) : [];
	};
	const ownReplies = async (key: string): Promise<string[]> => {
		const src = sourceOf(key);
		const adapter = src && deps.adapters[src.kind];
		return src && adapter?.ownReplies ? adapter.ownReplies(src, 30) : [];
	};
	const idle = async () => {
		while (pending.size) await Promise.all([...pending]);
	};
	return { store, ownerOf, ...createSendRecovery({ store, adapters: deps.adapters, onState: gate.onState }), collect, refreshPast: createPastRefresh(store, deps, ownerOf), reconcile, makeDraft, revise, edit, learned, drop, restore, retrySend, dismissSend, pendingDrafts, send, sendMailOnly, update, threads, threadView, markRead, addDraft, linkMail, mailView, mailMarkOf, needs, noReply, unreplied, tokenStats, posts, ownReplies, idle, needsReply };
}
export type Engine = ReturnType<typeof createEngine>;
