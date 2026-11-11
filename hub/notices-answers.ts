// Answering, ignoring and reopening decisions, login requests, expiry. A part of the notice store split out of hub/notices.ts, code unchanged.
import { now } from "./config.ts";
import { detailOf } from "./choices.ts";
import { DRAFT_BODY_MAX, draftActionOf, draftNeedsText } from "./draft-approval.ts";
import type { Upload } from "./files.ts";
import type { DecisionOpt, Notice } from "./notices-types.ts";
import { closedHooks } from "./notices-wiring.ts";
import { TEXT_MAX, clean, closedInfo, isOpenDecision, needsAnswer, twinOf } from "./notices-rules.ts";
import { broadcast } from "./notices-read.ts";
import { expiresAtOf, sending } from "./notices-decisions.ts";
import { items, orchTurnFrom, putDecision, resolveAsks, save, settleDecision, unreadCount } from "./notices-store.ts";

// A question whose time is up stops waiting on the owner: it is closed as resolved (no answer), marked `expired` so the card reads 기한 지남, read, saved
// and broadcast like any other settle so every open page updates live. This runs in the hub's existing periodic pass (main.ts settleSweep); idempotent.
export function settleExpiredQuestions(at = now()): number {
	const stamp = Number.isNaN(Date.parse(at)) ? now() : at;
	const hit = items.filter(i => i.decision?.state === "open" && i.decision.expires_at !== undefined && i.decision.expires_at <= stamp);
	for (const i of hit) {
		i.decision!.expired = true;
		settleDecision(i, "", at, true);
	}
	return hit.length;
}

/** The open card `id` answered by the gateway's own path (a batch answer, a send the gateway runs): its queue shows the next card. */
export function settleOpenDecision(id: string, label: string): void {
	const item = items.find(i => i.id === id);
	if (item && isOpenDecision(item)) settleDecision(item, label);
}
export type DecisionSend = (a: { to: string; text: string; replyTo?: string; notice: string; action?: string; files?: Upload[]; picks?: { q: string; n: number; label: string; note?: string }[] }) => Promise<void>;
// A button of a decision: `n` is the option's number. The answer goes to the asking chat / session (or the login request) through `send`; only
// when that worked is the notice answered.
export async function answerDecision(id: unknown, body: { n?: unknown; note?: unknown; files?: Upload[] }, send: DecisionSend): Promise<{ status: number; body: Record<string, unknown> }> {
	const item = items.find(i => i.id === String(id));
	const d = item?.decision;
	if (!item || !d) return { status: 404, body: { error: "unknown decision" } };
	if (d.state !== "open") return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	// a second tap while the first answer is still going out: that one carries it (a double tap never sends the answer twice)
	if (sending.has(item.id)) return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	const o = d.options.find(x => x.n === Number(body.n));
	if (!o || o.action === "form") return { status: 400, body: { error: "unknown option" } };
	const label = `${o.n}) ${o.label}`;
	// 고치기 on a draft carries what to change and needs it. Elsewhere an option that needs detail (choices.ts detailOf: 안 됨 …) needs the owner's written reason too;
	// a button with its own `say` / `action` (login request, fixed yes / no) never does.
	const draftEdit = !!d.draft && draftNeedsText(o.label);
	const asksDetail = !d.draft && !o.say && !o.action && detailOf(o);
	const note = draftEdit || asksDetail ? String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, draftEdit ? DRAFT_BODY_MAX : 500) : "";
	if (draftEdit && !note) return { status: 400, body: { error: draftActionOf(o.label) === "own" ? "어떻게 보낼지 적어 주세요" : "무엇을 고칠지 적어 주세요" } };
	if (asksDetail && !note) return { status: 400, body: { error: "내용을 적어 주세요" } };
	const text = (o.say ?? (d.group > 1 ? `${item.title}: ${label}` : label)) + (note ? ` - ${note}` : "");
	sending.set(item.id, label);
	try {
		// `picks` carries the question with the chosen option, so the agent gets the context even from another conversation (intake.ts decisionLines).
		await send({ to: d.to, text, notice: item.id, ...(d.to.startsWith("auth:") ? {} : { picks: [{ q: item.title, n: o.n, label: o.label, ...(asksDetail ? { note } : {}) }] }), ...(d.reply_to ? { replyTo: d.reply_to } : {}), ...(o.action ? { action: o.action } : {}), ...(draftEdit && body.files?.length ? { files: body.files } : {}) });   // files: what 직접 수정 attached, for the bot to put on the draft
		settleDecision(item, label);
	} catch (err) {
		return { status: 409, body: { error: (err as Error).message } };
	} finally {
		sending.delete(item.id);
	}
	return { status: 200, body: { ok: true, item, unread: unreadCount() } };
}

// A login request (dotz_auth) waits on the owner: approve / cancel here, the form for typed values stays the page's own.
export function authRequested(a: { id: string; kind: "secret" | "otp" | "approve" | "form"; title: string; site: string; purpose: string }): void {
	const first: DecisionOpt = a.kind === "approve" ? { n: 1, label: "승인", desc: "", rec: true, action: "approve" } : { n: 1, label: "입력하기", desc: "", rec: true, action: "form" };
	putDecision({ key: `auth:${a.id}`, title: a.title, detail: `${a.purpose}\n사이트: ${a.site}`.slice(0, TEXT_MAX), to: `auth:${a.id}`, open: "main", options: [first, { n: 2, label: "취소", desc: "", rec: false, action: "cancel" }], group: 1 }, now());
}
const AUTH_DONE_WORDS: Record<string, string> = { approved: "승인했어요", entered: "입력했어요", cancelled: "취소했어요", timeout: "시간이 지나 닫혔어요", failed: "저장하지 못했어요" };
export function authSettled(id: string, status: string): void {
	const item = items.find(i => i.key === `auth:${id}`);
	if (item) settleDecision(item, AUTH_DONE_WORDS[status] ?? "끝났어요");
}

/* ---------- resolved matters: a notice whose work is over leaves the badge and the 'needs you' lists without an answer ---------- */
// The owner often settles a matter outside the app (a sudo password typed in a terminal, a file fixed by hand) and the bot then simply carries
// on, so an ask also counts as answered when real signals say its matter is over. resolveAsks is the one place that does it; it marks an open
// decision answered (`resolved`), reads the ask's twins and leaves every notice in the history. The signals:
//  1. the session that asked reports [done] / [fail] (its own report, or the worklog line keyed lane:<name>, or laneVerified);
//  2. an orchestrator turn answers [done] / [fail] to the same request (reply_to) that an EARLIER turn asked about (orchestratorTurnStarted /
//     orchestratorAnswered); an ask posted in the answering turn itself is never closed by that turn's own answer;
//  3. a watch posts "recovered" (watchRecovered);
//  4. the bot says so (resolveNotices: POST /api/notices/resolve, or dotz_send's `resolves`);
//  and, as before, the owner answering by a button, a reply in that chat or session (ownerReplied), or the login request ending.
//  A decision with options also closes when the owner quotes its one-question asking message in any words (ownerReplied, reply.id = reply_to, group 1).
// A decision with options is the owner's to pick (a phone check, an approval): signals 1-3 never touch it; only the owner's answer / x, or the
// bot naming that notice (ids / match in signal 4). A resolved decision is marked `resolved` and holds no answer text.

export function orchestratorAnswered(text: string, ref?: string, at = now()): number {
	const from = orchTurnFrom;
	const { tone } = clean(text);
	if (!from || !ref || (tone !== "done" && tone !== "fail")) return 0;
	return resolveAsks(i => i.by === "orchestrator" && i.ref === ref && (i.at ?? i.ts) < from, at);
}

// Signal 4: the bot resolves notices itself. `ids` picks exact notices, `match` every asking notice whose title or text holds that text, `conv` every
// one asked in that conversation, `all` every open ask. A login request keeps its own end (authSettled).
// The cards a session raised for the owner, once his word reached it another way. A send approval closes only on its own buttons.
export const closeLaneCards = (name: string): number => resolveAsks(i => i.decision?.to === `lane:${name}` && !i.decision.draft, now(), true);

// `inSession` limits match / all to the notices of one session's conversations (dotz_send's `resolves` from a conversation session); ids and conv name theirs.
export function resolveNotices(sel: { ids?: unknown; match?: unknown; conv?: unknown; all?: unknown }, inSession?: (conv: string | undefined) => boolean): { resolved: number; unread: number } {
	const ids = Array.isArray(sel.ids) ? new Set(sel.ids.map(String)) : undefined;
	const match = typeof sel.match === "string" && sel.match.trim() ? sel.match.trim().toLowerCase() : undefined;
	const conv = typeof sel.conv === "string" && sel.conv ? sel.conv : undefined;
	const mine = (i: Notice) => !inSession || (inSession(i.src ?? i.open) && (!i.decision?.to || inSession(i.decision.to)));
	const pick = (i: Notice) => (ids ? ids.has(i.id) : match ? mine(i) && `${i.title}\n${i.text}`.toLowerCase().includes(match) : conv ? (i.src ?? i.open) === conv || i.decision?.to === conv : sel.all === true && mine(i));
	// ids / match name notices; conv / all do not, so a decision with options is left for the owner there.
	return { resolved: resolveAsks(pick, now(), !!(ids || match)), unread: unreadCount() };
}

// The ask notices that go with `item` (the decision and its alert / message twins, made by one asking message). Ignoring a decision of a message
// with several decisions leaves the others and the twins; undoing brings the twins back with it.
function askGroup(item: Notice, undo: boolean): Notice[] {
	const on = (n: Notice) => (undo ? !!n.ignored : needsAnswer(n));
	const group = new Set<Notice>([item]);
	const roots = item.decision ? [item] : items.filter(d => d.decision && on(d) && twinOf(d, item));
	for (const d of roots) {
		group.add(d);
		const siblings = items.some(n => n.decision && n.decision.reply_to === d.decision!.reply_to && on(n) && !roots.includes(n));
		if (undo || !siblings) for (const t of items) if (on(t) && twinOf(d, t)) group.add(t);
	}
	return [...group];
}

export function announce(group: Notice[], at: string): void {
	save();
	const unread = unreadCount();
	for (const n of group) broadcast({ ts: at, kind: "notice", source: "gateway", item: n, unread });
}

// The x (무시) on a question that waits on the owner: it leaves the badge and 답변 필요, stays in the history marked ignored, answers nothing to
// the bot, and every open page hears the changed items. An item that is not waiting (answered, resolved, plain info) cannot be ignored.
export function ignoreNotice(id: unknown): { status: number; body: Record<string, unknown> } {
	const item = items.find(i => i.id === String(id));
	if (!item) return { status: 404, body: { error: "unknown notice" } };
	if (item.ignored) return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	if (!needsAnswer(item)) return { status: 409, body: { error: "not waiting" } };
	const at = now(), group = askGroup(item, false);
	for (const n of group) {
		n.ignored = at;
		n.read = true;
		if (n.decision?.state === "open") n.decision.state = "ignored";
	}
	announce(group, at);
	for (const n of group) if (n.decision?.state === "ignored") for (const fn of closedHooks) fn(n.decision.to, n.decision.draft?.ref, closedInfo(n, "ignored"));
	return { status: 200, body: { ok: true, item, ids: group.map(n => n.id), unread: unreadCount() } };
}

// Undo of ignoreNotice: the question waits again, unread, on every page.
export function unignoreNotice(id: unknown): { status: number; body: Record<string, unknown> } {
	const item = items.find(i => i.id === String(id));
	if (!item) return { status: 404, body: { error: "unknown notice" } };
	if (!item.ignored) return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	const at = now(), group = askGroup(item, true);
	for (const n of group) {
		delete n.ignored;
		n.read = false;
		if (n.decision?.state === "ignored") {
			n.decision.state = "open";
			// A question that waits again gets a full window from now, not the one it had before it was waved off.
			delete n.decision.expired;
			const exp = expiresAtOf(n.decision, at);
			if (exp) n.decision.expires_at = exp;
		}
	}
	announce(group, at);
	return { status: 200, body: { ok: true, item, ids: group.map(n => n.id), unread: unreadCount() } };
}

// Puts questions back that were closed by mistake (a wrong auto-resolve): open, unread, not resolved or ignored, no answer text. Only a decision or an
// [ask] item can be reopened; the hub does it in its own memory, so no file is edited behind its back.
export function reopenNotices(ids: unknown): { reopened: string[]; unread: number } {
	const want = new Set(Array.isArray(ids) ? ids.map(String) : []);
	const hit = items.filter(i => want.has(i.id) && (i.decision || i.tone === "ask"));
	const at = now();
	for (const i of hit) {
		i.read = false;
		i.updated = at;
		delete i.dismissed;
		delete i.ignored;
		const d = i.decision;
		if (!d) continue;
		d.state = "open";
		delete d.resolved;
		delete d.expired;
		delete d.answer;
		delete d.answered_at;
		const exp = expiresAtOf(d, at);
		if (exp) d.expires_at = exp;
	}
	if (hit.length) announce(hit, at);
	return { reopened: hit.map(i => i.id), unread: unreadCount() };
}
