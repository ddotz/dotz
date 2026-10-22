// Mail as conversations: each mail (zele, a webmail watcher, a custom plugin) is one web conversation `mail:<key>`, and, with
// Discord on, one thread in the mail channel. A web message in that conversation reaches the orchestrator the way a message in
// the mail's Discord thread does (hub/intake.ts sendWeb `mail`). Posters come in through POST /api/mail (docs/custom-plugins.md).
// Discord and the event bus are injected (MailDeps), so this module has no hub imports beyond config.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, writeAtomic } from "./config.ts";

export type MailRecord = { key: string; source: string; id: string; subject: string; from: string; to?: string; at: string; thread?: string };
export type MailInput = { source: string; id: string; subject: string; from?: string; to?: string; summary?: string; body?: string; thread?: string; wake?: boolean };
export type MailResult = { ok: true; key: string; target: string; thread?: string; duplicate?: boolean };
export type MailDeps = {
	/** Opens a thread under `parent` (a work channel target `ch:<id>`) from a starter message; discord.ts createThread. */
	createThread: (parent: string, name: string, starter: string) => Promise<{ id: string }>;
	/** Posts into a thread (`th:<id>`); discord.ts send. */
	send: (target: string, text: string) => Promise<unknown>;
	/** The mail work channel id, made when missing; undefined without Discord. */
	mailChannel: () => Promise<string | undefined>;
	discordOn: boolean;
	emit: (event: Record<string, any>) => void;
	/** One orchestrator turn for the mail event, its answer going to `target`. */
	wake: (event: Record<string, any>, target: string) => void;
	now?: () => string;
};

export class MailError extends Error {
	status = 400;
}

const FILE = join(DATA_DIR, "mail-conversations.json");
const KEEP = 500;
const BODY_MAX = 20_000;
const SUMMARY_MAX = 2000;
const THREAD_ID = /^\d{15,22}$/;

const clean = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 100);

/** `${source}-${id}` limited to [a-z0-9._-]; throws when either part has nothing left. */
export function mailKey(source: string, id: string): string {
	const s = clean(source);
	const i = clean(id);
	if (!s || !i) throw new MailError(`mail key needs a source and an id with letters or digits (got "${source}", "${id}")`);
	return `${s}-${i}`;
}

export const mailTarget = (key: string) => `mail:${key}`;

let records: MailRecord[] = [];
try {
	if (existsSync(FILE)) records = JSON.parse(readFileSync(FILE, "utf8"));
} catch (error) {
	log(`mail: ${FILE} unreadable, starting empty: ${error}`);
}
const byKey = new Map(records.map(r => [r.key, r]));

export const mailByKey = (key: string): MailRecord | undefined => byKey.get(key);
export const mailByThread = (thread: string): MailRecord | undefined => records.find(r => r.thread === thread);
export const mailTargets = (): string[] => [...records].sort((a, b) => b.at.localeCompare(a.at)).map(r => mailTarget(r.key));

export function recordMail(r: MailRecord): void {
	byKey.set(r.key, r);
	records = [...records.filter(x => x.key !== r.key), r].sort((a, b) => a.at.localeCompare(b.at)).slice(-KEEP);
	for (const k of [...byKey.keys()]) if (!records.some(x => x.key === k)) byKey.delete(k);
	writeAtomic(FILE, `${JSON.stringify(records, null, 2)}\n`);
}

const str = (v: unknown, name: string, max: number, required: boolean): string | undefined => {
	if (v === undefined || v === null || (!required && v === "")) {
		if (required) throw new MailError(`${name} is required`);
		return undefined;
	}
	if (typeof v !== "string") throw new MailError(`${name} must be a string`);
	const t = v.trim();
	if (required && !t) throw new MailError(`${name} is required`);
	return t.slice(0, max);
};

export function parseMail(raw: unknown): MailInput {
	if (!raw || typeof raw !== "object") throw new MailError("body must be a JSON object");
	const b = raw as Record<string, unknown>;
	const thread = str(b.thread, "thread", 30, false);
	if (thread && !THREAD_ID.test(thread)) throw new MailError("thread must be a Discord thread id (15-22 digits)");
	if (b.wake !== undefined && typeof b.wake !== "boolean") throw new MailError("wake must be a boolean");
	return {
		source: str(b.source, "source", 60, true)!,
		id: str(b.id, "id", 200, true)!,
		subject: str(b.subject, "subject", 300, true)!,
		from: str(b.from, "from", 300, false),
		to: str(b.to, "to", 500, false),
		summary: str(b.summary, "summary", SUMMARY_MAX, false),
		body: str(b.body, "body", BODY_MAX, false),
		thread,
		wake: b.wake === true,
	};
}

export function mailText(m: Pick<MailInput, "from" | "subject" | "summary" | "body">): string {
	return [m.from ? `${m.from} · ${m.subject}` : m.subject, m.summary ?? "", m.body ? `원문\n${m.body}` : ""].filter(Boolean).join("\n\n");
}

// A watcher retrying the same mail while the first post still opens its thread must not open a second one.
const inflight = new Map<string, Promise<MailResult>>();

export async function postMail(raw: unknown, deps: MailDeps): Promise<MailResult> {
	const m = parseMail(raw);
	const key = mailKey(m.source, m.id);
	const target = mailTarget(key);
	const known = byKey.get(key);
	if (known) return { ok: true, key, target, ...(known.thread ? { thread: known.thread } : {}), duplicate: true };
	const running = inflight.get(key);
	if (running) return { ...(await running), duplicate: true };
	const job = post(m, key, target, deps);
	inflight.set(key, job);
	try {
		return await job;
	} finally {
		inflight.delete(key);
	}
}

async function post(m: MailInput, key: string, target: string, deps: MailDeps): Promise<MailResult> {
	let thread = m.thread;
	let parent: string | undefined;
	if (!thread && deps.discordOn) {
		try {
			const channel = await deps.mailChannel();
			if (channel) {
				const starter = [m.from ?? "", m.summary ?? ""].filter(Boolean).join("\n").slice(0, 1900) || m.subject;
				thread = (await deps.createThread(`ch:${channel}`, m.subject, starter)).id;
				parent = `ch:${channel}`;
				if (m.body) await deps.send(`th:${thread}`, `원문\n${m.body}`).catch(e => log(`mail ${key}: body not posted to its thread: ${e}`));
			}
		} catch (error) {
			log(`mail ${key}: no Discord thread (${(error as Error).message}); web conversation only`);
		}
	}
	const at = deps.now?.() ?? new Date().toISOString();
	recordMail({ key, source: m.source, id: m.id, subject: m.subject, from: m.from ?? "", ...(m.to ? { to: m.to } : {}), at, ...(thread ? { thread } : {}) });
	const event = { ts: at, kind: "mail", source: m.source, channel: target, conv: target, mail: key, subject: m.subject, from: m.from ?? "", ...(thread ? { thread } : {}), ...(parent ? { parent } : {}), text: mailText(m) };
	deps.emit(event);
	if (m.wake) deps.wake(event, thread ? `th:${thread}` : target);
	return { ok: true, key, target, ...(thread ? { thread } : {}) };
}
