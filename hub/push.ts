// Web Push to the installed web app: VAPID keys made once in ~/.dotz/secrets/vapid.json (0600, never logged), the
// subscriptions with their per-kind toggles in ~/.dotz/push.json, and the rule that picks which hub events become a
// notification. A device whose page reported itself visible and focused in the last minute is skipped (no double alert).
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, writeAtomic } from "./config.ts";
import { eventTarget, type HubEvent, onEmit } from "./events.ts";
import { answerReply, decisionsOf, type Notice, onDecision } from "./notices.ts";
import { type Found, knownComputers } from "./peers.ts";
import { parseTone } from "./tone.ts";
import { generateVapidKeys, sendPush, type Subscription, type VapidKeys } from "./webpush.ts";

export const PUSH_KINDS = ["answer", "ask", "lane", "usage", "update"] as const;
type PushKind = (typeof PUSH_KINDS)[number];
type Prefs = Record<PushKind, boolean>;
// `app`: made by the installed app (the page runs standalone), the subscription a device is reached through when it has one.
// `did`: the device's id, shared by all its subscriptions on every computer (see fanOut).
type Stored = Subscription & { prefs: Prefs; ua?: string; at: string; app?: boolean; did?: string };
// `ts` is the id of the hub event the notification is about (its timestamp, the same key the web keeps its messages under): a tap
// makes sure that message is loaded before it jumps to it.
// `id` + `actions` (a decision notice): the page opens its detail sheet, and the service worker offers the first options as buttons that
// answer through POST /api/notices/<id>/answer.
type PushAction = { action: string; title: string };
// `pc`: a notice relayed from another computer (its origin); a tap opens the app, which switches to that computer (web/js/33-peers.js prFollow).
type PushMessage = { kind: PushKind | "test"; title: string; body: string; url: string; tag?: string; ts?: string; id?: string; actions?: PushAction[]; pc?: string };

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
const wants = (s: Stored, m: PushMessage, t: number) => (m.kind === "test" || s.prefs[m.kind] !== false) && (presence.get(s.endpoint) ?? 0) <= t - PRESENCE_MS;

// Deliver through one subscription for each device not in `done` (an app's before a browser's) and mark the device done. A device whose chosen
// subscription has the kind switched off (or whose page is open) stays quiet: that is its owner's choice there, and no other subscription fires.
function cover(list: Stored[], m: PushMessage, done: Set<string>): void {
	const now = Date.now();
	for (const s of [...list].sort((x, y) => Number(y.app === true) - Number(x.app === true))) {
		if (done.has(device(s))) continue;
		done.add(device(s));
		if (!s.app && hasApp(s.did)) continue;   // a browser of a device that has the app is never a channel
		if (wants(s, m, now)) void deliver(s, m);
	}
}

// undefined: the peer did not take the relay (down, refused, an error); otherwise the devices it covered.
async function relayTo(peerUrl: string, body: string): Promise<string[] | undefined> {
	try {
		const r = await fetch(`${peerUrl}/api/push/relay`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(RELAY_MS), redirect: "manual" });
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
	cover(subs.filter(s => s.app === true), m, done);
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
			const got = await relayTo(p.url, JSON.stringify({ from: me!.url, via, skip, kind: m.kind, title: m.title, body: m.body, url: m.url, tag: m.tag, ts: m.ts, id: m.id }));
			if (got) for (const k of got) done.add(k);
			else up.splice(up.indexOf(p), 1);
		}
	};
	await ask("app");
	cover(subs, m, done);
	await ask("all");
}

async function peerJson(peerUrl: string, path: string, body?: object): Promise<Record<string, any> | undefined> {
	try {
		const r = await fetch(`${peerUrl}${path}`, { method: body ? "POST" : "GET", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(RELAY_MS), redirect: "manual" });
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
async function tellPeers(body: object): Promise<void> {
	const { me, peers } = await ownAndPeers();
	if (me) await Promise.all(peers.map(p => peerJson(p.url, "/api/push/device", { from: me.url, ...body })));
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
	await Promise.all(list.filter(f => !f.self).map(f => fetch(`${f.url}/api/push/presence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ did, active, relayed: true }), signal: AbortSignal.timeout(RELAY_MS), redirect: "manual" }).catch(() => {})));
}

const RELAY_HASH = /^#[\w:%.\-/]{0,200}$/;
// A notice another computer relayed, as this computer shows it: the computer's name leads the title, the tap carries ?pc=<its origin>
// (and the item: ?n= for a decision, ?m= for a message) so the app switches to that computer's view. The sender's id/ts name items on ITS
// hub, so no option buttons (they would post the answer to this hub) and the tag is per computer.
export function relayedMessage(peer: { name: string; url: string }, p: Record<string, unknown>): PushMessage | undefined {
	const kind = (PUSH_KINDS as readonly string[]).includes(String(p.kind)) ? (p.kind as PushKind) : undefined;
	if (!kind || typeof p.title !== "string" || typeof p.body !== "string" || !p.title) return undefined;
	const id = typeof p.id === "string" && /^[\w.:-]{1,80}$/.test(p.id) ? p.id : "";
	const ts = typeof p.ts === "string" && /^[\w.:+-]{1,40}$/.test(p.ts) ? p.ts : "";
	let hash = "";
	try {
		hash = new URL(typeof p.url === "string" ? p.url : "/", "http://x").hash;
	} catch {}
	if (!RELAY_HASH.test(hash)) hash = "";
	const q = new URLSearchParams({ pc: new URL(peer.url).origin });
	if (id) q.set("n", id);
	else if (ts) q.set("m", ts);
	return { kind, title: `${peer.name} · ${plain(p.title, 80)}`, body: plain(p.body), url: `/?${q}${hash}`, tag: `${new URL(peer.url).host}:${typeof p.tag === "string" ? p.tag.slice(0, 80) : kind}`, pc: new URL(peer.url).origin, ...(id ? { id } : {}), ...(ts && !id ? { ts } : {}) };
}

const recent = new Map<string, number>();
// Resolves once every device has been decided (sent, covered by a peer, or quiet by its own setting).
export function notify(m: PushMessage): Promise<void> {
	const key = `${m.tag}|${m.body}`;
	const t = Date.now();
	for (const [k, at] of recent) if (t - at > DEDUPE_MS) recent.delete(k);
	if (recent.has(key)) return Promise.resolve();
	recent.set(key, t);
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
		const m = classify(e, ownerAt ? Date.now() - ownerAt : undefined);
		// A message that becomes a decision notice (an [ask] or a choice block) is pushed by onDecision below (one push, with the options), not twice.
		// The reply to a choice-button answer is quiet (notices.ts answerReply).
		if (m && !decisionsOf(e).length && !answerReply(e)) notify(m);
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
		return json({ publicKey: vapid().publicKey, kinds: PUSH_KINDS, subscribed: Boolean(s), prefs: s?.prefs ?? defaults(), app: s?.app === true, did: s?.did ?? "" });
	}
	if (req.method === "POST" && p === "/api/push/subscribe") {
		const sub = b.subscription as Subscription | undefined;
		if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "subscription with https endpoint and keys required" }, 400);
		const old = findSub(sub.endpoint);
		const prefs = { ...defaults(), ...(old?.prefs ?? {}), ...(b.prefs ?? {}) };
		const did = typeof b.did === "string" && DID.test(b.did) ? b.did : old?.did;
		const app = b.app === true || old?.app === true;
		if (!app && hasApp(did)) return json({ error: "this device gets its notifications through its app" }, 409);
		subs = [...subs.filter(s => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, prefs, ...(b.app === true || old?.app === true ? { app: true } : {}), ...(did ? { did } : {}), ua: String(req.headers.get("user-agent") ?? "").slice(0, 160), at: new Date().toISOString() }];
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
		const m = relayedMessage(peer, b);
		if (!m) return json({ error: "kind, title and body required" }, 400);
		const skip = new Set<string>(Array.isArray(b.skip) ? b.skip.filter((k: unknown): k is string => typeof k === "string" && k.length <= 80).slice(0, 200) : []);
		const done = new Set(skip);
		cover(b.via === "app" ? subs.filter(s => s.app === true) : subs, m, done);
		return json({ ok: true, served: [...done].filter(k => !skip.has(k)) });
	}
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
	if (req.method === "PUT" && p === "/api/push/prefs") {
		const s = findSub(b.endpoint);
		if (!s) return json({ error: "not subscribed" }, 404);
		for (const k of PUSH_KINDS) if (typeof b.prefs?.[k] === "boolean") s.prefs[k] = b.prefs[k];
		save();
		return json({ ok: true, prefs: s.prefs });
	}
	// A page that is open and visible quiets its device's subscriptions here. The same device (`did`) is quieted on the other computers too: the page shows
	// their notices as toasts (hub/peer-stream.ts), so a push there would be a second alert. The forward carries `relayed` and is never sent on.
	if (req.method === "POST" && p === "/api/push/presence") {
		const mark = (endpoint: string) => (b.active ? presence.set(endpoint, Date.now()) : presence.delete(endpoint));
		if (typeof b.endpoint === "string") mark(b.endpoint);
		const did = typeof b.did === "string" && DID.test(b.did) ? b.did : typeof b.endpoint === "string" ? findSub(b.endpoint)?.did : undefined;
		if (did) for (const s of subs) if (s.did === did) mark(s.endpoint);
		if (did && b.relayed !== true) void forwardPresence(did, b.active === true);
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
