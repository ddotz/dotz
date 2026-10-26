// Photos, videos, voice messages, files and other non-text messages of a watched room (contract: docs/kakao-rooms-api.md).
// `mediaOf` turns a message's attachment JSON into a safe `media` object for the web: no URL, no local path, no keys. The bytes are
// fetched server-side by `fetchMedia`, the one place that talks HTTP to a Kakao host: a read-only GET of a media URL that is already
// stored in the database, https only, host *.kakaocdn.net only, no cookies or auth headers, no redirects off that host, 25 MB, 20 s.
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { EMOTICON_TYPES } from "./db.ts";
import type { Msg } from "./types.ts";

export type Media =
	| { kind: "photo"; w?: number; h?: number; count: number; expired: boolean }
	| { kind: "video"; w?: number; h?: number; d?: number; expired: boolean }
	| { kind: "voice"; d?: number; expired: boolean }
	| { kind: "file"; name: string; size?: number; local: boolean; expired: boolean }
	| { kind: "emoticon"; alt: string; text?: string; image?: true }
	| { kind: "reply"; quote: string; quoteSender?: string }
	| { kind: "location"; label: string; lat: number; lng: number };

export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const MEDIA_TIMEOUT_MS = 20_000;
const MAX_HOPS = 3;
const QUOTE_MAX = 80;
export const GONE = "기간이 지나 볼 수 없어요";
export const NO_LOCAL = "이 컴퓨터에 내려받은 파일이 없어요";

const PHOTO = 2, VIDEO = 3, VOICE = [4, 5], FILE = 18, ALBUM = 27, EMOTICON = EMOTICON_TYPES, REPLY = 26, LOCATION = 16;
// Types whose message column is an attachment record, not text for people.
const NO_TEXT = new Set([PHOTO, VIDEO, ...VOICE, FILE, ALBUM, ...EMOTICON, LOCATION]);
// The body of a message: type 1, a reply's own text, a feed line (0) and unknown types show their text; media types never do.
export const showsText = (type: number) => !NO_TEXT.has(type);

type Att = Record<string, unknown>;
const parse = (s?: string): Att => {
	try {
		const v = JSON.parse(s ?? "");
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Att) : {};
	} catch {
		return {};
	}
};
const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const dims = (w: unknown, h: unknown) => ({ ...(pos(w) ? { w: pos(w) } : {}), ...(pos(h) ? { h: pos(h) } : {}) });
const clip = (s: string) => {
	const chars = [...s.replace(/\s+/g, " ").trim()];
	return chars.length > QUOTE_MAX ? `${chars.slice(0, QUOTE_MAX).join("")}…` : chars.join("");
};
// `expire` is epoch seconds (milliseconds are accepted too).
const expiredAt = (a: Att, now: number) => {
	const e = pos(a.expire);
	return e !== undefined && (e > 1e11 ? e : e * 1000) < now;
};
const localFile = (path?: string) => {
	try {
		return !!path && path.startsWith("/") && existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
};

// `names` maps an author id to a display name (the senders of the same page of messages) for a reply's quoted sender.
export function mediaOf(m: Msg, now: number, names: Map<string, string> = new Map()): Media | undefined {
	const a = parse(m.attachment), expired = expiredAt(a, now), type = m.type;
	if (type === PHOTO) return { kind: "photo", ...dims(a.thumbnailWidth ?? a.w, a.thumbnailHeight ?? a.h), count: 1, expired };
	if (type === ALBUM) {
		const count = Math.max(list(a.imageUrls).length, list(a.thumbnailUrls).length);
		if (!count) return { kind: "photo", count: 1, expired };
		return { kind: "photo", ...dims(list(a.thumbnailWidths)[0], list(a.thumbnailHeights)[0]), count, expired };
	}
	if (type === VIDEO) return { kind: "video", ...dims(a.w, a.h), ...(pos(a.d) ? { d: pos(a.d) } : {}), expired };
	if (VOICE.includes(type)) return { kind: "voice", ...(pos(a.d) ? { d: pos(a.d) } : {}), expired };
	if (type === FILE) {
		const local = localFile(m.localFilePath);
		return { kind: "file", name: text(a.name) || (m.localFilePath ? basename(m.localFilePath) : "파일"), ...(pos(a.size) ? { size: pos(a.size) } : {}), local, expired: expired && !local };
	}
	if (EMOTICON.includes(type)) {
		const alt = text(a.alt).replace(/^\s*\(이모티콘\)\s*/, "").trim(), words = m.text.trim();
		return { kind: "emoticon", alt, ...(words ? { text: words } : {}), ...(emoticonPath(a) ? { image: true as const } : {}) };
	}
	if (type === REPLY) {
		const quote = clip(text(a.src_message));
		if (!quote) return undefined;
		const who = names.get(replySource(m) ?? "");
		return { kind: "reply", quote, ...(who ? { quoteSender: who } : {}) };
	}
	if (type === LOCATION) {
		const lat = Number(a.lat), lng = Number(a.lng), label = text(a.a).trim() || text(a.t).trim();
		if (!Number.isFinite(lat) || !Number.isFinite(lng) || !label) return undefined;
		return { kind: "location", label, lat, lng };
	}
	return undefined;
}

// The author of the message a reply answers (type 26 src_userId), for the name above the quote.
export const replySource = (m: Pick<Msg, "type" | "attachment">): string | undefined => {
	if (m.type !== REPLY) return undefined;
	const id = parse(m.attachment).src_userId;
	return id === undefined || id === null || id === "" ? undefined : String(id);
};

// An emoticon's image is the item file named in its attachment ("4412207.emot_001.webp"), served by KakaoTalk's item CDN; only a plain file name is used.
const EMOTICON_CDN = "https://item.kakaocdn.net/dw/";
const emoticonPath = (a: Att): string | undefined => {
	const p = text(a.path).trim();
	return /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|webp|gif)$/i.test(p) ? p : undefined;
};

export type Target = { ok: true; url: string } | { ok: false; status: 404 | 410; error: string };
// Which stored URL a media request means. `i` is the album index; `v` thumb | full.
export function mediaTarget(m: Msg, i: number, v: "thumb" | "full", now: number): Target {
	const a = parse(m.attachment), pick = (...c: unknown[]) => c.map(text).find(Boolean);
	let url: string | undefined;
	if (m.type === PHOTO) url = v === "thumb" ? pick(a.thumbnailUrl, a.url) : pick(a.url, a.thumbnailUrl);
	else if (m.type === ALBUM) {
		const full = list(a.imageUrls), thumbs = list(a.thumbnailUrls);
		url = v === "thumb" ? pick(thumbs[i], full[i]) : pick(full[i], thumbs[i]);
	} else if (m.type === VIDEO) url = v === "thumb" ? pick(a.thumbnailUrl, a.tUrl) : pick(a.url, a.urlh);
	else if (VOICE.includes(m.type)) url = pick(a.url);
	else if (EMOTICON.includes(m.type)) {
		const p = emoticonPath(a);
		url = p ? `${EMOTICON_CDN}${p}` : undefined;
	}
	if (!url) return { ok: false, status: 404, error: "볼 수 있는 내용이 없어요" };
	if (expiredAt(a, now)) return { ok: false, status: 410, error: GONE };
	return { ok: true, url };
}

// https, no credentials, default port, a host under kakaocdn.net.
export function allowedUrl(raw: string): URL | undefined {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return undefined;
	}
	const host = u.hostname.toLowerCase();
	if (u.protocol !== "https:" || u.username || u.password || u.port || !host.endsWith(".kakaocdn.net") || host.length <= ".kakaocdn.net".length) return undefined;
	return u;
}

const fail = (status: number, error: string) => Response.json({ error }, { status });
const KINDS = /^(image|video|audio)\//i;

// Streams `body` and errors out once more than `max` bytes went through.
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
	let seen = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, ctl) {
				seen += chunk.byteLength;
				if (seen > max) ctl.error(new Error("too large"));
				else ctl.enqueue(chunk);
			},
		}),
	);
}

export async function fetchMedia(url: string, doFetch: typeof fetch): Promise<Response> {
	const signal = AbortSignal.timeout(MEDIA_TIMEOUT_MS);
	let at = allowedUrl(url);
	for (let hop = 0; at && hop <= MAX_HOPS; hop++) {
		let up: Response;
		try {
			up = await doFetch(at.href, { method: "GET", redirect: "manual", credentials: "omit", headers: {}, signal });
		} catch {
			return fail(502, "미디어를 가져오지 못했어요");
		}
		if (up.status >= 300 && up.status < 400) {
			const next = up.headers.get("location");
			await up.body?.cancel().catch(() => {});
			at = next ? allowedUrl(new URL(next, at).href) : undefined;
			continue;
		}
		if (up.status === 403 || up.status === 404 || up.status === 410) {
			await up.body?.cancel().catch(() => {});
			return fail(410, GONE);
		}
		const type = up.headers.get("content-type") ?? "";
		if (!up.ok || !up.body || !KINDS.test(type)) {
			await up.body?.cancel().catch(() => {});
			return fail(502, "미디어를 가져오지 못했어요");
		}
		const len = Number(up.headers.get("content-length"));
		if (Number.isFinite(len) && len > MEDIA_MAX_BYTES) {
			await up.body.cancel().catch(() => {});
			return fail(413, "너무 커서 열 수 없어요");
		}
		return new Response(capped(up.body, MEDIA_MAX_BYTES), {
			headers: {
				"Content-Type": type,
				"Cache-Control": "private, max-age=86400",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "sandbox; default-src 'none'",
				...(Number.isFinite(len) && len > 0 ? { "Content-Length": String(len) } : {}),
			},
		});
	}
	return fail(502, "허용되지 않는 주소예요");
}

// RFC 5987 attachment header, like hub/mail.ts.
export const attachmentHeader = (name: string) =>
	`attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

// The file route: the file the owner downloaded in KakaoTalk, only when it still exists on this computer.
export function serveLocalFile(m: Msg): Response {
	const a = parse(m.attachment);
	if (m.type !== FILE || !localFile(m.localFilePath)) return fail(404, NO_LOCAL);
	const name = text(a.name) || basename(m.localFilePath!);
	return new Response(Bun.file(m.localFilePath!), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": attachmentHeader(name), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
