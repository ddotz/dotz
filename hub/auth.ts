// Web-login auth requests answered from Discord or the web app: the gateway posts a Discord message with buttons (when
// Discord is set up), a button opens a modal, and the submitted value is delivered by INTERACTION_CREATE to this process
// only. The same pending request also shows in the web app (GET /api/state `auth`), answered by POST /api/auth/<id>, so a
// login asked for before Discord is connected (the Discord bot setup itself) no longer dead-ends. It is written to a 0600 secrets file (secret),
// held in memory until it is taken once (otp) or not kept at all (approve). Values are never logged, put in events, state
// or any prompt: log lines carry id, site, kind and status only. See hub/main.ts for the /api/auth* routes.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { cfg, DATA_DIR, HUB_TOKEN, log, TZ, writeAtomic } from "./config.ts";
import * as discord from "./discord.ts";
import { msg } from "./i18n.ts";
import { notify } from "./push.ts";

type Kind = "secret" | "otp" | "approve";
type Field = "username" | "password" | "code";
type Status = "pending" | "entered" | "approved" | "cancelled" | "timeout";
type AuthRequest = {
	id: string;
	site: string;
	kind: Kind;
	fields: Field[];
	purpose: string;
	expiresAt: number;
	status: Status;
	channelId: string;
	messageId: string;
	path?: string;
	otp?: string;
	timer?: ReturnType<typeof setTimeout>;
	waiters: Set<() => void>;
};

const PREFIX = "dotz-auth";
const SITE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TARGET_RE = /^(chat|alert|worklog|dm|lane:.+|ch:\d+|th:\d+)$/;
const FIELDS: Field[] = ["username", "password", "code"];
const DEFAULT_MINUTES = 10;
const MAX_MINUTES = 30;
const KEEP_MS = 30 * 60_000;
const OTP_MS = 5 * 60_000;
const MAX_WAIT_S = 55;
const OWNER = String(cfg.discord?.owner_id ?? "");
const RESERVED = new Set(["hub-token", "discord-bot-token", basename(String(cfg.discord?.token_file ?? "")).toLowerCase()].filter(Boolean));
const SECRETS_DIR = join(DATA_DIR, "secrets");
const reqs = new Map<string, AuthRequest>();

// Plain text like every gateway message (MODE "Message layout"): one leading status emoji, no embed.
const MARKS: Record<Status, string> = { pending: "❓", entered: "✅", approved: "✅", cancelled: "❌", timeout: "❌" };
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

function contentOf(r: AuthRequest): string {
	const m = msg().auth;
	const head = `${MARKS[r.status]} ${m.titles[r.kind]} (${m.site}: ${r.site})`;
	const tail = r.status === "pending" ? m.expires(clock.format(r.expiresAt)) : m.statuses[r.status];
	return `${head}\n${r.purpose}\n${tail}`.slice(0, 1900);
}

function componentsOf(r: AuthRequest) {
	const m = msg().auth;
	const off = r.status !== "pending";
	const button = (action: string, label: string, style: number) => ({ type: 2, style, label, custom_id: `${PREFIX}:${r.id}:${action}`, disabled: off });
	return [{ type: 1, components: [r.kind === "approve" ? button("approve", m.approve, 3) : button("input", m.input, 1), button("cancel", m.cancel, 2)] }];
}

const view = (r: AuthRequest) => ({
	id: r.id,
	site: r.site,
	kind: r.kind,
	status: r.status,
	...(r.status === "entered" && r.path ? { path: r.path } : {}),
	...(r.otp !== undefined ? { take: `/api/auth/${r.id}/take` } : {}),
});

// A request is finished once, whoever finishes it: the timer, an owner click, a modal submit or DELETE.
function settle(r: AuthRequest, status: Status): void {
	if (r.status !== "pending") return;
	r.status = status;
	clearTimeout(r.timer);
	log(`auth ${r.id} ${r.site} ${r.kind} ${status}`);
	for (const wake of [...r.waiters]) wake();
	setTimeout(() => reqs.delete(r.id), KEEP_MS).unref();
}

// Re-renders the original message (text + buttons) after a change that did not come from a button on it.
const refresh = (r: AuthRequest): void => {
	if (!r.messageId) return;
	void discord.editRich(r.channelId, r.messageId, { content: contentOf(r), components: componentsOf(r) }).catch(e => log(`auth ${r.id} message update failed: ${e}`));
};

function waitChange(r: AuthRequest, seconds: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = () => {
		clearTimeout(timer);
		r.waiters.delete(done);
		signal.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, seconds * 1000);
	r.waiters.add(done);
	signal.addEventListener("abort", done);
	return promise;
}

// ---- Discord interactions ----

const ephemeral = (content: string) => ({ content, flags: 64, allowed_mentions: { parse: [] } });
const reply = (d: discord.Interaction, type: number, data?: unknown) => discord.interactionCallback(d, type, data);

function modalOf(r: AuthRequest) {
	const m = msg().auth;
	return {
		custom_id: `${PREFIX}:${r.id}`,
		title: m.modalTitle(r.site).slice(0, 45),
		components: r.fields.map(f => ({ type: 1, components: [{ type: 4, custom_id: f, label: m.labels[f], style: 1, required: true, min_length: 1, max_length: 1000 }] })),
	};
}

// Takes the values of a modal submit; undefined unless every requested field arrived non-empty.
function submitted(d: discord.Interaction, fields: Field[]): Record<string, string> | undefined {
	const got: Record<string, string> = {};
	for (const row of d.data?.components ?? []) for (const c of row.components ?? []) if (typeof c.custom_id === "string" && typeof c.value === "string") got[c.custom_id] = c.value;
	const out: Record<string, string> = {};
	for (const f of fields) {
		if (!got[f]) return undefined;
		out[f] = got[f];
	}
	return out;
}

function store(r: AuthRequest, values: Record<string, string>): void {
	if (r.kind === "secret") {
		mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
		chmodSync(SECRETS_DIR, 0o700);
		const file = join(SECRETS_DIR, r.site);
		writeAtomic(file, `${JSON.stringify(values)}\n`, 0o600);
		r.path = file;
	} else {
		r.otp = values.code;
		setTimeout(() => {
			r.otp = undefined;
		}, OTP_MS).unref();
	}
}

async function interaction(d: discord.Interaction): Promise<void> {
	const cid = String(d?.data?.custom_id ?? "");
	if (!cid.startsWith(`${PREFIX}:`)) return;
	const m = msg().auth;
	const [, id, action] = cid.split(":");
	const user = String(d.member?.user?.id ?? d.user?.id ?? "");
	if (!OWNER || user !== OWNER) {
		log(`auth ${id} refused user ${user}`);
		return reply(d, 4, ephemeral(m.notOwner));
	}
	const r = reqs.get(id);
	if (!r || r.status !== "pending") return reply(d, 4, ephemeral(m.finished));
	if (d.type === 3) {
		if (action === "input" && r.kind !== "approve") return reply(d, 9, modalOf(r));
		if (action === "approve" && r.kind === "approve") settle(r, "approved");
		else if (action === "cancel") settle(r, "cancelled");
		else return reply(d, 4, ephemeral(m.finished));
		return reply(d, 7, { content: contentOf(r), components: componentsOf(r) });
	}
	if (d.type === 5 && action === undefined && r.kind !== "approve") {
		const values = submitted(d, r.fields);
		if (!values) return reply(d, 4, ephemeral(m.incomplete));
		try {
			store(r, values);
		} catch (e) {
			log(`auth ${r.id} ${r.site} ${r.kind} store failed: ${e}`);
			return reply(d, 4, ephemeral(m.storeFailed));
		}
		settle(r, "entered");
		await reply(d, 4, ephemeral(m.received));
		refresh(r);
		return;
	}
	return reply(d, 4, ephemeral(m.finished));
}

discord.setInteractionHandler(d => {
	interaction(d).catch(e => log(`auth interaction failed: ${e}`));
});

// ---- HTTP ----

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (error: string, status: number) => json({ error }, status);

async function create(req: Request): Promise<Response> {
	const b = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if (!b || typeof b !== "object" || Array.isArray(b)) return err("body must be a JSON object", 400);
	const kind = b.kind;
	if (kind !== "secret" && kind !== "otp" && kind !== "approve") return err("kind must be secret, otp or approve", 400);
	const site = b.site;
	if (typeof site !== "string" || !SITE_RE.test(site)) return err("site must match /^[a-z0-9][a-z0-9._-]{0,63}$/", 400);
	if (kind === "secret" && RESERVED.has(site)) return err(`site ${site} is reserved`, 400);
	const purpose = typeof b.purpose === "string" ? b.purpose.trim().slice(0, 500) : "";
	if (!purpose) return err("purpose is required", 400);
	const target = b.target;
	if (typeof target !== "string" || !TARGET_RE.test(target)) return err("target must be chat, alert, lane:<name>, ch:<id> or th:<id>", 400);
	const minutes = b.timeout_minutes === undefined ? DEFAULT_MINUTES : b.timeout_minutes;
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) return err(`timeout_minutes must be in (0, ${MAX_MINUTES}]`, 400);
	let fields: Field[] = kind === "secret" ? ["username", "password"] : kind === "otp" ? ["code"] : [];
	if (b.fields !== undefined) {
		if (!Array.isArray(b.fields) || b.fields.some(f => !FIELDS.includes(f as Field))) return err("fields must be a list of username, password, code", 400);
		if (kind === "secret") fields = [...new Set(b.fields as Field[])];
		if (kind === "secret" && !fields.length) return err("fields must not be empty for secret", 400);
	}
	const r: AuthRequest = { id: randomBytes(6).toString("hex"), site, kind, fields, purpose, expiresAt: Date.now() + minutes * 60_000, status: "pending", channelId: "", messageId: "", waiters: new Set() };
	// Discord is one way to answer; the web app is always the other, so a failed or missing Discord post is not fatal.
	if (discord.status.enabled) {
		try {
			const sent = await discord.postRich(target, { content: contentOf(r), components: componentsOf(r) });
			r.channelId = sent.channelId;
			r.messageId = sent.messageId;
		} catch (e) {
			log(`auth ${r.id} ${r.site}: discord post to ${target} failed, web only: ${e}`);
		}
	}
	reqs.set(r.id, r);
	notify({ kind: "ask", title: msg().auth.titles[kind], body: purpose.slice(0, 160), url: "/", tag: `auth-${r.id}` });
	r.timer = setTimeout(() => {
		settle(r, "timeout");
		refresh(r);
	}, minutes * 60_000);
	log(`auth ${r.id} ${r.site} ${r.kind} pending`);
	return json({ id: r.id });
}

// OTP values leave the gateway only to a caller holding the hub token itself: a tailscale-authorized web login gets 403.
function takeOtp(req: Request, r: AuthRequest | undefined): Response {
	const sent = Buffer.from(req.headers.get("x-dotz-token") ?? "");
	const real = Buffer.from(HUB_TOKEN);
	if (sent.length !== real.length || !timingSafeEqual(sent, real)) return new Response("forbidden", { status: 403 });
	if (!r) return err("unknown request", 404);
	if (r.kind !== "otp") return err("not an otp request", 400);
	if (r.status === "pending") return err("not entered yet", 409);
	const value = r.otp;
	r.otp = undefined;
	if (value === undefined) return new Response("gone", { status: 410 });
	log(`auth ${r.id} ${r.site} ${r.kind} taken`);
	return new Response(value, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// Pending requests for the web app: no values, only what the form needs.
export function pendingAuth() {
	const m = msg().auth;
	return [...reqs.values()].filter(r => r.status === "pending").map(r => ({ id: r.id, site: r.site, kind: r.kind, title: m.titles[r.kind], purpose: r.purpose, expiresAt: new Date(r.expiresAt).toISOString(), fields: r.fields.map(f => ({ name: f, label: m.labels[f] })) }));
}

// The web app's answer: {action: "submit", values} | {action: "approve"} | {action: "cancel"}. The caller already passed
// the gateway's owner check (hub token or an allowed tailnet login).
async function answer(req: Request, r: AuthRequest | undefined): Promise<Response> {
	if (!r) return err("unknown request", 404);
	if (r.status !== "pending") return json(view(r));
	const b = (await req.json().catch(() => undefined)) as { action?: unknown; values?: unknown } | undefined;
	const action = b?.action;
	if (action === "cancel") settle(r, "cancelled");
	else if (action === "approve" && r.kind === "approve") settle(r, "approved");
	else if (action === "submit" && r.kind !== "approve") {
		const raw = (b?.values && typeof b.values === "object" ? b.values : {}) as Record<string, unknown>;
		const values: Record<string, string> = {};
		for (const f of r.fields) {
			const v = raw[f];
			if (typeof v !== "string" || !v || v.length > 1000) return err(`${f} is required`, 400);
			values[f] = v;
		}
		try {
			store(r, values);
		} catch (e) {
			log(`auth ${r.id} ${r.site} ${r.kind} store failed: ${e}`);
			return err("store failed", 500);
		}
		settle(r, "entered");
	} else return err("action must be submit, approve or cancel", 400);
	refresh(r);
	return json({ id: r.id, status: r.status });
}

export function authRoute(req: Request, url: URL): Promise<Response> | undefined {
	if (url.pathname !== "/api/auth" && !url.pathname.startsWith("/api/auth/")) return undefined;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length === 2) return req.method === "POST" ? create(req) : Promise.resolve(err("method not allowed", 405));
	const r = reqs.get(parts[2]);
	if (parts.length === 4 && parts[3] === "take" && req.method === "GET") return Promise.resolve(takeOtp(req, r));
	if (parts.length !== 3) return Promise.resolve(err("not found", 404));
	if (req.method === "DELETE") {
		if (!r) return Promise.resolve(err("unknown request", 404));
		if (r.status === "pending") {
			settle(r, "cancelled");
			refresh(r);
		}
		return Promise.resolve(json(view(r)));
	}
	if (req.method === "POST") return answer(req, r);
	if (req.method !== "GET") return Promise.resolve(err("method not allowed", 405));
	if (!r) return Promise.resolve(err("unknown request", 404));
	const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 0) || 0, 0), MAX_WAIT_S);
	if (r.status !== "pending" || wait === 0) return Promise.resolve(json(view(r)));
	return waitChange(r, wait, req.signal).then(() => json(view(r)));
}
