// The one place every surface acts on a reply (the reply unification design, 1.6 and 3.1): the queue, 빠른 처리, the two-panes, the bell,
// a typed chat message, Discord and the other computer all call `act`. It guards the draft and send states, writes the owner's word to the
// inbox before anything is queued (the CLIs' own gate reads it there), runs a revise, moves the cards to the new ref and then learns. One
// vocabulary (the reply clarity design, 2026-11-16): `send` only sends the version the owner sees (its pick and job carry its approvalHash),
// `revise` (AI로 고치기) and `edit` (직접 고치기) only change, and an agent caller may only revise. A send the model read from the owner's words
// (`confirm`, the reply intent design 2026-11-16) sends nothing: it posts the card again to be pressed. Everything it touches is injected: it
// imports no adapter, no notice code and no route.
import { approvalHash, type SendJob, type SendResult } from "./approval-send.ts";
import { DRAFT_HAND_EDIT } from "./draft-approval.ts";
import { draftHead } from "./reply-chat.ts";
import { policyOf, reasonOf } from "./reply-reasons.ts";
import type { DraftView, Lesson, OwnerAction, Part, Reason, ReasonCode, ReplyAdapter, ReplyItem, ReplyKind, SendState } from "./reply-types.ts";

/** `owner`: the owner's chat message the model read this act from (its marker line); his pick then names that message. */
export type ActCtx = { surface: "web" | "discord" | "chat" | "peer" | "cli"; login?: string; agent?: boolean; owner?: { mid: string; text: string } };
/** `hash`: the draft.hash of the item the caller showed (a send act of another version is refused `changed`; "" = it showed none the hub can
 * name, refused the same). `subject`: an edit's new subject (mail, or the bundled mail with part "mail"). */
export type ActInput = { ref: string; action: string; change?: string; text?: string; subject?: string; part?: Part; asIs?: boolean; as?: "sent" | "retry"; hash?: string };
export type ActResult = { status: number; body: { ok: true; item?: ReplyItem } | { ok: false; code: ReasonCode | "bad_request" | "unknown_ref"; error: string; lint?: string[]; item?: ReplyItem } };
type Sender = {
	enqueue: (j: SendJob, approved?: (until: number) => void) => boolean;
	cancel: (ref: string) => "cancelled" | "late" | "none";
	settle: (j: SendJob, state: "sent" | "failed", text?: string) => void;
	forget: (ref: string) => boolean;
	results: () => SendResult[];
};
/** An open send-approval card (a notice) that shows draft `ref` in conversation `conv`; `hash`: the version it was last drawn with; `discord`: the
 * version its Discord message shows; `asked`: the ts of the post that asked it (a web quote names it); `posts`: its Discord message ids (a Discord reply names one). */
export type OpenCard = { ref: string; conv: string; notice: string; title: string; hash?: string; discord?: string; asked?: string; posts?: string[] };
export type ReplyDeps = {
	adapters: ReplyAdapter[];
	sender: Sender;
	/** The owner's word, sealed into the inbox (the CLIs' gate reads it): the one writer of a pick. */
	/** `until`: on a 보내기, when its undo window ends (the CLIs' gate counts it only from then). */
	recordPick: (p: { surface: ActCtx["surface"]; conv: string; q: string; n: number; label: string; note?: string; hash?: string; until?: number; from?: ActCtx["owner"] }) => void;
	/** A plain line from the owner in the card's conversation (나갔어요), no pick. */
	recordText?: (conv: string, text: string) => void;
	learning: { record: (key: Lesson["key"], line: string) => Promise<void>; refine: (key: Lesson["key"]) => Promise<void> };
	/** `rewrite` and `replace` draw a card anew (every surface, Discord included) and store `hash`, the version it now shows. `repost` posts the open card
	 * of `ref` again at the bottom of its conversation (the same notice; `text` and `hash` when given), its old post marked moved. */
	cards: { open: () => OpenCard[]; replace: (oldRef: string, newRef: string, text: string, hash: string | undefined) => void; rewrite: (ref: string, text: string, hash: string | undefined) => void; repost: (ref: string, text: string | undefined, hash: string | undefined) => Promise<void>; close: (ref: string) => void;
		/** The conversation of the newest card of `ref`, open or already answered. */
		convOf?: (ref: string) => string | undefined };
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

const SENDS = new Set(["send", "retry", "resolve"]);
// Every job here is the owner's own act, on the version `view` holds.
const job = (a: ReplyAdapter, view: DraftView, action: keyof typeof SEND_LABEL, extra: Partial<SendJob> = {}): SendJob => ({ ref: view.ref, conv: view.conv, action, title: a.question(view.ref), hash: approvalHash(view), by: "owner", ...extra });

function sendAction(input: ActInput): keyof typeof SEND_LABEL {
	if (input.part === "reply") return "send-main";
	if (input.part === "mail") return "send-mail";
	return input.asIs ? "send-as-is" : "send";
}

async function learn(deps: ReplyDeps, lesson: Lesson | undefined): Promise<void> {
	if (!lesson?.line) return;
	try {
		await deps.learning.record(lesson.key, lesson.line);
		await deps.learning.refine(lesson.key);
	} catch (e) {
		deps.log(`reply learning for ${lesson.key.app}${lesson.key.room ? `/${lesson.key.room}` : ""} failed: ${(e as Error).message}`);
	}
}

/** The cards of `ref` show the version the store holds now, and keep its hash (a pick from one of them is checked against it). */
async function redraw(deps: ReplyDeps, a: ReplyAdapter, ref: string, now: DraftView | undefined) {
	const text = await a.ask(ref);
	if (text) deps.cards.rewrite(ref, text, now && approvalHash(now));
}
/** The owner's pick on `view`, kept as his answer on the card; an agent's call records none. */
function pick(deps: ReplyDeps, ctx: ActCtx, a: ReplyAdapter, view: DraftView, n: number, label: string, o: { note?: string; hash?: string; until?: number } = {}) {
	if (!ctx.agent) deps.recordPick({ surface: ctx.surface, conv: view.conv, q: a.question(view.ref), n, label, ...o, ...(ctx.owner ? { from: ctx.owner } : {}) });
}

export function createReplyActions(deps: ReplyDeps) {
	const revising = new Set<string>();
	const running = new Set<Promise<void>>();
	const ledger = (ref: string) => deps.sender.results().findLast(r => r.ref === ref);

	/** The adapter that knows `ref` and its current view; `card` when only an open card names it. */
	async function resolve(ref: string): Promise<Resolved | undefined> {
		for (const adapter of deps.adapters) {
			const view = await adapter.get(ref);
			if (view) return { adapter, view };
		}
		const card = deps.cards.open().find(c => c.ref === ref);
		return card ? { card } : undefined;
	}

	const itemOf = (view: DraftView): ReplyItem => {
		const send = sendOf(ledger(view.ref));
		return { ...view, draft: { ...view.draft, hash: approvalHash(view), ...(revising.has(view.ref) ? { revising: true as const } : {}) }, ...(send ? { send, why: "reason" in send ? send.reason.text : view.why } : {}) };
	};
	/** A send or an edit whose `hash` names another version than the store holds: refused with the fresh item, nothing queued or saved, and its
	 * cards redrawn and every surface told (another device repaints too). */
	const stale = async (a: ReplyAdapter, view: DraftView, input: ActInput): Promise<ActResult | undefined> => {
		if ((!SENDS.has(input.action) && input.action !== "edit") || (input.action === "resolve" && input.as !== "retry") || typeof input.hash !== "string" || input.hash === approvalHash(view)) return undefined;
		await redraw(deps, a, view.ref, view);
		const item = itemOf(view);
		deps.emit({ kind: "reply", ref: view.ref, item });
		return { status: 409, body: { ok: false, code: "changed", error: reasonOf("changed").text, item } };
	};
	/** The owner's 보내기 on the version `view` holds: his pick carries its fingerprint and the end of its undo window (the sender's own, handed
	 *  over before the job is held or queued), so no CLI counts it before the gateway's sender would run it (qa-clean-7 N13). */
	const sendPicked = (ctx: ActCtx, a: ReplyAdapter, view: DraftView, n: number, label: string, j: SendJob): ActResult => {
		if (!deps.sender.enqueue(j, until => pick(deps, ctx, a, view, n, label, { hash: j.hash, until }))) return refused(409, "not_supported");
		return { status: 200, body: { ok: true, item: itemOf(view) } };
	};
	/** Why a send of `ref` holds its draft still: one waits, runs or may have gone out. */
	const held = (ref: string): "needs_resolve" | "already_sending" | undefined => {
		const st = ledger(ref)?.state;
		return st === "unsure" ? "needs_resolve" : st && LIVE.has(st) ? "already_sending" : undefined;
	};
	const announce = async (a: ReplyAdapter, ref: string) => {
		const view = await a.get(ref);
		deps.emit({ kind: "reply", ref, ...(view ? { item: itemOf(view) } : {}) });
		return view;
	};

	/** Why `view` cannot be sent now (a send's and a confirm card's guards, in this order), or undefined. */
	const unsendable = (view: DraftView): ActResult | undefined => {
		const code = held(view.ref) ?? (ledger(view.ref)?.state === "sent" || view.draft.state === "sent" ? "already_sent" : view.draft.state !== "pending" ? "not_pending" : revising.has(view.ref) ? "revising" : undefined);
		return code && refused(409, code);
	};
	// A failed send is no shortcut: 보내기 on it is a new approval of the version shown now, as on any other draft.
	async function send(ctx: ActCtx, a: ReplyAdapter, view: DraftView, input: ActInput): Promise<ActResult> {
		const no = unsendable(view);
		if (no) return no;
		const action = sendAction(input);
		return sendPicked(ctx, a, view, action === "send-as-is" ? 4 : 1, SEND_LABEL[action], job(a, view, action));
	}

	// 다시 보내기 of a surely-failed send: a fresh 보내기 on the current version (the CLIs' gates count from it), with no cancel window. A failure that
	// voids what the earlier send stood on (the mail draft went away, no pick counted) is sent as a new one, not as a retry of the old.
	function retry(ctx: ActCtx, a: ReplyAdapter, view: DraftView, input: ActInput): ActResult {
		const last = ledger(view.ref);
		if (last?.state !== "failed") return refused(409, "not_pending");
		if (last.reason && policyOf(last.reason.code).reapprove) {
			if (view.draft.state !== "pending") return refused(409, "not_pending");
			const action = sendAction(input);
			return sendPicked(ctx, a, view, action === "send-as-is" ? 4 : 1, SEND_LABEL[action], job(a, view, action));
		}
		return sendPicked(ctx, a, view, 1, SEND_LABEL.send, job(a, view, "send", { retry: true }));
	}

	function revise(ctx: ActCtx, a: ReplyAdapter, view: DraftView, input: ActInput): ActResult {
		const change = (input.change ?? "").replace(/\s+/g, " ").trim();
		if (!change) return fail(400, "bad_request", "무엇을 고칠지 적어 주세요");
		const guard = editable(view);
		if (guard) return guard;
		revising.add(view.ref);
		pick(deps, ctx, a, view, 2, "고치기", { note: change });
		// Code's own retry of an earlier failed send would send the text this changes.
		deps.sender.forget(view.ref);
		deps.emit({ kind: "reply", ref: view.ref, revising: true, item: itemOf(view) });
		const run = runRevise(a, view, change, input.part).finally(() => {
			revising.delete(view.ref);
			running.delete(run);
		});
		running.add(run);
		return { status: 202, body: { ok: true, item: itemOf(view) } };
	}

	// The adapter stores the new draft (the success point), the cards move to it, one event names it, then learning. The new ref is
	// `revising` until its cards moved, so nothing sends a draft the owner has not been shown yet.
	async function runRevise(a: ReplyAdapter, view: DraftView, change: string, part?: Part): Promise<void> {
		let r: Awaited<ReturnType<ReplyAdapter["revise"]>>;
		try {
			r = await a.revise(view.ref, change, part);
		} catch (e) {
			deps.log(`reply ${view.ref}: revise threw: ${(e as Error).stack ?? (e as Error).message}`);
			r = { ok: false, reason: reasonOf("revise_failed") };
		}
		// A rewritten text under the same ref would let an older 보내기 stand for it; only a bundled mail's revise keeps its card's ref.
		if (r.ok && r.ref === view.ref && part !== "mail") {
			deps.log(`reply ${view.ref}: revise kept the same ref; refused`);
			r = { ok: false, reason: reasonOf("revise_failed") };
		}
		if (!r.ok) {
			deps.emit({ kind: "reply", ref: view.ref, why: `고치지 못했어요 - ${r.reason.text}`, item: itemOf(view) });
			return;
		}
		const moved = r.ref !== view.ref;
		if (moved) revising.add(r.ref);
		const next = await a.get(r.ref);
		try {
			const text = await a.ask(r.ref);
			if (text && !moved) deps.cards.rewrite(view.ref, text, next && approvalHash(next));
			else if (text) deps.cards.replace(view.ref, r.ref, text, next && approvalHash(next));
		} catch (e) {
			// The new draft is stored but its cards could not be drawn: every surface leaves 고치는 중 and says so.
			deps.log(`reply ${view.ref}: card of the revised draft ${r.ref} not drawn: ${(e as Error).stack ?? (e as Error).message}`);
			deps.emit({ kind: "reply", ref: view.ref, ...(moved ? { next: r.ref } : {}), why: "고친 초안을 카드에 올리지 못했어요", ...(next ? { item: itemOf(next) } : {}) });
			return;
		} finally {
			if (moved) revising.delete(r.ref);
		}
		deps.emit({ kind: "reply", ref: view.ref, ...(moved ? { next: r.ref } : {}), ...(next ? { item: itemOf(next) } : {}) });
		await learn(deps, r.lesson);
	}

	/** A draft that can still change: no revise replacing it, pending, with no send waiting, running or unsure. */
	function editable(view: DraftView): ActResult | undefined {
		if (revising.has(view.ref)) return refused(409, "revising");
		if (view.draft.state !== "pending") return refused(409, "not_pending");
		const hold = held(view.ref);
		return hold ? refused(409, hold) : undefined;
	}

	// 직접 고치기 saves the owner's text (and a mail's subject) and nothing more: sending it is his 보내기 on the saved version.
	async function edit(ctx: ActCtx, a: ReplyAdapter, view: DraftView, input: ActInput): Promise<ActResult> {
		if (Object.hasOwn(input, "send")) return fail(400, "bad_request", "직접 고치기는 저장만 해요. 보내려면 저장한 뒤 보내기를 눌러 주세요");
		if (typeof input.text !== "string" || !input.text.trim()) return refused(400, "empty");
		const mailPart = input.part === "mail" ? !!view.draft.mail : view.kind === "mail" || view.kind === "webmail";
		if (input.subject !== undefined && (typeof input.subject !== "string" || !mailPart)) return fail(400, "bad_request", "제목은 메일에만 있어요");
		if (!view.can.edit) return refused(409, "not_supported");
		const guard = editable(view);
		if (guard) return guard;
		// The store first: a refused edit leaves no pick and keeps code's own retry. An older 보내기 cannot send the saved text (its fingerprint
		// names the old version), so his pick may follow the save.
		const r = await a.edit(view.ref, input.text, input.part, input.subject);
		if (!r.ok) return fail(422, r.reason.code, r.reason.text, "lint" in r ? r.lint : undefined);
		pick(deps, ctx, a, view, 0, DRAFT_HAND_EDIT);
		deps.sender.forget(view.ref);
		const next = await a.get(view.ref);
		await redraw(deps, a, view.ref, next);
		const item = itemOf(next ?? view);
		deps.emit({ kind: "reply", ref: view.ref, item });
		return { status: 200, body: { ok: true, item } };
	}

	async function drop(ctx: ActCtx, a: ReplyAdapter, view: DraftView): Promise<ActResult> {
		const guard = editable(view);
		if (guard) return guard;
		pick(deps, ctx, a, view, 3, "보내지 않기");
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
		return sendPicked(ctx, a, view, 1, SEND_LABEL.send, job(a, view, "send", { force: true }));
	}

	function undo(view: DraftView): ActResult {
		const r = deps.sender.cancel(view.ref);
		if (r === "late") return refused(409, "already_sending");
		if (r === "none") return refused(409, "not_pending");
		return { status: 200, body: { ok: true, item: itemOf(view) } };
	}

	async function act(input: ActInput, ctx: ActCtx): Promise<ActResult> {
		if (!input || typeof input.ref !== "string" || !input.ref || !ACTIONS.has(input.action)) return fail(400, "bad_request", "ref와 action이 필요해요");
		// An agent caller may only revise; it never writes the owner's word and never sends.
		if (ctx.agent && input.action !== "revise") return refused(403, "owner_only");
		const found = await resolve(input.ref);
		if (!found) return fail(404, "unknown_ref", "그 초안을 찾지 못했어요");
		if ("card" in found) return toBot(ctx, found.card, input);
		// The pick, the send and its card state belong where the draft's card was asked, when it has one (a 다시 보내기 comes after the card
		// was answered, so an answered card counts too); the store's own place otherwise.
		const card = deps.cards.open().find(c => c.ref === input.ref);
		const conv = card?.conv ?? deps.cards.convOf?.(input.ref);
		const a = found.adapter, view = conv ? { ...found.view, conv } : found.view;
		// A send that names no version (typed chat, an older page) is checked against the version its card was last drawn with. One with neither
		// (a card never drawn with one, no card) is refused like a stale one and its cards drawn anew: nothing sends a version no surface showed.
		const shown = input.hash ?? (SENDS.has(input.action) ? (card?.hash ?? "") : undefined);
		const old = await stale(a, view, shown === undefined ? input : { ...input, hash: shown });
		if (old) return old;
		switch (input.action) {
			case "send": return send(ctx, a, view, input);
			case "revise": return revise(ctx, a, view, input);
			case "edit": return edit(ctx, a, view, input);
			case "drop": return drop(ctx, a, view);
			case "restore": return restore(a, view);
			case "retry": return retry(ctx, a, view, input);
			case "resolve": return resolveSend(ctx, a, view, input.as);
			default: return undo(view);
		}
	}

	// A hand-written card has no store here: its answer is one message to the bot, as the card's own numbered answer would be. The model's own
	// revise marker on such a card goes the same way, as its 2) 고치기 line.
	async function toBot(ctx: ActCtx, card: OpenCard, input: ActInput): Promise<ActResult> {
		if (ctx.agent && input.action !== "revise") return refused(403, "owner_only");
		const line = cardAnswer(card, input);
		if (!line) return refused(409, "not_supported");
		await deps.toBot(card.conv, line);
		return { status: 200, body: { ok: true } };
	}

	return {
		act,
		held,
		confirm: async (input: { ref: string }, ctx: ActCtx): Promise<ActResult> => confirm({ deps, found: await resolve(input.ref), unsendable, itemOf }, input.ref, ctx),
		revising: (ref: string): boolean => revising.has(ref),
		/** A 고치기 form posted as one (Discord's; the reply clarity design, amendment A): the owner's own text is saved first, then his words, if any,
		 * revise that saved version. A failed save revises nothing. */
		async amend(input: { ref: string; text: string; change?: string; part?: Part }, ctx: ActCtx): Promise<ActResult> {
			const part = input.part ? { part: input.part } : {};
			const saved = await act({ ref: input.ref, action: "edit", text: input.text, ...part }, ctx);
			const change = input.change?.trim();
			return saved.body.ok && change ? act({ ref: input.ref, action: "revise", change, ...part }, ctx) : saved;
		},
		/** The card text of `ref` built from its store now (a held approval card is shown with it, hub/approval-queue.ts), or undefined when no store knows `ref`. */
		async ask(ref: string): Promise<string | undefined> {
			const found = await resolve(ref);
			return found && "view" in found ? found.adapter.ask(ref) : undefined;
		},
		/** One reply as every surface shows it (Discord's 고치기 form reads its text), or undefined when no store knows `ref`. */
		async view(ref: string): Promise<ReplyItem | undefined> {
			const found = await resolve(ref);
			return found && "view" in found ? itemOf(found.view) : undefined;
		},
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
		/** Every reply every surface shows: the adapters' drafts with their sends, then the hand-written cards. A draft with an open card is in the
		 * card's conversation and names its notice (as `act` places its pick), so a typed answer or the model's marker there finds it. */
		async list(): Promise<ReplyItem[]> {
			const views = (await Promise.all(deps.adapters.map(a => a.list().catch(e => (deps.log(`reply list of ${a.kind} failed: ${(e as Error).message}`), [] as DraftView[]))))).flat();
			const open = deps.cards.open();
			const known = new Set(views.map(v => v.ref));
			const shown = views.map(v => {
				const card = open.find(c => c.ref === v.ref);
				return card ? { ...itemOf({ ...v, conv: card.conv }), notice: card.notice } : itemOf(v);
			});
			return [...shown, ...open.filter(c => !known.has(c.ref)).map(c => cardItem(c, deps.now?.() ?? Date.now()))];
		},
		/** The open cards of conversation `conv`, as stored (no list needed): what a typed answer and the model's marker there may name. */
		open: (conv: string): OpenCard[] => deps.cards.open().filter(c => c.conv === conv),
		/** Resolves when every running revise has finished (tests, shutdown). */
		idle: async () => {
			while (running.size) await Promise.all([...running]);
		},
	};
}

type Resolved = { adapter: ReplyAdapter; view: DraftView } | { card: OpenCard };
const confirmHead = (v: DraftView): string => `보낼까요? → ${v.draft.toLabel} ${v.draft.to}: "${draftHead(v.draft.text)}"`;
/** A send the model read from the owner's words sends nothing (the reply intent design, 4.3): the draft's card is drawn again from its store at the
 * bottom of its conversation, headed 보낼까요? with the recipient and the start of the text and bound to the version it shows. Its 보내기 is the owner's,
 * refused `changed` once the draft moved. A hand-written card is posted again as it is: its bot is not told to send on the model's reading. */
async function confirm(c: { deps: ReplyDeps; found: Resolved | undefined; unsendable: (v: DraftView) => ActResult | undefined; itemOf: (v: DraftView) => ReplyItem }, ref: string, ctx: ActCtx): Promise<ActResult> {
	const { deps, found } = c;
	if (!found) return fail(404, "unknown_ref", "그 초안을 찾지 못했어요");
	const why = ctx.owner ? ` for owner msg ${ctx.owner.mid}` : "";
	if ("card" in found) {
		await deps.cards.repost(ref, undefined, found.card.hash);
		deps.log(`reply ${ref}: hand-written card posted again to confirm${why}`);
		return { status: 200, body: { ok: true } };
	}
	const card = deps.cards.open().find(x => x.ref === ref);
	const view = card ? { ...found.view, conv: card.conv } : found.view;
	const no = c.unsendable(view);
	if (no) return no;
	const text = await found.adapter.ask(ref, confirmHead(view));
	if (!text) return refused(409, "not_supported");
	const item = c.itemOf(view);
	await deps.cards.repost(ref, text, item.draft.hash);
	deps.emit({ kind: "reply", ref, item });
	deps.log(`reply ${ref}: confirm card posted${why} "${draftHead(view.draft.text)}" hash ${item.draft.hash}`);
	return { status: 200, body: { ok: true, item } };
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
// The cards open in conversation `conv` (hub/outbound.ts convOfTarget of a chat target), read from the stored cards: what a turn's note and the
// orchestrator's marker line may name, right after a restart too.
export const openRefsOf = (conv: string): string[] => live?.open(conv).map(c => c.ref) ?? [];
/** The live instance, for modules the wiring imports (late binding, like setRefHandled in hub/outbound.ts); undefined in tests that build a surface alone. */
export const useReplies = () => live;
export const setReplies = (r: ReturnType<typeof createReplyActions> | undefined): void => void (live = r);
