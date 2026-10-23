// The comment engine: collect (script only, no model), draft (a model call only on request or per-source auto-draft), send (only through
// the gate in contract.ts). Everything is injected (adapters, model, clock, tone, broadcast) so tests run without a network.
import { generateReply, reviseReply, type ReplyItem, type ReplyStyle } from "../reply-draft.ts";
import { type Comment, type CommentAdapter, dispatchReply, type GateResult, type Post, ruleAllows, type SourceConfig, type SourceKind, threadKey, toComment, watches } from "./contract.ts";
import { createStore, type Draft, type Reply, type Tokens } from "./store.ts";

export type ModelReply = { text: string; inputTokens?: number; outputTokens?: number };
export type DraftModel = (system: string, user: string) => Promise<ModelReply>;
export type EngineDeps = {
	dir: string;
	now: () => number;
	collector: string;
	adapters: Partial<Record<SourceKind, CommentAdapter>>;
	model?: DraftModel;
	style?: (src: SourceConfig) => ReplyStyle;
	learn?: (src: SourceConfig, change: string) => void;
	broadcast?: (event: Record<string, unknown>) => void;
};

export const appOf = (src: Pick<SourceConfig, "kind">): string => (src.kind === "website" ? "site" : src.kind);
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
	const gate = { store, adapters: deps.adapters, now: deps.now, collector: deps.collector, inflight, onState: (r: Reply) => emit({ kind: "comment_send", source: r.source, thread: r.thread, id: r.id, state: r.state, ...(r.reason ? { reason: r.reason } : {}) }) };

	const sourceOf = (id: string): SourceConfig | undefined => store.config().sources[id];
	const find = (id: string): Comment | undefined => store.comments().find(c => c.id === id);
	const stream = (c: Comment): Comment[] => {
		const top = c.parent ?? c.native;
		return store.comments().filter(x => x.source === c.source && x.thread === c.thread && (x.native === top || x.parent === top));
	};
	// A comment needs the owner's reply when it starts a stream, is not his own, and nobody of his (or a sent reply) answered it yet.
	const needsReply = (c: Comment): boolean =>
		!c.mine && !c.parent && !stream(c).some(x => x.mine && x.parent === c.native) && !store.replies().some(r => r.commentId === c.id && r.state !== "failed") && !store.drafts().some(d => d.commentId === c.id && d.status === "pending");

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
			const r = await deps.model!(system, user);
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
		const draft: Draft = { code: code(), commentId: c.id, source: src.key, thread: c.thread, text: r.draft.body, status: "pending", created: deps.now(), changes: previous ? [...previous.changes, change ?? ""] : [], clean: !notes.length, notes, tokens: measured };
		store.putDraft(draft);
		emit({ kind: "comment_draft", source: src.key, thread: c.thread });
		return { ok: true, draft };
	}

	function makeDraft(commentId: string): Promise<Step> {
		const c = find(commentId);
		const src = c && sourceOf(c.source);
		if (!c || !src) return Promise.resolve({ ok: false, reason: "원댓글을 찾지 못했어요" });
		if (c.mine) return Promise.resolve({ ok: false, reason: "내가 쓴 댓글에는 답글 초안을 만들지 않아요" });
		return run(c, src).catch(e => ({ ok: false as const, reason: e instanceof Error && e.message ? clip(e.message, 160) : "초안을 만들지 못했어요. 잠시 뒤에 다시 눌러 주세요" }));
	}

	function send(codeOrId: string, opts: { text?: string; by: "owner" | "rule" }): GateResult {
		const r = dispatchReply({ code: codeOrId, approval: { by: opts.by }, ...(opts.text !== undefined ? { text: opts.text } : {}) }, gate);
		if (r.ok) {
			pending.add(r.done);
			void r.done.finally(() => pending.delete(r.done));
		}
		return r;
	}

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
			out.added.push(...fresh);
			for (const t of new Set(fresh.map(c => c.thread))) emit({ kind: "comment", source: src.key, thread: t });
			if (!src.autoDraft) continue;
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

	function drop(draftCode: string): { ok: boolean; reason?: string } {
		const d = store.drafts().find(x => x.code === draftCode);
		if (!d) return { ok: false, reason: "그 초안을 찾지 못했어요" };
		if (d.status !== "pending") return { ok: false, reason: "이 초안은 이미 처리됐어요" };
		store.setDraftStatus(draftCode, "dropped");
		emit({ kind: "comment_draft", source: d.source, thread: d.thread });
		return { ok: true };
	}

	async function revise(draftCode: string, change: string): Promise<Step> {
		const d = store.drafts().find(x => x.code === draftCode);
		const c = d && find(d.commentId);
		const src = d && sourceOf(d.source);
		if (!d || !c || !src) return { ok: false, reason: "그 초안을 찾지 못했어요" };
		if (d.status !== "pending") return { ok: false, reason: "이 초안은 이미 처리됐어요" };
		if (!change.trim()) return { ok: false, reason: "무엇을 고칠지 적어 주세요" };
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
		const mine = new Set(Object.values(cfg.sources).filter(s => appOf(s) === app).map(s => s.key));
		const reads = store.reads();
		const pendingDrafts = store.drafts().filter(d => d.status === "pending");
		const by = new Map<string, Comment[]>();
		for (const c of store.comments()) if (mine.has(c.source) && watches(cfg.sources[c.source]!, c.thread)) by.set(threadKey(c.source, c.thread), [...(by.get(threadKey(c.source, c.thread)) ?? []), c]);
		return [...by.values()]
			.map(list => {
				const last = list[list.length - 1]!;
				return { source: last.source, thread: last.thread, title: last.postTitle, link: last.postLink ?? null, lastAt: last.at, lastText: clip(last.text, 80), lastAuthor: last.mine ? "나" : last.author, unread: list.filter(c => unreadOf(c, reads)).length, drafts: pendingDrafts.filter(d => d.source === last.source && d.thread === last.thread).length };
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
			thread: { id: thread, title: first.postTitle, link: first.postLink ?? null },
			comments: list.map(c => ({ id: c.id, parent: c.parent ?? null, author: c.author, text: c.text, at: c.at, mine: c.mine, needsReply: needsReply(c) })),
			read: store.reads()[threadKey(source, thread)] ?? null,
			drafts: store.drafts().filter(d => d.source === source && d.thread === thread && d.status === "pending").map(d => ({ code: d.code, commentId: d.commentId, text: d.text, notes: d.notes, clean: d.clean, created: d.created, ...(d.tokens ? { tokens: d.tokens } : {}) })),
			sends: store.replies().filter(r => r.source === source && r.thread === thread && r.at >= since).map(({ id, commentId, text, state, reason, at, via }) => ({ id, commentId, text, state, ...(reason ? { reason } : {}), at, via })),
		};
	}

	function markRead(source: string, thread: string): void {
		const at = Math.max(0, ...store.comments().filter(c => c.source === source && c.thread === thread).map(c => c.at));
		if (at) store.markRead(threadKey(source, thread), at);
	}

	// What waits on the owner per app (the 모니터링 status line): pending drafts and unread comments of the sources he chose.
	function needs(): Record<string, { drafts: number; unread: number }> {
		const cfg = store.config();
		const out: Record<string, { drafts: number; unread: number }> = {};
		if (!cfg.enabled) return out;
		const reads = store.reads();
		for (const src of Object.values(cfg.sources)) out[appOf(src)] ??= { drafts: 0, unread: 0 };
		for (const d of store.drafts()) {
			const s = cfg.sources[d.source];
			if (s && d.status === "pending") out[appOf(s)]!.drafts++;
		}
		for (const c of store.comments()) {
			const s = cfg.sources[c.source];
			if (s && watches(s, c.thread) && unreadOf(c, reads)) out[appOf(s)]!.unread++;
		}
		return out;
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
	return { store, collect, makeDraft, revise, drop, send, update, threads, threadView, markRead, needs, tokenStats, posts, ownReplies, idle, needsReply };
}
export type Engine = ReturnType<typeof createEngine>;
