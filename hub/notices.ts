import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log, now, paths, writeAtomic } from "./config.ts";
import { type DecisionOption, parseDecisions } from "./choices.ts";
import { broadcast, emit, eventTarget, type HubEvent, onEmit } from "./events.ts";
import { parseTone, stripHandoff } from "./tone.ts";

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
	read: boolean;
	// Swiped away / x in the bell: kept (so a session's next progress line does not bring it back) but never listed or counted.
	dismissed?: boolean;
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
	state: "open" | "answered";
	answer?: string;
	answered_at?: string;
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

type Input = { kind: NoticeKind; tone: NoticeTone; title: string; text: string; open: string; key?: string; read?: boolean; unread?: boolean; src?: string; at?: string };

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
		if (i.read) old.read = true;
		else if (reopened) {
			old.read = false;
			delete old.dismissed;
		}
		item = old;
	} else {
		item = { id: randomBytes(4).toString("hex"), ts: at, updated: at, kind: i.kind, tone: i.tone, title: i.title, text: i.text, open: i.open, src: i.src ?? i.open, at, ...(i.key ? { key: i.key } : {}), read: i.read === true };
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
	if (target === "worklog" || (restart && target === "web" && e.source === "gateway")) {
		if (key?.startsWith("lane:")) {
			const name = key.slice(5);
			return void upsert({ kind: "result", tone, title: laneTitle(name), text, open: key, key, at: e.ts });
		}
		return void upsert({ kind: "worklog", tone, title: systemTitle(text, "작업 기록"), text, open: "main", key, read: restart, at: e.ts });
	}
	if (target === "alert") return void upsert({ kind: "alert", tone, title: systemTitle(text, "알림"), text, open: "main", key, at: e.ts });
	const watch = /^ch:\d+$/.test(target) && e.source === "gateway" ? /^\[([^\]\n]+)\]\s*/.exec(text) : null;
	if (watch) upsert({ kind: "watch", tone, title: watch[1]!, text: text.slice(watch[0].length) || text, open: target, key, at: e.ts });
}

function fromInbox(e: HubEvent): void {
	if (e.kind === "lane_report") {
		const name = String(e.lane ?? "");
		const { tone, text } = clean(e.text);
		if (!name || !text || !LOUD.has(tone)) return;
		return void upsert({ kind: "result", tone, title: laneTitle(name), text, open: `lane:${name}`, key: `lane:${name}`, at: e.ts });
	}
	if (e.kind === "watch") {
		const ch = Array.isArray(e.channels) ? e.channels[0] : undefined;
		const body = [e.reason, e.text].filter(v => typeof v === "string" && v.trim()).join("\n");
		return void upsert({ kind: "watch", tone: "", title: String(e.watch ?? "감시"), text: clean(body).text || "알림이 왔어요", open: ch ? `ch:${ch}` : "main", at: e.ts });
	}
	if (e.kind === "schedule") {
		const ch = typeof e.channel === "string" && /^ch:\d+$/.test(e.channel) ? e.channel : "main";
		upsert({ kind: "watch", tone: "", title: "예약", text: clean(e.text).text || "예약한 일이 시작됐어요", open: ch, at: e.ts });
	}
}

function feed(e: HubEvent): void {
	try {
		if (e.kind === "lane_start") noteLaunch(e);
		else if (e.kind === "out") {
			fromOutbox(e);
			const ds = decisionsOf(e);
			for (const d of ds) putDecision(d, e.ts);
			// A decision message makes only its decision item; any other answer may become the conversation's unread message item.
			if (!ds.length) fromAnswer(e);
		} else if (e.kind === "message" || e.kind === "lane_message") ownerReplied(e);
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
const CONV_RE = /^(?:main|lane:[\w.-]+|ch:\d+)$/;
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
	return { ok: true, unread: item && !item.read ? markNoticesRead({ ids: [item.id] }).unread : unreadCount() };
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
	const title = conv.startsWith("lane:") ? laneTitle(conv.slice(5)) : convNameOf(conv) || (conv === "main" ? "대화" : conv);
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

type Draft = { title: string; detail: string; options: DecisionOpt[]; to: string; replyTo: string; group: number; key: string };

// The decisions an event asks of the owner: an [ask] from the assistant or a session, or any message holding a choice block
// (2+ options), split by its decision blocks.
export function decisionsOf(e: HubEvent): Draft[] {
	if (e.kind === "out") {
		const src = String(e.source ?? "");
		if (e.update_key || e.target === "worklog" || (src !== "orchestrator" && !src.startsWith("lane:"))) return [];
	} else if (e.kind !== "lane_report") return [];
	const p = parseTone(stripHandoff(String(e.text ?? "")));
	const body = p.text.trim();
	const pc = parseDecisions(body);
	if (!body || (p.tone !== "ask" && !pc.blocks.length)) return [];
	const to = eventTarget(e) ?? "main";
	const detail = body.slice(0, TEXT_MAX);
	const line = firstLine(body);
	const draft = (title: string, options: DecisionOpt[], group: number, idx: number): Draft => ({ title, detail, options, to, replyTo: e.ts, group, key: `dec:${to}:${hashOf(`${idx}|${title}|${options.map(o => o.label).join("/")}`)}` });
	if (!pc.blocks.length) return [draft(line || "답변이 필요해요", to.startsWith("lane:") && /\/budget-ok/.test(body) ? BUDGET_OPTIONS : [], 1, 0)];
	const many = pc.blocks.length > 1;
	return pc.blocks.map((b, i) => draft(b.title || (many ? `결정 ${i + 1}` : pc.question || line), b.options.map(o => ({ ...o })), pc.blocks.length, i));
}

function putDecision(d: { key: string; title: string; detail: string; to: string; open?: string; options: DecisionOpt[]; group: number; replyTo?: string }, at: string): void {
	const old = items.find(n => n.key === d.key);
	if (old?.decision) {
		// The same ask can arrive twice (a session's mid-turn line and its turn-end report): one notice, and an answered one stays answered.
		if (old.decision.state === "open") return;
		if (Date.parse(at) - Date.parse(old.decision.answered_at ?? "") < REASK_MS) return;
	}
	const open = d.open ?? d.to;
	const decision: Decision = { options: d.options, to: d.to, ...(d.replyTo ? { reply_to: d.replyTo } : {}), group: d.group, state: "open" };
	let item: Notice;
	if (old) {
		Object.assign(old, { kind: "decision", tone: "ask", title: d.title, text: d.detail, open, src: open, at, updated: at, read: false, decision });
		delete old.dismissed;
		item = old;
	} else {
		item = { id: randomBytes(4).toString("hex"), ts: at, updated: at, kind: "decision", tone: "ask", title: d.title, text: d.detail, open, src: open, at, key: d.key, read: false, decision };
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
function settleDecision(item: Notice, answer: string, at = now()): void {
	const d = item.decision;
	if (!d || d.state !== "open") return;
	d.state = "answered";
	d.answer = (sending.get(item.id) ?? answer).slice(0, 200);
	d.answered_at = at;
	item.read = true;
	item.updated = at;
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

export type DecisionSend = (a: { to: string; text: string; replyTo?: string; notice: string; action?: string }) => Promise<void>;
// A button of a decision: `n` is the option's number. The answer goes to the asking chat / session (or the login request) through `send`; only
// when that worked is the notice answered.
export async function answerDecision(id: unknown, body: { n?: unknown }, send: DecisionSend): Promise<{ status: number; body: Record<string, unknown> }> {
	const item = items.find(i => i.id === String(id));
	const d = item?.decision;
	if (!item || !d) return { status: 404, body: { error: "unknown decision" } };
	if (d.state !== "open") return { status: 200, body: { ok: true, already: true, item, unread: unreadCount() } };
	const o = d.options.find(x => x.n === Number(body.n));
	if (!o || o.action === "form") return { status: 400, body: { error: "unknown option" } };
	const label = `${o.n}) ${o.label}`;
	const text = o.say ?? (d.group > 1 ? `${item.title}: ${label}` : label);
	sending.set(item.id, label);
	try {
		await send({ to: d.to, text, notice: item.id, ...(d.reply_to ? { replyTo: d.reply_to } : {}), ...(o.action ? { action: o.action } : {}) });
		settleDecision(item, label);
	} catch (err) {
		return { status: 409, body: { error: (err as Error).message } };
	} finally {
		sending.delete(item.id);
	}
	return { status: 200, body: { ok: true, item, unread: unreadCount() } };
}

// A login request (dotz_auth) waits on the owner: approve / cancel here, the form for typed values stays the page's own.
export function authRequested(a: { id: string; kind: "secret" | "otp" | "approve"; title: string; site: string; purpose: string }): void {
	const first: DecisionOpt = a.kind === "approve" ? { n: 1, label: "승인", desc: "", rec: true, action: "approve" } : { n: 1, label: "입력하기", desc: "", rec: true, action: "form" };
	putDecision({ key: `auth:${a.id}`, title: a.title, detail: `${a.purpose}\n사이트: ${a.site}`.slice(0, TEXT_MAX), to: `auth:${a.id}`, open: "main", options: [first, { n: 2, label: "취소", desc: "", rec: false, action: "cancel" }], group: 1 }, now());
}
const AUTH_DONE_WORDS: Record<string, string> = { approved: "승인했어요", entered: "입력했어요", cancelled: "취소했어요", timeout: "시간이 지나 닫혔어요" };
export function authSettled(id: string, status: string): void {
	const item = items.find(i => i.key === `auth:${id}`);
	if (item) settleDecision(item, AUTH_DONE_WORDS[status] ?? "끝났어요");
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
	for (const i of items) if (isOpenDecision(i) && Date.parse(i.updated) < nowMs - DAY_MS) settleDecision(i, "지난 질문", i.updated);
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

// Unread first, then the most recently updated.
export function listNotices(limit = 100): { items: Notice[]; unread: number } {
	const n = Math.max(1, Math.min(Math.floor(limit) || 100, NOTICE_CAP));
	const shown = items.filter(i => !i.dismissed);
	const order = new Map(shown.map((i, idx) => [i, idx]));
	const sorted = [...shown].sort((a, b) => Number(isOpenDecision(b)) - Number(isOpenDecision(a)) || Number(a.read) - Number(b.read) || b.updated.localeCompare(a.updated) || order.get(b)! - order.get(a)!);
	return { items: sorted.slice(0, n), unread: unreadCount() };
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

export function markNoticesRead(sel: { ids?: unknown; all?: unknown }): { unread: number } {
	const ids = Array.isArray(sel.ids) ? new Set(sel.ids.map(String)) : new Set<string>();
	const all = sel.all === true;
	const hit = items.filter(i => !i.read && !i.dismissed && !isOpenDecision(i) && (all || ids.has(i.id)));
	if (hit.length) {
		for (const i of hit) i.read = true;
		save();
		broadcast({ ts: now(), kind: "notice_read", source: "gateway", ...(all ? { all: true } : { ids: hit.map(i => i.id) }), unread: unreadCount() });
	}
	return { unread: unreadCount() };
}
