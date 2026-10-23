// Comment reader on YouTube's public web endpoints (InnerTube), no login and no Data API quota. For the owner's own channel: the
// public uploads feed lists the newest videos with their titles, each watch page carries the API key, the client version and the
// first comments continuation, and youtubei/v1/next returns the comments (newest-first after one more call through the sort menu).
// The web only shows relative times ("3 hours ago"), so published times here are estimates; callers that need exact baselines
// use ids (lib/yt-read.ts). Anything unexpected throws InnerTubeError so the caller can fall back to the Data API.
import type { Ctx } from "./config.ts";

export class InnerTubeError extends Error {}

export type InnerComment = { id: string; videoId: string; videoTitle: string; author: string; authorChannelId?: string; text: string; publishedAt: string; replyCount: number };
export type FeedVideo = { id: string; title: string };
export type PageInfo = { key: string; version: string; token: string };

const FEED_MAX = 15;
const PER_VIDEO_MAX = 40;
const PARALLEL = 3;
const WATCH = "https://www.youtube.com/watch";
const NEXT = "https://www.youtube.com/youtubei/v1/next";
const FEED = "https://www.youtube.com/feeds/videos.xml";
const HEADERS = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", "accept-language": "en-US,en;q=0.9" };

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

export function parseFeed(xml: string): FeedVideo[] {
	const out: FeedVideo[] = [];
	for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const id = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(m[1]!)?.[1];
		const title = /<title>([\s\S]*?)<\/title>/.exec(m[1]!)?.[1];
		if (id) out.push({ id, title: unxml(title ?? "") });
	}
	return out.slice(0, FEED_MAX);
}

const walk = (node: unknown, visit: (o: Record<string, any>) => void): void => {
	if (Array.isArray(node)) for (const x of node) walk(x, visit);
	else if (node && typeof node === "object") {
		visit(node as Record<string, any>);
		for (const v of Object.values(node)) walk(v, visit);
	}
};

function initialData(html: string): unknown {
	const start = html.indexOf("ytInitialData = ");
	if (start < 0) throw new InnerTubeError("no ytInitialData");
	const from = html.indexOf("{", start);
	let depth = 0;
	let inStr = false;
	for (let i = from; i < html.length; i++) {
		const c = html[i];
		if (inStr) {
			if (c === "\\") i++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) {
			try {
				return JSON.parse(html.slice(from, i + 1));
			} catch {
				throw new InnerTubeError("ytInitialData is not JSON");
			}
		}
	}
	throw new InnerTubeError("ytInitialData is cut off");
}

// key + client version from the page's ytcfg, and the comments continuation of the page's comment section.
export function parseWatchPage(html: string): PageInfo {
	const key = /"INNERTUBE_API_KEY":"([\w-]+)"/.exec(html)?.[1];
	const version = /"INNERTUBE_(?:CONTEXT_)?CLIENT_VERSION":"([\d.]+)"/.exec(html)?.[1];
	if (!key || !version) throw new InnerTubeError("no InnerTube key or client version");
	let token: string | undefined;
	walk(initialData(html), o => {
		if (!token && o.sectionIdentifier === "comment-item-section") token = findToken(o);
	});
	if (!token) throw new InnerTubeError("no comments continuation (comments off?)");
	return { key, version, token };
}

function findToken(node: unknown): string | undefined {
	let t: string | undefined;
	walk(node, o => {
		if (!t && typeof o.continuationCommand?.token === "string") t = o.continuationCommand.token;
	});
	return t;
}

// The token of the "newest first" entry of the sort menu in a first comments response, if there is one.
export function newestToken(resp: unknown): string | undefined {
	let t: string | undefined;
	walk(resp, o => {
		if (t || !Array.isArray(o.subMenuItems)) return;
		const items = o.subMenuItems as Record<string, any>[];
		const pick = items.find(i => /newest|최신/i.test(String(i.title ?? ""))) ?? items[1];
		t = pick?.serviceEndpoint?.continuationCommand?.token;
	});
	return t;
}

const UNITS: [RegExp, number][] = [
	[/^(second|sec|초)/i, 1000],
	[/^(minute|min|분)/i, 60_000],
	[/^(hour|시간)/i, 3_600_000],
	[/^(day|일)/i, 86_400_000],
	[/^(week|주)/i, 7 * 86_400_000],
	[/^(month|개월|달)/i, 30 * 86_400_000],
	[/^(year|년)/i, 365 * 86_400_000],
];

export function estimateTime(relative: string, now: Date): string {
	const m = /(\d+)\s*([A-Za-z가-힣]+)/.exec(relative);
	const unit = m ? UNITS.find(([re]) => re.test(m[2]!)) : undefined;
	return new Date(now.getTime() - (m && unit ? Number(m[1]) * unit[1] : 0)).toISOString();
}

const runsText = (v: any): string => (typeof v?.simpleText === "string" ? v.simpleText : Array.isArray(v?.runs) ? v.runs.map((r: any) => r.text ?? "").join("") : "");

// Top-level comments of a /next response, both the entity format (commentEntityPayload) and the older commentRenderer.
export function parseComments(resp: unknown, video: FeedVideo, now: Date): InnerComment[] {
	const out: InnerComment[] = [];
	const seen = new Set<string>();
	const push = (c: InnerComment) => {
		if (c.id && !seen.has(c.id)) {
			seen.add(c.id);
			out.push(c);
		}
	};
	walk(resp, o => {
		const p = o.commentEntityPayload;
		if (p?.properties?.commentId) {
			if (Number(p.properties.replyLevel) > 0) return;
			push({ id: p.properties.commentId, videoId: video.id, videoTitle: video.title, author: String(p.author?.displayName ?? "").replace(/^@/, ""), authorChannelId: p.author?.channelId, text: String(p.properties.content?.content ?? ""), publishedAt: estimateTime(String(p.properties.publishedTime ?? ""), now), replyCount: Number(p.toolbar?.replyCount) || 0 });
		}
		const r = o.commentRenderer;
		if (r?.commentId) {
			push({ id: r.commentId, videoId: video.id, videoTitle: video.title, author: runsText(r.authorText).replace(/^@/, ""), authorChannelId: r.authorEndpoint?.browseEndpoint?.browseId, text: runsText(r.contentText), publishedAt: estimateTime(runsText(r.publishedTimeText), now), replyCount: Number(r.replyCount) || 0 });
		}
	});
	return out.slice(0, PER_VIDEO_MAX);
}

async function getText(ctx: Ctx, url: string): Promise<string> {
	const res = await ctx.fetch(url, { headers: HEADERS });
	if (!res.ok) throw new InnerTubeError(`http ${res.status}`);
	return res.text();
}

async function next(ctx: Ctx, page: PageInfo, token: string): Promise<unknown> {
	const res = await ctx.fetch(`${NEXT}?${new URLSearchParams({ key: page.key, prettyPrint: "false" })}`, {
		method: "POST",
		headers: { ...HEADERS, "content-type": "application/json" },
		body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: page.version, hl: "en" } }, continuation: token }),
	});
	if (!res.ok) throw new InnerTubeError(`next http ${res.status}`);
	return res.json();
}

async function videoComments(ctx: Ctx, video: FeedVideo): Promise<InnerComment[]> {
	const page = parseWatchPage(await getText(ctx, `${WATCH}?${new URLSearchParams({ v: video.id, hl: "en" })}`));
	const first = await next(ctx, page, page.token);
	const sorted = newestToken(first);
	return parseComments(sorted ? await next(ctx, page, sorted) : first, video, ctx.now());
}

// Newest comments of the channel's newest public videos (the uploads feed lists at most 15). Any failure throws, so a half-read feed
// is never taken for "no new comments".
export async function innertubeComments(ctx: Ctx, channelId: string): Promise<InnerComment[]> {
	let videos: FeedVideo[];
	try {
		videos = parseFeed(await getText(ctx, `${FEED}?${new URLSearchParams({ channel_id: channelId })}`));
	} catch (e) {
		throw e instanceof InnerTubeError ? e : new InnerTubeError("feed unreachable");
	}
	if (!videos.length) throw new InnerTubeError("empty uploads feed");
	const out: InnerComment[] = [];
	try {
		for (let i = 0; i < videos.length; i += PARALLEL) out.push(...(await Promise.all(videos.slice(i, i + PARALLEL).map(v => videoComments(ctx, v)))).flat());
	} catch (e) {
		throw e instanceof InnerTubeError ? e : new InnerTubeError("watch page unreachable");
	}
	return out;
}
