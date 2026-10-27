// Mail as conversations: each mail (zele, a webmail watcher, a custom plugin) is one web conversation `mail:<key>`, and, only when the
// owner turned on 디스코드에도 올리기 for the mail's app instance (MailDeps.threadOn), one thread in the mail channel. A web message in that conversation reaches the orchestrator the way a message in
// the mail's Discord thread does (hub/intake.ts sendWeb `mail`). Posters come in through POST /api/mail (docs/custom-plugins.md).
// Discord and the event bus are injected (MailDeps), so this module has no hub imports beyond config.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { cfg, DATA_DIR, log, writeAtomic } from "./config.ts";
import { FileError, safeName, serveFile } from "./files.ts";
import { MAIL_HTML_MAX, sanitizeMailHtml } from "./mailhtml.ts";
import { directionOf, migrateMails, nextReply, replyExpected, replyOf, setOwnAddresses, type MailReply, type MailReplyEvent, type StoredMail } from "./mail-state.ts";
import { mailUnreplied } from "./unreplied.ts";

/** One attached file of a mail. `file` is relative to the mail files folder (`<key>/<n>/<name>`); it never leaves that folder. */
export type MailAttachment = { name: string; type: string; size: number; file: string; cid?: string };
/** What a poster sends: the bytes inline (`data`, base64) or a file it already put in the mail files folder (`path`, absolute or relative to it). */
export type AttachmentInput = { name: string; type?: string; data?: string; path?: string; cid?: string };
// A suggested next action the web shows in the mail's row and conversation slot (only when present): `reply-draft` = a reply draft
// was offered as a send-approval [ask] whose question ends in "(<ref>)" (features/reply-drafts). `state` is the reply state the row shows
// (web 30-monitoring.js mailReplyChip): "draft" (default) a draft waits for approval, "sent" the reply went out, "waiting" a reply is expected.
export type MailSuggest = { kind: "reply-draft"; label: string; ref: string; state?: "draft" | "sent" | "waiting"; at?: string };
// `dir: "out"` = written by the owner (hub/mail-state.ts); `reply` = the reply state of an incoming mail, `sentAt` = when his reply was sent or found.
// `needsReply` / `noReply` are the flags of older records; migrateMails turns them into `reply`.
// `msg` = the id of the newest incoming message the record stands for (MailInput.messageId); a post with another id is a newer message of the
// same thread and reopens it (postMail). `reopenedAt` = when that happened: a reply draft sent before it answered an older message.
export type MailRecord = { msg?: string; reopenedAt?: string; key: string; source: string; id: string; subject: string; from: string; to?: string; cc?: string; at: string; thread?: string; summary?: string; preview?: string; attachments?: MailAttachment[]; html?: true; suggest?: MailSuggest; dir?: "out"; reply?: MailReply; sentAt?: string; needsReply?: true; noReply?: true };
export type MailInput = { /** Names this message of the thread; the same id again is a repeat, another id is a newer message and a new mail again. */ messageId?: string; source: string; id: string; subject: string; from?: string; to?: string; cc?: string; summary?: string; body?: string; html?: string; thread?: string; wake?: boolean; needsReply?: boolean; attachments?: AttachmentInput[]; /** "out" = the owner's own mail; `folder` / `labels` (SENT, 보낸편지함) say the same. */ direction?: "in" | "out"; folder?: string; labels?: string[] };
export type MailResult = { ok: true; key: string; target: string; thread?: string; duplicate?: boolean; skipped?: true; direction?: "out"; replied?: true };
export type MailDeps = {
	/** Opens a thread under `parent` (a work channel target `ch:<id>`) from a starter message; discord.ts createThread. */
	createThread: (parent: string, name: string, starter: string) => Promise<{ id: string }>;
	/** Posts into a thread (`th:<id>`); discord.ts send. */
	send: (target: string, text: string) => Promise<unknown>;
	/** The mail work channel id, made when missing; undefined without Discord. */
	mailChannel: () => Promise<string | undefined>;
	discordOn: boolean;
	/** Whether the app instance of this mail has 디스코드에도 올리기 on; missing = off (web conversation only, no mail channel made). */
	threadOn?: (source: string, key: string) => boolean;
	/** Whether the app instance of this mail has 새 메일 (hub/app-feature-flags.ts) on; off = the mail is not posted at all. Missing = on. */
	newMailOn?: (source: string, key: string) => boolean;
	emit: (event: Record<string, any>) => void;
	/** One orchestrator turn for the mail event, its answer going to `target`. */
	wake: (event: Record<string, any>, target: string) => void;
	/** Offered every new mail (never a duplicate), fire-and-forget: a throw is logged and never breaks postMail. features/reply-drafts offers an [ask] reply draft here. */
	offerDraft?: (m: { key: string; target: string; thread?: string; messageId?: string; source: string; id: string; subject: string; from?: string; to?: string; summary?: string; body?: string; attachments?: { name: string; size: number }[] }) => void;
	/** 초안 작성: a reply draft the owner asked for on a recorded mail (features/reply-drafts requestMailDraft); resolves with how it went. */
	requestDraft?: (m: { key: string; target: string; thread?: string; messageId?: string; source: string; id: string; subject: string; from?: string; to?: string; summary?: string; attachments?: { name: string; size: number }[] }) => Promise<string>;
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
const aliases = cfg as unknown as { mail?: { own_addresses?: unknown }; zele?: { aliases?: unknown } };
setOwnAddresses("config", [aliases.mail?.own_addresses, aliases.zele?.aliases].flatMap(v => (Array.isArray(v) ? v : [])).filter((v): v is string => typeof v === "string"));
if (migrateMails(records as StoredMail[])) writeAtomic(FILE, `${JSON.stringify(records, null, 2)}\n`);

export const mailByKey = (key: string): MailRecord | undefined => byKey.get(key);

// Sets (or clears) the suggested action of a known mail; false when the mail is not recorded.
export function setMailSuggest(key: string, suggest: MailSuggest | undefined): boolean {
	const r = byKey.get(key);
	if (!r) return false;
	const { suggest: _old, needsReply: _n, noReply: _o, ...rest } = r;
	const event: MailReplyEvent | undefined = !suggest ? undefined : suggest.state === "sent" ? "sent" : suggest.state === "waiting" ? "need" : "draft";
	const reply = event && r.dir !== "out" ? nextReply(replyOf(rest), event) : replyOf(rest);
	recordMail({ ...rest, ...(reply ? { reply } : {}), ...(suggest ? { suggest: suggest.state === "sent" ? { ...suggest, at: suggest.at ?? new Date().toISOString() } : suggest } : {}) });
	return true;
}

// The one write path of an incoming mail's reply state (transitions: hub/mail-state.ts nextReply). A reply that went out also takes the waiting
// draft chip off the row. False when the mail is not recorded.
export function setMailReply(key: string, event: MailReplyEvent, at = new Date().toISOString()): boolean {
	const r = byKey.get(key);
	if (!r) return false;
	if (r.dir === "out") return true;
	const { needsReply: _n, noReply: _o, suggest, ...rest } = r;
	const reply = nextReply(replyOf(r), event);
	const sentNow = event === "sent" && r.reply !== "replied";
	const keep = suggest && !(event === "sent" && suggest.state !== "sent") ? { suggest } : {};
	const next: MailRecord = { ...rest, ...(reply ? { reply } : {}), ...(sentNow ? { sentAt: at } : {}), ...keep };
	if (JSON.stringify(next) !== JSON.stringify(r)) recordMail(next);
	return true;
}
/** The keys whose reply draft was sent (from the drafts list); a draft sent before the thread was reopened by a newer message does not count. */
export function sentReplyRefs(drafts: ReadonlyArray<{ ref: string; status: string; created: string }>): Set<string> {
	return new Set(drafts.filter(d => d.status === "sent" && !(d.created < (byKey.get(d.ref)?.reopenedAt ?? ""))).map(d => d.ref));
}
export const mailByThread = (thread: string): MailRecord | undefined => records.find(r => r.thread === thread);
// 미답장 (hub/unreplied.ts): the mails still waiting for a reply, given the keys whose reply draft was sent. 답장 안 함 (`noReply`) is the owner's own mark.
export const unrepliedMails = (sentRefs: ReadonlySet<string>, now = Date.now()): MailRecord[] => records.filter(r => mailUnreplied(r, sentRefs, now));
export const setMailNoReply = (key: string, on: boolean): boolean => setMailReply(key, on ? "skip" : "reopen");
export const setMailFyi = (key: string, on: boolean): boolean => setMailReply(key, on ? "fyi" : "reopen");

/** The stored mails brought up to the current rules (hub/mail-state.ts migrateMails), saved when anything changed. Safe to run any number of times. */
export function migrateStoredMails(sentRefs?: ReadonlySet<string>): number {
	const n = migrateMails(records as StoredMail[], { sentRefs });
	if (n) writeAtomic(FILE, `${JSON.stringify(records, null, 2)}\n`);
	return n;
}
// The reply states of the mails (the 모니터링 app lines count them: hub/integrations.ts).
export const mailSuggests = (): Array<{ target: string; state?: string; at: string }> => records.flatMap(r => r.suggest ? [{ target: mailTarget(r.key), state: r.suggest.state ?? "draft", at: r.suggest.at ?? r.at }] : []);
export const mailTargets = (): string[] => [...records].sort((a, b) => b.at.localeCompare(a.at)).map(r => mailTarget(r.key));

export function recordMail(r: MailRecord): void {
	byKey.set(r.key, r);
	records = [...records.filter(x => x.key !== r.key), r].sort((a, b) => a.at.localeCompare(b.at)).slice(-KEEP);
	for (const k of [...byKey.keys()]) if (!records.some(x => x.key === k)) byKey.delete(k);
	writeAtomic(FILE, `${JSON.stringify(records, null, 2)}\n`);
}

// A derived summary is written a moment later, in one write however many mails the start-up fills in.
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		writeAtomic(FILE, `${JSON.stringify(records, null, 2)}\n`);
	}, 200);
	flushTimer.unref?.();
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
		const { name, type, data, path, cid } = a as Record<string, unknown>;
		if (typeof name !== "string" || !name.trim()) throw new MailError(`attachments[${i}].name is required`);
		if ((typeof data === "string") === (typeof path === "string")) throw new MailError(`attachments[${i}] needs exactly one of data (base64) or path`);
		return { name: name.slice(0, 200), ...(typeof type === "string" ? { type: type.slice(0, 100) } : {}), ...(typeof cid === "string" && cid.trim() ? { cid: cid.trim().replace(/^<|>$/g, "").slice(0, 200) } : {}), ...(typeof data === "string" ? { data } : { path: path as string }) };
	});
}

export function parseMail(raw: unknown): MailInput {
	if (!raw || typeof raw !== "object") throw new MailError("body must be a JSON object");
	const b = raw as Record<string, unknown>;
	const thread = str(b.thread, "thread", 30, false);
	if (thread && !THREAD_ID.test(thread)) throw new MailError("thread must be a Discord thread id (15-22 digits)");
	if (b.wake !== undefined && typeof b.wake !== "boolean") throw new MailError("wake must be a boolean");
	if (b.direction !== undefined && b.direction !== "in" && b.direction !== "out") throw new MailError('direction must be "in" or "out"');
	if (b.labels !== undefined && (!Array.isArray(b.labels) || b.labels.some(l => typeof l !== "string"))) throw new MailError("labels must be an array of strings");
	return {
		source: str(b.source, "source", 60, true)!,
		id: str(b.id, "id", 200, true)!,
		subject: str(b.subject, "subject", 300, true)!,
		from: str(b.from, "from", 300, false),
		to: str(b.to, "to", 500, false),
		cc: str(b.cc, "cc", 500, false),
		summary: str(b.summary, "summary", SUMMARY_MAX, false),
		body: str(b.body, "body", BODY_MAX, false),
		html: str(b.html, "html", MAIL_HTML_MAX, false),
		thread,
		messageId: str(b.messageId, "messageId", 200, false),
		wake: b.wake === true,
		needsReply: b.needsReply === true,
		attachments: parseAttachments(b.attachments),
		...(b.direction ? { direction: b.direction as "in" | "out" } : {}),
		folder: str(b.folder, "folder", 100, false),
		...(b.labels ? { labels: (b.labels as string[]).slice(0, 50) } : {}),
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
			out.push({ name, type: a.type || Bun.file(dest).type || "application/octet-stream", size: bytes.length, file, ...(a.cid ? { cid: a.cid } : {}) });
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

const BRIEF_LABELS = new Set(["요약", "할 일", "할일", "다음 할 일", "핵심", "결과", "변경", "참고", "상세", "확인할 것"]);
// "요약", "## 요약", "**할 일**", "할 일:" -> the label; any other line -> "" (web/js/11-resultcard.js rcLabel).
const briefLabel = (line: string): string => {
	const m = line.trim().match(/^(?:#{1,6}\s*)?(?:\*\*)?\s*([^*#:\n]{1,12}?)\s*:?\s*(?:\*\*)?\s*:?$/);
	return m && BRIEF_LABELS.has(m[1]!.trim()) ? m[1]!.trim() : "";
};

/**
 * The row text of a mail that came without a summary, from a conversation message (the web does the same, web/js/30-monitoring.js mailFromMsg):
 * up to 3 lines of its "요약" section, else the first 3 lines of its original (the text after a "원문" line). Lines that only repeat the
 * sender or the subject do not count; "" when nothing is left.
 */
export function mailBriefOf(text: string, from: string, subject: string): string {
	const plain = (s: string) => s.replace(/^\s*#{1,6}\s*/, "").replace(/\*\*/g, "").replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
	const name = plain(from.replace(/<[^>]*>/g, "").replace(/["']/g, "")) || plain(from);
	const skip = new Set([plain(subject), plain(`${from} · ${subject}`), plain(from), name].filter(Boolean));
	const lines = (s: string[]) => s.map(plain).filter(l => l && !briefLabel(l) && !skip.has(l)).slice(0, 3);
	const t = text.replace(/\r/g, "").trim();
	const cut = /(?:^|\n)원문[ \t]*\n([\s\S]*)$/.exec(t);
	const head = (cut ? t.slice(0, cut.index) : t).split("\n");
	const start = head.findIndex(l => briefLabel(l) === "요약");
	let section: string[] = [];
	if (start >= 0) {
		const rest = head.slice(start + 1);
		const end = rest.findIndex(l => briefLabel(l));
		section = rest.slice(0, end < 0 ? undefined : end);
	}
	const own = lines(section);
	return (own.length ? own : lines(cut ? cut[1]!.split("\n") : [])).join("\n").slice(0, PREVIEW_MAX);
}

/**
 * Gives a recorded mail that has neither summary nor preview the brief of one conversation message (called for each message that is not the
 * owner's, oldest first, until one yields text; hub/conversations.ts). Stored once, so the list never reads a conversation. True when stored.
 */
export function briefMail(key: string, text: string): boolean {
	const r = byKey.get(key);
	if (!r || r.summary || r.preview) return false;
	const brief = mailBriefOf(text, r.from, r.subject);
	if (!brief) return false;
	r.summary = brief;
	if (r.dir !== "out" && !replyOf(r) && replyExpected({ from: r.from, to: r.to, cc: r.cc, subject: r.subject, text: brief })) r.reply = "needs";
	persistSoon();
	return true;
}

const BODY_FILE = (key: string) => join(MAIL_FILES, key, "body.html");

// Stores the sanitized HTML body next to the attachments (not in the records file, which stays small). True when a body was kept.
async function saveHtml(key: string, html: string | undefined, attachments: MailAttachment[]): Promise<boolean> {
	if (!html?.trim()) return false;
	try {
		const cids: Record<string, string> = {};
		for (const [n, a] of attachments.entries()) if (a.cid) cids[a.cid] = `/api/mail/${key}/files/${n}`;
		const clean = await sanitizeMailHtml(html, cids);
		if (!clean) return false;
		mkdirSync(join(MAIL_FILES, key), { recursive: true });
		writeFileSync(BODY_FILE(key), clean);
		return true;
	} catch (error) {
		log(`mail ${key}: html body not stored: ${(error as Error).message}`);
		return false;
	}
}

/** GET /api/mail/<key>/body: the stored, sanitized HTML of a known mail. The CSP header keeps even a direct visit inert. */
export function mailBodyRoute(key: string): Response {
	const rec = mailByKey(key);
	const path = rec?.html ? insideMailFiles(BODY_FILE(key)) : undefined;
	if (!path) return Response.json({ error: "메일 본문을 찾을 수 없어요" }, { status: 404 });
	return new Response(Bun.file(path), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300" } });
}

/** The public face of a mail's files for the web: no stored paths. */
export const attachmentList = (m: Pick<MailRecord, "attachments">) => (m.attachments ?? []).map(({ name, type, size }) => ({ name, type, size }));

/** The direction and reply state a row shows (`sent` = a dotz send of a draft for this mail is on record). */
const mailStateOf = (m: MailRecord, sent: boolean) => {
	const reply = m.dir === "out" ? undefined : sent ? ("replied" as const) : replyOf(m);
	return { ...(m.dir === "out" ? { dir: "out" as const } : {}), ...(reply ? { reply } : {}), ...(m.sentAt ? { sentAt: m.sentAt } : {}) };
};

/** What the web draws a mail row from (GET /api/conversations `mail`, and a watch report that points at the mail): no stored paths. */
export const mailCard = (m: MailRecord, unreplied = false, sent = false) => ({ ...mailStateOf(m, sent), subject: m.subject, from: m.from, ...(m.to ? { to: m.to } : {}), ...(m.cc ? { cc: m.cc } : {}), source: m.source, at: m.at, ...(m.summary ? { summary: m.summary } : {}), ...(m.preview ? { preview: m.preview } : {}), ...(m.attachments?.length ? { attachments: attachmentList(m) } : {}), ...(m.html ? { html: true as const } : {}), ...(m.suggest ? { suggest: m.suggest } : {}), ...(unreplied ? { unreplied: true as const } : {}) });

/** GET/HEAD /api/mail/<key>/files/<n>[?dl=1]: main.ts adds the web auth in front. Only files of a known mail, only inside MAIL_FILES. */
export function mailFileRoute(req: Request, url: URL, key: string, index: string): Response {
	try {
		const a = /^\d{1,3}$/.test(index) ? mailByKey(key)?.attachments?.[Number(index)] : undefined;
		if (!a) throw new FileError("첨부파일을 찾을 수 없어요", 404);
		const path = insideMailFiles(a.file);
		if (!path) throw new FileError("첨부파일을 찾을 수 없어요", 404);
		const res = serveFile(path, req, url.searchParams.get("dl") === "1" || url.searchParams.get("download") === "1");
		// The file's own name, as RFC 5987 wants it: a Korean name survives, and ' ( ) * (which encodeURIComponent leaves) are percent-encoded too.
		const kind = res.headers.get("content-disposition")?.startsWith("attachment") ? "attachment" : "inline";
		res.headers.set("Content-Disposition", `${kind}; filename="${a.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(a.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
		return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: error instanceof FileError ? error.status : 400 });
	}
}

/** POST /api/mail/compose: the mail app lists a new-mail draft like a reply draft (a row with its draft chip); `state: "sent"` flips the chip. Never wakes the bot or offers a draft. */
export function composeMail(raw: unknown, deps: Pick<MailDeps, "emit" | "now">): { ok: true; key: string } {
	const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const ref = str(b.ref, "ref", 64, true)!;
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(ref)) throw new MailError("ref is not a draft id");
	const source = str(b.source, "source", 100, true)!;
	const key = mailKey(source, `compose-${ref.toLowerCase()}`);
	const known = byKey.get(key);
	if (b.state === "sent") {
		if (!known?.suggest) throw Object.assign(new MailError("no such draft mail"), { status: 404 });
		setMailSuggest(key, { ...known.suggest, state: "sent" });
		return { ok: true, key };
	}
	if (known) return { ok: true, key };
	const to = str(b.to, "to", 500, true)!;
	const subject = str(b.subject, "subject", 300, true)!;
	const origin = str(b.origin, "origin", 100, false);
	const at = deps.now?.() ?? new Date().toISOString();
	const summary = `새 메일 초안 · ${to}${origin ? ` · ${origin}` : ""}`;
	recordMail({ key, source, id: `compose-${ref}`, subject, from: "", at, dir: "out", summary, suggest: { kind: "reply-draft", label: "메일 초안", ref, state: "draft" } });
	deps.emit({ ts: at, kind: "mail", source, channel: mailTarget(key), conv: mailTarget(key), mail: key, subject, from: "", summary, text: summary });
	return { ok: true, key };
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
	if (deps.newMailOn && !deps.newMailOn(m.source, key)) return { ok: true, key, target, skipped: true };
	const known = byKey.get(key);
	if (directionOf({ from: m.from, direction: m.direction, folder: m.folder, labels: m.labels }) === "out") return recordOutgoing(m, key, target, deps);
	// An outgoing mail of the thread was recorded first; the answer that comes in now is a new incoming mail and replaces it.
	// A known incoming thread is a repeat, unless the post names another message than the one recorded: then the thread got a newer
	// message and it is a new mail again, whatever state it was in (answered, 답장 안 함, 참고만).
	const again = known && known.dir !== "out" && !!m.messageId && m.messageId !== known.msg ? known : undefined;
	if (known && known.dir !== "out" && !again) return { ok: true, key, target, ...(known.thread ? { thread: known.thread } : {}), duplicate: true };
	const running = inflight.get(key);
	if (running) return { ...(await running), duplicate: true };
	const job = post(m, key, target, deps, again);
	inflight.set(key, job);
	try {
		return await job;
	} finally {
		inflight.delete(key);
	}
}

// The owner's own mail: nothing is posted, no thread, no event (so no unread, notice or wake) and no reply draft. A known incoming thread
// becomes 답장함; an unknown mail is kept as 내가 보냄 for the 보낸 메일 list.
function recordOutgoing(m: MailInput, key: string, target: string, deps: MailDeps): MailResult {
	const known = byKey.get(key);
	const at = deps.now?.() ?? new Date().toISOString();
	if (known) {
		const replied = known.dir !== "out" && known.reply !== "replied";
		if (replied) setMailReply(key, "sent", at);
		return { ok: true, key, target, duplicate: true, direction: "out", ...(replied ? { replied: true as const } : {}) };
	}
	const summary = m.summary ?? "";
	const preview = summary ? "" : mailPreview(m.body);
	recordMail({ key, source: m.source, id: m.id, subject: m.subject, from: m.from ?? "", ...(m.to ? { to: m.to } : {}), ...(m.cc ? { cc: m.cc } : {}), at, dir: "out", ...(summary ? { summary } : {}), ...(preview ? { preview } : {}) });
	return { ok: true, key, target, direction: "out" };
}

async function post(m: MailInput, key: string, target: string, deps: MailDeps, reopened?: MailRecord): Promise<MailResult> {
	let thread = m.thread ?? reopened?.thread;
	let parent: string | undefined;
	if (reopened?.thread && !m.thread && deps.discordOn) {
		const note = [m.from ?? "", m.summary ?? "", m.body ? `원문\n${m.body}` : ""].filter(Boolean).join("\n").slice(0, 1900);
		if (note) await deps.send(`th:${reopened.thread}`, note).catch(e => log(`mail ${key}: new message not posted to its thread: ${e}`));
	}
	if (!thread && deps.discordOn && deps.threadOn?.(m.source, key)) {
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
	const html = await saveHtml(key, m.html, attachments);
	const summary = m.summary ?? "";
	const preview = summary ? "" : mailPreview(m.body);
	// 답장 필요: the poster's word, else the gateway reads the mail (hub/mail-state.ts replyExpected).
	const needs = m.needsReply || replyExpected({ from: m.from, to: m.to, cc: m.cc, subject: m.subject, text: summary || m.body || "" });
	recordMail({ key, source: m.source, id: m.id, subject: m.subject, from: m.from ?? "", ...(m.to ? { to: m.to } : {}), ...(m.cc ? { cc: m.cc } : {}), at, ...(thread ? { thread } : {}), ...(summary ? { summary } : {}), ...(preview ? { preview } : {}), ...(attachments.length ? { attachments } : {}), ...(html ? { html: true as const } : {}), ...(needs ? { reply: "needs" as const } : {}), ...(m.messageId ? { msg: m.messageId } : {}), ...(reopened ? { reopenedAt: at } : {}) });
	const event = { ts: at, kind: "mail", source: m.source, channel: target, conv: target, mail: key, subject: m.subject, from: m.from ?? "", ...(m.to ? { to: m.to } : {}), ...(m.cc ? { cc: m.cc } : {}), ...(thread ? { thread } : {}), ...(parent ? { parent } : {}), ...(summary ? { summary } : {}), ...(preview ? { preview } : {}), ...(attachments.length ? { attachments: attachmentList({ attachments }) } : {}), ...(html ? { html: true } : {}), text: mailText(m) };
	deps.emit(event);
	if (m.wake) deps.wake(event, thread ? `th:${thread}` : target);
	try {
		deps.offerDraft?.({ key, target, ...(thread ? { thread } : {}), ...(m.messageId ? { messageId: m.messageId } : {}), source: m.source, id: m.id, subject: m.subject, ...(m.from ? { from: m.from } : {}), ...(m.to ? { to: m.to } : {}), ...(m.summary ? { summary: m.summary } : {}), ...(m.body ? { body: m.body } : {}), ...(attachments.length ? { attachments: attachmentList({ attachments }) } : {}) });
	} catch (error) {
		log(`mail ${key}: reply draft offer failed: ${(error as Error).message}`);
	}
	return { ok: true, key, target, ...(thread ? { thread } : {}) };
}
