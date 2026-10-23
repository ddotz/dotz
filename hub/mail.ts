// Mail as conversations: each mail (zele, a webmail watcher, a custom plugin) is one web conversation `mail:<key>`, and, with
// Discord on, one thread in the mail channel. A web message in that conversation reaches the orchestrator the way a message in
// the mail's Discord thread does (hub/intake.ts sendWeb `mail`). Posters come in through POST /api/mail (docs/custom-plugins.md).
// Discord and the event bus are injected (MailDeps), so this module has no hub imports beyond config.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { DATA_DIR, log, writeAtomic } from "./config.ts";
import { FileError, safeName, serveFile } from "./files.ts";

/** One attached file of a mail. `file` is relative to the mail files folder (`<key>/<n>/<name>`); it never leaves that folder. */
export type MailAttachment = { name: string; type: string; size: number; file: string };
/** What a poster sends: the bytes inline (`data`, base64) or a file it already put in the mail files folder (`path`, absolute or relative to it). */
export type AttachmentInput = { name: string; type?: string; data?: string; path?: string };
export type MailRecord = { key: string; source: string; id: string; subject: string; from: string; to?: string; at: string; thread?: string; summary?: string; preview?: string; attachments?: MailAttachment[] };
export type MailInput = { source: string; id: string; subject: string; from?: string; to?: string; summary?: string; body?: string; thread?: string; wake?: boolean; attachments?: AttachmentInput[] };
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
	/** Offered every new mail (never a duplicate), fire-and-forget: a throw is logged and never breaks postMail. features/reply-drafts offers an [ask] reply draft here. */
	offerDraft?: (m: { key: string; target: string; thread?: string; source: string; id: string; subject: string; from?: string; to?: string; summary?: string; body?: string }) => void;
	now?: () => string;
};

export class MailError extends Error {
	status = 400;
}

const FILE = join(DATA_DIR, "mail-conversations.json");
/** Attachments live only here: <data dir>/mail-files/<key>/<n>/<name>. The route serves nothing outside it. */
export const MAIL_FILES = join(DATA_DIR, "mail-files");
const FILE_MAX_BYTES = 25 * 1024 * 1024;
const FILES_MAX = 10;
const PREVIEW_MAX = 240;
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

function parseAttachments(v: unknown): AttachmentInput[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (!Array.isArray(v)) throw new MailError("attachments must be an array");
	if (v.length > FILES_MAX) throw new MailError(`attachments: at most ${FILES_MAX} files`);
	return v.map((a, i) => {
		if (!a || typeof a !== "object") throw new MailError(`attachments[${i}] must be an object`);
		const { name, type, data, path } = a as Record<string, unknown>;
		if (typeof name !== "string" || !name.trim()) throw new MailError(`attachments[${i}].name is required`);
		if ((typeof data === "string") === (typeof path === "string")) throw new MailError(`attachments[${i}] needs exactly one of data (base64) or path`);
		return { name: name.slice(0, 200), ...(typeof type === "string" ? { type: type.slice(0, 100) } : {}), ...(typeof data === "string" ? { data } : { path: path as string }) };
	});
}

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
		attachments: parseAttachments(b.attachments),
	};
}

const real = (p: string): string | undefined => {
	try {
		return realpathSync(p);
	} catch {
		return undefined;
	}
};

/** The real path of `p` when it is a regular file inside MAIL_FILES (symlinks and `..` resolved first), else undefined. */
export function insideMailFiles(p: string): string | undefined {
	const root = real(MAIL_FILES);
	const r = real(isAbsolute(p) ? p : join(MAIL_FILES, p));
	return root && r && r.startsWith(root + sep) && statSync(r).isFile() ? r : undefined;
}

// Stores each attachment under mail-files/<key>/<n>/<safe name> and returns what the record keeps. A file that cannot be stored
// is skipped with a log line: the mail still opens, only that file is missing.
function saveAttachments(key: string, inputs: AttachmentInput[] | undefined): MailAttachment[] {
	const out: MailAttachment[] = [];
	for (const [n, a] of (inputs ?? []).entries()) {
		try {
			const name = safeName(a.name);
			const file = `${key}/${n}/${name}`;
			const dest = join(MAIL_FILES, file);
			let bytes: Buffer;
			if (a.data !== undefined) {
				bytes = Buffer.from(a.data, "base64");
			} else {
				const src = insideMailFiles(a.path!);
				if (!src) throw new Error("path is not a file inside the mail files folder");
				bytes = readFileSync(src);
			}
			if (!bytes.length || bytes.length > FILE_MAX_BYTES) throw new Error(`size ${bytes.length} not accepted`);
			mkdirSync(join(MAIL_FILES, key, String(n)), { recursive: true });
			writeFileSync(dest, bytes);
			out.push({ name, type: a.type || Bun.file(dest).type || "application/octet-stream", size: bytes.length, file });
		} catch (error) {
			log(`mail ${key}: attachment ${n} (${a.name}) not stored: ${(error as Error).message}`);
		}
	}
	return out;
}

/** First lines of a body as one short text, for the list row when no summary came with the mail. */
export function mailPreview(body: string | undefined): string {
	const lines = (body ?? "").split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
	return lines.slice(0, 3).join("\n").slice(0, PREVIEW_MAX);
}

/** The public face of a mail's files for the web: no stored paths. */
export const attachmentList = (m: Pick<MailRecord, "attachments">) => (m.attachments ?? []).map(({ name, type, size }) => ({ name, type, size }));

/** GET/HEAD /api/mail/<key>/files/<n>[?dl=1]: main.ts adds the web auth in front. Only files of a known mail, only inside MAIL_FILES. */
export function mailFileRoute(req: Request, url: URL, key: string, index: string): Response {
	try {
		const a = /^\d{1,3}$/.test(index) ? mailByKey(key)?.attachments?.[Number(index)] : undefined;
		if (!a) throw new FileError("첨부파일을 찾을 수 없어요", 404);
		const path = insideMailFiles(a.file);
		if (!path) throw new FileError("첨부파일을 찾을 수 없어요", 404);
		const res = serveFile(path, req, url.searchParams.get("dl") === "1" || url.searchParams.get("download") === "1");
		return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: error instanceof FileError ? error.status : 400 });
	}
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
	const attachments = saveAttachments(key, m.attachments);
	const summary = m.summary ?? "";
	const preview = summary ? "" : mailPreview(m.body);
	recordMail({ key, source: m.source, id: m.id, subject: m.subject, from: m.from ?? "", ...(m.to ? { to: m.to } : {}), at, ...(thread ? { thread } : {}), ...(summary ? { summary } : {}), ...(preview ? { preview } : {}), ...(attachments.length ? { attachments } : {}) });
	const event = { ts: at, kind: "mail", source: m.source, channel: target, conv: target, mail: key, subject: m.subject, from: m.from ?? "", ...(thread ? { thread } : {}), ...(parent ? { parent } : {}), ...(summary ? { summary } : {}), ...(preview ? { preview } : {}), ...(attachments.length ? { attachments: attachmentList({ attachments }) } : {}), text: mailText(m) };
	deps.emit(event);
	if (m.wake) deps.wake(event, thread ? `th:${thread}` : target);
	try {
		deps.offerDraft?.({ key, target, ...(thread ? { thread } : {}), source: m.source, id: m.id, subject: m.subject, ...(m.from ? { from: m.from } : {}), ...(m.to ? { to: m.to } : {}), ...(m.summary ? { summary: m.summary } : {}), ...(m.body ? { body: m.body } : {}) });
	} catch (error) {
		log(`mail ${key}: reply draft offer failed: ${(error as Error).message}`);
	}
	return { ok: true, key, target, ...(thread ? { thread } : {}) };
}
