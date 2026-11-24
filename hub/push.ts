// Web Push to the installed web app: VAPID keys made once in ~/.dotz/secrets/vapid.json (0600, never logged), the
// subscriptions with their per-kind toggles in ~/.dotz/push.json, and the rule that picks which hub events become a
// notification. A device whose page reported itself visible and focused in the last minute is skipped (no double alert).
import { peerFetch } from "./tailnet-fetch.ts";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, log, NAME, updateNotifyPush, writeAtomic } from "./config.ts";
import { UnreadableFileError } from "./json-update.ts";
import { classOfNotice, NOTICE_CLASSES, type NoticeClass, noticeClass } from "./notice-class.ts";
import { type KindItem, kindOf, NOTICE_KINDS, type NoticeKindName, pushTitle } from "./notice-kinds.ts";
import { clean, isOpenDecision, laterOn } from "./notices-rules.ts";
import { RUN_DECISION, taskRunOf } from "./notices-schedule.ts";
import { pushClasses, route } from "./notify-route.ts";
import { eventTarget, type HubEvent, onBroadcast, onEmit } from "./events.ts";
import { dropForLine, orchestratorOnlyAsk } from "./forline.ts";
import { quietAlert } from "./alert-gate.ts";
import { answerReply, confirmGroup, conversationTitle, decisionsOf, isViewing, laneNameKo, type Notice, onDecision, onHalfTime, onNoticeUnread, openDecisionNotices, setViewing, unreadCount } from "./notices.ts";
import { msg } from "./i18n.ts";
import { DECISION_HEAD, decisionText } from "./choices.ts";
import { doctorPreview } from "./doctor-text.ts";
import { dropIdNote, noticeKo, plainTable } from "./notice.ts";
import { type Found, knownComputers } from "./peers.ts";
import { isLater, parseTone, previewSource, stripMarkers } from "./tone.ts";
import { webText } from "./web-i18n.ts";
import { generateVapidKeys, sendPush, type Subscription, type VapidKeys } from "./webpush.ts";
import { json } from "./routes-util.ts";

// A notification's kind is its notice class (hub/notice-class.ts); whether it goes out is the owner's switch for that class (config.json notify.push)
// and, for news, the app's own switch (custom/apps.json <app>.push). `prefs` on a subscription are the per-device toggles of before; kept, not read.
export const PUSH_KINDS = NOTICE_CLASSES;
type PushKind = NoticeClass;
type Prefs = Record<string, boolean>;
// The kinds a computer that runs an older gateway relays, as classes.
const LEGACY_KINDS: Record<string, PushKind> = { answer: "conv", ask: "ask", lane: "result", usage: "alert", update: "news", watch: "news" };
// A general monitor's own 휴대폰 알림 switch (watches.json <watch>.push, hub/watch-settings.ts): main.ts installs the reader.
let watchPushOff: (name: string) => boolean = () => false;
export const setWatchPushOff = (fn: typeof watchPushOff): void => void (watchPushOff = fn);
export const classPushOn = (cls: PushKind, app?: string): boolean => route({ cls, ...(app ? { app } : {}) }).push;
// `app`: made by the installed app (the page runs standalone), the subscription a device is reached through when it has one.
// `did`: the device's id, shared by all its subscriptions on every computer (see fanOut).
type Stored = Subscription & { prefs: Prefs; ua?: string; at: string; app?: boolean; did?: string };
// `ts` is the id of the hub event the notification is about (its timestamp, the same key the web keeps its messages under): a tap
// makes sure that message is loaded before it jumps to it.
// `id` + `actions` (a decision notice): the page opens its detail sheet, and the service worker offers the first options as buttons that
// answer through POST /api/notices/<id>/answer.
// `nid`: the bell notice this notification came from, so a tap opens that notice's own screen and row (web/js/30-notices.js pushOpen).
type PushAction = { action: string; title: string };
// `pc`: a notice relayed from another computer (its origin); a tap opens the app, which switches to that computer (web/js/33-peers.js prFollow).
// `withdraw`: tags of notifications already handled; the service worker closes them (a "withdraw" push carries nothing else).
type PushMessage = { kind: PushKind | "test" | "withdraw"; title: string; body: string; url: string; tag?: string; app?: string; ts?: string; id?: string; nid?: string; actions?: PushAction[]; pc?: string; withdraw?: string[]; unread?: number };

const KEY_FILE = join(DATA_DIR, "secrets", "vapid.json");
const SUBS_FILE = join(DATA_DIR, "push.json");
const PRESENCE_MS = 60_000;
const DEDUPE_MS = 10 * 60_000;
const defaults = (): Prefs => ({});

let keys: VapidKeys | undefined;
function vapid(): VapidKeys {
	if (keys) return keys;
	if (existsSync(KEY_FILE)) return (keys = JSON.parse(readFileSync(KEY_FILE, "utf8")) as VapidKeys);
	mkdirSync(join(DATA_DIR, "secrets"), { recursive: true, mode: 0o700 });
	keys = generateVapidKeys();
	writeAtomic(KEY_FILE, `${JSON.stringify(keys)}\n`, 0o600);
	chmodSync(KEY_FILE, 0o600);
	log("push: VAPID keys created");
	return keys;
}

let subs: Stored[] = [];
try {
	if (existsSync(SUBS_FILE)) subs = (JSON.parse(readFileSync(SUBS_FILE, "utf8")) as Stored[]).filter(s => s?.endpoint && s.keys?.p256dh && s.keys.auth);
} catch (e) {
	log(`push: ${SUBS_FILE} unreadable, starting empty (${e})`);
}
const save = () => writeAtomic(SUBS_FILE, `${JSON.stringify(subs, null, 2)}\n`, 0o600);
// endpoint -> when its page last said it is visible and focused, and the conversation it shows ("" = not a chat). A presence without `conv` (an
// older page, or one forwarded from another computer whose page shows this computer's notices as toasts) quiets every push to that device.
const presence = new Map<string, { at: number; conv?: string }>();
const origin = (endpoint: string) => {
	try {
		return new URL(endpoint).host;
	} catch {
		return "?";
	}
};

let subject = () => "mailto:dotz@example.com";

const plain = (raw: string, max = 180) => {
	const t = dropForLine(raw);
	const s = dropIdNote(plainTable(noticeKo(stripMarkers(previewSource(t.split("\n").some(l => DECISION_HEAD.test(l)) ? decisionText(t, 0) || t : t)), { lane: laneNameKo }).replace(/```[\s\S]*?```/g, " ")).replace(/^\s*-#\s+/gm, "").replace(/[*`#>|]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "")).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Events notify for what the owner must see now (owner 2026-10-20: "완료/개입필요/중대한 경고에만"; 2026-11-01: "결과보고, 개입필요, 모니터링 인앱 새로운
// 알림 등 사용자가 바로 확인해야하는 것들은 알림 발송"). Routine progress ([run], a lane's start included) never notifies. Everything that lands unread in
// the bell also notifies once through noticePush below; the two paths share tags and notify() keeps one push per tag.
// - work done: a lane's [done]/[fail], and an answer on web that was marked [done]/[fail] or took LONG_TURN_MS or more
//   since the owner's message (the owner has likely left); a quick reply does not notify;
// - input needed: any [ask];
// - critical warning: the gateway's own alerts (limits, provider errors, memory) and alerts marked [fail] or worded as
//   something stopped or failed; replies in the alert channel and routine reports do not.
// Other progress edits (update_key) never notify; a lane's [ask]/[done]/[fail] line can arrive twice (mid-turn line and
// turn-end report), the caller dedupes.
export const LONG_TURN_MS = 2 * 60_000;
const CRITICAL = /멈췄|멈춤|막혔|실패|오류|끊겼|한도|위험|소진|확인이 필요|failed|error|stopped|limit/i;
export function classify(e: HubEvent, sinceOwner?: number): PushMessage | undefined {
	const m = classifyEvent(e, sinceOwner);
	if (!m) return undefined;
	const { conv, ...rest } = m;
	return { ...rest, ...addrOf({ conv, at: e.ts }) };
}
type Classified = Omit<PushMessage, "url"> & { conv: string };
function made(nk: NoticeKindName, item: KindItem, body: string): Classified {
	const row = NOTICE_KINDS[nk];
	return { kind: row.cls, title: pushTitle(nk, row.lead === "gateway" ? NAME : item.name), body, conv: row.open(item), tag: row.tag(item) };
}
function classifyEvent(e: HubEvent, sinceOwner?: number): Classified | undefined {
	const text = typeof e.text === "string" ? e.text : "";
	if (!text || isLater(text)) return undefined;
	const src = String(e.source ?? "");
	const { tone, text: rest } = parseTone(text);
	const key = typeof e.update_key === "string" ? e.update_key : "";
	// An edited line (a lane's worklog entry, progress): its [done]/[fail] arrives as a bell notice (noticePush), its [run] never notifies.
	if (key || e.hushed === true || (taskRunOf(e) && tone !== "ask" && tone !== "fail")) return undefined;
	const named = kindOf(e.nk);
	const lane = typeof e.lane === "string" ? e.lane : src.startsWith("lane:") ? src.slice(5) : undefined;
	if (lane && tone === "ask" && orchestratorOnlyAsk(rest)) return undefined;
	const pick = (cls: NoticeClass, guess: Partial<Record<NoticeClass, NoticeKindName>>): NoticeKindName | undefined => (cls === "log" ? undefined : (named ?? guess[cls]));
	if (e.kind === "out" && e.target === "alert") {
		// An all-clear, or the same alert again (hub/alert-gate.ts), was already as good as told: a record, not a warning.
		const quiet = !!e.reply_to || tone === "done" || e.repeat === true || quietAlert(text) || (tone !== "fail" && src !== "gateway" && !CRITICAL.test(rest));
		const nk = pick(noticeClass({ kind: "alert", tone: tone ?? "", text: rest, quiet, nk: named }).cls, { ask: "ask", alert: "alert" });
		return nk ? made(nk, { name: NAME, conv: "alert", text: clean(text).text }, plain(rest.split("\n").some(l => DECISION_HEAD.test(l)) ? rest : doctorPreview(rest))) : undefined;
	}
	if (lane && (e.kind === "out" || e.kind === "lane_report")) {
		// An untagged turn-end report that answers the owner, after a long turn, is the session's finished work, like the main chat's below.
		const long = e.kind === "lane_report" && e.answering === true && !tone && (sinceOwner ?? 0) >= LONG_TURN_MS;
		const nk = pick(noticeClass({ kind: "result", tone: long ? "done" : (tone ?? ""), nk: named }).cls, { ask: "session-ask", result: "session-done", alert: "session-fail" });
		return nk ? made(nk, { name: laneNameKo(lane), conv: `lane:${lane}`, key: `lane:${lane}`, text: clean(text).text }, plain(rest)) : undefined;
	}
	// The main chat's answers and a project's (work channel or one of its threads) are the same kind of message: one rule, each opening its own chat.
	const chat = e.kind === "out" && e.source === "orchestrator" ? (e.target === "web" ? "main" : /^(?:ch:|settings:)/.test(eventTarget(e) ?? "") ? eventTarget(e) : undefined) : undefined;
	if (chat) {
		// A monitor's or app's settings conversation is titled with its label, like its notice in the bell.
		const name = chat.startsWith("settings:") ? conversationTitle(chat) : NAME;
		// A quick reply is not finished work: it reaches the owner as the conversation's unread answer (noticePush, class conv) when he is elsewhere.
		const nk = pick(noticeClass({ kind: "result", tone: tone || ((sinceOwner ?? 0) >= LONG_TURN_MS ? "done" : ""), nk: named }).cls, { ask: "ask", result: "answer-done", alert: "answer-fail" });
		return nk ? made(nk, { name, conv: chat, text: clean(text).text }, plain(rest)) : undefined;
	}
	return undefined;
}

// The conversation a notification opens (`/#chat/<conv>`), for the "already on screen" check; undefined for any other page.
export function convOfUrl(url: string): string | undefined {
	const m = /#chat\/([^?#]+)$/.exec(url);
	if (!m) return undefined;
	try {
		return decodeURIComponent(m[1]!);
	} catch {
		return undefined;
	}
}
const hashOf = (conv: string) => (!conv ? "" : conv === "settings" || conv === "home" ? `#${conv}` : conv.startsWith("lane:") ? `#chat/lane:${encodeURIComponent(conv.slice(5))}` : `#chat/${conv}`);
const convOfHash = (hash: string): string => {
	if (hash === "#settings" || hash === "#home") return hash.slice(1);
	const m = /^#chat\/(.+)$/.exec(hash);
	try {
		return m ? decodeURIComponent(m[1]!) : "";
	} catch {
		return "";
	}
};
/** The one address a push carries: `gw` the origin of the computer that owns the item (set only on a relayed copy), `conv` its conversation, `at` the message's time, `nid` the bell notice, `dec` the decision. */
export type PushAddr = { gw?: string; conv: string; at?: string; nid?: string; dec?: string };
/** The address as the push fields every receiver reads: the URL `/?m=<at>&i=<nid>&n=<dec>[&pc=<gw>]#chat/<conv>` and the same values as ts, nid, id, pc. */
export function addrOf(a: PushAddr): Pick<PushMessage, "url" | "ts" | "nid" | "id" | "pc"> {
	const q = new URLSearchParams();
	if (a.at) q.set("m", a.at);
	if (a.nid) q.set("i", a.nid);
	if (a.dec) q.set("n", a.dec);
	if (a.gw) q.set("pc", a.gw);
	return { url: `/${q.size ? `?${q}` : ""}${hashOf(a.conv)}`, ...(a.at ? { ts: a.at } : {}), ...(a.nid ? { nid: a.nid } : {}), ...(a.dec ? { id: a.dec } : {}), ...(a.gw ? { pc: a.gw } : {}) };
}

// A bell notice that just became unread (hub/notices.ts onNoticeUnread) as a notification: results, monitoring news, alerts, unread answers.
// Decisions push through decisionPush (onDecision), so an [ask] twin here stays quiet; [run] progress and the gateway's routine records never notify.
export function noticePush(n: Notice & { nk?: unknown }): PushMessage | undefined {
	if (n.read || n.dismissed) return undefined;
	const { cls } = classOfNotice(n);
	if (cls === "ask" || cls === "log") return undefined;
	const conv = n.open || "main";
	const nk = kindOf(n.nk) ?? guessedKind(n, cls, conv);
	if (!nk || (cls === "news" && n.watch && watchPushOff(n.watch))) return undefined;
	const result = nk === "schedule";
	const item: KindItem = { name: result ? `${n.title} · ${plain(n.text)}` : n.title, conv, text: n.text, id: n.id, at: n.at, ...(n.key ? { key: n.key } : {}), ...(n.watch ? { watch: n.watch } : {}), folded: !!n.repeats?.length };
	const { conv: open, ...m } = made(nk, item, result ? "" : plain(doctorPreview(n.text)) || plain(n.title));
	return { ...m, ...addrOf({ conv: open, at: n.at, nid: n.id }), ...(cls === "news" && n.app ? { app: n.app } : {}) };
}
function guessedKind(n: Notice, cls: NoticeClass, conv: string): NoticeKindName | undefined {
	switch (cls) {
		case "result":
			return n.kind === "worklog" ? "worklog-done" : "session-done";
		case "alert":
			return n.kind === "worklog" ? "worklog-fail" : n.kind === "result" ? "session-fail" : "alert";
		case "news":
			return n.key === "self-update" ? "self-update" : conv.startsWith("mail:") ? "mail" : "watch";
		case "conv":
			return "answer";
		case "ask":
		case "log":
			return undefined;
		default: {
			const _exhaustive: never = cls;
			return _exhaustive;
		}
	}
}

const DECISION_ACTIONS = 2;
// A decision notice as a notification: the decision line as the body, at most two option buttons (never the login form's own input).
export function decisionPush(n: Notice): PushMessage {
	const d = n.decision!;
	const { conv, ...m } = made("decision", { name: NAME, conv: d.to.startsWith(RUN_DECISION) ? n.open : d.to, id: n.id }, plain(n.title));
	const group = confirmGroup(n);
	// The send approvals of one monitoring app are one notification that evolves (same tag): "메일 답장 확인 3건", with no button, since a button answers one item.
	if (group && group.count > 1) return { ...m, body: `${group.label} ${group.count}건`, ...addrOf({ conv: "home", at: n.at, dec: n.id }), tag: `decision-group:${group.key}` };
	const actions = d.options.filter(o => o.action !== "form").slice(0, DECISION_ACTIONS).map(o => ({ action: `opt:${o.n}`, title: plain(`${o.n}) ${o.label}`, 40) }));
	return { ...m, ...addrOf({ conv, at: n.at, dec: n.id }), ...(actions.length ? { actions } : {}) };
}
/** The one reminder when half of a card's answer time has gone (notices.ts onHalfTime): the card's push, its body `<title> · 답할 시간이 절반 남았어요`. */
export const halfTimePush = (n: Notice): PushMessage => ({ ...decisionPush(n), body: msg().asker.half(plain(n.title)) });

const GROUP_BODY = 180;
const opening = new Map<string, string>();
let held: Notice[] = [];
const msgKey = (n: Pick<Notice, "at"> & { decision?: { to: string } }) => `${n.decision?.to ?? ""}@${n.at ?? ""}`;
function leadOf(text: string): string {
	const lines = text.split("\n"), end = lines.findIndex(l => DECISION_HEAD.test(l));
	return plain(lines.slice(0, end < 0 ? 1 : end).find(l => plain(l)) ?? "", 80);
}
/** The one notification of the open cards `cards` of one message: `답변이 N개 필요해요`, its first line `lead` and then card titles as the body, opening the first card. */
export function messagePush(cards: readonly [Notice, ...Notice[]], lead: string): PushMessage {
	const { kind, url, ts, id } = decisionPush(cards[0]), lines = lead ? [lead] : [];
	for (const n of cards) {
		const line = `· ${plain(n.title, 60)}`;
		if ([...lines, line].join("\n").length > GROUP_BODY) break;
		lines.push(line);
	}
	return { kind, title: webText("notice.push.decisions", { n: cards.length }), body: lines.join("\n"), url, ...(ts ? { ts } : {}), ...(id ? { id } : {}), tag: `decision-msg:${msgKey(cards[0])}` };
}
function pushHeld(): void {
	const cards = held.filter(isOpenDecision);
	held = [];
	for (const [k, [first, ...rest]] of Map.groupBy(cards, n => (!n.decision?.draft && opening.has(msgKey(n)) ? msgKey(n) : n.id))) {
		const lead = opening.get(k);
		if (!first) continue;
		if (!rest.length || lead === undefined) void notify(decisionPush(first));
		else void notify(messagePush([first, ...rest], lead));
	}
	opening.clear();
}

// Taking back what was handled (owner 2026-10-28: "완료된건데 확인이 필요하다고 막 이러면 좀 헷갈려"): every tag a device was shown is remembered with the
// endpoints it reached, and once its matter is settled (a decision answered or dismissed, a conversation read) those devices close it. Apple's push
// service revokes a subscription whose push shows nothing (webkit.org/blog/16535), so an Apple endpoint is never sent a bare withdraw: its owed
// tags ride on its next real notification and the open app closes them itself (web/js/30-notices.js); other endpoints get a withdraw push now.
const SHOWN_MS = 3 * 24 * 3600_000;
const shown = new Map<string, Map<string, number>>();
const owed = new Map<string, Set<string>>();
const alertsSent = new Map<string, number>();
export const isAppleEndpoint = (endpoint: string): boolean => /(^|\.)push\.apple\.com$/.test(origin(endpoint).replace(/^https?:\/\//, ""));
function noteShown(endpoint: string, tag: string | undefined): void {
	if (!tag) return;
	const now = Date.now();
	for (const [t, eps] of shown) {
		for (const [ep, at] of eps) if (now - at > SHOWN_MS) eps.delete(ep);
		if (!eps.size) shown.delete(t);
	}
	if (!shown.has(tag)) shown.set(tag, new Map());
	shown.get(tag)!.set(endpoint, now);
}
/** Closes `tags` on every device they were shown on; `relay`: the other computers close their relayed copies too. Returns the endpoints told now. */
export async function withdraw(tags: readonly string[], relay = true): Promise<number> {
	const now = new Map<string, Set<string>>();
	for (const tag of new Set(tags)) {
		// A settled matter may notify again when something new comes for it.
		recentTags.delete(tag);
		alertsSent.delete(tag);
		const eps = shown.get(tag);
		if (!eps) continue;
		shown.delete(tag);
		for (const ep of eps.keys()) {
			const into = isAppleEndpoint(ep) ? owed : now;
			if (!into.has(ep)) into.set(ep, new Set());
			into.get(ep)!.add(tag);
		}
	}
	await Promise.all([...now].map(([ep, set]) => {
		const sub = findSub(ep);
		return sub ? deliver(sub, { kind: "withdraw", title: "", body: "", url: "/", withdraw: [...set] }) : undefined;
	}));
	if (now.size || owed.size) log(`push: took back ${[...new Set(tags)].join(", ")} (${now.size} device(s) now${owed.size ? `, ${owed.size} at their next notification` : ""})`);
	if (relay) {
		const { me, peers } = await ownAndPeers();
		if (me) await Promise.all(peers.map(p => peerJson(p.url, "/api/push/relay", { from: me.url, withdraw: [...new Set(tags)] })));
	}
	return now.size;
}
/** A relayed computer's chat is on screen: the notifications of its replies (tagged `<conv>:<line id>`, hub/jandi-peers.ts peerReplyPush) are read, on every device. */
export async function withdrawRelay(conv: string): Promise<void> {
	const tags = [...shown.keys()].filter(t => t.startsWith(`${conv}:`));
	if (tags.length) await withdraw(tags);
}
/** POST /api/viewing: the page says which conversation it shows; a relayed computer's chat has no bell item, so what reads it is here. */
export function viewConversation(id: unknown, conv: unknown): ReturnType<typeof setViewing> {
	const r = setViewing(id, conv);
	if (r.ok && typeof conv === "string" && conv.startsWith("relay:")) void withdrawRelay(conv).catch(err => log(`push: withdraw failed: ${(err as Error).message}`));
	return r;
}
/** The notification tags a settled matter makes stale: a decision answered or dismissed, a conversation read. */
export function staleTags(e: Record<string, unknown>): string[] {
	if (e.kind === "notice_dismiss" && e.id != null) return [`decision:${e.id}`];
	if (e.kind === "notice") {
		const n = e.item as Notice | undefined;
		if (!n?.decision) return [];
		if (n.decision.state === "open" && !n.dismissed && !laterOn(n.decision)) return [];
		// Its app's grouped notification goes too once no approval of that app is open (the group is asked as if this one were still open; it is not counted).
		const group = n.decision.draft ? confirmGroup({ ...n, decision: { ...n.decision, state: "open" } }) : undefined;
		const msgTag = `decision-msg:${msgKey(n)}`, more = shown.has(msgTag) && openDecisionNotices().some(i => i.id !== n.id && msgKey(i) === msgKey(n) && !laterOn(i.decision));
		return [`decision:${n.id}`, ...(group && group.count === 0 ? [`decision-group:${group.key}`] : []), ...(shown.has(msgTag) && !more ? [msgTag] : [])];
	}
	if (e.kind === "read" && typeof e.target === "string") {
		const t = e.target;
		if (t === "main") return ["answer", "ask:main"];
		if (t === "alert") return ["ask:alert", "alert", ...new Set([...shown.keys(), ...alertsSent.keys()].filter(tag => tag.startsWith("alert:")))];
		if (t.startsWith("lane:")) return [`ask:${t.slice(5)}`, `lane:${t.slice(5)}`, `start:${t.slice(5)}`];
		if (/^(?:ch|settings):/.test(t)) return [`answer:${t}`, `ask:${t}`];
	}
	return [];
}

const RECALL_OPTS = { urgency: "low", ttl: 300 } as const;
// One send, tried a second time when the push service's connection broke (a reused socket reset: ECONNRESET, 2026-11-03) or it answered 5xx.
async function sendOnce(sub: Stored, msg: PushMessage): Promise<number> {
	try {
		const status = await sendPush(sub, msg, vapid(), subject(), msg.kind === "withdraw" ? RECALL_OPTS : {});
		if (status < 500) return status;
	} catch {}
	return sendPush(sub, msg, vapid(), subject(), msg.kind === "withdraw" ? RECALL_OPTS : {});
}

async function deliver(sub: Stored, m: PushMessage): Promise<number> {
	try {
		// What this device still owes closing rides on its next real notification.
		const due = m.kind === "withdraw" ? undefined : owed.get(sub.endpoint);
		const msg = { ...m, ...(due?.size ? { withdraw: [...due] } : {}), unread: unreadCount() };
		const status = await sendOnce(sub, msg);
		if (status > 0 && status < 300) {
			if (due) owed.delete(sub.endpoint);
			if (m.kind !== "withdraw" && m.kind !== "test") noteShown(sub.endpoint, m.tag);
		}
		if (status === 404 || status === 410) {
			subs = subs.filter(s => s.endpoint !== sub.endpoint);
			save();
			log(`push: subscription at ${origin(sub.endpoint)} expired (${status}), removed`);
			// A dead app subscription no longer makes the app the device's only channel (as an unsubscribe does): otherwise its browser pages
			// are refused (409) and the device gets nothing until the app subscribes again (2026-10-30: push.json emptied, push-devices.json kept app).
			if (sub.app && sub.did && !subs.some(s => s.did === sub.did && s.app === true) && devices[sub.did]?.app) {
				patchDevice(sub.did, { app: undefined });
				void tellPeers({ did: sub.did, app: false });
			}
		} else if (status >= 300) log(`push: ${origin(sub.endpoint)} answered ${status}`);
		return status;
	} catch (e) {
		log(`push: send to ${origin(sub.endpoint)} failed: ${(e as Error).message}`);
		return 0;
	}
}

// One notice, each of the owner's devices once. A device is one browser or installed app; the web app mints an id for it (`did`) and hands it
// on whenever it opens another computer (web/js/23-installable-app-web.js, 33-peers.js), so its subscriptions on every computer carry the same id.
// A subscription without an id is a device of its own. The computer that made the notice picks ONE subscription per device: the installed app's on
// any computer (its own first, then the peers in a fixed order), else a browser's (own first). A peer delivers through POST /api/push/relay, titled
// with the sender's name; the tap carries ?pc= so the app opens the sender's view. A peer that does not answer covers no device, so the next choice
// (this computer's own subscription of that device) fires. A relayed notice is delivered where it lands and never sent on, so there is no loop.
const RELAY_MS = 2500;
let relayPeers: () => Promise<Array<Pick<Found, "name" | "url" | "self">>> = knownComputers;
export const setRelayPeers = (fn: typeof relayPeers): void => void (relayPeers = fn);
const sameOrigin = (a: string, b: string) => {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
};
const DID = /^[\w-]{8,64}$/;
const device = (s: Stored) => s.did ?? `e:${s.endpoint}`;
// One browser/app subscription is one endpoint, whichever computers hold it. Its short hash travels between gateways (the endpoint itself never does), so a
// computer that holds the same endpoint under no device id (an old subscription) still counts as the same device and stays quiet when another computer covered it.
const epKey = (endpoint: string) => `ep:${createHash("sha256").update(endpoint).digest("hex").slice(0, 24)}`;
const EP_KEY = /^ep:[0-9a-f]{24}$/;

// What this gateway knows about a device (by `did`), in ~/.dotz/push-devices.json. `app`: the device has the installed app (on this or another gateway; the
// app tells every gateway, see tellPeers). `off`: THIS gateway's notices do not reach the device. The setting lives where the decision is made: the gateway
// that makes a notice picks the device's channel (fanOut), so a toggle edits that gateway's own record, from any page of the device (gatewayView/setGateway).
// A device with the app has exactly one channel, the app: its browser subscriptions are removed (dropBrowsers), refused (subscribe) and never used (cover).
type Device = { app?: true; off?: true };
const DEVICES_FILE = join(DATA_DIR, "push-devices.json");
const devices: Record<string, Device> = {};
try {
	if (existsSync(DEVICES_FILE)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(DEVICES_FILE, "utf8")) as Record<string, Device>)) if (DID.test(k)) devices[k] = { ...(v?.app === true ? { app: true } : {}), ...(v?.off === true ? { off: true } : {}) };
} catch (e) {
	log(`push: ${DEVICES_FILE} unreadable, starting empty (${e})`);
}
const saveDevices = () => writeAtomic(DEVICES_FILE, `${JSON.stringify(devices, null, 2)}\n`, 0o600);
const hasApp = (did?: string) => !!did && (devices[did]?.app === true || subs.some(s => s.did === did && s.app === true));
const isOff = (did: string) => devices[did]?.off === true;
// Whether some device of the owner takes this gateway's answer notifications; then Discord does not ping him for the same answer (owner 2026-10-30).
export const answersReach = (list: Array<Pick<Stored, "did">>, off: (did: string) => boolean, on = classPushOn("conv")): boolean => on && list.some(s => !(s.did && off(s.did)));
export const pushReachesOwner = (): boolean => answersReach(subs, isOff);
function dropBrowsers(did: string): void {
	const rest = subs.filter(s => s.did !== did || s.app === true);
	if (rest.length === subs.length) return;
	log(`push: ${subs.length - rest.length} browser subscription(s) of a device with the app removed`);
	subs = rest;
	save();
}
function patchDevice(did: string, patch: Device & { app?: true | undefined; off?: true | undefined }): void {
	const d = { ...devices[did], ...patch };
	if (!d.app) delete d.app;
	if (!d.off) delete d.off;
	if (d.app || d.off) devices[did] = d;
	else delete devices[did];
	saveDevices();
	if (hasApp(did)) dropBrowsers(did);
}
for (const did of new Set([...Object.keys(devices), ...subs.flatMap(s => (s.app && s.did ? [s.did] : []))])) if (hasApp(did)) dropBrowsers(did);
// A device whose page is visible and focused skips the notification when that page shows the same conversation (or did not say which it shows).
export function presenceQuiets(p: { at: number; conv?: string } | undefined, url: string, t: number): boolean {
	if (!p || p.at <= t - PRESENCE_MS) return false;
	return p.conv === undefined || p.conv === convOfUrl(url);
}
const wants = (s: Stored, m: PushMessage, t: number) => m.kind === "test" || !presenceQuiets(presence.get(s.endpoint), m.url, t);

async function cover(list: Stored[], m: PushMessage, done: Set<string>, failed: Set<string> = new Set()): Promise<number> {
	const now = Date.now();
	const picked = new Set<string>();
	const sends: Promise<boolean>[] = [];
	for (const s of [...list].sort((x, y) => Number(y.app === true) - Number(x.app === true))) {
		const dk = device(s), ek = epKey(s.endpoint);
		if (done.has(dk) || done.has(ek) || picked.has(dk) || failed.has(s.endpoint)) continue;
		if (!s.app && hasApp(s.did)) {
			done.add(ek);
			continue;
		}
		if (!wants(s, m, now)) {
			done.add(dk);
			done.add(ek);
			continue;
		}
		picked.add(dk);
		sends.push(deliver(s, m).then(status => {
			if (status > 0 && status < 300) {
				done.add(dk);
				done.add(ek);
				return true;
			}
			failed.add(s.endpoint);
			return false;
		}));
	}
	return (await Promise.all(sends)).filter(Boolean).length;
}

// undefined: the peer did not take the relay (down, refused, an error); otherwise the devices it covered.
async function relayTo(peerUrl: string, body: string): Promise<string[] | undefined> {
	try {
		const r = await peerFetch(`${peerUrl}/api/push/relay`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(RELAY_MS), redirect: "manual" });
		if (!r.ok) return undefined;
		const served = ((await r.json()) as { served?: unknown }).served;
		return Array.isArray(served) ? served.filter((k): k is string => typeof k === "string") : [];
	} catch {
		return undefined;
	}
}

async function fanOut(m: PushMessage): Promise<void> {
	// A device this gateway is switched off for counts as covered: no subscription of it fires here, and the peers are told to skip it too.
	const done = new Set<string>(Object.keys(devices).filter(isOff));
	for (const s of subs) if (s.did && isOff(s.did)) done.add(epKey(s.endpoint));
	const failed = new Set<string>();
	let reached = await cover(subs.filter(s => s.app === true), m, done, failed);
	let list: Awaited<ReturnType<typeof relayPeers>> = [];
	try {
		list = await relayPeers();
	} catch {}
	const me = list.find(f => f.self);
	const up = me ? list.filter(f => !f.self).sort((x, y) => (x.url < y.url ? -1 : 1)) : [];
	// Peers one after the other: each is told what is already covered, so a device with an app on two computers hears it once.
	const ask = async (via: "app" | "all") => {
		for (const p of [...up]) {
			const skip = [...done].filter(k => !k.startsWith("e:"));
			const got = await relayTo(p.url, JSON.stringify({ from: me!.url, via, skip, kind: m.kind, title: m.title, body: m.body, url: m.url, tag: m.tag, ts: m.ts, id: m.id, nid: m.nid }));
			if (got) {
				for (const k of got) done.add(k);
				reached += got.filter(k => EP_KEY.test(k)).length;   // one ep: key per device the peer reached
			} else up.splice(up.indexOf(p), 1);
		}
	};
	await ask("app");
	reached += await cover(subs, m, done, failed);
	await ask("all");
	// One line per send, so a tap that does not land can be traced to what was sent (ids and address only, never the title or body).
	log(`push: sent ${logFields({ tag: m.tag, kind: m.kind, to: m.url, ts: m.ts, nid: m.nid, id: m.id })} devices=${reached}`);
}
const logValue = (v: unknown): string => (typeof v === "string" ? v.replace(/[\s=]+/g, "_").slice(0, 120) : "");
const logFields = (f: Record<string, unknown>): string => Object.entries(f).flatMap(([k, v]) => (logValue(v) ? [`${k}=${logValue(v)}`] : [])).join(" ");
// A tapped notification, as its page reports it (web/js/23-installable-app-web.js pushTapReport): the way it came in and the screen it reached.
const TAP_PATHS = ["open-window", "new-window", "action"];
export function tapLanded(b: Record<string, unknown>): boolean {
	if (typeof b.path !== "string" || !TAP_PATHS.includes(b.path)) return false;
	log(`push: tap ${logFields({ tag: b.tag, path: b.path, via: b.why, screen: b.screen, reason: b.reason })}`);
	return true;
}

async function peerJson(peerUrl: string, path: string, body?: object): Promise<Record<string, any> | undefined> {
	try {
		const r = await peerFetch(`${peerUrl}${path}`, { method: body ? "POST" : "GET", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(RELAY_MS), redirect: "manual" });
		return r.ok ? ((await r.json()) as Record<string, any>) : undefined;
	} catch {
		return undefined;
	}
}
async function ownAndPeers(): Promise<{ me?: Awaited<ReturnType<typeof relayPeers>>[number]; peers: Awaited<ReturnType<typeof relayPeers>> }> {
	const list = await relayPeers().catch(() => []);
	const me = list.find(f => f.self);
	return { me, peers: me ? list.filter(f => !f.self) : [] };
}
// The app (or its removal) is told to every other gateway, so each one drops the device's browser subscriptions and answers the settings screen alike.
// `eps` (with app: true): the endpoints of the device's app subscriptions here, so a peer that holds one of them under no device id adopts it (see /api/push/device).
async function tellPeers(body: { did: string; app: boolean }): Promise<void> {
	const { me, peers } = await ownAndPeers();
	const eps = body.app ? subs.filter(s => s.did === body.did && s.app === true).map(s => epKey(s.endpoint)) : [];
	if (me) await Promise.all(peers.map(p => peerJson(p.url, "/api/push/device", { from: me.url, ...body, ...(eps.length ? { eps } : {}) })));
}
// The settings screen's list: one row per discovered gateway (this one first), `on` = that gateway's notices reach the device. A gateway that does not answer is `online: false`.
async function gatewayView(did: string): Promise<{ app: boolean; gateways: Array<{ name: string; url: string; self: boolean; on: boolean; online: boolean }> }> {
	const { me, peers } = await ownAndPeers();
	if (!me) return { app: hasApp(did), gateways: [{ name: "", url: "", self: true, on: !isOff(did), online: true }] };
	const rows = await Promise.all([me, ...peers].map(async f => {
		if (f.self) return { name: f.name, url: f.url, self: true, on: !isOff(did), online: true, app: hasApp(did) };
		const r = await peerJson(f.url, `/api/push/device?did=${did}&from=${encodeURIComponent(me.url)}`);
		return { name: f.name, url: f.url, self: false, on: r ? r.on !== false : true, online: Boolean(r), app: r?.app === true };
	}));
	// Same order on every gateway's page (by address), so the list does not shuffle when the app switches computers.
	return { app: rows.some(r => r.app), gateways: rows.sort((p, q) => (p.url < q.url ? -1 : 1)).map(({ app: _app, ...g }) => g) };
}

async function forwardPresence(did: string, active: boolean): Promise<void> {
	const list = await relayPeers().catch(() => []);
	await Promise.all(list.filter(f => !f.self).map(f => peerFetch(`${f.url}/api/push/presence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ did, active, relayed: true }), signal: AbortSignal.timeout(RELAY_MS), redirect: "manual" }).catch(() => {})));
}

const RELAY_HASH = /^#[\w:%.\-/]{0,200}$/;
// A notice another computer relayed, as this computer shows it: the computer's name leads the title, the tap carries ?pc=<its origin>
// (and the item: ?n= for a decision, ?m= for a message) so the app switches to that computer's view. The sender's id/ts name items on ITS
// hub, so no option buttons (they would post the answer to this hub) and the tag is per computer.
export function relayedMessage(peer: { name: string; url: string }, p: Record<string, unknown>): PushMessage | undefined {
	const kind = (PUSH_KINDS as readonly string[]).includes(String(p.kind)) ? (p.kind as PushKind) : LEGACY_KINDS[String(p.kind)];
	if (!kind || typeof p.title !== "string" || typeof p.body !== "string" || !p.title) return undefined;
	const id = typeof p.id === "string" && /^[\w.:-]{1,80}$/.test(p.id) ? p.id : "";
	const ts = typeof p.ts === "string" && /^[\w.:+-]{1,40}$/.test(p.ts) ? p.ts : "";
	const nid = typeof p.nid === "string" && /^[\w.:-]{1,80}$/.test(p.nid) ? p.nid : "";
	let hash = "";
	try {
		hash = new URL(typeof p.url === "string" ? p.url : "/", "http://x").hash;
	} catch {}
	if (!RELAY_HASH.test(hash)) hash = "";
	const gw = new URL(peer.url).origin;
	return { kind, title: `${peer.name} · ${plain(p.title, 80)}`, body: plain(p.body), tag: `${new URL(peer.url).host}:${typeof p.tag === "string" ? p.tag.slice(0, 80) : kind}`, ...addrOf({ gw, conv: convOfHash(hash), at: ts, nid, dec: id }) };
}

const recent = new Map<string, number>();
// One matter, one notification: an event and the bell notice it makes (or a lane's mid-turn line and its turn-end report) carry the same tag, so a
// second push of a tag within TAG_MS is dropped. A tag taken back (withdraw: read, answered) may notify again at once.
const TAG_MS = 2 * 60_000;
const recentTags = new Map<string, number>();
/** Whether `m` goes out: not the same tag+body within DEDUPE_MS, not the same tag within TAG_MS, not a conversation someone has on screen. */
export function shouldNotify(m: Pick<PushMessage, "kind" | "tag" | "body" | "url" | "app">, t = Date.now(), viewing: (conv: string) => boolean = isViewing, on: (cls: PushKind, app?: string) => boolean = classPushOn): boolean {
	if (m.kind === "test") return true;
	if (m.kind !== "withdraw" && !on(m.kind, m.app)) return false;
	const conv = convOfUrl(m.url);
	if (conv && viewing(conv)) return false;
	const key = `${m.tag}|${m.body}`;
	for (const [k, at] of recent) if (t - at > DEDUPE_MS) recent.delete(k);
	for (const [k, at] of recentTags) if (t - at > TAG_MS) recentTags.delete(k);
	if (recent.has(key) || (m.tag && recentTags.has(m.tag))) return false;
	recent.set(key, t);
	if (m.tag) recentTags.set(m.tag, t);
	return true;
}
export const resetPushDedupeForTest = (): void => {
	recent.clear();
	recentTags.clear();
};
// Resolves once every device has been decided (sent, covered by a peer, or quiet by its own setting).
export function notify(raw: PushMessage): Promise<void> {
	const m = raw.kind === "withdraw" ? raw : { ...raw, title: noticeKo(raw.title, { lane: laneNameKo }), body: noticeKo(raw.body, { lane: laneNameKo }) };
	const t = Date.now();
	if (!shouldNotify(m, t)) return Promise.resolve();
	if (m.tag?.startsWith("alert:")) {
		for (const [tag, at] of alertsSent) if (t - at > SHOWN_MS) alertsSent.delete(tag);
		alertsSent.set(m.tag, t);
	}
	if (m.kind === "test") {
		for (const s of subs) if (wants(s, m, t)) void deliver(s, m);
		return Promise.resolve();
	}
	return fanOut(m);
}

export function startPush(opts: { subject: () => string }): void {
	subject = opts.subject;
	// When the owner's last web message arrived: an answer long after it is a finished piece of work.
	let ownerAt = 0;
	// emit() has appended the event to its jsonl and broadcast it to the open pages before any listener runs, so a push (and the
	// bell notice, fed the same way) never reaches a device ahead of the message it is about.
	onEmit(e => {
		if (e.kind === "message" && e.source === "web") ownerAt = Date.parse(String(e.ts)) || Date.now();
		const m = classify(e, ownerAt ? Date.now() - ownerAt : undefined), ds = decisionsOf(e);
		if (ds.length > 1) for (const d of ds) opening.set(msgKey({ at: String(e.ts), decision: d }), leadOf(typeof e.text === "string" ? e.text : ""));
		// A message that becomes a decision notice (an [ask] or a choice block) is pushed by onDecision below (one push, with the options), not twice.
		// The reply to a choice-button answer is quiet (notices.ts answerReply).
		if (m && !ds.length && !answerReply(e)) notify(m);
	});
	onDecision(n => {
		if (!held.length) queueMicrotask(pushHeld);
		held.push(n);
	});
	onHalfTime(n => notify(halfTimePush(n)));
	onNoticeUnread(n => {
		const m = noticePush(n);
		if (m) void notify(m);
	});
	onBroadcast(e => {
		const tags = staleTags(e);
		if (tags.length) void withdraw(tags).catch(err => log(`push: withdraw failed: ${(err as Error).message}`));
	});
}

const findSub = (endpoint: unknown) => subs.find(s => s.endpoint === endpoint);

// /api/push*: the app's subscribe/settings surface. Same tailnet auth as every other /api route (checked by main.ts).
export async function pushRoute(req: Request, url: URL): Promise<Response | undefined> {
	if (url.pathname !== "/api/push" && !url.pathname.startsWith("/api/push/")) return undefined;
	const b = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, any>);
	const p = url.pathname;
	if (req.method === "GET" && p === "/api/push") {
		const s = findSub(url.searchParams.get("endpoint"));
		return json({ publicKey: vapid().publicKey, kinds: PUSH_KINDS, subscribed: Boolean(s), prefs: s?.prefs ?? defaults(), app: s?.app === true, did: s?.did ?? "" });
	}
	if (req.method === "POST" && p === "/api/push/subscribe") {
		const sub = b.subscription as Subscription | undefined;
		if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "subscription with https endpoint and keys required" }, 400);
		// `replaces`: the endpoint the push service swapped for this one (the service worker's pushsubscriptionchange, web/sw.js), which knows no device id:
		// the new subscription takes the old one's device, app role and switches, and the old one goes.
		const prev = typeof b.replaces === "string" && b.replaces !== sub.endpoint ? findSub(b.replaces) : undefined;
		const old = findSub(sub.endpoint) ?? prev;
		const prefs = { ...defaults(), ...(old?.prefs ?? {}), ...(b.prefs ?? {}) };
		const did = typeof b.did === "string" && DID.test(b.did) ? b.did : old?.did;
		const app = b.app === true || old?.app === true;
		if (!app && hasApp(did)) return json({ error: "this device gets its notifications through its app" }, 409);
		subs = [...subs.filter(s => s.endpoint !== sub.endpoint && s !== prev), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, prefs, ...(app ? { app: true } : {}), ...(did ? { did } : {}), ua: String(req.headers.get("user-agent") ?? "").slice(0, 160), at: new Date().toISOString() }];
		save();
		log(`push: subscribed at ${origin(sub.endpoint)} (${subs.length} total)`);
		if (app && did) {
			patchDevice(did, { app: true });
			await tellPeers({ did, app: true });
		}
		return json({ ok: true, prefs });
	}
	// The installed app says again that it is the device's channel (each time it opens), for gateways that were down when it subscribed.
	if (req.method === "POST" && p === "/api/push/claim") {
		if (typeof b.did !== "string" || !DID.test(b.did) || !subs.some(s => s.did === b.did && s.app === true)) return json({ error: "no app subscription for this device here" }, 404);
		patchDevice(b.did, { app: true });
		await tellPeers({ did: b.did, app: true });
		return json({ ok: true });
	}
	// The settings screen (any page of the device, on any gateway): GET lists the gateways with their switch, PUT flips one. Another gateway's switch is set
	// on that gateway through the peer route below, since its record is the one its deliveries read.
	if (p === "/api/push/gateways" && (req.method === "GET" || req.method === "PUT")) {
		const did = req.method === "GET" ? url.searchParams.get("did") : b.did;
		if (typeof did !== "string" || !DID.test(did)) return json({ error: "did required" }, 400);
		if (req.method === "GET") return json(await gatewayView(did));
		if (typeof b.on !== "boolean" || typeof b.url !== "string") return json({ error: "url and on required" }, 400);
		const { me, peers } = await ownAndPeers();
		if (!me || sameOrigin(me.url, b.url)) patchDevice(did, { off: b.on ? undefined : true });
		else {
			const peer = peers.find(f => sameOrigin(f.url, b.url));
			if (!peer) return json({ error: "not a known computer" }, 404);
			if (!(await peerJson(peer.url, "/api/push/device", { from: me.url, did, on: b.on }))) return json({ error: `${peer.name}에 연결할 수 없어요` }, 502);
		}
		return json({ ok: true });
	}
	// Between gateways only (a computer this one discovered, named by the discovery as in /api/push/relay): this gateway's record of a device.
	if (p === "/api/push/device" && (req.method === "GET" || req.method === "POST")) {
		const from = req.method === "GET" ? (url.searchParams.get("from") ?? "") : typeof b.from === "string" ? b.from : "";
		if (!(await relayPeers().catch(() => [])).some(f => !f.self && sameOrigin(f.url, from))) return json({ error: "not a known computer" }, 403);
		const did = req.method === "GET" ? url.searchParams.get("did") : b.did;
		if (typeof did !== "string" || !DID.test(did)) return json({ error: "did required" }, 400);
		if (req.method === "GET") return json({ on: !isOff(did), app: hasApp(did) });
		if (typeof b.on === "boolean") patchDevice(did, { off: b.on ? undefined : true });
		// A subscription here without a device id whose endpoint is the app's elsewhere is that same app subscription: it takes the id and the app role,
		// so the device is one device here too (and stays this computer's own fallback channel if the app's computer is down).
		if (b.app === true && Array.isArray(b.eps)) {
			const eps = new Set<string>(b.eps.filter((k: unknown): k is string => typeof k === "string" && EP_KEY.test(k)).slice(0, 20));
			const same = subs.filter(s => !s.did && eps.has(epKey(s.endpoint)));
			if (same.length) {
				for (const s of same) Object.assign(s, { did, app: true });
				save();
				log(`push: ${same.length} subscription(s) without a device id adopted as the app's`);
			}
		}
		if (typeof b.app === "boolean") patchDevice(did, { app: b.app ? true : undefined });
		return json({ ok: true });
	}
	// Another computer's notice for this computer's subscriptions: `via` app = only the apps', skip = the devices already covered. Only a computer this one
	// discovered as its peer (hub/peers.ts) may send one, named by the discovery, never by the body; the caller already passed the gateway's owner check
	// like any /api call. The answer lists the devices this computer covered. Nothing here sends a notice on.
	if (req.method === "POST" && p === "/api/push/relay") {
		const from = typeof b.from === "string" ? b.from : "";
		const peer = (await relayPeers().catch(() => [])).find(f => !f.self && sameOrigin(f.url, from));
		if (!peer) return json({ error: "not a known computer" }, 403);
		// The other computer took back notices it relayed here: this computer closes its copies (tagged with that computer's host).
		if (Array.isArray(b.withdraw)) {
			const host = new URL(peer.url).host;
			await withdraw(b.withdraw.filter((t: unknown): t is string => typeof t === "string" && t.length <= 80).slice(0, 50).map((t: string) => `${host}:${t}`), false);
			return json({ ok: true });
		}
		const m = relayedMessage(peer, b);
		if (!m) return json({ error: "kind, title and body required" }, 400);
		const skip = new Set<string>(Array.isArray(b.skip) ? b.skip.filter((k: unknown): k is string => typeof k === "string" && k.length <= 80).slice(0, 200) : []);
		const done = new Set(skip);
		await cover(b.via === "app" ? subs.filter(s => s.app === true) : subs, m, done);
		return json({ ok: true, served: [...done].filter(k => !skip.has(k)) });
	}
	if (req.method === "POST" && p === "/api/push/tap") return tapLanded(b) ? json({ ok: true }) : json({ error: "path required" }, 400);
	if (req.method === "POST" && p === "/api/push/unsubscribe") {
		const gone = findSub(b.endpoint);
		subs = subs.filter(s => s.endpoint !== b.endpoint);
		save();
		// The app turning its notifications off ends its role as the device's channel (a second app subscription elsewhere keeps it).
		if (gone?.app && gone.did && !subs.some(s => s.did === gone.did && s.app === true)) {
			patchDevice(gone.did, { app: undefined });
			await tellPeers({ did: gone.did, app: false });
		}
		return json({ ok: true });
	}
	// The owner's push switch per notice class (config.json notify.push): one setting for every device, unknown keys and non-booleans are a 400.
	if (p === "/api/push/classes" && (req.method === "GET" || req.method === "PUT")) {
		if (req.method === "PUT") {
			const v = b.classes as Record<string, unknown> | undefined;
			if (!v || typeof v !== "object" || Object.entries(v).some(([k, x]) => !(PUSH_KINDS as readonly string[]).includes(k) || typeof x !== "boolean")) return json({ error: "classes: { <class>: boolean }" }, 400);
			try {
				updateNotifyPush(v as Record<string, boolean>);
			} catch (error) {
				if (error instanceof UnreadableFileError) return json({ error: error.message }, 500);
				throw error;
			}
		}
		return json({ classes: pushClasses() });
	}
	// A page that is open and visible quiets its device's subscriptions here. The same device (`did`) is quieted on the other computers too: the page shows
	// their notices as toasts (hub/peer-stream.ts), so a push there would be a second alert. The forward carries `relayed` and is never sent on.
	if (req.method === "POST" && p === "/api/push/presence") {
		const conv = typeof b.conv === "string" && b.conv.length <= 120 && b.relayed !== true ? b.conv : undefined;
		const mark = (endpoint: string) => (b.active ? presence.set(endpoint, { at: Date.now(), ...(conv !== undefined ? { conv } : {}) }) : presence.delete(endpoint));
		if (typeof b.endpoint === "string") mark(b.endpoint);
		const did = typeof b.did === "string" && DID.test(b.did) ? b.did : typeof b.endpoint === "string" ? findSub(b.endpoint)?.did : undefined;
		if (did) for (const s of subs) if (s.did === did) mark(s.endpoint);
		if (did && b.relayed !== true) void forwardPresence(did, b.active === true);
		return json({ ok: true });
	}
	if (req.method === "POST" && p === "/api/push/test") {
		const s = findSub(b.endpoint);
		if (!s) return json({ error: "not subscribed" }, 404);
		const status = await deliver(s, { kind: "test", title: webText("notice.push.test", { name: NAME }), body: webText("notice.push.test_body"), url: "/#chat/main", tag: "test" });
		return json({ ok: status >= 200 && status < 300, status }, status >= 200 && status < 300 ? 200 : 502);
	}
	return json({ error: "unknown push route" }, 404);
}
