// YouTube Data API v3 client over the injected ctx.fetch: refresh-token grant with a cached access token, channel stats,
// comment threads (one call for the whole channel), recent uploads, metadata update with a one-time backup, resumable
// upload and comment replies. Every call is booked in the quota ledger first; 5xx/429/network are TransientError, a
// rejected login is AuthError. Secrets only travel in request bodies and Authorization headers.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, type Lang, paths, readJson, SetupError, writeJson, type YoutubeAccess, type YoutubeOauth } from "./config.ts";
import { COSTS, spend } from "./quota.ts";
import { AuthError, TransientError } from "./watchkit.ts";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3/videos";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_MARGIN_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export class YoutubeError extends Error {
	readonly status: number;
	readonly reason: string;
	constructor(status: number, reason: string) {
		super(`youtube ${status} ${reason}`);
		this.name = "YoutubeError";
		this.status = status;
		this.reason = reason;
	}
}

export type YtLoc = { title: string; description: string };
export type YtVideo = { id: string; title: string; description: string; categoryId: string; tags?: string[]; defaultLanguage?: string; publishedAt?: string; localizations: Record<Lang, YtLoc> };
export type YtComment = { id: string; videoId: string; author: string; authorChannelId?: string; text: string; publishedAt: string; replied: boolean };
export type VideoSource = { size: number; body: () => BodyInit };
export type VideoReader = (path: string) => VideoSource;

export const bunReader: VideoReader = path => {
	const f = Bun.file(path);
	return { size: f.size, body: () => f };
};

async function send(ctx: Ctx, url: string, init: RequestInit): Promise<Response> {
	let res: Response;
	try {
		res = await ctx.fetch(url, init);
	} catch {
		throw new TransientError("youtube network error");
	}
	if (res.status === 401) throw new AuthError("youtube");
	if (res.status === 429 || res.status >= 500) throw new TransientError(`youtube http ${res.status}`);
	return res;
}

async function reject(res: Response): Promise<never> {
	const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; status?: string } };
	throw new YoutubeError(res.status, String(body.error?.errors?.[0]?.reason ?? body.error?.status ?? "error"));
}

async function api<T>(ctx: Ctx, token: string, method: string, path: string, params: Record<string, string>, cost: number, body?: unknown): Promise<T> {
	spend(ctx, cost);
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await send(ctx, `${API}/${path}?${new URLSearchParams(params)}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	if (!res.ok) await reject(res);
	return (await res.json()) as T;
}

function cachedAccess(ctx: Ctx): string | undefined {
	try {
		const c = readJson<YoutubeAccess>(paths.ytAccess());
		if (c?.access_token && Date.parse(c.expires_at) - ctx.now().getTime() > EXPIRY_MARGIN_MS) return c.access_token;
	} catch {}
	return undefined;
}

export async function accessToken(ctx: Ctx): Promise<string> {
	const cached = cachedAccess(ctx);
	if (cached) return cached;
	const oauth = readJson<YoutubeOauth>(paths.ytOauth());
	if (!oauth?.client_id || !oauth.client_secret || !oauth.refresh_token) throw new SetupError("youtube login is not set up");
	let res: Response;
	try {
		res = await ctx.fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: oauth.client_id, client_secret: oauth.client_secret, refresh_token: oauth.refresh_token, grant_type: "refresh_token" }),
		});
	} catch {
		throw new TransientError("youtube token network error");
	}
	if (res.status === 429 || res.status >= 500) throw new TransientError(`youtube token http ${res.status}`);
	const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
	if (res.status === 401 || (res.status === 400 && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(String(j.error)))) throw new AuthError("youtube");
	if (!res.ok || !j.access_token) throw new YoutubeError(res.status, String(j.error ?? "token"));
	const access: YoutubeAccess = { access_token: j.access_token, expires_at: new Date(ctx.now().getTime() + (Number(j.expires_in) || 3600) * 1000).toISOString() };
	writeJson(paths.ytAccess(), access, true);
	return access.access_token;
}

export async function myChannel(ctx: Ctx, token?: string): Promise<{ id: string; title: string }> {
	const t = token ?? (await accessToken(ctx));
	const d = await api<{ items?: { id: string; snippet: { title: string } }[] }>(ctx, t, "GET", "channels", { part: "snippet", mine: "true" }, COSTS.list);
	const c = d.items?.[0];
	if (!c) throw new YoutubeError(404, "noChannel");
	return { id: c.id, title: c.snippet.title };
}

export async function channelStats(ctx: Ctx, channelId: string): Promise<{ title: string; subscribers: number; views: number; videos: number }> {
	const t = await accessToken(ctx);
	const d = await api<{ items?: { snippet: { title: string }; statistics: { subscriberCount?: string; viewCount?: string; videoCount?: string } }[] }>(ctx, t, "GET", "channels", { part: "statistics,snippet", id: channelId }, COSTS.list);
	const c = d.items?.[0];
	if (!c) throw new YoutubeError(404, "noChannel");
	return { title: c.snippet.title, subscribers: Number(c.statistics.subscriberCount) || 0, views: Number(c.statistics.viewCount) || 0, videos: Number(c.statistics.videoCount) || 0 };
}

type Thread = {
	snippet: { videoId?: string; topLevelComment: { id: string; snippet: { authorDisplayName: string; authorChannelId?: { value: string }; textDisplay?: string; textOriginal?: string; publishedAt: string } } };
	replies?: { comments: { snippet: { authorChannelId?: { value: string }; textDisplay?: string; textOriginal?: string } }[] };
};
type ThreadPage = { items?: Thread[]; nextPageToken?: string };

async function* threadPages(ctx: Ctx, token: string, channelId: string, maxPages: number): AsyncGenerator<Thread[]> {
	let pageToken: string | undefined;
	for (let i = 0; i < maxPages; i++) {
		const params: Record<string, string> = { part: "snippet,replies", allThreadsRelatedToChannelId: channelId, order: "time", maxResults: "100", textFormat: "plainText" };
		if (pageToken) params.pageToken = pageToken;
		const d = await api<ThreadPage>(ctx, token, "GET", "commentThreads", params, COSTS.list);
		yield d.items ?? [];
		pageToken = d.nextPageToken;
		if (!pageToken) return;
	}
}

// New = top-level comment newer than `since`, not by the channel, with no reply by the channel. Without `since` (first run)
// it reads one page only to learn `newest`, the value the baseline moves to.
export async function commentThreadsSince(ctx: Ctx, channelId: string, since: string | undefined, maxPages = 3): Promise<{ comments: YtComment[]; newest?: string }> {
	const token = await accessToken(ctx);
	const sinceMs = since === undefined ? undefined : Date.parse(since);
	const comments: YtComment[] = [];
	let newest: string | undefined;
	for await (const page of threadPages(ctx, token, channelId, sinceMs === undefined ? 1 : maxPages)) {
		let reachedBaseline = false;
		for (const t of page) {
			const top = t.snippet.topLevelComment;
			const at = top.snippet.publishedAt;
			if (!newest || Date.parse(at) > Date.parse(newest)) newest = at;
			if (sinceMs === undefined) return { comments, newest };
			if (Date.parse(at) <= sinceMs) {
				reachedBaseline = true;
				break;
			}
			const authorId = top.snippet.authorChannelId?.value;
			const replied = (t.replies?.comments ?? []).some(r => r.snippet.authorChannelId?.value === channelId);
			if (authorId === channelId || replied) continue;
			comments.push({ id: top.id, videoId: t.snippet.videoId ?? "", author: top.snippet.authorDisplayName, authorChannelId: authorId, text: top.snippet.textDisplay ?? top.snippet.textOriginal ?? "", publishedAt: at, replied });
		}
		if (reachedBaseline) break;
	}
	return { comments, newest };
}

// The channel's own replies (texts only) from the newest threads, for tone-sample.
export async function ownReplies(ctx: Ctx, channelId: string, limit: number, maxPages = 3): Promise<string[]> {
	const token = await accessToken(ctx);
	const out: string[] = [];
	for await (const page of threadPages(ctx, token, channelId, maxPages)) {
		for (const t of page) for (const r of t.replies?.comments ?? []) if (r.snippet.authorChannelId?.value === channelId) out.push(r.snippet.textDisplay ?? r.snippet.textOriginal ?? "");
		if (out.length >= limit) break;
	}
	return out.slice(0, limit);
}

export async function recentUploads(ctx: Ctx, channelId: string, max = 10): Promise<{ id: string; title: string; publishedAt: string }[]> {
	const t = await accessToken(ctx);
	const uploads = `UU${channelId.slice(2)}`;
	const d = await api<{ items?: { snippet: { title: string; publishedAt: string; resourceId: { videoId: string } } }[] }>(ctx, t, "GET", "playlistItems", { part: "snippet", playlistId: uploads, maxResults: String(max) }, COSTS.list);
	return (d.items ?? []).map(i => ({ id: i.snippet.resourceId.videoId, title: i.snippet.title, publishedAt: i.snippet.publishedAt }));
}

type RawVideo = { id: string; snippet: { title: string; description?: string; categoryId: string; tags?: string[]; defaultLanguage?: string; publishedAt?: string }; localizations?: Record<Lang, YtLoc> };

export async function videosWithLocalizations(ctx: Ctx, ids: string[]): Promise<YtVideo[]> {
	const t = await accessToken(ctx);
	const out: YtVideo[] = [];
	for (let i = 0; i < ids.length; i += 50) {
		const d = await api<{ items?: RawVideo[] }>(ctx, t, "GET", "videos", { part: "snippet,localizations", id: ids.slice(i, i + 50).join(",") }, COSTS.list);
		for (const v of d.items ?? []) out.push({ id: v.id, title: v.snippet.title, description: v.snippet.description ?? "", categoryId: v.snippet.categoryId, tags: v.snippet.tags, defaultLanguage: v.snippet.defaultLanguage, publishedAt: v.snippet.publishedAt, localizations: v.localizations ?? {} });
	}
	return out;
}

type Backup = { snippet: { title: string; description: string; categoryId: string; tags?: string[]; defaultLanguage?: string }; localizations: Record<Lang, YtLoc> };
const backupFile = (videoId: string) => join(paths.backup(), `${videoId}.json`);
const snippetOf = (v: YtVideo, defaultLanguage: string) => ({ title: v.title, description: v.description, categoryId: v.categoryId, ...(v.tags ? { tags: v.tags } : {}), defaultLanguage });

// `video` is the current state as read by videosWithLocalizations; the first change writes its backup, later ones keep it.
export async function updateVideo(ctx: Ctx, video: YtVideo, change: { description?: string; localizations?: Record<Lang, YtLoc> }, baseLanguage: Lang): Promise<void> {
	const t = await accessToken(ctx);
	const lang = video.defaultLanguage ?? baseLanguage;
	if (!existsSync(backupFile(video.id))) writeJson(backupFile(video.id), { snippet: snippetOf(video, lang), localizations: video.localizations } satisfies Backup);
	const snippet = { ...snippetOf(video, lang), description: change.description ?? video.description };
	await api(ctx, t, "PUT", "videos", { part: "snippet,localizations" }, COSTS.update, { id: video.id, snippet, localizations: { ...video.localizations, ...change.localizations } });
}

export async function restoreVideo(ctx: Ctx, videoId: string): Promise<void> {
	const b = readJson<Backup>(backupFile(videoId));
	if (!b) throw new YoutubeError(404, "noBackup");
	const t = await accessToken(ctx);
	await api(ctx, t, "PUT", "videos", { part: "snippet,localizations" }, COSTS.update, { id: videoId, snippet: b.snippet, localizations: b.localizations });
}

export type NewVideo = { file: string; title: string; description: string; tags?: string[]; privacy: "private" | "unlisted" | "public"; defaultLanguage?: Lang; localizations?: Record<Lang, YtLoc> };

export async function insertVideo(ctx: Ctx, v: NewVideo, reader: VideoReader = bunReader): Promise<string> {
	const t = await accessToken(ctx);
	const src = reader(v.file);
	const localized = v.localizations && Object.keys(v.localizations).length > 0;
	const parts = ["snippet", "status", ...(localized ? ["localizations"] : [])].join(",");
	const meta = {
		snippet: { title: v.title, description: v.description, ...(v.tags ? { tags: v.tags } : {}), ...(v.defaultLanguage ? { defaultLanguage: v.defaultLanguage } : {}) },
		status: { privacyStatus: v.privacy, selfDeclaredMadeForKids: false },
		...(localized ? { localizations: v.localizations } : {}),
	};
	spend(ctx, COSTS.videoInsert);
	const start = await send(ctx, `${UPLOAD_API}?${new URLSearchParams({ uploadType: "resumable", part: parts })}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(src.size), "X-Upload-Content-Type": "video/*" },
		body: JSON.stringify(meta),
	});
	if (!start.ok) await reject(start);
	const session = start.headers.get("location");
	if (!session) throw new YoutubeError(502, "noUploadSession");
	const done = await send(ctx, session, { method: "PUT", headers: { "Content-Length": String(src.size), "Content-Type": "video/*" }, body: src.body(), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
	if (!done.ok) await reject(done);
	const id = ((await done.json()) as { id?: string }).id;
	if (!id) throw new YoutubeError(502, "noVideoId");
	return id;
}

export async function replyToComment(ctx: Ctx, parentId: string, text: string): Promise<string> {
	const t = await accessToken(ctx);
	const d = await api<{ id: string }>(ctx, t, "POST", "comments", { part: "snippet" }, COSTS.insertComment, { snippet: { parentId, textOriginal: text } });
	return d.id;
}
