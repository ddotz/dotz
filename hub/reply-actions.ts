// The one place every surface acts on a reply (the reply unification design, 1.6 and 3.1): the queue, 빠른 처리, the two-panes, the bell,
// a typed chat message, Discord and the other computer all call `act`. It guards the draft and send states, writes the owner's word to the
// inbox before anything is queued (the CLIs' own gate reads it there), runs a revise and learns only after the new draft is stored, and
// moves the cards to the new ref. Everything it touches is injected: it imports no adapter, no notice code and no route.
import type { SendJob, SendResult } from "./approval-send.ts";
import { policyOf, reasonOf } from "./reply-reasons.ts";
import type { DraftView, Lesson, OwnerAction, Part, Reason, ReasonCode, ReplyAdapter, ReplyItem, ReplyKind, SendState } from "./reply-types.ts";

export type ActCtx = { surface: "web" | "discord" | "chat" | "peer" | "cli"; login?: string; agent?: boolean };
export type ActInput = { ref: string; action: string; change?: string; text?: string; part?: Part; asIs?: boolean; send?: boolean; as?: "sent" | "retry" };
export type ActResult = { status: number; body: { ok: true; item?: ReplyItem } | { ok: false; code: ReasonCode | "bad_request" | "unknown_ref"; error: string; lint?: string[] } };
type Sender = {
	enqueue: (j: SendJob, o?: { hold?: false }) => boolean;
	cancel: (ref: string) => "cancelled" | "late" | "none";
	settle: (j: SendJob, state: "sent" | "failed", text?: string) => void;
	forget: (ref: string) => boolean;
	results: () => SendResult[];
};
/** An open send-approval card (a notice) that shows draft `ref` in conversation `conv`. */
export type OpenCard = { ref: string; conv: string; notice: string; title: string };
export type ReplyDeps = {
	adapters: ReplyAdapter[];
	sender: Sender;
	/** The owner's word, sealed into the inbox (the CLIs' gate reads it): the one writer of a pick. */
	recordPick: (p: { surface: ActCtx["surface"]; conv: string; q: string; n: number; label: string; note?: string }) => void;
	/** A plain line from the owner in the card's conversation (나갔어요), no pick. */
	recordText?: (conv: string, text: string) => void;
	learning: { record: (key: Lesson["key"], line: string) => Promise<void>; refine: (key: Lesson["key"]) => Promise<void> };
	cards: { open: () => OpenCard[]; replace: (oldRef: string, newRef: string, text: string) => void; rewrite: (ref: string, text: string) => void; close: (ref: string) => void };
	/** A card a session wrote by hand (kind `card`): its answer goes to the bot as one message per conversation. */
	toBot: (conv: string, text: string) => Promise<void>;
	emit: (e: { kind: "reply"; ref: string; item?: ReplyItem; next?: string; revising?: true; why?: string }) => void;
	log: (line: string) => void;
	now?: () => number;
};

const SEND_LABEL = { send: "보내기", "send-as-is": "이대로 보내기", "send-main": "답글만 보내기", "send-mail": "메일만 보내기" } as const;
const ACTIONS = new Set(["send", "revise", "edit", "drop", "restore", "retry", "resolve", "undo"]);
const fail = (status: number, code: ActResult["body"] extends infer B ? (B extends { ok: false; code: infer C } ? C : never) : never, error: string, lint?: string[]): ActResult => ({ status, body: { ok: false, code, error, ...(lint ? { lint } : {}) } });
const refused = (status: number, code: ReasonCode, vars?: Record<string, string | number>): ActResult => fail(status, code, reasonOf(code, vars).text);
const LIVE = new Set(["undo", "queued", "sending"]);

/** The send state the queue holds for `ref`, as every surface reads it, with the owner's buttons for one that needs him. */
export function sendOf(r: SendResult | undefined): (SendState & { actions: OwnerAction[] }) | undefined {
	if (!r || r.state === "back") return undefined;
	const n = r.attempts ?? 0;
	if (r.state === "undo") return { state: "undo", at: r.at, until: r.until ?? r.at, actions: [] };
	if (r.state === "queued" || r.state === "sending") return { state: r.state, at: r.at, attempt: n, actions: [] };
	if (r.state === "sent") return { state: "sent", at: r.at, how: "owner", actions: [] };
	const reason: Reason = r.reason ?? { code: r.state === "unsure" ? "unknown" : "tool_before_send", text: r.text };
	const actions = policyOf(reason.code).actions;
	if (r.state === "unsure") return { state: "unsure", at: r.at, reason, attempts: n, actions };
	return { state: "failed", at: r.at, reason, safeToAuto: r.safeToAuto === true, attempts: n, ...(r.auto ? { auto: r.auto } : {}), actions: actions.includes("retry") ? actions : ["retry", ...actions] };
}

export function createReplyActions(deps: ReplyDeps) {
	const revising = new Set<string>();
	const running = new Set<Promise<void>>();
	const ledger = (ref: string) => deps.sender.results().findLast(r => r.ref === ref);

	/** The adapter that knows `ref` and its current view; `card` when only an open card names it. */
	async function resolve(ref: string): Promise<{ adapter: ReplyAdapter; view: DraftView } | { card: OpenCard } | undefined> {
		for (const adapter of deps.adapters) {
			const view = await adapter.get(ref);
			if (view) return { adapter, view };
		}
		const card = deps.cards.open().find(c => c.ref === ref);
		return card ? { card } : undefined;
	}

	const itemOf = (view: DraftView): ReplyItem => {
		const send = sendOf(ledger(view.ref));
		return { ...view, draft: { ...view.draft, ...(revising.has(view.ref) ? { revising: true as const } : {}) }, ...(send ? { send, why: "reason" in send ? send.reason.text : view.why } : {}) };
	};
	const job = (a: ReplyAdapter, view: DraftView, action: keyof typeof SEND_LABEL, extra: Partial<SendJob> = {}): SendJob => ({ ref: view.ref, conv: view.conv, action, title: a.question(view.ref), ...extra });
	const pick = (ctx: ActCtx, a: ReplyAdapter, view: DraftView, n: number, label: string, note?: string) => {
		if (!ctx.agent) deps.recordPick({ surface: ctx.surface, conv: view.conv, q: a.question(view.ref), n, label, ...(note ? { note } : {}) });
	};
	const announce = async (a: ReplyAdapter, ref: string) => {
		const view = await a.get(ref);
		deps.emit({ kind: "reply", ref, ...(view ? { item: itemOf(view) } : {}) });
		return view;
	};

	function sendAction(input: ActInput): keyof typeof SEND_LABEL {
		if (input.part === "reply") return "send-main";
		if (input.part === "mail") return "send-mail";
		return input.asIs ? "send-as-is" : "send";
	}

	async function send(ctx: ActCtx, a: ReplyAdapter, view: DraftView, input: ActInput): Promise<ActResult> {
		const st = ledger(view.ref)?.state;
		if (st === "unsure") return refused(409, "needs_resolve");
		if (st && LIVE.has(st)) return refused(409, "already_sending");
		if (st === "sent" || view.draft.state === "sent") return refused(409, "already_sent");
		if (st === "failed") return retry(a, view);
		if (view.draft.state !== "pending") return refused(409, "not_pending");
		const action = sendAction(input);
		pick(ctx, a, view, action === "send" ? 1 : action === "send-as-is" ? 4 : 1, SEND_LABEL[action]);
		if (!deps.sender.enqueue(job(a, view, action))) return refused(409, "not_supported");
		return { status: 200, body: { ok: true, item: itemOf(view) } };
	}

	function retry(a: ReplyAdapter, view: DraftView): ActResult {
		if (ledger(view.ref)?.state !== "failed") return refused(409, "not_pending");
		// The sender's own gate reads the earlier pick again: a retry writes nothing.
		if (!deps.sender.enqueue(job(a, view, "send", { retry: true }))) return refused(409, "not_supported");
		return { status: 200, body: { ok: true, item: itemOf(view) } };
	}

	function revise(ctx: ActCtx, a: ReplyAdapter, view: DraftView, input: ActInput): ActResult {
		const change = (input.change ?? "").replace(/\s+/g, " ").trim();
		if (!change) return fail(400, "bad_request", "무엇을 고칠지 적어 주세요");
		if (revising.has(view.ref)) return refused(409, "revising");
		const guard = editable(view);
		if (guard) return guard;
		revising.add(view.ref);
		pick(ctx, a, view, 2, "고치기", change);
		deps.emit({ kind: "reply", ref: view.ref, revising: true, item: itemOf(view) });
		const run = runRevise(a, view, change, input.part).finally(() => {
			revising.delete(view.ref);
			running.delete(run);
		});
		running.add(run);
		return { status: 202, body: { ok: true, item: itemOf(view) } };
	}

	// 3.1: the adapter stores the new draft (the success point), then learning, then the cards move to the new ref, then one event.
	async function runRevise(a: ReplyAdapter, view: DraftView, change: string, part?: Part): Promise<void> {
		let r: Awaited<ReturnType<ReplyAdapter["revise"]>>;
		try {
			r = await a.revise(view.ref, change, part);
		} catch (e) {
			deps.log(`reply ${view.ref}: revise threw: ${(e as Error).stack ?? (e as Error).message}`);
			r = { ok: false, reason: reasonOf("revise_failed") };
		}
		if (!r.ok) {
			deps.emit({ kind: "reply", ref: view.ref, why: `고치지 못했어요 - ${r.reason.text}`, item: itemOf(view) });
			return;
		}
		await learn(r.lesson);
		const text = await a.ask(r.ref);
		if (text && r.ref === view.ref) deps.cards.rewrite(view.ref, text);
		else if (text) deps.cards.replace(view.ref, r.ref, text);
		const next = await a.get(r.ref);
		deps.emit({ kind: "reply", ref: view.ref, ...(r.ref !== view.ref ? { next: r.ref } : {}), ...(next ? { item: itemOf(next) } : {}) });
	}

	async function learn(lesson: Lesson | undefined): Promise<void> {
		if (!lesson?.line) return;
		try {
			await deps.learning.record(lesson.key, lesson.line);
			await deps.learning.refine(lesson.key);
		} catch (e) {
			deps.log(`reply learning for ${lesson.key.app}${lesson.key.room ? `/${lesson.key.room}` : ""} failed: ${(e as Error).message}`);
		}
	}

	/** A draft that can still change: pending, with no send waiting, running or unsure. */
	function editable(view: DraftView): ActResult | undefined {
		if (view.draft.state !== "pending") return refused(409, "not_pending");
		const st = ledger(view.ref)?.state;
		if (st === "unsure") return refused(409, "needs_resolve");
		if (st && LIVE.has(st)) return refused(409, "already_sending");
		return undefined;
	}

	async function edit(ctx: ActCtx, a: ReplyAdapter, view: DraftView, input: ActInput): Promise<ActResult> {
		if (typeof input.text !== "string" || !input.text.trim()) return refused(400, "empty");
		if (!view.can.edit) return refused(409, "not_supported");
		const guard = editable(view);
		if (guard) return guard;
		// A 고치기 first: an older 보내기 no longer authorizes the changed text; only the one written after it does.
		pick(ctx, a, view, 2, "고치기", "직접 수정");
		const r = await a.edit(view.ref, input.text, input.part);
		if (!r.ok) return fail(422, r.reason.code, r.reason.text, "lint" in r ? r.lint : undefined);
		const text = await a.ask(view.ref);
		if (text) deps.cards.rewrite(view.ref, text);
		const now = (await announce(a, view.ref)) ?? view;
		return input.send ? send(ctx, a, now, { ...input, asIs: true }) : { status: 200, body: { ok: true, item: itemOf(now) } };
	}

	async function drop(ctx: ActCtx, a: ReplyAdapter, view: DraftView): Promise<ActResult> {
		if (view.draft.state !== "pending") return refused(409, "not_pending");
		const st = ledger(view.ref)?.state;
		if (st === "unsure") return refused(409, "needs_resolve");
		if (st && LIVE.has(st)) return refused(409, "already_sending");
		pick(ctx, a, view, 3, "보내지 않기");
		const r = await a.drop(view.ref);
		if (!r.ok) return fail(409, r.reason.code, r.reason.text);
		deps.sender.forget(view.ref);
		deps.cards.close(view.ref);
		return { status: 200, body: { ok: true, item: itemOf((await announce(a, view.ref)) ?? view) } };
	}

	async function restore(a: ReplyAdapter, view: DraftView): Promise<ActResult> {
		if (view.draft.state !== "dropped") return refused(409, "not_pending");
		const r = await a.restore(view.ref);
		if (!r.ok) return fail(409, r.reason.code, r.reason.text);
		return { status: 200, body: { ok: true, item: itemOf((await announce(a, view.ref)) ?? view) } };
	}

	async function resolveSend(ctx: ActCtx, a: ReplyAdapter, view: DraftView, as: ActInput["as"]): Promise<ActResult> {
		if (ledger(view.ref)?.state !== "unsure") return refused(409, "not_pending");
		if (as === "sent") {
			const r = await a.markSent(view.ref);
			if (!r.ok) return fail(409, r.reason.code, r.reason.text);
			deps.sender.settle(job(a, view, "send"), "sent");
			deps.recordText?.(view.conv, "나갔어요");
			deps.cards.close(view.ref);
			return { status: 200, body: { ok: true, item: itemOf((await announce(a, view.ref)) ?? view) } };
		}
		if (as !== "retry") return fail(400, "bad_request", "as는 sent 또는 retry여야 해요");
		// The owner decided again after 확인 필요: a fresh 보내기, and the send may go out again (force).
		pick(ctx, a, view, 1, SEND_LABEL.send);
		if (!deps.sender.enqueue(job(a, view, "send", { force: true }))) return refused(409, "not_supported");
		return { status: 200, body: { ok: true, item: itemOf(view) } };
	}

	function undo(view: DraftView): ActResult {
		const r = deps.sender.cancel(view.ref);
		if (r === "late") return refused(409, "already_sending");
		if (r === "none") return refused(409, "not_pending");
		return { status: 200, body: { ok: true, item: itemOf(view) } };
	}

	async function act(input: ActInput, ctx: ActCtx): Promise<ActResult> {
		if (!input || typeof input.ref !== "string" || !input.ref || !ACTIONS.has(input.action)) return fail(400, "bad_request", "ref와 action이 필요해요");
		// An agent caller may revise, or run a send the owner already picked; it never writes the owner's word (1.6).
		if (ctx.agent && input.action !== "revise" && input.action !== "send") return refused(403, "owner_only");
		const found = await resolve(input.ref);
		if (!found) return fail(404, "unknown_ref", "그 초안을 찾지 못했어요");
		if ("card" in found) return toBot(ctx, found.card, input);
		// The pick, the send and its card state belong where the draft's card was asked, when it has one; the store's own place otherwise.
		const card = deps.cards.open().find(c => c.ref === input.ref);
		const a = found.adapter, view = card ? { ...found.view, conv: card.conv } : found.view;
		if (ctx.agent && input.action === "send") return agentSend(a, view);
		switch (input.action) {
			case "send": return send(ctx, a, view, input);
			case "revise": return revise(ctx, a, view, input);
			case "edit": return edit(ctx, a, view, input);
			case "drop": return drop(ctx, a, view);
			case "restore": return restore(a, view);
			case "retry": return retry(a, view);
			case "resolve": return resolveSend(ctx, a, view, input.as);
			default: return undo(view);
		}
	}

	// An agent's send writes no pick: the sender's gate must find the owner's own earlier 보내기, or it refuses.
	function agentSend(a: ReplyAdapter, view: DraftView): ActResult {
		const guard = editable(view);
		if (guard) return guard;
		if (!deps.sender.enqueue(job(a, view, "send"), { hold: false })) return refused(409, "not_supported");
		return { status: 200, body: { ok: true, item: itemOf(view) } };
	}

	// A hand-written card has no store here: its answer is one message to the bot, as the card's own numbered answer would be.
	async function toBot(ctx: ActCtx, card: OpenCard, input: ActInput): Promise<ActResult> {
		if (ctx.agent) return refused(403, "owner_only");
		const line = cardAnswer(card, input);
		if (!line) return refused(409, "not_supported");
		await deps.toBot(card.conv, line);
		return { status: 200, body: { ok: true } };
	}

	return {
		act,
		/** List mode: one result per item, in order; hand-written cards of one conversation go to the bot as one message. */
		async batch(items: ActInput[], ctx: ActCtx) {
			if (!Array.isArray(items) || !items.length || items.length > 100) return { status: 400, body: { ok: false, code: "bad_request", error: "items는 1개에서 100개 사이여야 해요" } };
			const results: { ref: string; ok: boolean; code?: string; error?: string; item?: ReplyItem }[] = [];
			const forBot = new Map<string, string[]>();
			for (const it of items) {
				const found = typeof it?.ref === "string" && !ctx.agent ? await resolve(it.ref) : undefined;
				const line = found && "card" in found ? cardAnswer(found.card, it) : undefined;
				if (found && "card" in found && line) {
					forBot.set(found.card.conv, [...(forBot.get(found.card.conv) ?? []), line]);
					results.push({ ref: it.ref, ok: true });
					continue;
				}
				const r = await act(it, ctx);
				results.push(r.body.ok ? { ref: it.ref, ok: true, ...(r.body.item ? { item: r.body.item } : {}) } : { ref: it.ref, ok: false, code: r.body.code, error: r.body.error });
			}
			for (const [conv, lines] of forBot) await deps.toBot(conv, lines.join("\n"));
			return { status: 200, body: { results } };
		},
		/** Every reply every surface shows: the adapters' drafts with their sends, then the hand-written cards. */
		async list(): Promise<ReplyItem[]> {
			const views = (await Promise.all(deps.adapters.map(a => a.list().catch(e => (deps.log(`reply list of ${a.kind} failed: ${(e as Error).message}`), [] as DraftView[]))))).flat();
			const known = new Set(views.map(v => v.ref));
			const cards = deps.cards.open().filter(c => !known.has(c.ref)).map(c => cardItem(c, deps.now?.() ?? Date.now()));
			const items = [...views.map(itemOf), ...cards];
			noteOpen(items);
			return items;
		},
		/** The old dismiss and delete routes: a failed or unsure send is forgotten and its draft waits again; nothing is sent. */
		clear: (ref: string): boolean => deps.sender.forget(ref),
		/** Resolves when every running revise has finished (tests, shutdown). */
		idle: async () => {
			while (running.size) await Promise.all([...running]);
		},
	};
}

function cardAnswer(card: OpenCard, input: ActInput): string | undefined {
	const q = card.title;
	if (input.action === "send") return `결정 답: ${q} → 1) 보내기`;
	if (input.action === "drop") return `결정 답: ${q} → 3) 보내지 않기`;
	if (input.action === "revise" && input.change?.trim()) return `결정 답: ${q} → 2) 고치기 - ${input.change.trim()}`;
	return undefined;
}

function cardItem(c: OpenCard, at: number): ReplyItem {
	const kind: ReplyKind = "card";
	return { item: `card:${c.conv}|${c.ref}`, ref: c.ref, kind, app: "card", label: c.title, conv: c.conv, notice: c.notice, at, can: { send: true, revise: true, edit: false, drop: true, restore: false }, draft: { state: "pending", toLabel: "", to: "", text: "" } };
}

let live: ReturnType<typeof createReplyActions> | undefined;
// The revisable cards of each conversation as of the last list (the queue page and the chat check read it often): what a turn's note and the
// orchestrator's marker line may name, without waiting for a list in the turn's path.
const openByConv = new Map<string, string[]>();
export const openRefsOf = (conv: string): readonly string[] => openByConv.get(conv) ?? [];
export function noteOpen(items: readonly Pick<ReplyItem, "conv" | "ref" | "can">[]): void {
	openByConv.clear();
	for (const i of items) if (i.can.revise) openByConv.set(i.conv, [...(openByConv.get(i.conv) ?? []), i.ref]);
}
/** The live instance, for modules the wiring imports (late binding, like setRefHandled in hub/outbound.ts); undefined in tests that build a surface alone. */
export const useReplies = () => live;
export const setReplies = (r: ReturnType<typeof createReplyActions> | undefined): void => void (live = r);
