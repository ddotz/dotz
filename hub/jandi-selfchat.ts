import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomic } from "./config.ts";
import { attachmentLine, safeName, UPLOAD_MAX_BYTES, type Upload, uploadRecord, writeAll } from "./files.ts";
import { readSecretFile, writeSecretFile } from "./secretbox.ts";

// JANDI "나와의 대화" (the member's private chat with the JANDI bot) as an inbound path for members who cannot add a Team Outgoing Webhook.
// The owner's own JANDI session (a refresh token in a dotz secret) reads that one room, and only the owner's own messages that start with
// the keyword, and files the owner sends without other text, reach dotz. Replies still go out through the room's Incoming Webhook. This uses the JANDI web client's API, which JANDI does
// not document: a JANDI change can break it, and the adapter then shows the error instead of guessing.

/** Another computer reached only through this room: it listens for `keyword` and answers with lines that start with `reply_prefix` (shown by hub/jandi-peers.ts).
 *  `notify: false`: its new replies raise no phone notification (the default notifies, hub/jandi-peers.ts peerReplyPush). */
export type SelfChatPeer = { name: string; keyword: string; reply_prefix: string; notify?: false };
export type SelfChatConfig = { enabled: boolean; team_id: number; room_id: number; member_id: number; bot_id: number; keyword: string; reply_prefix: string; session_secret: string; interval_ms: number; peers?: SelfChatPeer[] };
export type SelfChatDeps = {
	dataDir: string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	api?: string;
	/** An owner message: its command text ("" for a file sent without text) and the files it carried, saved under <data dir>/uploads/<day>/jandi-<message id>/.
	 *  A file that could not be saved is an `[attachment] <name> <url>` line in `text` instead, its url without a query. */
	receive: (text: string, files: Upload[]) => void;
	/** The largest file saved (default: the web upload limit). */
	maxFileBytes?: number;
	/** How long the files of one message may take together; what is not in by then becomes an [attachment] line. */
	filesTimeoutMs?: number;
	/** A new reply of a peer (a post by anyone but the owner that starts with its reply prefix), the prefix taken off; never for a peer with `notify: false`. */
	peerReply?: (peer: SelfChatPeer, text: string, id: number) => void;
	log: (msg: string) => void;
	onError: (err: string | undefined) => void;
};

const API = "https://i1.jandi.com/";
const PAGE = 50;
const MAX_BACKOFF = 5 * 60_000;
const TOKEN_MARGIN_MS = 5 * 60_000;

const MAX_PEERS = 8;
const MAX_FILES = 10;
const MAX_REDIRECTS = 3;
const FILES_TIMEOUT_MS = 120_000;

const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0);

/** The valid peers, in order: a keyword of 1-30 non-space characters that is neither this gateway's own nor a repeat, a reply prefix of 1-30 characters; at most 8. */
function normalizePeers(raw: unknown, own: string): SelfChatPeer[] {
	const out: SelfChatPeer[] = [];
	const seen = new Set([own.toLowerCase()]);
	for (const p of Array.isArray(raw) ? raw : []) {
		if (!p || typeof p !== "object") continue;
		const o = p as Record<string, unknown>;
		const kw = typeof o.keyword === "string" && /^\S{1,30}$/.test(o.keyword.trim()) ? o.keyword.trim().replace(/^\//, "") : "";
		const prefix = typeof o.reply_prefix === "string" ? o.reply_prefix.trim() : "";
		if (!kw || seen.has(kw.toLowerCase()) || prefix.length < 1 || prefix.length > 30) continue;
		seen.add(kw.toLowerCase());
		out.push({ name: (typeof o.name === "string" ? o.name.trim().slice(0, 30) : "") || kw, keyword: kw, reply_prefix: prefix, ...(o.notify === false ? { notify: false as const } : {}) });
		if (out.length >= MAX_PEERS) break;
	}
	return out;
}
export function normalizeSelfChat(raw: unknown): SelfChatConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const o = raw as Record<string, unknown>;
	const keyword = typeof o.keyword === "string" && /^\S{1,30}$/.test(o.keyword.trim()) ? o.keyword.trim().replace(/^\//, "") : "dotz";
	const secret = typeof o.session_secret === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(o.session_secret) ? o.session_secret : "jandi-session";
	const ms = Number(o.interval_ms);
	const peers = normalizePeers(o.peers, keyword);
	return {
		enabled: o.enabled === true,
		team_id: int(o.team_id),
		room_id: int(o.room_id),
		member_id: int(o.member_id),
		bot_id: int(o.bot_id),
		keyword,
		reply_prefix: typeof o.reply_prefix === "string" ? o.reply_prefix.trim().slice(0, 30) : "",
		session_secret: secret,
		interval_ms: Number.isInteger(ms) && ms >= 1000 ? ms : 3000,
		...(peers.length ? { peers } : {}),
	};
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The command in an owner message, or undefined: `dotz <text>` or `/dotz <text>` (case-insensitive), the rest trimmed. The keyword may carry a
 * Korean call particle and punctuation (`곰돌아 <text>`, `곰돌, <text>`) or be followed directly by a slash command (`곰돌/login`). */
export function commandOf(body: string, keyword: string): string | undefined {
	const m = new RegExp(`^\\s*/?${escapeRe(keyword)}(?:아|야)?[,.:!~]*(?:\\s+([\\s\\S]*)|(/[\\s\\S]*))?$`, "i").exec(body);
	const text = (m?.[1] ?? m?.[2])?.trim();
	return text || undefined;
}

/** `body` starts with `word` as a whole word (followed by a space, a newline or nothing). */
export const startsWord = (body: string, word: string): boolean => body === word || body.startsWith(`${word} `) || body.startsWith(`${word}\n`);

/** The peer whose reply `body` is (it starts with that peer's reply prefix as a word) and the text after the prefix, or undefined. */
export function peerReplyOf(body: string, peers: readonly SelfChatPeer[] | undefined): { peer: SelfChatPeer; text: string } | undefined {
	const b = body.trim();
	for (const peer of peers ?? []) {
		if (!startsWord(b, peer.reply_prefix)) continue;
		const text = b.slice(peer.reply_prefix.length).trim();
		return text ? { peer, text } : undefined;
	}
	return undefined;
}

/** `body` is the keyword alone (`dotz`, `/dotz`, `곰돌아`): the caption of a file sent to this gateway. */
const bareKeyword = (body: string, keyword: string): boolean => new RegExp(`^\\s*/?${escapeRe(keyword)}(?:아|야)?[,.:!~]*\\s*$`, "i").test(body);

// A file in the JANDI room: either a text record's `attachments[]` entry ({ contentType: "file", content }) or a record of contentType "file" itself.
type JandiFile = { name?: unknown; filename?: unknown; title?: unknown; type?: unknown; size?: unknown; fileUrl?: unknown };
type Message_ = { contentType?: unknown; content?: { body?: unknown } & JandiFile; attachments?: unknown };
type Record_ = { id: number; fromEntity: number; message?: Message_ };

/** The files of a message that carry a URL, at most MAX_FILES. */
function filesOf(m: Message_ | undefined): JandiFile[] {
	const out: JandiFile[] = [];
	for (const a of Array.isArray(m?.attachments) ? m.attachments : []) if (a?.contentType === "file" && typeof a.content?.fileUrl === "string") out.push(a.content);
	if (m?.contentType === "file" && typeof m.content?.fileUrl === "string") out.push(m.content);
	return out.slice(0, MAX_FILES);
}

const seoulDay = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

/** Where an unsaved file lives, for the turn's text: no query, fragment or credentials, which can sign a URL. */
function plainUrl(raw: string): string {
	const u = URL.parse(raw);
	return u && /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : "(not saved)";
}

export class SelfChatError extends Error {}

export function createSelfChat(cfg: SelfChatConfig, deps: SelfChatDeps) {
	const f = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
	const api = deps.api ?? API;
	const stateFile = join(deps.dataDir, "messengers", "jandi-selfchat.json");
	const secretFile = join(deps.dataDir, "secrets", cfg.session_secret);
	let access: { token: string; until: number } | undefined;
	let stopped = false;
	let wake: (() => void) | undefined;

	const readLast = (): number => {
		try {
			const v = JSON.parse(readFileSync(stateFile, "utf8")) as { room_id?: unknown; last_link_id?: unknown };
			return v.room_id === cfg.room_id ? int(v.last_link_id) : 0;
		} catch {
			return 0;
		}
	};
	const saveLast = (id: number) => writeAtomic(stateFile, `${JSON.stringify({ room_id: cfg.room_id, last_link_id: id })}\n`, 0o600);

	function refreshToken(): string {
		if (!existsSync(secretFile)) throw new SelfChatError(`no JANDI session (dotz secret ${cfg.session_secret})`);
		let v: unknown;
		try {
			v = (JSON.parse(readSecretFile(secretFile)) as Record<string, unknown>).refresh_token;
		} catch {
			throw new SelfChatError(`dotz secret ${cfg.session_secret} is unreadable`);
		}
		if (typeof v !== "string" || !v) throw new SelfChatError(`dotz secret ${cfg.session_secret} has no refresh_token`);
		return v;
	}

	async function token(): Promise<string> {
		if (access && Date.now() < access.until) return access.token;
		const rt = refreshToken();
		const res = await f(`${api}inner-api/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json;charset=UTF-8", Accept: "application/vnd.tosslab.jandi-v4+json" },
			body: JSON.stringify({ grant_type: "refresh_token", refresh_token: rt, platform: "web" }),
			signal: AbortSignal.timeout(15_000),
		});
		const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
		if (!res.ok || typeof j.access_token !== "string") throw new SelfChatError(`JANDI session refresh failed (HTTP ${res.status}); log in again`);
		if (typeof j.refresh_token === "string" && j.refresh_token && j.refresh_token !== rt) writeSecretFile(secretFile, JSON.stringify({ refresh_token: j.refresh_token }));
		const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in * 1000 : 3_600_000;
		access = { token: j.access_token, until: Date.now() + Math.max(60_000, ttl - TOKEN_MARGIN_MS) };
		return access.token;
	}

	async function request(path: string, version: number, init: RequestInit = {}): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			const res = await f(api + path, {
				...init,
				headers: { ...init.headers, Authorization: `bearer ${await token()}`, Accept: `application/vnd.tosslab.jandi-v${version}+json` },
				signal: AbortSignal.timeout(20_000),
			});
			if (res.status === 401 && attempt === 0) {
				void res.body?.cancel();
				access = undefined;
				continue;
			}
			if (!res.ok) {
				void res.body?.cancel();
				throw new SelfChatError(`JANDI ${path.split("?")[0]} HTTP ${res.status}`);
			}
			return res;
		}
	}

	const get = async (path: string, version: number): Promise<any> => (await request(path, version)).json();

	// The owner's session goes only to JANDI itself (the API's origin or a jandi.com host), never to a host a redirect points at.
	const apiOrigin = new URL(api).origin;
	const trusted = (u: URL) => u.origin === apiOrigin || (u.protocol === "https:" && (u.hostname === "jandi.com" || u.hostname.endsWith(".jandi.com")));

	/** Streams one file to `path`, at most `max` bytes, so its size costs no memory and a failure leaves no partial file; returns its size, throws with a short reason. */
	async function download(url: URL, path: string, max: number, signal: AbortSignal): Promise<number> {
		let retried = false;
		for (let hops = 0; hops <= MAX_REDIRECTS; ) {
			// Also on every redirect: fetch would read a file: or s3: address too.
			if (url.protocol !== "https:" && url.origin !== apiOrigin) throw new SelfChatError("not https");
			const res = await f(url, { headers: trusted(url) ? { Authorization: `bearer ${await token()}` } : {}, redirect: "manual", signal });
			const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
			if (to) {
				void res.body?.cancel();
				url = new URL(to, url);
				hops++;
				continue;
			}
			if (res.status === 401 && trusted(url) && !retried) {
				void res.body?.cancel();
				access = undefined;
				retried = true;
				continue;
			}
			if (!res.ok || !res.body) {
				void res.body?.cancel();
				throw new SelfChatError(`HTTP ${res.status}`);
			}
			if (Number(res.headers.get("content-length")) > max) {
				void res.body.cancel();
				throw new SelfChatError("too big");
			}
			mkdirSync(dirname(path), { recursive: true });
			const part = `${path}.part`;
			const out = await open(part, "w");
			try {
				let total = 0;
				for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
					total += chunk.byteLength;
					if (total > max) throw new SelfChatError("too big");
					await writeAll(out, chunk);
				}
				if (!total) throw new SelfChatError("empty");
				renameSync(part, path);
				return total;
			} finally {
				await out.close();
				rmSync(part, { force: true });
			}
		}
		throw new SelfChatError("too many redirects");
	}

	/** Saves a message's files into its own folder; a file that cannot be saved becomes an [attachment] line with its JANDI URL. */
	async function saveFiles(id: number, list: JandiFile[]): Promise<{ files: Upload[]; lines: string[] }> {
		const max = deps.maxFileBytes ?? UPLOAD_MAX_BYTES;
		const folder = join(deps.dataDir, "uploads", seoulDay(), `jandi-${id}`);
		const files: Upload[] = [];
		const lines: string[] = [];
		const taken = new Set<string>();
		const signal = AbortSignal.timeout(deps.filesTimeoutMs ?? FILES_TIMEOUT_MS);
		for (const file of list) {
			const raw = [file.name, file.filename, file.title].find((x): x is string => typeof x === "string" && x.trim() !== "") ?? "file";
			let name = safeName(raw);
			for (let n = 2; taken.has(name); n++) name = `${n}-${safeName(raw)}`;
			taken.add(name);
			const type = typeof file.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "";
			const url = String(file.fileUrl);
			try {
				if (typeof file.size === "number" && file.size > max) throw new SelfChatError("too big");
				const path = join(folder, name);
				files.push(uploadRecord(path, name, raw, type, await download(new URL(url), path, max, signal)));
			} catch (e) {
				// Never the URL in the log: it can carry a file token.
				deps.log(`jandi self-chat: file ${name} of message ${id} not saved (${e instanceof SelfChatError ? e.message : String((e as Error)?.name ?? "error")})`);
				lines.push(attachmentLine({ name, ...(type ? { type } : {}) }, plainUrl(url)));
			}
		}
		return { files, lines };
	}

	/** A JSON POST as the owner; the answer is not read. */
	async function post(path: string, version: number, body: unknown): Promise<void> {
		const res = await request(path, version, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		void res.body?.cancel();
	}

	/** The room must be the member's own chat with the JANDI bot; anything else is refused before a message is read. */
	async function checkRoom(): Promise<void> {
		const r = (await get(`room-api/v2/teams/${cfg.team_id}/rooms/${cfg.room_id}`, 2)) as { type?: unknown; companionId?: unknown; members?: unknown };
		const members = Array.isArray(r.members) ? r.members : [];
		if (r.type !== "chat" || r.companionId !== cfg.bot_id || !members.includes(cfg.member_id))
			throw new SelfChatError(`JANDI room ${cfg.room_id} is not this member's chat with the JANDI bot; nothing was read`);
	}

	async function latest(): Promise<number> {
		const j = (await get(`message-api/v2/teams/${cfg.team_id}/rooms/${cfg.room_id}/messages?count=1`, 2)) as { lastLinkId?: unknown };
		return int(j.lastLinkId);
	}

	/** One poll: new messages after `last`, the owner's commands handed on in order; returns the new last id. */
	async function poll(last: number): Promise<number> {
		const j = (await get(`message-api/v2/teams/${cfg.team_id}/rooms/${cfg.room_id}/messages?linkId=${last}&type=new&count=${PAGE}`, 2)) as { records?: unknown };
		const records = (Array.isArray(j.records) ? j.records : []) as Record_[];
		const commands: [string, Upload[]][] = [];
		for (const r of records.sort((a, b) => a.id - b.id)) {
			if (stopped) break; // a download can outlast stop(); what follows is the next reader's, from the saved id
			if (!int(r.id) || r.id <= last) continue;
			last = r.id;
			saveLast(last); // before handing it on: a crash never runs the same command twice (nor notifies the same reply twice)
			const body = r.message?.content?.body;
			if (r.fromEntity !== cfg.member_id) {
				const reply = typeof body === "string" ? peerReplyOf(body, cfg.peers) : undefined;
				if (reply && reply.peer.notify !== false) deps.peerReply?.(reply.peer, reply.text, r.id);
				continue;
			}
			// A file alone, or with the keyword as its caption, is for this gateway; a caption without the keyword is not (like any other text).
			const list = filesOf(r.message);
			const said = typeof body === "string" ? body.trim() : "";
			const text = said ? (commandOf(said, cfg.keyword) ?? (list.length && bareKeyword(said, cfg.keyword) ? "" : undefined)) : list.length ? "" : undefined;
			if (text === undefined) continue;
			if (!list.length) {
				commands.push([text, []]);
				continue;
			}
			const { files, lines } = await saveFiles(r.id, list);
			commands.push([[text, ...lines].filter(Boolean).join("\n"), files]);
		}
		// Handed on together: a text and the file right after it stay in one intake burst however long the download took.
		for (const [text, files] of commands) deps.receive(text, files);
		return last;
	}

	let ready = false;
	let last = 0;
	/** One step: the room check and starting point the first time, then one poll. Throws on any failure (nothing is skipped). */
	async function tick(): Promise<void> {
		if (!ready) {
			await checkRoom();
			last = readLast() || (await latest());
			saveLast(last);
			ready = true;
			deps.log(`jandi self-chat: reading room ${cfg.room_id} from message ${last}`);
		}
		last = await poll(last);
	}

	async function run(): Promise<void> {
		let backoff = cfg.interval_ms;
		while (!stopped) {
			try {
				await tick();
				deps.onError(undefined);
				backoff = cfg.interval_ms;
			} catch (e) {
				const msg = e instanceof SelfChatError ? e.message : `JANDI ${String((e as { code?: unknown })?.code ?? (e as Error)?.name ?? "error")}`;
				deps.onError(msg);
				deps.log(`jandi self-chat: ${msg}`);
				backoff = Math.min(MAX_BACKOFF, backoff * 2);
			}
			if (stopped) break;
			await Promise.race([sleep(backoff), new Promise<void>(r => (wake = r))]);
		}
	}

	return {
		get,
		post,
		checkRoom,
		tick,
		run,
		stop() {
			stopped = true;
			wake?.();
		},
	};
}
export type SelfChat = ReturnType<typeof createSelfChat>;
