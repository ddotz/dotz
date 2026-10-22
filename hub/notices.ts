import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log, now, paths, writeAtomic } from "./config.ts";
import { type DecisionOption, detailOf, hasDecisionHead, parseDecisions } from "./choices.ts";
import { type DraftApproval, draftActionOf, parseDraftApproval } from "./draft-approval.ts";
import { broadcast, emit, eventTarget, type HubEvent, onEmit } from "./events.ts";
import { readOf } from "./reads.ts";
import { parseTone, stripHandoff } from "./tone.ts";
import { humanLabel, scheduleLine, watchLine, watchReasonKo } from "./watchtext.ts";

// The web notification store: every worklog / alert / session result / watch / schedule post, kept in notices.json so the
// bell survives a restart. Fed by what the hub already emits (onEmit), so main.ts only wires the API and the resolver.
export type NoticeKind = "result" | "alert" | "worklog" | "watch" | "decision" | "message";
export type NoticeTone = "done" | "run" | "ask" | "fail" | "";
export type Notice = {
	id: string;
	ts: string;
	updated: string;
	kind: NoticeKind;
	tone: NoticeTone;
	title: string;
	text: string;
	// The conversation to open on tap: "main", "lane:<name>" or "ch:<id>".
	open: string;
	// The source message: the conversation it lives in ("main", "lane:<name>", "ch:<id>") and its event ts, which the web finds
	// on the rendered message (data-ts). Older items have neither: the web falls back to open + updated.
	src?: string;
	at?: string;
	key?: string;
	// Who raised it: "orchestrator", "lane:<name>" or "gateway" (older items have none: originOf falls back to the decision target / lane key).
	by?: string;
	// The owner message (or earlier post) the asking post replied to: what lets a later [done] to that same request tell it is about the same matter.
	ref?: string;
	read: boolean;
	// Swiped away / x in the bell: kept (so a session's next progress line does not bring it back) but never listed or counted.
	dismissed?: boolean;
	// The owner's x on a question (ignoreNotice): off the badge and 답변 필요 but kept in the history, marked as ignored; undoable.
	// Nothing is sent to the bot. The value is when it was ignored.
	ignored?: string;
	// kind "decision": a question that waits on the owner (title = the decision line, text = the whole asking message).
	decision?: Decision;
};

// `say` is the text sent when the button is chosen (default "<n>) <label>"); `action` marks a login request's button (approve / cancel /
// form = the page's own input form, never answered through the hub).
export type DecisionOpt = DecisionOption & { say?: string; action?: string };
export type Decision = {
	options: DecisionOpt[];
	// Where the answer goes: "main", "lane:<name>", "ch:<id>" (a project chat) or "auth:<request id>".
	to: string;
	// The asking message (its event ts): the answer is sent as a reply to it.
	reply_to?: string;
	// How many decisions the asking message held; with more than one the answer names its decision.
	group: number;
	// "ignored": the owner waved it off with the x (Notice.ignored); the matter was not answered.
	state: "open" | "answered" | "ignored";
	// True when no answer came but the matter was resolved by other means (resolveAsks): the bot finished it, the owner acted outside the app.
	resolved?: boolean;
	answer?: string;
	answered_at?: string;
	// A draft waiting for send approval (hub/draft-approval.ts): the sheet shows it above the options.
	draft?: DraftApproval;
};

export const NOTICE_CAP = 300;
const TEXT_MAX = 1500;
const LOUD = new Set<NoticeTone>(["done", "fail", "ask"]);
const RESTART_PREFIX = /^게이트웨이(?: 재시작했어요|를 다시 시작했어요)/;

const load = (): Notice[] => {
	if (!existsSync(paths.notices)) return [];
	try {
		const parsed = JSON.parse(readFileSync(paths.notices, "utf8"));
		return Array.isArray(parsed) ? parsed.filter((n): n is Notice => typeof n?.id === "string" && typeof n.text === "string") : [];
	} catch (e) {
		log(`notices.json unreadable, starting empty: ${e}`);
		return [];
	}
};
let items: Notice[] = load();
// The title a lane was launched with, from its lane_start event (live or replayed): the fallback once lane.json is gone.
const launchTitles = new Map<string, string>();
// True while backfillNotices replays old events: upsert then neither writes the file nor broadcasts per item.
let replaying = false;

const save = () => writeAtomic(paths.notices, `${JSON.stringify(items, null, 1)}\n`);
export const unreadCount = () => items.reduce((n, i) => n + (i.read || i.dismissed ? 0 : 1), 0);

// The Korean title of a session (never its code name); main.ts passes lanes.get(name)?.title.
let laneTitleOf: (name: string) => string | undefined = () => undefined;
export const setLaneTitleResolver = (fn: (name: string) => string | undefined) => void (laneTitleOf = fn);

// Watch names are keys ([a-z0-9-]); the owner reads the label. And a watch event routed to the orchestrator makes no notice while the
// orchestrator can take it (the orchestrator reports in that channel itself); main.ts wires both.
let watchLabelOf: (name: string) => string = name => name;
let orchestratorUp: () => boolean = () => true;
export const setWatchLabelResolver = (fn: (name: string) => string) => void (watchLabelOf = fn);
export const setOrchestratorAvailable = (fn: () => boolean) => void (orchestratorUp = fn);
// A stopped lane is no longer in the live map: its title lives in the lane record the hub keeps (lanes/<name>/lane.json) and
// in the title its lane_start event carries.
function recordedTitle(name: string): string | undefined {
	if (!/^[\w.-]+$/.test(name)) return undefined;
	try {
		const title = JSON.parse(readFileSync(join(paths.lanes, name, "lane.json"), "utf8"))?.title;
		if (typeof title === "string" && title.trim()) return title.trim();
	} catch {
		// no record (or an unreadable one): fall through to the launch event
	}
	return launchTitles.get(name);
}
const noteLaunch = (e: HubEvent) => {
	if (typeof e.lane === "string" && typeof e.title === "string" && e.title.trim()) launchTitles.set(e.lane, e.title.trim());
};
const laneTitle = (name: string) => laneTitleOf(name)?.trim() || recordedTitle(name) || "세션";

// On load: items that were stored as "세션" (the title was not known when they were made) get their lane's real title when one
// can be found, without touching anything else.
function retitleStored(): void {
	if (!items.some(i => i.key?.startsWith("lane:") && i.title === "세션")) return;
	if (existsSync(paths.outbox))
		for (const line of readFileSync(paths.outbox, "utf8").split("\n"))
			if (line.includes('"lane_start"') && line.includes('"title"'))
				try {
					const e = JSON.parse(line) as HubEvent;
					if (e.kind === "lane_start") noteLaunch(e);
				} catch {
					continue;
				}
	let changed = 0;
	for (const i of items) {
		if (!i.key?.startsWith("lane:") || i.title !== "세션") continue;
		const title = recordedTitle(i.key.slice(5));
		if (title) {
			i.title = title;
			changed++;
		}
	}
	if (changed) {
		save();
		log(`notices retitled: ${changed} lane items`);
	}
}
retitleStored();

const isOpenDecision = (i: Notice) => i.decision?.state === "open";
// A notice that waits on the owner's action: an open decision, or an [ask] item (the alert / message twin of one). Looking at it, anywhere, never
// reads it; only an answer, a resolving signal (resolveAsks) or the owner's x (ignoreNotice) takes it off. Every other notice clears on view.
export const needsAnswer = (i: Notice) => !i.read && !i.dismissed && !i.ignored && (isOpenDecision(i) || i.tone === "ask");
// The alert / message twin of a decision: an [ask] item made by the same asking event, or by a repeat of the same text (a session's mid-turn line and its
// turn-end report both post it), so it ends with the decision.
const twinOf = (d: Notice, n: Notice) => !n.decision && n.tone === "ask" && (n.at === d.decision?.reply_to || n.text === d.text);

// Oldest read item goes first; when everything is unread, the oldest one. An open decision is never dropped.
function trim(): void {
	while (items.length > NOTICE_CAP) {
		const oldest = (list: Notice[]) => list.reduce((a, b) => (b.updated < a.updated ? b : a));
		const droppable = items.filter(i => !isOpenDecision(i));
		if (!droppable.length) return;
		const pool = droppable.filter(i => i.read);
		const drop = oldest(pool.length ? pool : droppable);
		items = items.filter(i => i !== drop);
	}
}

type Input = { kind: NoticeKind; tone: NoticeTone; title: string; text: string; open: string; key?: string; by?: string; ref?: string; read?: boolean; unread?: boolean; src?: string; at?: string };

function upsert(i: Input): Notice {
	const at = i.at ?? now();
	const old = i.key ? items.find(n => n.key === i.key) : undefined;
	let item: Notice;
	if (old) {
		const reopened = (LOUD.has(i.tone) && i.tone !== old.tone) || (i.kind === "result" && i.text !== old.text) || i.unread === true;
		old.kind = i.kind;
		old.tone = i.tone;
		old.title = i.title;
		old.text = i.text;
		old.open = i.open;
		old.src = i.src ?? i.open;
		old.at = at;
		old.updated = at;
		if (i.by) old.by = i.by;
		if (i.ref) old.ref = i.ref;
		if (i.read) old.read = true;
		else if (reopened) {
			old.read = false;
			delete old.dismissed;
			delete old.ignored;
		}
		item = old;
	} else {
		item = { id: randomBytes(4).toString("hex"), ts: at, updated: at, kind: i.kind, tone: i.tone, title: i.title, text: i.text, open: i.open, src: i.src ?? i.open, at, ...(i.key ? { key: i.key } : {}), ...(i.by ? { by: i.by } : {}), ...(i.ref ? { ref: i.ref } : {}), read: i.read === true };
		items.push(item);
		trim();
	}
	if (!replaying) {
		save();
		broadcast({ ts: at, kind: "notice", source: "gateway", item, unread: unreadCount() });
	}
	return item;
}

const clean = (raw: unknown) => {
	const p = parseTone(stripHandoff(String(raw ?? "")));
	return { tone: (p.tone ?? "") as NoticeTone, text: p.text.trim().slice(0, TEXT_MAX) };
};

// Gateway jobs that post on their own get their own title; everything else is a plain worklog / alert entry.
function systemTitle(text: string, fallback: string): string {
	if (/^토큰 (누수 )?점검/.test(text)) return "토큰 점검";
	if (text.includes("야간 정리")) return "야간 정리";
	return fallback;
}

function fromOutbox(e: HubEvent): void {
	const target = String(e.target ?? "");
	const key = typeof e.update_key === "string" && e.update_key ? e.update_key : undefined;
	if (key === "progress") return;
	const { tone, text } = clean(e.text);
	if (!text) return;
	const restart = RESTART_PREFIX.test(text);
	const by = authorOf(e);
	const recovered = e.source === "gateway" ? /^\[([^\]\n]+)\]\s*(?:recovered\b|다시 정상이에요)/.exec(text)?.[1] : undefined;
	if (recovered) watchRecovered(recovered, e.ts);
	if (target === "worklog" || (restart && target === "web" && e.source === "gateway")) {
		if (key?.startsWith("lane:")) {
			const name = key.slice(5);
			return void upsert({ kind: "result", tone, title: laneTitle(name), text, open: key, key, ...(by ? { by } : {}), at: e.ts });
		}
		return void upsert({ kind: "worklog", tone, title: systemTitle(text, "작업 기록"), text, open: target === "worklog" ? "worklog" : "main", key, read: restart, at: e.ts });
	}
	if (target === "alert") return void upsert({ kind: "alert", tone, title: systemTitle(text, "알림"), text, open: "alert", key, ...(by ? { by } : {}), ...(refOf(e) ? { ref: refOf(e) } : {}), read: Boolean(recovered), at: e.ts });
	const watch = /^ch:\d+$/.test(target) && e.source === "gateway" ? /^\[([^\]\n]+)\]\s*/.exec(text) : null;
	if (watch) upsert({ kind: "watch", tone, title: watch[1]!, text: text.slice(watch[0].length) || text, open: target, key, read: Boolean(recovered), at: e.ts });
}

function fromInbox(e: HubEvent): void {
	if (e.kind === "lane_report") {
		const name = String(e.lane ?? "");
		const { tone, text } = clean(e.text);
		if (!name || !text || !LOUD.has(tone)) return;
		return void upsert({ kind: "result", tone, title: laneTitle(name), text, open: `lane:${name}`, key: `lane:${name}`, by: `lane:${name}`, at: e.ts });
	}
	if (e.kind === "watch") {
		const recovered = /^recovered\b/.test(String(e.reason ?? ""));
		const name = String(e.watch ?? "");
		const label = humanLabel(typeof e.label === "string" && e.label.trim() ? e.label : name, "");
		if (recovered) watchRecovered(name, e.ts, label);
		// The wake event itself is a message of the 알림 conversation (hub/events.ts eventTarget); the bell gets nothing extra when the
		// orchestrator, which reports in the channel, is up.
		if (e.to === "orchestrator" && Array.isArray(e.channels) && e.channels.length && orchestratorUp()) return;
		const text = clean(watchLine(label || "모니터링", String(e.reason ?? ""), String(e.text ?? ""), { raw: false })).text;
		return void upsert({ kind: "watch", tone: "", title: label || "모니터링", text: text || "알림이 왔어요", open: "alert", read: recovered, at: e.ts });
	}
	if (e.kind === "schedule") {
		const ch = typeof e.channel === "string" && /^ch:\d+$/.test(e.channel) ? e.channel : "main";
		upsert({ kind: "watch", tone: "", title: "예약", text: clean(scheduleLine(String(e.text ?? ""), { raw: false })).text, open: ch, at: e.ts });
	}
}

function feed(e: HubEvent): void {
	try {
		resolveByReport(e);
		if (e.kind === "lane_start") noteLaunch(e);
		else if (e.kind === "out") {
			fromOutbox(e);
			const ds = decisionsOf(e);
			for (const d of ds) putDecision(d, e.ts);
			// A decision message makes only its decision item; any other answer may become the conversation's unread message item
			// (not the reply to a button answer: answerReply).
			if (!answerReply(e) && !ds.length) fromAnswer(e);
		} else if (e.kind === "message" || e.kind === "lane_message") {
			answerReply(e);
			ownerReplied(e);
		}
		else {
			fromInbox(e);
			for (const d of decisionsOf(e)) putDecision(d, e.ts);
		}
	} catch (err) {
		log(`notice feed failed: ${err}`);
	}
}

/* ---------- unread answers: one bell item per conversation the owner is not looking at ---------- */
const VIEW_MS = 60_000;
const MESSAGE_PREVIEW = 120;
const CONV_RE = /^(?:main|alert|worklog|lane:[\w.-]+|ch:\d+)$/;
// What each open web page reports it is showing (id -> conversation, "" = hidden / not a chat). A report older than VIEW_MS no longer counts.
const viewers = new Map<string, { conv: string; at: number }>();
let convNameOf: (conv: string) => string | undefined = () => undefined;
export const setConvNameResolver = (fn: (conv: string) => string | undefined) => void (convNameOf = fn);
export function isViewing(conv: string, nowMs = Date.now()): boolean {
	for (const [id, v] of viewers) {
		if (nowMs - v.at >= VIEW_MS) viewers.delete(id);
		else if (v.conv === conv) return true;
	}
	return false;
}
// POST /api/viewing: the page says which conversation is on screen ("" when hidden). Looking at a conversation reads its message item.
export function setViewing(id: unknown, conv: unknown, nowMs = Date.now()): { ok: boolean; unread?: number } {
	const who = typeof id === "string" ? id.slice(0, 64) : "";
	if (!who || typeof conv !== "string" || (conv !== "" && !CONV_RE.test(conv))) return { ok: false };
	viewers.set(who, { conv, at: nowMs });
	const item = conv ? items.find(n => n.key === `msg:${conv}`) : undefined;
	if (item && !item.read) markNoticesRead({ ids: [item.id] });
	// Items of this conversation that the read position already covers (read on another device, or before this fix) leave the bell too.
	const seen = conv ? readOf(conv) : null;
	if (seen) readConversationNotices(conv, seen);
	return { ok: true, unread: unreadCount() };
}

// The reply to a choice-button answer is a quiet reply: no push, no corner toast, no message item. A button answer is the owner's message
// carrying `picks` or `decision` (hub/intake.ts sendWeb); the first answer after it in that conversation is its reply. A reply that asks or
// fails still speaks up, and so does a session's [done] (its result item). Safe to call twice for one event (push and notices both do).
const QUIET_MS = 10 * 60_000;
const awaitingReply = new Map<string, number>();
const quietReplies = new Set<string>();
export function answerReply(e: HubEvent): boolean {
	if (e.kind === "message" || e.kind === "lane_message") {
		const button = (Array.isArray(e.picks) && e.picks.length > 0) || typeof e.decision === "string";
		const conv = eventTarget(e) ?? "main";
		if (button && !replaying) awaitingReply.set(conv, Date.parse(e.ts) || Date.now());
		else awaitingReply.delete(conv);
		return false;
	}
	if (e.kind !== "out" && e.kind !== "lane_report") return false;
	if (quietReplies.has(e.ts)) return true;
	const src = String(e.source ?? "");
	const lane = src.startsWith("lane:") || e.kind === "lane_report";
	if (e.update_key || e.target === "alert" || e.target === "worklog" || (src !== "orchestrator" && !lane)) return false;
	const conv = eventTarget(e) ?? "main", since = awaitingReply.get(conv);
	if (since === undefined) return false;
	awaitingReply.delete(conv);
	const { tone } = clean(e.text);
	if (Date.parse(e.ts) - since > QUIET_MS || tone === "ask" || tone === "fail" || (lane && tone === "done")) return false;
	quietReplies.add(e.ts);
	if (quietReplies.size > 200) quietReplies.delete(quietReplies.values().next().value!);
	return true;
}

// An answer of the assistant or a session (not progress, not a keepalive "ok" / "-") in a conversation nobody is viewing: that
// conversation's one "message" item, rewritten by each later answer. A session's [done] / [fail] already has its result item.
function fromAnswer(e: HubEvent): void {
	if (replaying) return;
	const src = String(e.source ?? "");
	const lane = src.startsWith("lane:");
	if (e.update_key || e.target === "worklog" || e.target === "alert" || (src !== "orchestrator" && !lane)) return;
	const { tone, text } = clean(e.text);
	if (!text || /^(?:ok|-)$/i.test(text) || (lane && LOUD.has(tone))) return;
	const conv = eventTarget(e) ?? "main";
	if (isViewing(conv)) return;
	const preview = text.replace(/\s+/g, " ");
	const title = conv.startsWith("lane:") ? laneTitle(conv.slice(5)) : conv === "alert" ? "알림" : conv === "worklog" ? "작업 기록" : convNameOf(conv) || (conv === "main" ? "대화" : conv);
	upsert({ kind: "message", tone: "", title, text: preview.length > MESSAGE_PREVIEW ? `${preview.slice(0, MESSAGE_PREVIEW - 1)}…` : preview, open: conv, key: `msg:${conv}`, unread: true, src: conv, at: e.ts });
}

/* ---------- decisions: every question that waits on the owner is its own pinned notice ---------- */
// Created from an [ask] of the assistant or a session (one notice per "결정:" block of the message, one for a plain question), a
// login request (authRequested) or a budget question. Stays unread and cannot be dismissed until answered: by a button
// (answerDecision), by the owner replying in that chat or session (ownerReplied), or by the login request finishing.
const REASK_MS = 30 * 60_000;
const decisionHooks: Array<(n: Notice) => void> = [];
// Called once for every new (or re-asked) open decision, never while the old history is replayed.
export const onDecision = (fn: (n: Notice) => void): void => void decisionHooks.push(fn);

const BUDGET_OPTIONS: DecisionOpt[] = [
	{ n: 1, label: "네, 진행해 주세요", desc: "", rec: true, say: "진행해" },
	{ n: 2, label: "아니요, 하지 마세요", desc: "", rec: false, say: "하지 마" },
];
const hashOf = (s: string) => {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	return h.toString(36);
};
const firstLine = (text: string) => {
	const l = text.split("\n").map(s => s.replace(/^\s*\[[^\]\n]{1,10}\][ \t]*/, "").replace(/[*_`#>]/g, "").trim()).find(Boolean) ?? "";
	return l.length > 80 ? `${l.slice(0, 79)}…` : l;
};

type Draft = { title: string; detail: string; options: DecisionOpt[]; to: string; replyTo: string; group: number; key: string; by?: string; ref?: string; draft?: DraftApproval };

// The decisions an event asks of the owner: an [ask] from the assistant or a session, or any message holding a choice block
// (2+ options), split by its decision blocks.
export function decisionsOf(e: HubEvent): Draft[] {
	if (e.kind === "out") {
		const src = String(e.source ?? "");
		// The gateway's own alert (a token audit, a failed update) may ask a question too; its other posts never do.
		if (e.update_key || e.target === "worklog" || (src !== "orchestrator" && !src.startsWith("lane:") && !(src === "gateway" && e.target === "alert"))) return [];
	} else if (e.kind !== "lane_report") return [];
	const p = parseTone(stripHandoff(String(e.text ?? "")));
	const body = p.text.trim();
	const pc = parseDecisions(body);
	// An [ask] is a decision; so is any other message (a [done] answer, a lane report, no marker) holding a "결정:" choice block with 2+
	// options. A plain numbered list without "결정:" is not. The gateway's own alert keeps its older, looser rule.
	const gatewayAlert = e.kind === "out" && e.source === "gateway" && e.target === "alert";
	if (!body || (p.tone !== "ask" && !hasDecisionHead(pc.blocks) && !(gatewayAlert && pc.blocks.length))) return [];
	const to = eventTarget(e) ?? "main";
	const detail = body.slice(0, TEXT_MAX);
	const line = firstLine(body);
	const sendDraft = pc.blocks.length === 1 ? parseDraftApproval(body) : undefined;
	const by = authorOf(e), ref = refOf(e);
	const draft = (title: string, options: DecisionOpt[], group: number, idx: number): Draft => ({ title, detail, options, to, replyTo: e.ts, group, ...(by ? { by } : {}), ...(ref ? { ref } : {}), key: `dec:${to}:${hashOf(`${idx}|${title}|${options.map(o => o.label).join("/")}${sendDraft ? `|${sendDraft.to}|${sendDraft.subject ?? ""}|${sendDraft.body}` : ""}`)}`, ...(sendDraft ? { draft: sendDraft } : {}) });
	if (!pc.blocks.length) return [draft(line || "답변이 필요해요", to.startsWith("lane:") && /\/budget-ok/.test(body) ? BUDGET_OPTIONS : [], 1, 0)];
	const many = pc.blocks.length > 1;
	return pc.blocks.map((b, i) => draft(b.title || (many ? `결정 ${i + 1}` : pc.question || line), b.options.map(o => ({ ...o })), pc.blocks.length, i));
}

// A repeat of an ask that is already answered or ignored makes its twin item before putDecision sees it: that twin ends the same way.
function closeRepeat(old: Notice, at: string): void {
	const hit = items.filter(n => n.at === at && twinOf(old, n) && !n.read);
	for (const n of hit) {
		n.read = true;
		if (old.ignored) n.ignored = old.ignored;
	}
	if (hit.length && !replaying) {
		save();
		for (const n of hit) broadcast({ ts: at, kind: "notice", source: "gateway", item: n, unread: unreadCount() });
	}
}

function putDecision(d: { key: string; title: string; detail: string; to: string; open?: string; options: DecisionOpt[]; group: number; replyTo?: string; draft?: DraftApproval; by?: string; ref?: string }, at: string): void {
	const old = items.find(n => n.key === d.key);
	if (old?.decision) {
		// The same ask can arrive twice (a session's mid-turn line and its turn-end report): one notice, and an answered one stays answered.
		if (old.decision.state === "open") return;
		if (Date.parse(at) - Date.parse(old.ignored ?? old.decision.answered_at ?? "") < REASK_MS) return void closeRepeat(old, at);
	}
	const open = d.open ?? d.to;
	const decision: Decision = { options: d.options, to: d.to, ...(d.replyTo ? { reply_to: d.replyTo } : {}), group: d.group, state: "open", ...(d.draft ? { draft: d.draft } : {}) };
	let item: Notice;
	if (old) {
		Object.assign(old, { kind: "decision", tone: "ask", title: d.title, text: d.detail, open, src: open, at, updated: at, read: false, decision, ...(d.by ? { by: d.by } : {}), ...(d.ref ? { ref: d.ref } : {}) });
		delete old.dismissed;
		delete old.ignored;
		item = old;
	} else {
		item = { id: randomBytes(4).toString("hex"), ts: at, updated: at, kind: "decision", tone: "ask", title: d.title, text: d.detail, open, src: open, at, key: d.key, ...(d.by ? { by: d.by } : {}), ...(d.ref ? { ref: d.ref } : {}), read: false, decision };
		items.push(item);
		trim();
	}
	if (replaying) return;
	save();
	broadcast({ ts: at, kind: "notice", source: "gateway", item, unread: unreadCount() });
	for (const fn of decisionHooks) fn(item);
}

// The label a button answer shows (the sent text may be longer): set while its message is on the way, since that message settles the notice too.
const sending = new Map<string, string>();
function settleDecision(item: Notice, answer: string, at = now(), resolved = false): void {
	const d = item.decision;
	if (!d || d.state !== "open") return;
	d.state = "answered";
	// A resolved matter was not answered: it is marked resolved and carries no answer text.
	if (resolved) d.resolved = true;
	else d.answer = (sending.get(item.id) ?? answer).slice(0, 200);
	d.answered_at = at;
	item.read = true;
	item.updated = at;
	// The notices made by the same asking event (the alert and message twins) are settled with it.
	if (d.reply_to !== undefined && !items.some(n => n !== item && isOpenDecision(n) && n.decision!.reply_to === d.reply_to))
		readIds(items.filter(n => twinOf(item, n) && !n.read && !n.dismissed).map(n => n.id));
	if (replaying) return;
	save();
	broadcast({ ts: at, kind: "notice", source: "gateway", item, unread: unreadCount() });
}

// The owner wrote in a chat or session: every open decision there is answered by it, unless the message names its decision
// (a button answer carries `decision`), which then settles only that one.
function ownerReplied(e: HubEvent): void {
	const to = eventTarget(e) ?? "main";
	const id = typeof e.decision === "string" ? e.decision : "";
	const text = String(e.text ?? "").trim();
	for (const i of items) if (isOpenDecision(i) && !i.decision!.to.startsWith("auth:") && (id ? i.id === id : i.decision!.to === to)) settleDecision(i, text, e.ts);
}

export type DecisionSend = (a: { to: string; text: string; replyTo?: string; notice: string; action?: string; picks?: { q: string; n: number; label: string; note?: string }[] }) => Promise<void>;
// A button of a decision: `n` is the option's number. The answer goes to the asking chat / session (or the login request) through `send`; only
// when that worked is the notice answered.
export async function answerDecision(id: unknown, body: { n?: unknown; note?: unknown }, send: DecisionSend): Promise<{ status: number; body: Record<string, unknown> }> {
	const item = items.find(i => i.id === String(id));
	const d = item?.decision;
	if (!item || !d) return { status: 404, body: { error: "unknown decision" } };
	if (d.state !== "open") return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	const o = d.options.find(x => x.n === Number(body.n));
	if (!o || o.action === "form") return { status: 400, body: { error: "unknown option" } };
	const label = `${o.n}) ${o.label}`;
	// 고치기 on a draft carries what to change and needs it. Elsewhere an option that needs detail (choices.ts detailOf: 안 됨 …) needs the owner's written reason too;
	// a button with its own `say` / `action` (login request, fixed yes / no) never does.
	const draftEdit = !!d.draft && draftActionOf(o.label) === "edit";
	const asksDetail = !d.draft && !o.say && !o.action && detailOf(o);
	const note = draftEdit || asksDetail ? String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500) : "";
	if (draftEdit && !note) return { status: 400, body: { error: "무엇을 고칠지 적어 주세요" } };
	if (asksDetail && !note) return { status: 400, body: { error: "내용을 적어 주세요" } };
	const text = (o.say ?? (d.group > 1 ? `${item.title}: ${label}` : label)) + (note ? ` - ${note}` : "");
	sending.set(item.id, label);
	try {
		// `picks` carries the question with the chosen option, so the agent gets the context even from another conversation (intake.ts decisionLines).
		await send({ to: d.to, text, notice: item.id, ...(d.to.startsWith("auth:") ? {} : { picks: [{ q: item.title, n: o.n, label: o.label, ...(asksDetail ? { note } : {}) }] }), ...(d.reply_to ? { replyTo: d.reply_to } : {}), ...(o.action ? { action: o.action } : {}) });
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
const AUTH_DONE_WORDS: Record<string, string> = { approved: "승인했어요", entered: "입력했어요", cancelled: "취소했어요", timeout: "시간이 지나 닫혔어요" };
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
// A decision with options is the owner's to pick (a phone check, an approval): signals 1-3 never touch it; only the owner's answer / x, or the
// bot naming that notice (ids / match in signal 4). A resolved decision is marked `resolved` and holds no answer text.

const refOf = (e: HubEvent): string | undefined => (typeof e.reply_to === "string" && e.reply_to ? e.reply_to : undefined);
const hasChoice = (i: Notice) => !!i.decision && i.decision.options.length > 0;

function authorOf(e: HubEvent): string | undefined {
	if (e.kind === "lane_report") return typeof e.lane === "string" && e.lane ? `lane:${e.lane}` : undefined;
	if (e.kind !== "out") return undefined;
	const src = String(e.source ?? "");
	return src.startsWith("lane:") || src === "orchestrator" || src === "gateway" ? src : undefined;
}
// Older items carry no `by`: a session's question shows in its decision target or lane key.
const originOf = (i: Notice): string | undefined => i.by ?? (i.decision?.to.startsWith("lane:") ? i.decision.to : i.key?.startsWith("lane:") ? i.key : undefined);
const isAsking = (i: Notice) => !i.dismissed && !i.decision?.to.startsWith("auth:") && (isOpenDecision(i) || (i.tone === "ask" && !i.read));

function readIds(ids: string[]): void {
	if (!ids.length) return;
	if (!replaying) return void markNoticesRead({ ids }, true);
	for (const i of items) if (ids.includes(i.id) && !isOpenDecision(i)) i.read = true;
}

// Resolves every asking notice that `pick` accepts and that was raised before `at`. Returns how many it closed. Decisions with options (and
// their alert twins) are skipped unless `named`: the bot named that notice itself.
function resolveAsks(pick: (i: Notice) => boolean, at: string, named = false): number {
	const owned = new Set(items.filter(hasChoice).map(d => d.decision!.reply_to));
	const hit = items.filter(i => isAsking(i) && (i.at ?? i.ts) < at && pick(i) && (named || !(hasChoice(i) || (!i.decision && owned.has(i.at)))));
	for (const i of hit) if (isOpenDecision(i)) settleDecision(i, "", at, true);
	readIds(hit.filter(i => !i.read).map(i => i.id));
	return hit.length;
}

// Signal 1: a session's [done] / [fail] closes what that session asked.
function resolveByReport(e: HubEvent): void {
	if ((e.kind !== "out" && e.kind !== "lane_report") || typeof e.ts !== "string") return;
	const { tone } = clean(e.text);
	if (tone !== "done" && tone !== "fail") return;
	const key = typeof e.update_key === "string" && e.update_key.startsWith("lane:") ? e.update_key : "";
	const who = key || (authorOf(e)?.startsWith("lane:") ? authorOf(e)! : "");
	if (who) resolveAsks(i => originOf(i) === who, e.ts);
}

// Signal 2: an orchestrator turn ends with [done] / [fail] for the request `ref` (the owner message it answers). That closes an ask of the
// orchestrator about the same request, but only one raised in an earlier turn: anything asked in this very turn (even mid-turn, with the same
// reply_to) is still waiting on the owner, and an answer for a different or unknown request closes nothing.
let orchTurnFrom: string | undefined;
export const orchestratorTurnStarted = (at = now()): void => void (orchTurnFrom = at);
export function orchestratorAnswered(text: string, ref?: string, at = now()): number {
	const from = orchTurnFrom;
	const { tone } = clean(text);
	if (!from || !ref || (tone !== "done" && tone !== "fail")) return 0;
	return resolveAsks(i => i.by === "orchestrator" && i.ref === ref && (i.at ?? i.ts) < from, at);
}

// Signal 3: a watch that failed passes again. Its failure alert (and the choice it carried) is over; the recovery note itself is born read.
function watchRecovered(name: string, at: string, label = name): void {
	if (!name) return;
	const isTitle = (t: string) => t === name || t === label;
	// Only the gateway's own failure alert for that watch (it may carry a cause-check choice that a pass makes moot), never another author's question.
	resolveAsks(i => (i.by === "gateway" && i.text.startsWith(`[${name}]`)) || (i.kind === "watch" && isTitle(i.title)), at, true);
	readIds(items.filter(i => !i.read && !i.dismissed && i.ts < at && ((i.kind === "watch" && isTitle(i.title)) || (i.kind === "alert" && i.tone !== "ask" && i.text.startsWith(`[${name}]`)))).map(i => i.id));
}

// Signal 4: the bot resolves notices itself. `ids` picks exact notices, `match` every asking notice whose title or text holds that text, `conv` every
// one asked in that conversation, `all` every open ask. A login request keeps its own end (authSettled).
export function resolveNotices(sel: { ids?: unknown; match?: unknown; conv?: unknown; all?: unknown }): { resolved: number; unread: number } {
	const ids = Array.isArray(sel.ids) ? new Set(sel.ids.map(String)) : undefined;
	const match = typeof sel.match === "string" && sel.match.trim() ? sel.match.trim().toLowerCase() : undefined;
	const conv = typeof sel.conv === "string" && sel.conv ? sel.conv : undefined;
	const pick = (i: Notice) => (ids ? ids.has(i.id) : match ? `${i.title}\n${i.text}`.toLowerCase().includes(match) : conv ? (i.src ?? i.open) === conv || i.decision?.to === conv : sel.all === true);
	// ids / match name notices; conv / all do not, so a decision with options is left for the owner there.
	return { resolved: resolveAsks(pick, now(), !!(ids || match)), unread: unreadCount() };
}

onEmit(feed);

export const BACKFILL_DAYS = 7;
const DAY_MS = 86_400_000;

// One-time fill of an empty store from what the hub already persisted (outbox.jsonl / inbox.jsonl of the last BACKFILL_DAYS days),
// through the same mapping as the live feed: worklog / alert / watch / schedule posts and lane results (one item per lane key, the
// latest). Items older than 24 h come in read, newer ones unread. Idempotent: once notices.json holds anything it does nothing.
// Call it once at startup, after setLaneTitleResolver and before anything posts. Returns the number of items created.
export function backfillNotices(nowMs = Date.now()): number {
	if (items.length) return 0;
	const since = nowMs - BACKFILL_DAYS * DAY_MS;
	const events: HubEvent[] = [];
	for (const file of [paths.outbox, paths.inbox]) {
		if (!existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			try {
				const e = JSON.parse(line) as HubEvent;
				if (Date.parse(e.ts) >= since) events.push(e);
			} catch {
				continue;
			}
		}
	}
	events.sort((a, b) => a.ts.localeCompare(b.ts));
	replaying = true;
	try {
		for (const e of events) feed(e);
	} finally {
		replaying = false;
	}
	// A question older than a day that nobody answered in the replayed history is no longer waiting.
	for (const i of items) if (isOpenDecision(i) && Date.parse(i.updated) < nowMs - DAY_MS) settleDecision(i, "", i.updated, true);
	for (const i of items) if (!isOpenDecision(i) && Date.parse(i.updated) < nowMs - DAY_MS) i.read = true;
	if (items.length) save();
	log(`notices backfilled: ${items.length} items from ${events.length} persisted events`);
	return items.length;
}

// A session's work was checked by the orchestrator: its result item turns unread "done" and, once, a compact card goes into
// the main chat (a [done] that is only reported, not yet verified, stays in the bell).
export function laneVerified(name: string, fallbackText: string): void {
	const key = `lane:${name}`;
	const title = laneTitle(name);
	const prior = items.find(n => n.key === key);
	const text = ((prior?.tone === "done" ? prior.text : clean(fallbackText).text) || "확인을 마쳤어요").slice(0, 600);
	// The notice points at the compact card in the main chat, which carries the same ts.
	const at = now();
	resolveAsks(i => originOf(i) === key, at);
	upsert({ kind: "result", tone: "done", title, text, open: key, key, unread: true, src: "main", at });
	emit("outbox", { ts: at, kind: "result", source: "gateway", target: "web", session: name, title, tone: "done", verified: true, text: summary(text), open: key });
}

// The daily self-update check found a new dotz version: one fixed-key item in the bell (a later check updates it in place and
// turns it unread again), opening 설정 → 업데이트.
export const UPDATE_NOTICE_KEY = "self-update";
export function updateAvailable(text: string): void {
	upsert({ kind: "alert", tone: "", title: "dotz 새 버전", text: clean(text).text, open: "settings", key: UPDATE_NOTICE_KEY, unread: true });
}

// The update was applied or the checkout is current again: the item stays in the list but is read.
export function updateResolved(): void {
	const item = items.find(n => n.key === UPDATE_NOTICE_KEY);
	if (item) markNoticesRead({ ids: [item.id] });
}

// First three meaningful lines (no blank lines, rules or fences).
export function summary(text: string): string {
	return text
		.split("\n")
		.map(l => l.trim())
		.filter(l => l && !/^(?:[-*_=]{3,}|```.*)$/.test(l))
		.slice(0, 3)
		.map(l => (l.length > 160 ? `${l.slice(0, 159)}…` : l))
		.join("\n");
}

// A watch notice stored before labels and Korean reasons: its title is the watch name and its text starts with the raw reason.
function readable(n: Notice): Notice {
	if (n.kind !== "watch") return n;
	const title = watchLabelOf(n.title);
	const [first = "", ...rest] = n.text.split("\n");
	const text = watchReasonKo(first) !== first ? watchLine(title, first, rest.join("\n"), { raw: false }) : n.text;
	return title === n.title && text === n.text ? n : { ...n, title, text };
}

// Unread first, then the most recently updated.
export function listNotices(limit = 100): { items: Notice[]; unread: number } {
	const n = Math.max(1, Math.min(Math.floor(limit) || 100, NOTICE_CAP));
	const shown = items.filter(i => !i.dismissed);
	const order = new Map(shown.map((i, idx) => [i, idx]));
	const sorted = [...shown].sort((a, b) => Number(isOpenDecision(b)) - Number(isOpenDecision(a)) || Number(a.read) - Number(b.read) || b.updated.localeCompare(a.updated) || order.get(b)! - order.get(a)!);
	return { items: sorted.slice(0, n).map(readable), unread: unreadCount() };
}

// Swipe / x in the bell: read and gone from every list and count, on every open tab (a notice_dismiss frame).
export function dismissNotice(id: unknown): { ok: boolean; held?: boolean; unread: number } {
	const item = items.find(i => i.id === String(id));
	if (!item) return { ok: false, unread: unreadCount() };
	// A question that still waits on the owner cannot be swiped away.
	if (isOpenDecision(item)) return { ok: false, held: true, unread: unreadCount() };
	if (!item.dismissed) {
		item.dismissed = true;
		item.read = true;
		save();
		broadcast({ ts: now(), kind: "notice_dismiss", source: "gateway", id: item.id, unread: unreadCount() });
	}
	return { ok: true, unread: unreadCount() };
}

// The owner read a conversation up to `upTo`: every bell item whose source message lives there (and the 알림 / 작업 기록 items of
// those two conversations) up to that point is read too (an open decision stays open until answered).
export function readConversationNotices(conv: string, upTo: string): void {
	const ids = items.filter(i => !i.read && !i.dismissed && (i.kind === conv || (i.src ?? i.open) === conv) && (i.at ?? i.ts) <= upTo).map(i => i.id);
	if (ids.length) markNoticesRead({ ids });
}

// `force` is for the hub's own closing paths (an answer settled the ask, a resolving signal): the request body can never set it, so a client's
// view / "read all" leaves every item that needsAnswer unread. The frame always names the ids that were read (never "all"), so clients agree.
export function markNoticesRead(sel: { ids?: unknown; all?: unknown }, force = false): { unread: number } {
	const ids = Array.isArray(sel.ids) ? new Set(sel.ids.map(String)) : new Set<string>();
	const all = sel.all === true;
	const hit = items.filter(i => !i.read && !i.dismissed && !(force ? isOpenDecision(i) : needsAnswer(i)) && (all || ids.has(i.id)));
	if (hit.length) {
		for (const i of hit) i.read = true;
		save();
		broadcast({ ts: now(), kind: "notice_read", source: "gateway", ids: hit.map(i => i.id), unread: unreadCount() });
	}
	return { unread: unreadCount() };
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

function announce(group: Notice[], at: string): void {
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
		if (n.decision?.state === "ignored") n.decision.state = "open";
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
		delete d.answer;
		delete d.answered_at;
	}
	if (hit.length) announce(hit, at);
	return { reopened: hit.map(i => i.id), unread: unreadCount() };
}
