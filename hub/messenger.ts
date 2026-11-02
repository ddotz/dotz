import { parseChoices } from "./choices.ts";
import { log } from "./config.ts";
import { postKind } from "./discord-post.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { listNotices, NOTICE_CAP } from "./notices.ts";

// A generic messenger layer: any chat service (Telegram, JANDI, ...) is an Adapter. Outgoing posts reach every non-native adapter
// through one outbox subscription (installFanout); incoming owner messages enter through ctx.receive, like a web message.
// Discord keeps its own send path (hub/outbound.ts) and is registered as a native adapter, so the fan-out skips it.

export type Kind = "main" | "project" | "lane" | "alert" | "worklog";
export type AdapterStatus = { state: "off" | "connecting" | "ok" | "error"; error?: string };
export type OutMsg = { target: string; kind: Kind; text: string; replyTo?: string; updateKey?: string; options?: { n: number; label: string }[]; files?: string[] };
export type DeliverResult = { delivered: boolean; reason?: string; ids?: string[] };
export type Incoming = { adapter: string; target: string; text: string; author: string; replyTo?: string; messageId?: string; quoted?: string };
export type MessengerCtx = { receive(m: Incoming): void; log(s: string): void };
export type Adapter = {
	id: string;
	label: string;
	enabled(): boolean;
	status: AdapterStatus;
	start(ctx: MessengerCtx): void | Promise<void>;
	stop(): void | Promise<void>;
	deliver(msg: OutMsg): Promise<DeliverResult>;
	edit?(target: string, id: string, text: string): Promise<DeliverResult>;
	canEdit: boolean;
	canButtons: boolean;
	// Has its own send path (Discord): the fan-out never delivers to it.
	native?: boolean;
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
export const adapters = (): Adapter[] => [...registry.values()];
export const get = (id: string): Adapter | undefined => registry.get(id);

export async function startAll(ctx: MessengerCtx): Promise<void> {
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
function outMsg(e: HubEvent): OutMsg | undefined {
	const kind = typeof e.target === "string" ? kindOf(e.target) : undefined;
	if (!kind || typeof e.text !== "string" || !e.text) return undefined;
	const files = [...e.text.matchAll(FILE_LINE)].map(m => m[1]!);
	const options = parseChoices(e.text).options.map(o => ({ n: o.n, label: o.label }));
	return {
		target: e.target as string,
		kind,
		text: e.text,
		...(typeof e.reply_to === "string" ? { replyTo: e.reply_to } : {}),
		...(typeof e.update_key === "string" ? { updateKey: e.update_key } : {}),
		...(options.length ? { options } : {}),
		...(files.length ? { files } : {}),
	};
}

function fail(a: Adapter, e: unknown): void {
	a.status = { state: "error", error: String(e) };
	log(`messenger ${a.id} delivery failed: ${e}`);
}

let fanout = false;
/** One outbox subscription: every "out" event goes to each enabled, non-native adapter that is up. A failing adapter never reaches emit. */
export function installFanout(): void {
	if (fanout) return;
	fanout = true;
	onEmit(e => {
		if (e.kind !== "out") return;
		const msg = outMsg(e);
		if (!msg) return;
		for (const a of registry.values()) {
			if (a.native || a.status.state !== "ok" || !a.enabled()) continue;
			try {
				void a.deliver(msg).catch(err => fail(a, err));
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
	const open = listNotices(NOTICE_CAP).items.filter(i => i.decision?.state === "open" && i.decision.to === to && i.decision.options.some(o => o.n === pick.n));
	const item = open.sort((a, b) => b.updated.localeCompare(a.updated))[0];
	if (!item) return false;
	return (await applier(item.id, pick, author)).status === 200;
}

/** The ctx adapters get: an incoming message answers an open decision when it is an option number, else `enter` takes it as an owner message. */
export function makeCtx(enter: (m: Incoming) => Promise<void>): MessengerCtx {
	return {
		receive: m => {
			void (async () => {
				if (await answerAsk(m.target, m.text, m.author)) return;
				await enter(m);
			})().catch(e => log(`messenger ${m.adapter} message from ${m.author} failed: ${e}`));
		},
		log: s => log(s),
	};
}
