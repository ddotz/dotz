import { parseChoices } from "./choices.ts";
import { log } from "./config.ts";
import { postKind } from "./discord-post.ts";
import { type HubEvent, onEmit } from "./events.ts";
import type { Upload } from "./files.ts";
import { postClass, route } from "./notify-route.ts";
import { allNotices } from "./notices.ts";
import type { Peer } from "./peers.ts";
import { convPath, webLink } from "./weblink.ts";

// A generic messenger layer: any chat service (Telegram, JANDI, ...) is an Adapter. Outgoing posts reach the non-native adapters whose
// class switch is on (hub/notify-route.ts) through one outbox subscription (installFanout); incoming owner messages enter through ctx.receive, like a web message.
// Discord keeps its own send path (hub/outbound.ts) and is registered as a native adapter, so the fan-out skips it.

export type Kind = "main" | "project" | "lane" | "alert" | "worklog";
export type AdapterStatus = { state: "off" | "connecting" | "ok" | "error"; error?: string };
export type OutMsg = { target: string; kind: Kind; text: string; replyTo?: string; updateKey?: string; options?: { n: number; label: string }[]; files?: string[]; /** A gateway status line, not an answer (see gatewayNote). */ gatewayNote?: true; /** The conversation's address in the web app, when there is one. */ link?: string };
export type DeliverResult = { delivered: boolean; reason?: string; ids?: string[] };
/** `files`: what the message carried, already saved locally (hub/files.ts Upload); the turn gets one [attachment] line per file. */
export type Incoming = { adapter: string; target: string; text: string; author: string; replyTo?: string; messageId?: string; quoted?: string; files?: Upload[] };
/** A phone notification an adapter raises for something that reached it outside the owner's own conversations (hub/push.ts notify). */
export type AdapterPush = { kind: "ask" | "result" | "conv"; title: string; body: string; url: string; tag: string };
export type MessengerCtx = { receive(m: Incoming): void; log(s: string): void; notify?(m: AdapterPush): void };
/** One line of a conversation with a computer reached through a messenger: `me` is the owner's own line, `at` its time in ms (0 = unknown). */
export type RelayLine = { id: number; at: number; me: boolean; text: string };
/** A row of the computer list (hub/peers.ts) reached through a messenger: `key` names it to the adapter, `note` is the adapter's one line about the transport. */
export type RelayRow = Peer & { key: string; note: string };
/** What a relay refuses or cannot reach; the route answers with `status` and the message. */
export class RelayError extends Error {
	status: 404 | 502;
	constructor(message: string, status: 404 | 502 = 502) {
		super(message);
		this.status = status;
	}
}
// The generic settings schema every adapter describes itself with (served by hub/messengers-api.ts, drawn by web/js/25-settings-messengers.js).
// Secrets are write-only: a GET never carries a secret value, only `set`; a PUT that omits a secret keeps it, "" clears it.
export type SettingsField = { key: string; label: string; type: "text" | "secret" | "number" | "readonly" | "copy" | "select"; value?: string | number; set?: boolean; hint?: string; as_user?: boolean; /** The choices of a "select" field (a room field; its value is the room's `values[key]`). */ options?: { value: string; label: string }[] };
export type SettingsRoom = {
	id: string;
	name: string;
	kind: string;
	project?: { target: string; name: string };
	values: Record<string, string | number>;
	set: Record<string, boolean>;
	last_in?: number;
	last_out?: number;
	last_error?: string;
};
export type Settings = {
	enabled: boolean;
	help: string[];
	fields: SettingsField[];
	allow?: { label: string; hint?: string; items: string[] };
	/** `hint` is the one line of setup an adapter cannot do itself (hub/messenger-rooms.ts); the rooms themselves are made and mapped by the gateway. */
	rooms?: { label: string; fields: SettingsField[]; items: SettingsRoom[]; editable: boolean; hint?: string };
	projects: { target: string; name: string }[];
	/** Another settings screen that owns the real controls (Discord). */
	link?: { label: string; view: string };
	/** Which notice classes this messenger receives (hub/notify-route.ts); filled in by hub/messengers-api.ts, set with PUT { notify }. */
	notify?: Record<string, boolean>;
};
/** A room the web app's conversation structure calls for (hub/messenger-rooms.ts desiredRooms): main, alert, worklog and one per project. */
export type DesiredRoom = { kind: "main" | "project" | "alert" | "worklog"; name: string; project?: string };
export type SettingsPut = { enabled?: boolean; values?: Record<string, unknown>; allow?: string[]; rooms?: { id?: string; name?: string; kind?: string; project?: string; values?: Record<string, unknown> }[] };
export type TestResult = { results: { id: string; name: string; ok: boolean; status?: number; error?: string }[] };
/** A settings body the adapter refuses; the route answers 400 with the message. */
export class SettingsError extends Error {}

export type Adapter = {
	id: string;
	label: string;
	enabled(): boolean;
	/** Has what it needs to connect (a token, a room); the list shows 설정 안 됨 until then, even while switched off. */
	configured?: () => boolean;
	status: AdapterStatus;
	start(ctx: MessengerCtx): void | Promise<void>;
	stop(): void | Promise<void>;
	deliver(msg: OutMsg): Promise<DeliverResult>;
	edit?(target: string, id: string, text: string): Promise<DeliverResult>;
	canEdit: boolean;
	canButtons: boolean;
	// Has its own send path (Discord): the fan-out never delivers to it.
	native?: boolean;
	settings?(): Settings;
	saveSettings?(body: SettingsPut): Settings;
	test?(): Promise<TestResult>;
	/** Creates or maps the rooms of `desired` in this messenger's own config (only when it is switched on); existing rooms and their keys stay. */
	syncRooms?(desired: DesiredRoom[]): Promise<void>;
	/** Left out of the settings list (an adapter another module owns while it is unfinished). */
	hidden?(): boolean;
	/** Computers with no address of their own that this messenger carries a conversation to (the web app's chat view, /api/relay/<id>/<key>/messages|send). */
	relay?: {
		rows(): Promise<RelayRow[]>;
		lines(key: string): Promise<RelayLine[]>;
		send(key: string, text: string): Promise<void>;
		note: string;
	};
	/** deliver() places msg.link itself (JANDI's connect info, Telegram's URL button, Slack's link). Absent: the fan-out appends it to the text as a last line. */
	ownsLink?: true;
};

/** The kind of conversation a target belongs to, or undefined for targets that live in the web only (mail:, settings:). */
export function kindOf(target: string): Kind | undefined {
	if (target.startsWith("mail:") || target.startsWith("settings:")) return undefined;
	if (target === "web:alert") return "alert";
	if (target === "web:worklog") return "worklog";
	if (target.startsWith("ch:") || target.startsWith("th:")) return "project";
	const k = postKind(target);
	return k === "chat" ? "main" : k === "lanes" ? "lane" : k;
}

const registry = new Map<string, Adapter>();
export const register = (a: Adapter): void => void registry.set(a.id, a);
export const unregister = (id: string): void => void registry.delete(id);
export const adapters = (): Adapter[] => [...registry.values()];
export const get = (id: string): Adapter | undefined => registry.get(id);

let startCtx: MessengerCtx | undefined;
export async function startAll(ctx: MessengerCtx): Promise<void> {
	startCtx = ctx;
	for (const a of registry.values()) {
		if (!a.enabled()) continue;
		try {
			await a.start(ctx);
		} catch (e) {
			a.status = { state: "error", error: String(e) };
			log(`messenger ${a.id} failed to start: ${e}`);
		}
	}
}
/** Stop and start one adapter again (its settings changed); it stays off when disabled. */
export async function restart(a: Adapter): Promise<void> {
	await a.stop();
	if (!startCtx || !a.enabled()) return;
	try {
		await a.start(startCtx);
	} catch (e) {
		a.status = { state: "error", error: String(e) };
		log(`messenger ${a.id} failed to start: ${e}`);
	}
}
export async function stopAll(): Promise<void> {
	for (const a of registry.values()) {
		try {
			await a.stop();
		} catch (e) {
			log(`messenger ${a.id} failed to stop: ${e}`);
		}
	}
}

const FILE_LINE = /^[ \t]*\[file\][ \t]+(.+?)[ \t]*$/gm;
// A deferral receipt, or the gateway's own record for the web conversation or the work log (a restart, an update). Asks, alerts and failures are never this.
const gatewayNote = (e: HubEvent, target: string, kind: Kind, text: string): boolean =>
	!!e.system || (e.source === "gateway" && (target === "web" || kind === "worklog") && !postClass(target, text, e) && !/^\[fail\]/i.test(text));
function outMsg(e: HubEvent): OutMsg | undefined {
	const kind = typeof e.target === "string" ? kindOf(e.target) : undefined;
	if (!kind || typeof e.text !== "string" || !e.text) return undefined;
	const files = [...e.text.matchAll(FILE_LINE)].map(m => m[1]!);
	const options = parseChoices(e.text).options.map(o => ({ n: o.n, label: o.label }));
	const path = convPath(kind, e.target as string);
	const link = path ? webLink(path) : undefined;
	return {
		target: e.target as string,
		kind,
		text: e.text,
		...(typeof e.reply_to === "string" ? { replyTo: e.reply_to } : {}),
		...(typeof e.update_key === "string" ? { updateKey: e.update_key } : {}),
		...(options.length ? { options } : {}),
		...(files.length ? { files } : {}),
		...(gatewayNote(e, e.target as string, kind, e.text) ? { gatewayNote: true as const } : {}),
		...(link ? { link } : {}),
	};
}

// A delivery failure shows as an error but does not take the adapter out of the fan-out (a LAN hiccup must not mute it until restart);
// the next delivery that works sets it back to ok. A start failure (startAll) stays out.
const deliveryFailed = new Set<string>();
function fail(a: Adapter, e: unknown): void {
	deliveryFailed.add(a.id);
	a.status = { state: "error", error: String(e) };
	log(`messenger ${a.id} delivery failed: ${e}`);
}

// The default way a web link reaches a messenger: a last line of the text (an adapter that sets ownsLink gets msg.link as it is).
const shaped = (a: Adapter, msg: OutMsg): OutMsg => {
	if (!msg.link || a.ownsLink) return msg;
	const { link, ...rest } = msg;
	return { ...rest, text: `${msg.text}\n\n웹에서 보기: ${link}` };
};

let fanout = false;
/** One outbox subscription: every "out" event goes to each enabled, non-native adapter that is up and whose switch for the post's class is on. A failing adapter never reaches emit. */
export function installFanout(): void {
	if (fanout) return;
	fanout = true;
	onEmit(e => {
		if (e.kind !== "out") return;
		const msg = outMsg(e);
		if (!msg) return;
		const live = [...registry.values()].filter(a => !a.native && (a.status.state === "ok" || deliveryFailed.has(a.id)) && a.enabled());
		const wants = route({ target: msg.target, text: msg.text, extra: e, messengers: live.map(a => a.id) }).messengers;
		for (const a of live) {
			if (!wants[a.id]) continue;
			try {
				void a
					.deliver(shaped(a, msg))
					.then(r => {
						if (r.delivered && deliveryFailed.delete(a.id)) a.status = { state: "ok" };
					})
					.catch(err => fail(a, err));
			} catch (err) {
				fail(a, err);
			}
		}
	});
}

/** "1", "1)", "1.", "2) 고치기 - 이유" are an option number (with the owner's note after " - "); "10개 주세요", "1등이야", "" are not. */
export function parseAskNumber(text: string): { n: number; note?: string } | undefined {
	const m = /^\s*(\d{1,3})(?:[).](?:\s+(.*))?)?\s*$/s.exec(text);
	const n = m ? Number(m[1]) : 0;
	if (!m || n < 1) return undefined;
	const rest = m[2] ?? "";
	const dash = rest.search(/\s[-–—]\s/);
	const note = (dash < 0 ? "" : rest.slice(dash).replace(/^\s[-–—]\s/, "")).replace(/\s+/g, " ").trim();
	return { n, ...(note ? { note } : {}) };
}

// The same answer path the web card's button takes (hub/approval-wire.ts webAnswer, wired in hub/main.ts).
type Applier = (id: string, body: { n: number; note?: string }, login: string) => Promise<{ status: number }>;
let applier: Applier | undefined;
export const setAskApplier = (fn: Applier): void => {
	applier = fn;
};

// A decision's `to` names the conversation it was asked in ("main" for the web and terminal chat).
const decisionTo = (target: string) => (target === "web" || target === "terminal" ? "main" : target);

/** Answers the open decision of `target` when `text` is a valid option number; false leaves the text an ordinary message. */
export async function answerAsk(target: string, text: string, author = "owner"): Promise<boolean> {
	const pick = parseAskNumber(text);
	if (!pick || !applier) return false;
	const to = decisionTo(target);
	const open = allNotices().filter(i => i.decision?.state === "open" && i.decision.to === to && i.decision.options.some(o => o.n === pick.n));
	const item = open.sort((a, b) => b.updated.localeCompare(a.updated))[0];
	if (!item) return false;
	return (await applier(item.id, pick, author)).status === 200;
}

/** The ctx adapters get: an incoming message answers an open decision when it is an option number, else `enter` takes it as an owner message. */
export function makeCtx(enter: (m: Incoming) => Promise<void>, notify?: (m: AdapterPush) => void): MessengerCtx {
	return {
		...(notify ? { notify } : {}),
		receive: m => {
			void (async () => {
				// A number sent with a file is a message about that file, not a pick.
				if (!m.files?.length && (await answerAsk(m.target, m.text, m.author))) return;
				await enter(m);
			})().catch(e => log(`messenger ${m.adapter} message from ${m.author} failed: ${e}`));
		},
		log: s => log(s),
	};
}
