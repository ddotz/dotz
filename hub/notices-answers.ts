// Answering, ignoring and reopening decisions, login requests, expiry. A part of the notice store split out of hub/notices.ts, code unchanged.
import { log, now } from "./config.ts";
import { detailOf, unnumbered } from "./choices.ts";
import { DRAFT_BODY_MAX, draftActionOf, draftNeedsText } from "./draft-approval.ts";
import type { Upload } from "./files.ts";
import type { Decision, DecisionOpt, HeldAnswer, Notice, OwnerSaid } from "./notices-types.ts";
import { msg } from "./i18n.ts";
import { tellAsker } from "./notices-tell.ts";
import { closedHooks, decisionHooks } from "./notices-wiring.ts";
import { TEXT_MAX, clean, closedInfo, isOpenDecision, laterOn, needsAnswer, twinOf } from "./notices-rules.ts";
import { broadcast } from "./notices-read.ts";
import { expiresAtOf, holds, plainCard, sending } from "./notices-decisions.ts";
import { finishOnStop } from "./shutdown.ts";
import { RUN_DECISION } from "./notices-schedule.ts";
import { laneExists } from "./notices-lanes.ts";
import { escalations } from "./escalate.ts";
import { items, orchTurnFrom, putDecision, resolveAsks, save, settleDecision, unreadCount } from "./notices-store.ts";

// A question whose time is up stops waiting on the owner: it is closed as resolved (no answer), marked `expired` so the card reads 기한 지남, read, saved
// and broadcast like any other settle so every open page updates live. This runs in the hub's existing periodic pass (main.ts settleSweep); idempotent.
export function settleExpiredQuestions(at = now()): number {
	const stamp = Number.isNaN(Date.parse(at)) ? now() : at;
	const hit = items.filter(i => i.decision?.state === "open" && i.decision.expires_at !== undefined && i.decision.expires_at <= stamp);
	for (const i of hit) {
		i.decision!.expired = true;
		tellAsker(i, msg().asker.expired(i.title));
		settleDecision(i, "", at, true, { how: "expired" });
	}
	return hit.length;
}

/** The open card `id` answered by the gateway's own path (a batch answer, a send the gateway runs): its queue shows the next card. */
export function settleOpenDecision(id: string, label: string): void {
	const item = items.find(i => i.id === id);
	if (item && isOpenDecision(item)) settleDecision(item, label);
}
const OWN_WORDS_MAX = 1000;
/** The asking session has ended, so an answer cannot reach it: the card stays open and offers the hand-off to the main conversation. */
export class SessionEnded extends Error {
	readonly code = "session_ended";
	constructor(readonly lane: string) {
		super("이 세션은 이미 끝나서 전달하지 못했어요");
	}
}
const NOT_DELIVERED = "전달하지 못했어요. 잠시 뒤에 다시 해 주세요";
export type DecisionSend = (a: { to: string; text: string; replyTo?: string; notice: string; action?: string; files?: Upload[]; picks?: { q: string; n: number; label: string; note?: string; hash?: string }[] }) => Promise<void>;
const HANDED_OFF = "메인에 넘겼어요";
const handedOff = (item: Notice, answer: string): string => `세션 ${item.decision!.to.slice(5)}은(는) 이미 끝나서 메인에 대신 전해요.\n질문: ${item.title}\n답: ${answer}`;
// A button of a decision: `n` is the option's number. The answer goes to the asking chat / session (or the login request) through `send`; only
// when that worked is the notice answered.
export async function answerDecision(id: unknown, body: { n?: unknown; note?: unknown; files?: Upload[]; handoff?: unknown; hold?: unknown }, send: DecisionSend): Promise<{ status: number; body: Record<string, unknown> }> {
	const item = items.find(i => i.id === String(id));
	const d = item?.decision;
	if (!item || !d) return { status: 404, body: { error: "unknown decision" } };
	if (d.state !== "open") return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	// a second tap while the first answer is still going out: that one carries it (a double tap never sends the answer twice)
	if (sending.has(item.id)) return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	const held = heldOf(item);
	if (held) return { status: 409, body: { code: "held", error: msg().answerHeld(held.label.replace(/^\d+\)\s*/, "")), held, item, unread: unreadCount() } };
	if (d.hold) delete d.hold;
	const handoff = body.handoff === "main";
	if (body.handoff !== undefined && (!handoff || !d.to.startsWith("lane:") || d.draft)) return { status: 400, body: { error: "unknown option" } };
	const mayHold = body.hold === true && plainCard(d) && !handoff && !body.files?.length && !(d.to.startsWith("lane:") && !laneExists(d.to.slice(5)));
	if (body.n === undefined || body.n === null) return answerInWords(item, String(body.note ?? "").trim().slice(0, OWN_WORDS_MAX), send, handoff, mayHold);
	const o = d.options.find(x => x.n === Number(body.n));
	if (!o || o.action === "form") return { status: 400, body: { error: "unknown option" } };
	const hold = mayHold && !o.action && !escalations()?.answers({ to: d.to, label: o.label });
	const label = `${o.n}) ${unnumbered(o.label)}`;
	// 고치기 on a draft carries what to change and needs it. Elsewhere an option that needs detail (choices.ts detailOf: 안 됨 …) needs the owner's written reason too;
	// a button with its own `say` / `action` (login request, fixed yes / no) never does.
	const draftEdit = !!d.draft && draftNeedsText(o.label);
	const asksDetail = !d.draft && !o.say && !o.action && detailOf(o);
	const note = draftEdit || asksDetail ? String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, draftEdit ? DRAFT_BODY_MAX : 500) : "";
	if (draftEdit && !note) return { status: 400, body: { error: draftActionOf(o.label) === "own" ? "어떻게 보낼지 적어 주세요" : "무엇을 고칠지 적어 주세요" } };
	if (asksDetail && !note) return { status: 400, body: { error: "내용을 적어 주세요" } };
	const text = (o.say ?? (d.group > 1 ? `${item.title}: ${label}` : label)) + (note ? ` - ${note}` : "");
	return (hold ? holdDecision : deliverDecision)(item, handoff ? `${label} · ${HANDED_OFF}` : label, { to: handoff ? "main" : d.to, text: handoff ? handedOff(item, text) : text, notice: item.id, ...(d.to.startsWith("auth:") ? {} : { picks: [{ q: item.title, n: o.n, label: o.label, ...(asksDetail ? { note } : {}), ...(d.draft && d.hash ? { hash: d.hash } : {}) }] }), ...(d.reply_to && !handoff ? { replyTo: d.reply_to } : {}), ...(o.action ? { action: o.action } : {}), ...(draftEdit && body.files?.length ? { files: body.files } : {}) }, send);   // `picks` carries the question with the chosen option, so the agent gets the context even from another conversation (intake.ts decisionLines); files: what 직접 수정 attached, for the bot to put on the draft
}
// Sends the answer, and only when that worked is the notice answered. `label` is what the notice then shows as the answer.
async function deliverDecision(item: Notice, label: string, payload: Parameters<DecisionSend>[0], send: DecisionSend): Promise<{ status: number; body: Record<string, unknown> }> {
	sending.set(item.id, label);
	try {
		await send(payload);
		delete item.decision?.hold;
		settleDecision(item, label);
	} catch (err) {
		if (err instanceof SessionEnded) return { status: 409, body: { code: err.code, error: err.message } };
		const said = (err as Error).message;
		log(`answer of ${item.id} not delivered: ${said}`);
		if (err instanceof Error && "code" in err && err.code === "runtime_mismatch") return { status: 409, body: { code: "runtime_mismatch", error: said } };
		return { status: 409, body: { code: "not_delivered", error: /[A-Za-z]{3,}|\//.test(said) ? NOT_DELIVERED : said } };
	} finally {
		sending.delete(item.id);
	}
	return { status: 200, body: { ok: true, item, unread: unreadCount() } };
}
/** How long a plain card's answer waits in the gateway's memory before it goes out, while the page offers 되돌리기 (POST /api/notices/<id>/unhold).
 * An orderly stop (지금 재시작, the restart gate of an update, SIGTERM: hub/shutdown.ts) sends every held answer at once before it saves anything, and a
 * restart that waits for an idle gateway waits for it. A crash (kill -9, power loss) inside the window loses the answer unsent; the card was never
 * settled on disk, so it waits on the owner again. */
export const ANSWER_HOLD_MS = 5000;
const ANSWER_GONE = "답이 이미 전해져서 되돌릴 수 없어요";
type HoldGiven = Omit<HeldAnswer & { state: "held" }, "left"> | Omit<HeldAnswer & { state: "failed" }, "left">;
function holdOn(d: Decision, h: HoldGiven): void {
	Object.defineProperty(d, "hold", { configurable: true, enumerable: true, get: (): HeldAnswer => ({ ...h, left: Math.max(0, h.until - Date.now()) }) });
}
const givenOf = new WeakMap<object, HoldGiven>();
/** The answer held for `item` in its undo window, put back on its decision when a re-ask of the same question replaced that object; undefined when none waits. */
export function heldOf(item: Notice): HeldAnswer | undefined {
	const h = holds.by.get(item.id), given = h && givenOf.get(h);
	if (!given || !item.decision) return undefined;
	if (item.decision.hold?.until !== given.until) holdOn(item.decision, given);
	return item.decision.hold;
}
async function holdDecision(item: Notice, label: string, payload: Parameters<DecisionSend>[0], send: DecisionSend): Promise<{ status: number; body: Record<string, unknown> }> {
	if (!holds.on) return deliverDecision(item, label, payload, send);
	const pick = payload.picks?.[0], typed = pick ? { n: pick.n, ...(pick.note ? { note: pick.note } : {}) } : { note: label };
	const until = Date.now() + ANSWER_HOLD_MS;
	const deliver = async (): Promise<void> => {
		if (!isOpenDecision(item) || !items.includes(item)) {
			delete item.decision?.hold;
			return;
		}
		const r = await deliverDecision(item, label, payload, send);
		if (r.status === 200) return;
		if (!isOpenDecision(item)) {
			delete item.decision?.hold;
			return;
		}
		holdOn(item.decision!, { state: "failed", label, until, ...typed, code: String(r.body.code), error: String(r.body.error) });
		announce([item], now());
	};
	let going: Promise<void> | undefined;
	const go = (): Promise<void> => (going ??= deliver().finally(() => {
		if (holds.by.get(item.id) === entry) holds.by.delete(item.id);
	}));
	const entry = { timer: setTimeout(() => void go(), ANSWER_HOLD_MS), go }, given: HoldGiven = { state: "held", label, until, ...typed };
	givenOf.set(entry, given);
	holds.by.set(item.id, entry);
	holdOn(item.decision!, given);
	announce([item], now());
	return { status: 200, body: { ok: true, held: item.decision!.hold, item, unread: unreadCount() } };
}
/** 되돌리기 of a held answer: nothing went out and the card waits as it did; `back` is what was typed with the answer (its option and text), for the page to
 * put back. 409 once the answer has left (or there was none to take back). */
export function unholdDecision(id: unknown): { status: number; body: Record<string, unknown> } {
	const item = items.find(i => i.id === String(id)), h = holds.by.get(String(id));
	if (!item || !h || sending.has(item.id)) return { status: 409, body: { code: "gone_out", error: ANSWER_GONE } };
	clearTimeout(h.timer);
	holds.by.delete(item.id);
	const given = givenOf.get(h);
	delete item.decision?.hold;
	announce([item], now());
	return { status: 200, body: { ok: true, item, unread: unreadCount(), ...(given?.note ? { back: { ...(given.n === undefined ? {} : { n: given.n }), note: given.note } } : {}) } };
}
/** Every held answer goes out now, each once, and a later answer is not held: the first work of an orderly stop (hub/shutdown.ts finishOnStop). */
export async function sendHeldNow(): Promise<void> {
	holds.on = false;
	const all = [...holds.by.values()];
	for (const h of all) clearTimeout(h.timer);
	await Promise.all(all.map(h => h.go()));
}
finishOnStop("held answers", sendHeldNow, () => holds.by.size > 0);

// The owner's own words as the answer, no option picked: for a question asked where no composer takes typed text (the 알림 conversation), so the sheet's
// text field is the only place to write. It reaches the asking chat / session as an option answer does, with the question (intake.ts decisionLines reads
// replyTo and the notice); a question of a several-question message, or one with no asking message to point at, carries its title. A send approval and a
// login request are answered by their buttons only.
async function answerInWords(item: Notice, said: string, send: DecisionSend, handoff: boolean, hold = false): Promise<{ status: number; body: Record<string, unknown> }> {
	const d = item.decision!;
	if (d.draft || d.to.startsWith("auth:") || d.to.startsWith(RUN_DECISION)) return { status: 400, body: { error: "unknown option" } };
	if (!said) return { status: 400, body: { error: "내용을 적어 주세요" } };
	const text = d.group > 1 || !d.reply_to ? `${item.title}: ${said}` : said;
	return (hold ? holdDecision : deliverDecision)(item, handoff ? `${said} · ${HANDED_OFF}` : said, { to: handoff ? "main" : d.to, text: handoff ? handedOff(item, text) : text, notice: item.id, ...(d.reply_to && !handoff ? { replyTo: d.reply_to } : {}) }, send);
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
export function resolveNotices(sel: { ids?: unknown; match?: unknown; conv?: unknown; all?: unknown }, inSession?: (conv: string | undefined) => boolean, ownerOnly?: (i: Notice) => boolean, said?: OwnerSaid): { resolved: number; unread: number } {
	const ids = Array.isArray(sel.ids) ? new Set(sel.ids.map(String)) : undefined;
	const match = typeof sel.match === "string" && sel.match.trim() ? sel.match.trim().toLowerCase() : undefined;
	const conv = typeof sel.conv === "string" && sel.conv ? sel.conv : undefined;
	const mine = (i: Notice) => !inSession || (inSession(i.src ?? i.open) && (!i.decision?.to || inSession(i.decision.to)));
	const chosen = (i: Notice) => (ids ? ids.has(i.id) : match ? mine(i) && `${i.title}\n${i.text}`.toLowerCase().includes(match) : conv ? (i.src ?? i.open) === conv || i.decision?.to === conv : sel.all === true && mine(i));
	const pick = (i: Notice) => !ownerOnly?.(i) && chosen(i);
	// ids / match name notices; conv / all do not, so a decision with options is left for the owner there.
	return { resolved: resolveAsks(pick, now(), !!(ids || match), said), unread: unreadCount() };
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

/** The x (무시) on a question that waits on the owner: it leaves the badge and 답변 필요, stays in the history marked ignored, its asker hears it with its next prompt
 * (hub/notices-tell.ts), and every open page hears the changed items. An item that is not waiting (answered, resolved, plain info) cannot be ignored. */
export function ignoreNotice(id: unknown): { status: number; body: Record<string, unknown> } {
	const item = items.find(i => i.id === String(id));
	if (!item) return { status: 404, body: { error: "unknown notice" } };
	if (item.ignored) return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	if (!needsAnswer(item) && !(isOpenDecision(item) && laterOn(item.decision))) return { status: 409, body: { error: "not waiting" } };
	const at = now(), group = askGroup(item, false);
	for (const n of group) {
		n.ignored = at;
		n.read = true;
		if (n.decision?.state !== "open") continue;
		n.decision.state = "ignored";
		delete n.decision.judging;
		delete n.decision.later_until;
		tellAsker(n, msg().asker.ignored(n.title));
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
			delete n.decision.half_told;
			delete n.decision.tell;
			const exp = expiresAtOf(n.decision, at);
			if (exp) n.decision.expires_at = exp;
		}
	}
	announce(group, at);
	return { status: 200, body: { ok: true, item, ids: group.map(n => n.id), unread: unreadCount() } };
}

// Puts questions back that were closed by mistake (a wrong auto-resolve): open, unread, not resolved or ignored, no answer text. Only a decision or an
// [ask] item can be reopened; the hub does it in its own memory, so no file is edited behind its back.
const REOPEN_CLEARS = ["closed_how", "words", "judging", "kept_open", "half_told", "later_until", "more_at", "tell"] as const satisfies readonly (keyof Decision)[];
const pushedFor = new Map<string, string>();
export function reopenNotices(ids: unknown, because?: string): { reopened: string[]; unread: number } {
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
		for (const k of REOPEN_CLEARS) delete d[k];
		const exp = expiresAtOf(d, at);
		if (exp) d.expires_at = exp;
	}
	if (hit.length) announce(hit, at);
	if (because !== undefined) {
		if (pushedFor.size > 200) for (const id of pushedFor.keys()) if (!items.some(i => i.id === id)) pushedFor.delete(id);
		for (const i of hit) {
			if (i.decision?.state !== "open" || pushedFor.get(i.id) === because) continue;
			pushedFor.set(i.id, because);
			for (const fn of decisionHooks) fn(i);
		}
	}
	return { reopened: hit.map(i => i.id), unread: unreadCount() };
}
