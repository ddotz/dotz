// Instagram Graph API client (Instagram Login, graph.instagram.com) over the injected ctx.fetch: account info, media with
// comment counts, comments, replies, Reels publishing (container, bounded status polling, publish) and long-lived token
// upkeep. The token only travels in the Authorization header; OAuthException 190 / 401 is AuthError, 5xx/429/rate limits and
// network errors are TransientError.
import { type Ctx, type InstagramSecret, paths, readJson, SetupError, writeJson } from "./config.ts";
import { AuthError, TransientError } from "./watchkit.ts";

const BASE = "https://graph.instagram.com/v23.0";
const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";
const DAY_MS = 86_400_000;
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

export type IgMedia = { id: string; caption?: string; comments_count: number; timestamp: string };
export type IgComment = { id: string; text: string; username: string; timestamp: string; replies: { username: string; text: string }[] };

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
	const d = await graph<{ data?: IgMedia[] }>(ctx, `${BASE}/me/media?${new URLSearchParams({ fields: "id,caption,comments_count,timestamp", limit: String(limit) })}`, secret().access_token);
	return (d.data ?? []).map(m => ({ ...m, comments_count: m.comments_count ?? 0 }));
}

export async function commentsFor(ctx: Ctx, mediaId: string): Promise<IgComment[]> {
	const d = await graph<{ data?: { id: string; text?: string; username: string; timestamp: string; replies?: { data?: { username: string; text?: string }[] } }[] }>(
		ctx,
		`${BASE}/${encodeURIComponent(mediaId)}/comments?${new URLSearchParams({ fields: "id,text,username,timestamp,replies{username,text}", limit: "50" })}`,
		secret().access_token,
	);
	return (d.data ?? []).map(c => ({ id: c.id, text: c.text ?? "", username: c.username, timestamp: c.timestamp, replies: (c.replies?.data ?? []).map(r => ({ username: r.username, text: r.text ?? "" })) }));
}

export async function reply(ctx: Ctx, commentId: string, text: string): Promise<string> {
	const d = await graph<{ id: string }>(ctx, `${BASE}/${encodeURIComponent(commentId)}/replies`, secret().access_token, form({ message: text }));
	return d.id;
}

export async function publishReel(ctx: Ctx, videoUrl: string, caption: string): Promise<string> {
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

// Refreshes when the token is at least 24 h old and either older than 7 days or expiring within 20 days.
export async function refreshIfNeeded(ctx: Ctx): Promise<{ refreshed: boolean }> {
	const s = secret();
	const now = ctx.now().getTime();
	const age = now - Date.parse(s.obtained_at);
	const left = s.expires_at ? Date.parse(s.expires_at) - now : Number.POSITIVE_INFINITY;
	if (!(age >= MIN_REFRESH_AGE_MS && (age > REFRESH_AFTER_MS || left < REFRESH_WINDOW_MS))) return { refreshed: false };
	// Meta documents this endpoint with the token as a query parameter only (no Authorization header).
	const d = await graph<{ access_token: string; expires_in: number }>(ctx, `${REFRESH_URL}?${new URLSearchParams({ grant_type: "ig_refresh_token" })}`, s.access_token, {}, true);
	writeJson(paths.instagram(), { ...s, access_token: d.access_token, obtained_at: ctx.now().toISOString(), expires_at: new Date(now + d.expires_in * 1000).toISOString() } satisfies InstagramSecret, true);
	return { refreshed: true };
}
