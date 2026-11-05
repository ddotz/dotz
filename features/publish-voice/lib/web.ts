// A page, or the latest posts of a blog (RSS/Atom first, then a sitemap). Only the host the user named is fetched, every fetch is time limited.
import { htmlText, type Collected } from "./readers.ts";
import { guardUrl, OutOfScopeError, sameSite, type Scope, type Target } from "./targets.ts";

export type Fetcher = (url: string) => Promise<string>;
export type FeedItem = { title: string; link: string; html: string; date: string };

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 2_000_000;
const MAX_HOPS = 5;
// A feed that gives less than this is a summary; the post page is read for the body.
const ENOUGH = 500;
const SITEMAP_CHILDREN = 3;

async function bodyText(res: Response): Promise<string> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = res.body?.getReader();
	while (reader && size < MAX_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.length;
	}
	await reader?.cancel();
	return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8");
}

// A redirect to another site is outside what the user was told, so it is refused before any request goes there.
export const realFetch: Fetcher = async url => {
	let current = url;
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "dotz-publish-voice" } });
		const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
		if (!location) {
			if (!res.ok) throw new Error(`${url} 응답 ${res.status}`);
			return bodyText(res);
		}
		await res.body?.cancel();
		const next = new URL(location, current);
		if (!/^https?:$/.test(next.protocol) || !sameSite(next.hostname, new URL(url).hostname)) throw new Error(`${url}이(가) ${next.hostname}(으)로 넘어가서 읽지 않아요`);
		current = next.href;
	}
	throw new Error(`${url}이(가) ${MAX_HOPS}번 넘어가도 끝나지 않아서 읽지 않아요`);
};

const unwrap = (s: string): string => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
const tag = (xml: string, name: string): string => {
	const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
	return m ? unwrap(m[1] ?? "") : "";
};

function linkOf(block: string): string {
	const atom = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map(m => m[1] ?? "").find(a => /href=/i.test(a) && !/rel=["'](?!alternate)/i.test(a));
	return /href=["']([^"']+)["']/i.exec(atom ?? "")?.[1] ?? tag(block, "link");
}

export function parseFeed(xml: string): FeedItem[] {
	const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
	return blocks.map(b => ({
		title: htmlText(tag(b, "title")),
		link: linkOf(b),
		html: tag(b, "content:encoded") || tag(b, "content") || tag(b, "description") || tag(b, "summary"),
		date: tag(b, "pubDate") || tag(b, "updated") || tag(b, "published"),
	}));
}

export function parseSitemap(xml: string): { loc: string; lastmod: string }[] {
	return (xml.match(/<(?:url|sitemap)>[\s\S]*?<\/(?:url|sitemap)>/gi) ?? []).map(b => ({ loc: tag(b, "loc"), lastmod: tag(b, "lastmod") })).filter(u => u.loc);
}

const byNewest = <T extends { date: string }>(items: T[]): T[] => [...items].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

async function itemsOf(scope: Scope, start: string, fetchText: Fetcher): Promise<FeedItem[]> {
	const first = await fetchText(guardUrl(scope, start));
	if (/<(?:rss|feed)[\s>]/i.test(first.slice(0, 2000))) return byNewest(parseFeed(first));
	const alt = /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i.exec(first)?.[0];
	const href = /href=["']([^"']+)["']/i.exec(alt ?? "")?.[1];
	if (href) return byNewest(parseFeed(await fetchText(guardUrl(scope, new URL(href, start).href))));
	const map = await fetchText(guardUrl(scope, new URL("/sitemap.xml", start).href));
	const entries = parseSitemap(map);
	const pages = /<sitemapindex/i.test(map)
		? (await Promise.all(entries.slice(0, SITEMAP_CHILDREN).map(e => fetchText(guardUrl(scope, e.loc))))).flatMap(parseSitemap)
		: entries;
	// The sitemap also lists the blog's home page (a list of posts, not a post) and, on a shared host, other people's blogs: only entries under the blog's own path stay.
	const base = new URL(start).pathname.replace(/\/+$/, "");
	const own = (loc: string): boolean => {
		const path = new URL(loc, start).pathname;
		return path !== "/" && path !== base && path.startsWith(`${base}/`);
	};
	return byNewest(pages.filter(p => own(p.loc)).map(p => ({ title: "", link: p.loc, html: "", date: p.lastmod })));
}

export async function readPage(scope: Scope, url: string, fetchText: Fetcher): Promise<Collected> {
	const html = await fetchText(guardUrl(scope, url));
	return { docs: [{ key: url, source: "url", text: htmlText(html), hint: htmlText(tag(html, "title")) }], skipped: {} };
}

// Naver post pages are framed (the body is in an iframe); the mobile address holds the body itself.
function bodyAddress(link: string): string {
	const u = new URL(link);
	if (u.hostname !== "blog.naver.com") return link;
	const [id, no] = u.pathname.split("/").filter(Boolean);
	const blogId = u.searchParams.get("blogId") ?? id;
	const logNo = u.searchParams.get("logNo") ?? no;
	return blogId && /^\d+$/.test(logNo ?? "") ? `https://m.blog.naver.com/${blogId}/${logNo}` : link;
}

async function listItems(scope: Scope, target: Target, fetchText: Fetcher): Promise<FeedItem[]> {
	const host = new URL(target.url ?? "").host;
	let items: FeedItem[];
	try { // no-excuse-ok: catch (adds the site name)
		items = await itemsOf(scope, target.url ?? "", fetchText);
	} catch (e) {
		throw new Error(`${host}에서 글 목록을 읽지 못했어요(${e instanceof Error ? e.message : String(e)})`);
	}
	if (items.length === 0) throw new Error(`${host}에서 글을 한 편도 찾지 못했어요(RSS나 사이트맵이 없는 곳일 수 있어요)`);
	return items.slice(0, target.limit ?? 50);
}

export async function readBlog(scope: Scope, target: Target, fetchText: Fetcher): Promise<Collected> {
	const out: Collected = { docs: [], skipped: {} };
	const skip = (why: string) => (out.skipped[why] = (out.skipped[why] ?? 0) + 1);
	for (const item of await listItems(scope, target, fetchText)) {
		const link = item.link ? new URL(item.link, target.url).href : "";
		try { // no-excuse-ok: catch (one link out of scope skips one post)
			if (link) guardUrl(scope, link);
		} catch (e) {
			if (!(e instanceof OutOfScopeError)) throw e;
			skip("범위 밖 링크");
			continue;
		}
		let text = htmlText(item.html);
		if (text.replace(/\s/g, "").length < ENOUGH && link) {
			try { // no-excuse-ok: catch (the summary stays when the page cannot be read)
				const page = htmlText(await fetchText(guardUrl(scope, bodyAddress(link))));
				if (page.length > text.length) text = page;
			} catch (e) {
				if (e instanceof OutOfScopeError) {
					skip("범위 밖 링크");
					continue;
				}
				skip("본문 페이지 못 읽음(요약만)");
			}
		}
		out.docs.push({ key: item.link, source: "blog", text, hint: item.title });
	}
	return out;
}
