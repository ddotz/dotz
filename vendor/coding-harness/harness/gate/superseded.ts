import { say } from "../notice.ts";
import { inDotz, notify } from "./host.ts";
import type { AssistantTextContext, Ctx } from "./host.ts";
import { stripMarkdown } from "./plaintext.ts";
import type { State } from "./session.ts";
import { message } from "./util.ts";

interface SentBack {
	classes: readonly string[];
	expanded: boolean;
}

interface Shelf {
	last: number | undefined;
	sentBack: Map<number, SentBack>;
}

const shelves = new WeakMap<State, Shelf>();
const index = new Map<number, Shelf>();

function shelfOf(state: State): Shelf {
	const known = shelves.get(state);
	if (known !== undefined) return known;
	const created: Shelf = { last: undefined, sentBack: new Map() };
	shelves.set(state, created);
	return created;
}

/** Notes the `message.timestamp` of a finished reply of the session as its latest reply; a reply without one leaves no latest reply. */
export function noteReply(state: State, timestamp: number | undefined): void {
	shelfOf(state).last = timestamp;
}

/** The `message.timestamp` of the session's latest finished reply, undefined when it had none. */
export function latestReply(state: State): number | undefined {
	return shelves.get(state)?.last;
}

/**
 * Marks the reply with `message.timestamp` `at`, one that ended a turn whose stop was refused or whose deferred check failed, as
 * sent back with the finding `classes`, folded, and draws it again as one row. Only an interactive session (`ctx.hasUI`) on a host
 * with `ctx.ui.rerenderMessage` is marked; a reply without a timestamp (`at` undefined) leaves nothing. A failing redraw is kept
 * in `state.errors`.
 */
export function supersede(state: State, ctx: Ctx, at: number | undefined, classes: readonly string[]): void {
	const shelf = shelves.get(state);
	const rerender = ctx.ui?.rerenderMessage;
	if (ctx.hasUI !== true || shelf === undefined || at === undefined || rerender === undefined) return;
	shelf.sentBack.set(at, { classes, expanded: false });
	index.set(at, shelf);
	try {
		rerender.call(ctx.ui, at);
	} catch (error) {
		state.errors.push(message(error));
	}
}

/** Forgets the session's sent-back replies: the session was left or shut down. */
export function forgetReplies(state: State): void {
	const shelf = shelves.get(state);
	if (shelf === undefined) return;
	for (const at of shelf.sentBack.keys()) if (index.get(at) === shelf) index.delete(at);
	shelves.delete(state);
}

/**
 * `/gate-show`: while any sent-back reply of the session is folded, draws every one in full; once all are drawn in full, folds
 * them all. Draws again only the replies whose state changed and tells the user the new state and the count of sent-back replies;
 * `state` is undefined for a session the gate does not know.
 */
export function toggleSuperseded(state: State | undefined, ctx: Ctx): void {
	const shelf = state === undefined ? undefined : shelves.get(state);
	const count = shelf?.sentBack.size ?? 0;
	if (shelf === undefined || count === 0) return notify(ctx, say({ en: "done-gate: no reply of this session was sent back.", ko: "done-gate: 이 세션에서 게이트가 돌려보낸 답변은 없습니다." }), "info");
	const expand = [...shelf.sentBack.values()].some(reply => !reply.expanded);
	for (const [at, reply] of shelf.sentBack) {
		if (reply.expanded === expand) continue;
		reply.expanded = expand;
		ctx.ui?.rerenderMessage?.(at);
	}
	const replies = { en: count === 1 ? "1 reply the gate sent back is" : `${count} replies the gate sent back are`, it: count === 1 ? "it" : "them" };
	notify(
		ctx,
		expand
			? say({ en: `done-gate: ${replies.en} shown in full; /gate-show folds ${replies.it} again.`, ko: `done-gate: 게이트가 돌려보낸 답변 ${count}개를 모두 펼쳤습니다. /gate-show로 다시 접습니다.` })
			: say({ en: `done-gate: ${replies.en} folded into one row; /gate-show shows ${replies.it} again.`, ko: `done-gate: 게이트가 돌려보낸 답변 ${count}개를 한 줄로 접었습니다. /gate-show로 다시 펼칩니다.` }),
		"info",
	);
}

/**
 * The assistant text renderer: a reply the gate sent back, while folded, is drawn as one row on its first text block and as
 * nothing on its other text blocks. Any other finished text block outside dotz is drawn without the markdown the terminal shows
 * raw (`stripMarkdown`: bold, headings, tables) when it has any; every other reply is drawn unchanged (`undefined`). One map
 * lookup for a reply not sent back.
 */
export function renderReply(context: AssistantTextContext): string | undefined {
	const at = context.message?.timestamp;
	const shelf = at === undefined ? undefined : index.get(at);
	const reply = at === undefined ? undefined : shelf?.sentBack.get(at);
	if (reply === undefined || reply.expanded) return context.streaming === false && !inDotz() && typeof context.text === "string" ? stripMarkdown(context.text) : undefined;
	const content = context.message?.content;
	const first = Array.isArray(content) ? content.findIndex(block => typeof block === "object" && block !== null && "type" in block && block.type === "text") : -1;
	if (context.contentIndex !== first) return "";
	const named = reply.classes.join(", ") || say({ en: "see the gate log", ko: "게이트 로그 참고" });
	return say({ en: `done-gate sent this reply back (${named}); the report after the fix follows. /gate-show shows it again.`, ko: `done-gate가 이 답변을 돌려보냈습니다(${named}). 수정한 뒤의 보고가 이어집니다. /gate-show로 다시 펼칩니다.` });
}
