// Instagram Graph API client (Instagram Login, graph.instagram.com) over the injected ctx.fetch: account info, media with
// comment counts, comments, replies, Reels publishing (container, bounded status polling, publish) and long-lived token
// upkeep. The token only travels in the Authorization header; OAuthException 190 / 401 is AuthError, 5xx/429/rate limits and
// network errors are TransientError.
import { type Ctx, type InstagramSecret, paths, readJson, SetupError, writeJson } from "./config.ts";
import { PUBLISH_MISSING_KO, clearPublishMissing, setPublishMissing } from "./ig-publish.ts";
import { UNKNOWN_USER } from "./ig-owner.ts";
import { AuthError, TransientError } from "./watchkit.ts";

const BASE = "https://graph.instagram.com/v23.0";
const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";
const DAY_MS = 86_400_000;
const PUBLISH_DENIED_CODE = 10;
const REFRESH_AFTER_MS = 7 * DAY_MS;
const REFRESH_WINDOW_MS = 20 * DAY_MS;
const MIN_REFRESH_AGE_MS = DAY_MS;
const POLL_TRIES = 30;
const POLL_WAIT_MS = 5_000;
const RATE_LIMIT_CODES = [4, 17, 32, 613];

export class InstagramError extends Error {
	readonly status: number;
	readonly code?: number;
	constructor(status: number, message: string, code?: number) {
		super(`instagram ${status} ${message}`);
		this.name = "InstagramError";
		this.status = status;
		this.code = code;
	}
}

export type IgMedia = { id: string; caption?: string; comments_count: number; timestamp: string; permalink?: string; thumb?: string };
export type IgReply = { id?: string; username: string; text: string; fromId?: string; timestamp?: string };
export type IgComment = { id: string; text: string; username: string; timestamp: string; fromId?: string; replies: IgReply[] };

// The token has no instagram_business_content_publish (API code 10): the Reel cannot go out until the owner makes the token again.
export class PublishPermissionError extends Error {
	constructor() {
		super(PUBLISH_MISSING_KO);
		this.name = "PublishPermissionError";
	}
}

type IgFrom = { id?: string; username?: string };
// Some comments (left, restricted or deleted accounts) come without `username`; fall back to `from`, then to a fixed label.
const authorOf = (c: { username?: string; from?: IgFrom }): string => c.username || c.from?.username || c.from?.id || UNKNOWN_USER;

type GraphError = { error?: { code?: number; message?: string; type?: string } };

function secret(): InstagramSecret {
	const s = readJson<InstagramSecret>(paths.instagram());
	if (!s?.access_token) throw new SetupError("instagram login is not set up");
	return s;
}

async function graph<T>(ctx: Ctx, url: string, token: string, init: RequestInit = {}, tokenInQuery = false): Promise<T> {
	let res: Response;
	try {
		res = tokenInQuery
			? await ctx.fetch(`${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams({ access_token: token })}`, init)
			: await ctx.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } });
	} catch {
		throw new TransientError("instagram network error");
	}
	const body = (await res.json().catch(() => ({}))) as T & GraphError;
	const code = body.error?.code;
	if (res.status === 401 || code === 190) throw new AuthError("instagram");
	if (res.status === 429 || res.status >= 500 || (code !== undefined && RATE_LIMIT_CODES.includes(code))) throw new TransientError(`instagram http ${res.status}`);
	if (!res.ok || body.error) throw new InstagramError(res.status, String(body.error?.type ?? "error"), code);
	return body;
}

const form = (fields: Record<string, string>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

export async function me(ctx: Ctx, token?: string): Promise<{ user_id: string; username: string; followers: number; media: number }> {
	const t = token ?? secret().access_token;
	const d = await graph<{ user_id?: string; id?: string; username: string; followers_count?: number; media_count?: number }>(ctx, `${BASE}/me?${new URLSearchParams({ fields: "user_id,username,followers_count,media_count" })}`, t);
	return { user_id: String(d.user_id ?? d.id), username: d.username, followers: d.followers_count ?? 0, media: d.media_count ?? 0 };
}

export async function mediaWithCounts(ctx: Ctx, limit = 50): Promise<IgMedia[]> {
	type Raw = { id: string; caption?: string; comments_count?: number; timestamp: string; permalink?: string; media_type?: string; media_url?: string; thumbnail_url?: string };
	const d = await graph<{ data?: Raw[] }>(ctx, `${BASE}/me/media?${new URLSearchParams({ fields: "id,caption,comments_count,timestamp,permalink,media_type,media_url,thumbnail_url", limit: String(limit) })}`, secret().access_token);
	// The picture to show: a video's own media_url is the video file, so only its thumbnail_url counts.
	return (d.data ?? []).map(m => {
		const thumb = m.media_type === "VIDEO" ? m.thumbnail_url : (m.media_url ?? m.thumbnail_url);
		return { id: m.id, caption: m.caption, comments_count: m.comments_count ?? 0, timestamp: m.timestamp, ...(m.permalink ? { permalink: m.permalink } : {}), ...(thumb ? { thumb } : {}) };
	});
}

// ---- direct messages (read only) --------------------------------------------------------------------------------------
// Instagram API with Instagram Login, Conversations API (graph.instagram.com): GET /me/conversations?platform=instagram and
// GET /<conversation-id>?fields=messages{...}. Permission: instagram_business_manage_messages (+ instagram_business_basic). Nothing here sends.
// Docs: developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api
export const DM_PERMISSION = "instagram_business_manage_messages";
export type IgConversation = { id: string; updated_time: string };
export type IgDmParty = { id?: string; username?: string };
export type IgDmMessage = { id: string; text: string; from: IgDmParty; to: IgDmParty[]; created_time: string; attachments: { kind: "image" | "video" | "audio" | "file"; name?: string }[] };

// Meta answers a missing permission with OAuthException code 10 ("requires the instagram_business_manage_messages permission") or a code in 200-299.
export const isPermissionError = (e: unknown): boolean => e instanceof InstagramError && e.code !== undefined && (e.code === 10 || (e.code >= 200 && e.code <= 299));

export async function conversations(ctx: Ctx, limit = 50): Promise<IgConversation[]> {
	const d = await graph<{ data?: IgConversation[] }>(ctx, `${BASE}/me/conversations?${new URLSearchParams({ platform: "instagram", fields: "id,updated_time", limit: String(limit) })}`, secret().access_token);
	return (d.data ?? []).filter(c => c?.id);
}

// Details exist only for the 20 most recent messages of a conversation (Meta limit), newest first as the API lists them.
export async function conversationMessages(ctx: Ctx, conversationId: string): Promise<IgDmMessage[]> {
	type Raw = { id: string; message?: string; created_time: string; from?: IgDmParty; to?: { data?: IgDmParty[] }; attachments?: { data?: { mime_type?: string; name?: string; image_data?: unknown; video_data?: unknown }[] } };
	const d = await graph<{ messages?: { data?: Raw[] } }>(ctx, `${BASE}/${encodeURIComponent(conversationId)}?${new URLSearchParams({ fields: "messages.limit(20){message,from,to,created_time,attachments}" })}`, secret().access_token);
	return (d.messages?.data ?? []).map(m => ({
		id: m.id,
		text: m.message ?? "",
		from: m.from ?? {},
		to: m.to?.data ?? [],
		created_time: m.created_time,
		attachments: (m.attachments?.data ?? []).map(a => {
			const mime = a.mime_type ?? "";
			const kind = a.image_data || mime.startsWith("image/") ? "image" : a.video_data || mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";
			return { kind, ...(a.name ? { name: a.name } : {}) };
		}),
	}));
}

export async function commentsFor(ctx: Ctx, mediaId: string): Promise<IgComment[]> {
	type Raw = { id?: string; username?: string; from?: IgFrom; text?: string; timestamp?: string };
	const d = await graph<{ data?: (Raw & { id: string; timestamp: string; replies?: { data?: Raw[] } })[] }>(
		ctx,
		`${BASE}/${encodeURIComponent(mediaId)}/comments?${new URLSearchParams({ fields: "id,text,username,from{id,username},timestamp,replies{id,username,from{id,username},text,timestamp}", limit: "50" })}`,
		secret().access_token,
	);
	return (d.data ?? []).map(c => ({
		id: c.id,
		text: c.text ?? "",
		username: authorOf(c),
		timestamp: c.timestamp,
		fromId: c.from?.id,
		replies: (c.replies?.data ?? []).map(r => ({ id: r.id, username: authorOf(r), text: r.text ?? "", fromId: r.from?.id, timestamp: r.timestamp })),
	}));
}

export async function reply(ctx: Ctx, commentId: string, text: string): Promise<string> {
	const d = await graph<{ id: string }>(ctx, `${BASE}/${encodeURIComponent(commentId)}/replies`, secret().access_token, form({ message: text }));
	return d.id;
}

// A publish that Meta refuses with code 10 is remembered (lib/ig-publish.ts) and surfaces as PublishPermissionError; one that works clears it.
export async function publishReel(ctx: Ctx, videoUrl: string, caption: string): Promise<string> {
	try {
		const id = await publishReelCall(ctx, videoUrl, caption);
		clearPublishMissing();
		return id;
	} catch (e) {
		if (e instanceof InstagramError && e.code === PUBLISH_DENIED_CODE) {
			setPublishMissing(ctx);
			throw new PublishPermissionError();
		}
		throw e;
	}
}

async function publishReelCall(ctx: Ctx, videoUrl: string, caption: string): Promise<string> {
	const token = secret().access_token;
	const container = await graph<{ id: string }>(ctx, `${BASE}/me/media`, token, form({ media_type: "REELS", video_url: videoUrl, caption }));
	for (let i = 0; ; i++) {
		const s = await graph<{ status_code?: string }>(ctx, `${BASE}/${container.id}?${new URLSearchParams({ fields: "status_code" })}`, token);
		if (s.status_code === "FINISHED") break;
		if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new InstagramError(422, `container ${s.status_code}`);
		if (i + 1 >= POLL_TRIES) throw new InstagramError(408, "container not ready in time");
		await ctx.sleep(POLL_WAIT_MS);
	}
	const published = await graph<{ id: string }>(ctx, `${BASE}/me/media_publish`, token, form({ creation_id: container.id }));
	return published.id;
}

// The one schedule: due when the token is at least 24 h old and either older than 7 days or expiring within 20 days.
export function refreshDue(s: Pick<InstagramSecret, "obtained_at" | "expires_at">, now: Date): boolean {
	const age = now.getTime() - Date.parse(s.obtained_at);
	const left = s.expires_at ? Date.parse(s.expires_at) - now.getTime() : Number.POSITIVE_INFINITY;
	return age >= MIN_REFRESH_AGE_MS && (age > REFRESH_AFTER_MS || left < REFRESH_WINDOW_MS);
}

export async function refreshIfNeeded(ctx: Ctx): Promise<{ refreshed: boolean }> {
	const s = secret();
	const now = ctx.now().getTime();
	if (!refreshDue(s, ctx.now())) return { refreshed: false };
	// Meta documents this endpoint with the token as a query parameter only (no Authorization header).
	const d = await graph<{ access_token: string; expires_in: number }>(ctx, `${REFRESH_URL}?${new URLSearchParams({ grant_type: "ig_refresh_token" })}`, s.access_token, {}, true);
	writeJson(paths.instagram(), { ...s, access_token: d.access_token, obtained_at: ctx.now().toISOString(), expires_at: new Date(now + d.expires_in * 1000).toISOString() } satisfies InstagramSecret, true);
	return { refreshed: true };
}
