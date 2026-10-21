// Web Push to the installed web app: VAPID keys made once in ~/.dotz/secrets/vapid.json (0600, never logged), the
// subscriptions with their per-kind toggles in ~/.dotz/push.json, and the rule that picks which hub events become a
// notification. A device whose page reported itself visible and focused in the last minute is skipped (no double alert).
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, writeAtomic } from "./config.ts";
import { eventTarget, type HubEvent, onEmit } from "./events.ts";
import { decisionsOf, type Notice, onDecision } from "./notices.ts";
import { parseTone } from "./tone.ts";
import { generateVapidKeys, sendPush, type Subscription, type VapidKeys } from "./webpush.ts";

export const PUSH_KINDS = ["answer", "ask", "lane", "usage", "update"] as const;
type PushKind = (typeof PUSH_KINDS)[number];
type Prefs = Record<PushKind, boolean>;
type Stored = Subscription & { prefs: Prefs; ua?: string; at: string };
// `ts` is the id of the hub event the notification is about (its timestamp, the same key the web keeps its messages under): a tap
// makes sure that message is loaded before it jumps to it.
// `id` + `actions` (a decision notice): the page opens its detail sheet, and the service worker offers the first options as buttons that
// answer through POST /api/notices/<id>/answer.
type PushAction = { action: string; title: string };
type PushMessage = { kind: PushKind | "test"; title: string; body: string; url: string; tag?: string; ts?: string; id?: string; actions?: PushAction[] };

const KEY_FILE = join(DATA_DIR, "secrets", "vapid.json");
const SUBS_FILE = join(DATA_DIR, "push.json");
const PRESENCE_MS = 60_000;
const DEDUPE_MS = 10 * 60_000;
const defaults = (): Prefs => ({ answer: true, ask: true, lane: true, usage: true, update: true });

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
const presence = new Map<string, number>();
const origin = (endpoint: string) => {
	try {
		return new URL(endpoint).host;
	} catch {
		return "?";
	}
};

let subject = () => "mailto:dotz@example.com";

const plain = (t: string, max = 180) => {
	const s = t.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>|]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Only four things notify (owner 2026-10-20: "작업시작/완료/개입필요/중대한 경고에만 지능적으로 알림 보내. 전부 다 보낼 필요는 없다"):
// - work started: a lane's worklog entry when it is first posted ([run] ... 시작);
// - work done: a lane's [done]/[fail], and an answer on web that was marked [done]/[fail] or took LONG_TURN_MS or more
//   since the owner's message (the owner has likely left); a quick reply does not notify;
// - input needed: any [ask];
// - critical warning: the gateway's own alerts (limits, provider errors, memory) and alerts marked [fail] or worded as
//   something stopped or failed; replies in the alert channel and routine reports do not.
// Other progress edits (update_key) never notify; a lane's [ask]/[done]/[fail] line can arrive twice (mid-turn line and
// turn-end report), the caller dedupes.
export const LONG_TURN_MS = 2 * 60_000;
const CRITICAL = /멈췄|멈춤|막혔|실패|오류|끊겼|한도|위험|소진|확인이 필요|failed|error|stopped|limit/i;
const ROUTINE_ALERT = /^토큰 누수 점검/;
export function classify(e: HubEvent, sinceOwner?: number): PushMessage | undefined {
	const m = classifyEvent(e, sinceOwner);
	return m ? { ...m, ts: e.ts } : undefined;
}
function classifyEvent(e: HubEvent, sinceOwner?: number): PushMessage | undefined {
	const text = typeof e.text === "string" ? e.text : "";
	if (!text) return undefined;
	const src = String(e.source ?? "");
	const { tone, text: rest } = parseTone(text);
	const key = typeof e.update_key === "string" ? e.update_key : "";
	if (key) {
		if (e.kind !== "out" || e.target !== "worklog" || !key.startsWith("lane:") || tone !== "run" || !/시작/.test(rest)) return undefined;
		const name = key.slice(5);
		return { kind: "lane", title: `${name} · 시작`, body: plain(rest), url: `/#chat/lane:${encodeURIComponent(name)}`, tag: `start:${name}` };
	}
	const lane = typeof e.lane === "string" ? e.lane : src.startsWith("lane:") ? src.slice(5) : undefined;
	if (e.kind === "out" && e.target === "alert") {
		if (tone === "ask") return { kind: "ask", title: "dotz · 확인 필요", body: plain(rest), url: "/#chat/main", tag: "ask:alert" };
		if (e.reply_to || tone === "done" || tone === "run" || ROUTINE_ALERT.test(rest)) return undefined;
		if (tone !== "fail" && src !== "gateway" && !CRITICAL.test(rest)) return undefined;
		return { kind: "usage", title: "dotz · 경고", body: plain(rest), url: "/#chat/main", tag: "alert" };
	}
	if (lane && (e.kind === "out" || e.kind === "lane_report")) {
		const url = `/#chat/lane:${encodeURIComponent(lane)}`;
		if (tone === "ask") return { kind: "ask", title: `${lane} · 질문`, body: plain(rest), url, tag: `ask:${lane}` };
		if (tone === "done" || tone === "fail") return { kind: "lane", title: `${lane} · ${tone === "done" ? "완료" : "실패"}`, body: plain(rest), url, tag: `lane:${lane}` };
		return undefined;
	}
	// The main chat's answers and a project's (work channel or one of its threads) are the same kind of message: one rule, each opening its own chat.
	const chat = e.kind === "out" && e.source === "orchestrator" ? (e.target === "web" ? "main" : eventTarget(e)?.startsWith("ch:") ? eventTarget(e) : undefined) : undefined;
	if (chat) {
		const url = `/#chat/${chat}`, sfx = chat === "main" ? "" : `:${chat}`;
		if (tone === "ask") return { kind: "ask", title: "dotz · 확인 필요", body: plain(rest), url, tag: `ask:${chat}` };
		if (tone === "fail") return { kind: "answer", title: "dotz · 실패", body: plain(rest), url, tag: `answer${sfx}` };
		if (tone === "done" || (sinceOwner ?? 0) >= LONG_TURN_MS) return { kind: "answer", title: "dotz · 완료", body: plain(rest), url, tag: `answer${sfx}` };
		return undefined;
	}
	return undefined;
}

const DECISION_PUSH_TITLE = "답변이 필요해요";
const DECISION_ACTIONS = 2;
// A decision notice as a notification: the decision line as the body, at most two option buttons (never the login form's own input).
export function decisionPush(n: Notice): PushMessage {
	const d = n.decision!;
	const url = d.to.startsWith("lane:") ? `/#chat/lane:${encodeURIComponent(d.to.slice(5))}` : d.to.startsWith("ch:") ? `/#chat/${d.to}` : "/#chat/main";
	const actions = d.options.filter(o => o.action !== "form").slice(0, DECISION_ACTIONS).map(o => ({ action: `opt:${o.n}`, title: plain(`${o.n}) ${o.label}`, 40) }));
	return { kind: "ask", title: DECISION_PUSH_TITLE, body: plain(n.title), url, tag: `decision:${n.id}`, ts: n.at, id: n.id, ...(actions.length ? { actions } : {}) };
}

async function deliver(sub: Stored, m: PushMessage): Promise<number> {
	try {
		const status = await sendPush(sub, m, vapid(), subject());
		if (status === 404 || status === 410) {
			subs = subs.filter(s => s.endpoint !== sub.endpoint);
			save();
			log(`push: subscription at ${origin(sub.endpoint)} expired (${status}), removed`);
		} else if (status >= 300) log(`push: ${origin(sub.endpoint)} answered ${status}`);
		return status;
	} catch (e) {
		log(`push: send to ${origin(sub.endpoint)} failed: ${(e as Error).message}`);
		return 0;
	}
}

const recent = new Map<string, number>();
export function notify(m: PushMessage): void {
	const key = `${m.tag}|${m.body}`;
	const t = Date.now();
	for (const [k, at] of recent) if (t - at > DEDUPE_MS) recent.delete(k);
	if (recent.has(key)) return;
	recent.set(key, t);
	for (const s of subs) {
		if (m.kind !== "test" && s.prefs[m.kind] === false) continue;
		if ((presence.get(s.endpoint) ?? 0) > t - PRESENCE_MS) continue;
		void deliver(s, m);
	}
}

export function startPush(opts: { subject: () => string }): void {
	subject = opts.subject;
	// When the owner's last web message arrived: an answer long after it is a finished piece of work.
	let ownerAt = 0;
	// emit() has appended the event to its jsonl and broadcast it to the open pages before any listener runs, so a push (and the
	// bell notice, fed the same way) never reaches a device ahead of the message it is about.
	onEmit(e => {
		if (e.kind === "message" && e.source === "web") ownerAt = Date.parse(String(e.ts)) || Date.now();
		const m = classify(e, ownerAt ? Date.now() - ownerAt : undefined);
		// A message that becomes a decision notice (an [ask] or a choice block) is pushed by onDecision below (one push, with the options), not twice.
		if (m && !decisionsOf(e).length) notify(m);
	});
	onDecision(n => notify(decisionPush(n)));
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const findSub = (endpoint: unknown) => subs.find(s => s.endpoint === endpoint);

// /api/push*: the app's subscribe/settings surface. Same tailnet auth as every other /api route (checked by main.ts).
export async function pushRoute(req: Request, url: URL): Promise<Response | undefined> {
	if (url.pathname !== "/api/push" && !url.pathname.startsWith("/api/push/")) return undefined;
	const b = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, any>);
	const p = url.pathname;
	if (req.method === "GET" && p === "/api/push") {
		const s = findSub(url.searchParams.get("endpoint"));
		return json({ publicKey: vapid().publicKey, kinds: PUSH_KINDS, subscribed: Boolean(s), prefs: s?.prefs ?? defaults() });
	}
	if (req.method === "POST" && p === "/api/push/subscribe") {
		const sub = b.subscription as Subscription | undefined;
		if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "subscription with https endpoint and keys required" }, 400);
		const old = findSub(sub.endpoint);
		const prefs = { ...defaults(), ...(old?.prefs ?? {}), ...(b.prefs ?? {}) };
		subs = [...subs.filter(s => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, prefs, ua: String(req.headers.get("user-agent") ?? "").slice(0, 160), at: new Date().toISOString() }];
		save();
		log(`push: subscribed at ${origin(sub.endpoint)} (${subs.length} total)`);
		return json({ ok: true, prefs });
	}
	if (req.method === "POST" && p === "/api/push/unsubscribe") {
		subs = subs.filter(s => s.endpoint !== b.endpoint);
		save();
		return json({ ok: true });
	}
	if (req.method === "PUT" && p === "/api/push/prefs") {
		const s = findSub(b.endpoint);
		if (!s) return json({ error: "not subscribed" }, 404);
		for (const k of PUSH_KINDS) if (typeof b.prefs?.[k] === "boolean") s.prefs[k] = b.prefs[k];
		save();
		return json({ ok: true, prefs: s.prefs });
	}
	if (req.method === "POST" && p === "/api/push/presence") {
		if (typeof b.endpoint === "string") b.active ? presence.set(b.endpoint, Date.now()) : presence.delete(b.endpoint);
		return json({ ok: true });
	}
	if (req.method === "POST" && p === "/api/push/test") {
		const s = findSub(b.endpoint);
		if (!s) return json({ error: "not subscribed" }, 404);
		const status = await deliver(s, { kind: "test", title: "dotz 테스트 알림", body: "알림이 잘 와요. 누르면 대화로 가요.", url: "/#chat/main", tag: "test" });
		return json({ ok: status >= 200 && status < 300, status }, status >= 200 && status < 300 ? 200 : 502);
	}
	return json({ error: "unknown push route" }, 404);
}
