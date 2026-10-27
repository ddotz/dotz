// The comment engine: collect (script only, no model), draft (a model call only on request or per-source auto-draft), send (only through
// the gate in contract.ts). Everything is injected (adapters, model, clock, tone, broadcast) so tests run without a network.
import { generateReply, reviseReply, type ReplyItem, type ReplyStyle } from "../reply-draft.ts";
import { type Comment, type CommentAdapter, dispatchReply, type GateResult, isUntitled, type Post, ruleAllows, type SourceConfig, type SourceKind, threadKey, toComment, watches } from "./contract.ts";
import { fileSizeText } from "../draft-approval.ts";
import { createStore, type Draft, type MailOutcome, type Reply, type Tokens } from "./store.ts";
import { unrepliedFresh } from "../unreplied.ts";

// The mail that rides on a comment reply (hub/comments/mail-link.ts is the real one): written with the draft, shown in the same card, sent right
// after the reply is posted, revised or dropped with it.
export type MailSpec = { app: string; to: string; subject: string; body: string; attach?: string[]; fromLibrary?: string };
export type MailView = { id: string; to: string; subject?: string; body: string; attachments: { name: string; size?: number }[]; asksFile?: boolean; libraryMiss?: boolean };
export type MailLink = {
	compose: (spec: MailSpec) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
	/** Sends the mail draft; the reply was just posted by the owner's pick, so no second pick is asked. */
	send: (id: string) => Promise<{ ok: boolean; text: string }>;
	drop: (id: string) => void;
	revise: (id: string, change: string) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
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
};

export const appOf = (src: Pick<SourceConfig, "kind">): string => (src.kind === "website" ? "site" : src.kind);
export const OFF_REASON = "댓글 답글이 꺼져 있어요. 앱 설정에서 켜 주세요";
const MAX_AUTO_PER_RUN = 5;
const DEFAULT_EVERY_MIN = 5;
const SAMPLES = 5;
const CONTEXT_COMMENTS = 6;
const CLIP = 240;
const BASE32 = "abcdefghjkmnpqrstvwxyz23456789";
const clip = (s: string, n = CLIP) => s.replace(/\s+/g, " ").trim().slice(0, n);
const estimate = (chars: number) => Math.ceil(chars / 3);

export type Step = { ok: true; draft: Draft } | { ok: false; reason: string };

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
		!c.mine && !c.parent && !stream(c).some(x => x.mine && x.parent === c.native) && !store.replies().some(r => r.commentId === c.id && r.state !== "failed") && !store.drafts().some(d => d.commentId === c.id && d.status === "pending") && !answeredOnPlatform(c);

	// 미답장 (hub/unreplied.ts): someone else's comment stays open until a reply was sent for it, a comment of his own came after it in the same
	// stream (he answered on the platform), or he tapped 답장 안 함. Reading it changes nothing.
	const unrepliedWith = (c: Comment, replies: Reply[], dismissed: Record<string, number>): boolean =>
		!c.mine && unrepliedFresh(c.at, deps.now()) && !dismissed[c.id] && !replies.some(r => r.commentId === c.id && r.state !== "failed") && !stream(c).some(x => x.mine && x.at >= c.at) && !answeredOnPlatform(c);
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

	async function run(c: Comment, src: SourceConfig, previous?: Draft, change?: string): Promise<Step> {
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
		const item: ReplyItem = { kind: "comment", app: src.key, from: c.author, text: c.text, context: contextOf(c) };
		const style = styleOf(src);
		const r = previous && change !== undefined ? await reviseReply(item, style, { to: `${c.author} 댓글`, body: previous.text }, change, call) : await generateReply(item, style, call);
		if (r.action === "skip") return { ok: false, reason: r.reason || "답할 내용이 없어서 초안을 만들지 않았어요" };
		const measured: Tokens = tokens.reported ? { in: tokens.in, out: tokens.out } : { in: estimate(tokens.chars), out: estimate(tokens.outChars), estimated: true };
		const notes = [...r.warnings.map(w => `확인: ${w}`), ...r.questions.map(q => `정해 주세요: ${q}`)];
		for (const d of store.drafts()) if (d.commentId === c.id && d.status === "pending") store.setDraftStatus(d.code, "stale");
		const draft: Draft = { code: code(), commentId: c.id, source: src.key, thread: c.thread, text: r.draft.body, status: "pending", created: deps.now(), changes: previous ? [...previous.changes, change ?? ""] : [], clean: !notes.length && !previous?.mail, notes, tokens: measured, ...(previous?.mail ? { mail: previous.mail, ...(previous.mailAt ? { mailAt: previous.mailAt } : {}) } : {}) };
		store.putDraft(draft);
		emit({ kind: "comment_draft", source: src.key, thread: c.thread });
		return { ok: true, draft };
	}

	function makeDraft(commentId: string): Promise<Step> {
		const c = find(commentId);
		const src = c && sourceOf(c.source);
		if (!c || !src) return Promise.resolve({ ok: false, reason: "원댓글을 찾지 못했어요" });
		if (!replyOn(src)) return Promise.resolve({ ok: false, reason: OFF_REASON });
		if (c.mine) return Promise.resolve({ ok: false, reason: "내가 쓴 댓글에는 답글 초안을 만들지 않아요" });
		return run(c, src).catch(e => ({ ok: false as const, reason: e instanceof Error && e.message ? clip(e.message, 160) : "초안을 만들지 못했어요. 잠시 뒤에 다시 눌러 주세요" }));
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
		const notes = extra ? [`함께 할 일: ${extra}`] : [];
		for (const d of store.drafts()) if (d.commentId === c.id && d.status === "pending") store.setDraftStatus(d.code, "stale");
		const draft: Draft = { code: code(), commentId: c.id, source: src.key, thread: c.thread, text, status: "pending", created: deps.now(), changes: [], clean: !notes.length && !made, notes, ...(made ? { mail: made.id, mailAt: deps.now() } : {}) };
		store.putDraft(draft);
		emit({ kind: "comment_draft", source: src.key, thread: c.thread });
		return { ok: true, draft };
	}

	// The reply goes through the gate (contract.ts); only when it was posted does the mail of the same card go out, so a refused or failed reply
	// sends no mail. A failed mail leaves the reply posted and says so in the send record (Reply.mail) and the event.
	function send(codeOrId: string, opts: { text?: string; by: "owner" | "rule" }): GateResult {
		const mailId = opts.by === "owner" ? store.drafts().find(d => d.code === codeOrId)?.mail : undefined;
		const r = dispatchReply({ code: codeOrId, approval: { by: opts.by }, ...(opts.text !== undefined ? { text: opts.text } : {}) }, gate);
		if (!r.ok) return r;
		const done = mailId ? r.done.then(rep => sendMail(rep, mailId)) : r.done;
		pending.add(done);
		void done.finally(() => pending.delete(done));
		return { ...r, done };
	}

	async function sendMail(rep: Reply, mailId: string): Promise<Reply> {
		if (rep.state !== "sent") return rep;
		let mail: MailOutcome;
		try {
			const m = deps.mail ? await deps.mail.send(mailId) : { ok: false, text: "메일 보내기를 쓸 수 없어요" };
			mail = { state: m.ok ? "sent" : "failed", text: m.text };
		} catch (e) {
			mail = { state: "failed", text: e instanceof Error && e.message ? clip(e.message, 160) : "메일을 보내는 중 오류가 났어요" };
		}
		const final: Reply = { ...rep, mail };
		store.putReply(final);
		emit({ kind: "comment_send", source: rep.source, thread: rep.thread, id: rep.id, state: rep.state, mail: mail.state, ...(mail.state === "failed" ? { mailReason: mail.text } : {}) });
		return final;
	}

	const mailView = (d: Draft): MailView | undefined => (d.mail ? deps.mail?.view(d.mail) : undefined);

	// The script part of the watch: reads new comments of every source the owner chose, stores the new ids, then (only for sources with
	// auto-draft on) drafts, and (only with the owner's rule) sends through the gate. Nothing is read for a source with nothing chosen.
	async function collect(opts: { force?: boolean } = {}): Promise<{ added: Comment[]; drafted: Draft[]; sent: Reply[]; errors: Record<string, string> }> {
		const out = { added: [] as Comment[], drafted: [] as Draft[], sent: [] as Reply[], errors: {} as Record<string, string> };
		const cfg = store.config();
		if (!cfg.enabled) return out;
		for (const src of Object.values(cfg.sources)) {
			const adapter = deps.adapters[src.kind];
			if (!adapter || !src.watch.length) continue;
			const prior = store.cursors()[src.key] ?? {};
			if (!opts.force && prior.ranAt && deps.now() - prior.ranAt < (src.everyMin ?? DEFAULT_EVERY_MIN) * 60_000) continue;
			let fresh: Comment[];
			try {
				const res = await adapter.list(src, prior.cursor);
				fresh = store.addComments(res.comments.filter(r => watches(src, r.thread)).map(r => toComment(src, r, deps.collector)));
				store.setCursor(src.key, { cursor: res.cursor ?? prior.cursor, ranAt: deps.now() });
			} catch (e) {
				const reason = e instanceof Error ? clip(e.message, 160) : "읽지 못했어요";
				out.errors[src.key] = reason;
				store.setCursor(src.key, { ...prior, ranAt: deps.now(), error: reason });
				continue;
			}
			await retitle(src, adapter);
			out.added.push(...fresh);
			for (const t of new Set(fresh.map(c => c.thread))) emit({ kind: "comment", source: src.key, thread: t });
			if (!src.autoDraft || !replyOn(src)) continue;
			let made = 0;
			for (const c of fresh) {
				if (made >= MAX_AUTO_PER_RUN) break;
				if (c.at < (src.autoSince ?? 0) || !needsReply(c)) continue;
				made++;
				const step = await makeDraft(c.id);
				if (!step.ok) continue;
				out.drafted.push(step.draft);
				if (ruleAllows(src, c.text)) {
					const r = send(step.draft.code, { by: "rule" });
					if (r.ok) out.sent.push(await r.done);
				}
			}
		}
		return out;
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
		if (r.state !== "failed") return { ok: false, reason: "실패한 답글만 다시 보낼 수 있어요" };
		return send(r.draft, { by: "owner", text: r.text });
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
		const comments = store.comments();
		return store.drafts().filter(d => d.status === "pending" && cfg.sources[d.source]).map(d => {
			const src = cfg.sources[d.source]!, c = comments.find(x => x.id === d.commentId);
			return { code: d.code, app: ownerOf(src), kind: src.kind, source: src.key, sourceLabel: src.label, thread: d.thread, commentId: d.commentId, title: c?.postTitle ?? "", link: c?.postLink ?? null, to: c?.author ?? "", text: d.text, notes: d.notes, created: d.created,
				...(c ? { original: { who: c.author, text: clip(c.text, 200), at: c.at } } : {}), ...mailJson(d) };
		});
	}

	// `part` "mail" changes only the mail of the card (the reply stays, same code); "reply" (default) rewrites the reply and the mail stays attached.
	async function revise(draftCode: string, change: string, part: "reply" | "mail" = "reply"): Promise<Step> {
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
		deps.learn?.(src, change.trim());
		return run(c, src, d, change.trim()).catch(e => ({ ok: false as const, reason: e instanceof Error && e.message ? clip(e.message, 160) : "고친 초안을 만들지 못했어요" }));
	}

	function update(key: string, patch: { watch?: string[]; autoDraft?: boolean; autoSend?: SourceConfig["autoSend"] }): SourceConfig | undefined {
		const src = sourceOf(key);
		if (!src) return undefined;
		const next: SourceConfig = { ...src };
		if (patch.watch) next.watch = [...new Set(patch.watch)];
		if (patch.autoDraft !== undefined) {
			next.autoDraft = patch.autoDraft;
			if (patch.autoDraft) next.autoSince = deps.now();
		}
		if (patch.autoSend) next.autoSend = patch.autoSend;
		if (!next.watch.length) next.autoDraft = false;
		store.setSource(next);
		emit({ kind: "comment_sources" });
		return next;
	}

	const unreadOf = (c: Comment, reads: Record<string, number>) => !c.mine && c.at > (reads[threadKey(c.source, c.thread)] ?? 0);

	function threads(app: string) {
		const cfg = store.config();
		const mine = new Set(Object.values(cfg.sources).filter(s => ownerOf(s) === app).map(s => s.key));
		const reads = store.reads();
		const pendingDrafts = store.drafts().filter(d => d.status === "pending");
		const replies = store.replies(), dismissed = store.dismissed();
		const by = new Map<string, Comment[]>();
		for (const c of store.comments()) if (mine.has(c.source) && watches(cfg.sources[c.source]!, c.thread)) by.set(threadKey(c.source, c.thread), [...(by.get(threadKey(c.source, c.thread)) ?? []), c]);
		return [...by.values()]
			.map(list => {
				const last = list[list.length - 1]!;
				return { source: last.source, thread: last.thread, kind: cfg.sources[last.source]!.kind, title: last.postTitle, link: last.postLink ?? null, thumb: last.thumb ?? null, lastAt: last.at, lastText: clip(last.text, 80), lastAuthor: last.mine ? "나" : last.author, unread: list.filter(c => unreadOf(c, reads)).length, drafts: pendingDrafts.filter(d => d.source === last.source && d.thread === last.thread).length, unreplied: list.filter(c => unrepliedWith(c, replies, dismissed)).length };
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
		return {
			source: { key: src.key, kind: src.kind, label: src.label },
			thread: { id: thread, title: list[list.length - 1]!.postTitle, link: list[list.length - 1]!.postLink ?? first.postLink ?? null, thumb: list[list.length - 1]!.thumb ?? first.thumb ?? null },
			comments: list.map(c => ({ id: c.id, parent: c.parent ?? null, author: c.author, text: c.text, at: c.at, mine: c.mine, needsReply: needsReply(c), unreplied: unreplied(c) })),
			read: store.reads()[threadKey(source, thread)] ?? null,
			drafts: store.drafts().filter(d => d.source === source && d.thread === thread && d.status === "pending").map(d => ({ code: d.code, commentId: d.commentId, text: d.text, notes: d.notes, clean: d.clean, created: d.created, ...(d.tokens ? { tokens: d.tokens } : {}), ...mailJson(d) })),
			sends: store.replies().filter(r => r.source === source && r.thread === thread && r.at >= since).map(({ id, commentId, text, state, reason, at, via }) => ({ id, commentId, text, state, ...(reason ? { reason } : {}), at, via })),
		};
	}

	// The mail of a draft as the web sheet shows it (sizes as text, like the files of a mail card).
	function mailJson(d: Draft): { mail?: { id: string; to: string; subject?: string; body: string; attachments: { name: string; size?: string }[] } } {
		const m = mailView(d);
		return m ? { mail: { id: m.id, to: m.to, ...(m.subject ? { subject: m.subject } : {}), body: m.body, attachments: m.attachments.map(f => ({ name: f.name, ...(f.size !== undefined ? { size: fileSizeText(f.size) } : {}) })) } } : {};
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
		for (const d of store.drafts()) {
			const s = cfg.sources[d.source];
			if (s && d.status === "pending") out[ownerOf(s)]!.drafts++;
		}
		for (const c of store.comments()) {
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
	return { store, ownerOf, collect, makeDraft, revise, drop, restore, retrySend, dismissSend, pendingDrafts, send, update, threads, threadView, markRead, addDraft, mailView, needs, noReply, unreplied, tokenStats, posts, ownReplies, idle, needsReply };
}
export type Engine = ReturnType<typeof createEngine>;
