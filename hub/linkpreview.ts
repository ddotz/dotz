// Link previews for the web views (first wired into KakaoTalk, docs/kakao-rooms-api.md). The gateway fetches the page itself: http/https only,
// every host (and every redirect hop, at most 5) DNS-resolved and refused when any address is private, loopback, link-local or otherwise
// unroutable (SSRF), 5 s for the whole request, at most 512 KB read, only HTML. The page's og: / twitter: / <title> / meta description become
// a small card; the image is served through this gateway (never hot-linked by the web, so a tracker never sees the reader).
// Results are cached in memory and in one small JSON file under the data dir (24 h); failures are cached in memory for a few minutes.
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LinkPreview = { url: string; ok: true; site?: string; title?: string; description?: string; image?: string; at: number } | { url: string; ok: false; error: string; at: number };
export type Resolver = (host: string) => Promise<string[]>;
export type PreviewDeps = {
	fetch?: typeof fetch;
	resolve?: Resolver;
	// Host names exempted from the private-address rule: the tests' local fake server only.
	allowHosts?: string[];
	// <dir>/kakao/link-previews.json holds the disk cache; without a dir the cache is memory only.
	dir?: string;
	now?: () => number;
	timeoutMs?: number;
	maxBytes?: number;
};

export const PREVIEW_TTL_MS = 24 * 3600 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const MAX_HOPS = 5;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_CACHED = 200;
const TITLE_MAX = 120;
const DESC_MAX = 240;
const SITE_MAX = 60;

const defaultResolve: Resolver = async host => (await lookup(host, { all: true })).map(a => a.address);
const isIp = (host: string) => host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

const ip4Private = (ip: string): boolean => {
	const p = ip.split(".").map(Number);
	if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = p as [number, number, number, number];
	return (
		a === 0 || // "this network"
		a === 10 || // private
		a === 127 || // loopback
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) || // link-local / cloud metadata
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) || // private
		(a === 192 && b === 0) || // IETF protocol assignments
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast, reserved, broadcast
	);
};

// Loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10), multicast and IPv4-mapped private addresses.
const ip6Private = (raw: string): boolean => {
	let ip = raw.toLowerCase();
	const zone = ip.indexOf("%");
	if (zone >= 0) ip = ip.slice(0, zone);
	if (ip === "::" || ip === "::1") return true;
	if (ip.startsWith("::ffff:")) return ip4Private(ip.slice(7));
	if (ip.startsWith("64:ff9b::")) return true; // NAT64
	if (/^f[cd]/.test(ip)) return true;
	if (/^fe[89ab]/.test(ip)) return true;
	if (/^ff/.test(ip)) return true;
	return false;
};

export const isPrivateAddress = (ip: string): boolean => (ip.includes(":") ? ip6Private(ip) : ip4Private(ip));

// A URL this module may fetch: http/https, no credentials, and every address its host resolves to is public.
async function checked(raw: string, resolve: Resolver, allowed?: Set<string>): Promise<{ ok: true; url: URL; addresses: string[] } | { ok: false; error: string }> {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { ok: false, error: "주소가 올바르지 않아요" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "http/https 주소만 미리 볼 수 있어요" };
	if (u.username || u.password) return { ok: false, error: "허용되지 않는 주소예요" };
	const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!host) return { ok: false, error: "주소가 올바르지 않아요" };
	let addresses: string[];
	if (isIp(host)) addresses = [host];
	else {
		try {
			addresses = await resolve(host);
		} catch {
			return { ok: false, error: "주소를 찾지 못했어요" };
		}
	}
	if (!addresses.length) return { ok: false, error: "주소를 찾지 못했어요" };
	// One private answer is enough to refuse: a name that maps to both a public and an internal address must not be fetchable.
	if (!allowed?.has(host) && addresses.some(isPrivateAddress)) return { ok: false, error: HOST_LIMIT };
	u.hash = "";
	return { ok: true, url: u, addresses };
}

const entity = (s: string) =>
	s
		.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");

const clip = (s: string, max: number) => {
	const chars = [...s.replace(/\s+/g, " ").trim()];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

type Meta = Map<string, string>;

// Every <meta> of the document's head-ish text: property or name -> content (the first one wins, like browsers).
function metas(html: string): Meta {
	const out: Meta = new Map();
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		const key = /\b(?:property|name)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		const val = /\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		if (!key || !val) continue;
		const k = (key[2] ?? key[3] ?? key[4] ?? "").trim().toLowerCase();
		const v = entity(val[2] ?? val[3] ?? val[4] ?? "").trim();
		if (k && v && !out.has(k)) out.set(k, v);
	}
	return out;
}

const pageTitle = (html: string): string => {
	const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return m ? entity(m[1] ?? "").trim() : "";
};

// The fields a page names, in the order browsers and link cards prefer them: og:, twitter:, then the page's own title/description.
export function parsePreview(html: string, pageUrl: URL): { site?: string; title?: string; description?: string; image?: string } {
	const m = metas(html);
	const pick = (...keys: string[]) => keys.map(k => m.get(k)).find(v => !!v);
	const title = clip(pick("og:title", "twitter:title") ?? pageTitle(html), TITLE_MAX);
	const description = clip(pick("og:description", "twitter:description", "description") ?? "", DESC_MAX);
	const site = clip(pick("og:site_name", "application-name", "twitter:site") ?? pageUrl.hostname.replace(/^www\./, ""), SITE_MAX);
	const imageRaw = pick("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src");
	let image: string | undefined;
	if (imageRaw) {
		try {
			const u = new URL(imageRaw, pageUrl);
			if (u.protocol === "http:" || u.protocol === "https:") image = u.href;
		} catch {}
	}
	return { ...(site ? { site } : {}), ...(title ? { title } : {}), ...(description ? { description } : {}), ...(image ? { image } : {}) };
}

// The bytes of a response body, at most `max`; a body that keeps coming is cut off there (the head of an HTML page carries its metas).
async function readCapped(res: Response, max: number): Promise<{ text: string; cut: boolean }> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	if (!res.body) return { text: "", cut: false };
	const reader = res.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const room = max - total;
			if (value.byteLength >= room) {
				chunks.push(value.subarray(0, room));
				await reader.cancel().catch(() => {});
				return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), cut: true };
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock?.();
	}
	return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), cut: false };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const HOST_LIMIT = "허용되지 않는 주소예요";

export function createLinkPreview(deps: PreviewDeps = {}) {
	const doFetch = deps.fetch ?? fetch;
	const resolve = deps.resolve ?? defaultResolve;
	const now = deps.now ?? Date.now;
	const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
	const maxBytes = deps.maxBytes ?? MAX_BYTES;
	const allowed = new Set((deps.allowHosts ?? []).map(h => h.toLowerCase()));
	const cacheFile = deps.dir ? join(deps.dir, "kakao", "link-previews.json") : undefined;
	const mem = new Map<string, LinkPreview>();
	const failures = new Map<string, { error: string; at: number }>();
	let loaded = false;

	const load = () => {
		if (loaded) return;
		loaded = true;
		if (!cacheFile) return;
		try {
			const raw = JSON.parse(readFileSync(cacheFile, "utf8")) as LinkPreview[];
			for (const p of Array.isArray(raw) ? raw : []) if (p && typeof p.url === "string" && p.at) mem.set(p.url, p);
		} catch {}
	};
	const save = () => {
		if (!cacheFile) return;
		try {
			mkdirSync(dirname(cacheFile), { recursive: true });
			const list = [...mem.values()].sort((a, b) => a.at - b.at).slice(-MAX_CACHED);
			const tmp = `${cacheFile}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(list, null, 1)}\n`, { mode: 0o600 });
			renameSync(tmp, cacheFile);
		} catch {}
	};
	const remembered = (url: string): LinkPreview | undefined => {
		load();
		const hit = mem.get(url);
		if (hit && now() - hit.at < PREVIEW_TTL_MS) return hit;
		if (hit) mem.delete(url);
		const bad = failures.get(url);
		if (bad && now() - bad.at < FAIL_TTL_MS) return { url, ok: false, error: bad.error, at: bad.at };
		return undefined;
	};

	// The request goes to the address that was checked, not to a second DNS answer (rebinding): the host travels in Host and,
	// for https, as the TLS server name the certificate is verified against.
	// IPv4 first, then the next checked address when one cannot be reached (a network without IPv6 routes).
	const pinnedGet = async (at: { url: URL; addresses: string[] }, init: RequestInit & { headers: Record<string, string> }): Promise<Response> => {
		const host = at.url.hostname.replace(/^\[|\]$/g, "");
		if (!at.addresses.length || isIp(host)) return doFetch(at.url.href, init);
		const ips = [...at.addresses].sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
		const headers = { ...init.headers, host: at.url.host };
		const tls = at.url.protocol === "https:" ? { tls: { serverName: host } } : {};
		let last: unknown;
		for (const ip of ips) {
			const to = new URL(at.url.href);
			to.hostname = ip.includes(":") ? `[${ip}]` : ip;
			try {
				return await doFetch(to.href, { ...init, headers, ...tls } as RequestInit);
			} catch (e) {
				if (init.signal?.aborted) throw e;
				last = e;
			}
		}
		throw last;
	};

	// One GET with the redirects followed by hand, each new address checked again; the content type must be HTML.
	const getHtml = async (raw: string): Promise<{ ok: true; html: string; url: URL; cut: boolean } | { ok: false; error: string }> => {
		const signal = AbortSignal.timeout(timeoutMs);
		let at = await checked(raw, resolve, allowed);
		if (!at.ok) return at;
		for (let hop = 0; hop <= MAX_HOPS; hop++) {
			let up: Response;
			try {
				up = await pinnedGet(at, { method: "GET", redirect: "manual", credentials: "omit", signal, headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" } });
			} catch {
				return { ok: false, error: "미리 보기를 가져오지 못했어요" };
			}
			if (up.status >= 300 && up.status < 400) {
				const loc = up.headers.get("location");
				await up.body?.cancel().catch(() => {});
				if (!loc || hop === MAX_HOPS) return { ok: false, error: "미리 보기를 가져오지 못했어요" };
				let next: string;
				try {
					next = new URL(loc, at.url).href;
				} catch {
					return { ok: false, error: "허용되지 않는 주소예요" };
				}
				const c = await checked(next, resolve, allowed);
				if (!c.ok) return c;
				at = c;
				continue;
			}
			const type = (up.headers.get("content-type") ?? "").toLowerCase();
			if (!up.ok || !up.body || !/^(?:text\/html|application\/xhtml\+xml)/.test(type)) {
				await up.body?.cancel().catch(() => {});
				return { ok: false, error: "미리 볼 수 있는 페이지가 아니에요" };
			}
			const body = await readCapped(up, maxBytes);
			return { ok: true, html: body.text, url: at.url, cut: body.cut };
		}
		return { ok: false, error: "너무 많이 이동하는 주소예요" };
	};

	const preview = async (raw: string): Promise<LinkPreview> => {
		const hit = remembered(raw);
		if (hit) return hit;
		const page = await getHtml(raw);
		let out: LinkPreview;
		if (!page.ok) out = { url: raw, ok: false, error: page.error, at: now() };
		else {
			const fields = parsePreview(page.html, page.url);
			out = { url: raw, ok: true, ...fields, at: now() };
		}
		if (out.ok) {
			mem.set(raw, out);
			failures.delete(raw);
			save();
		} else failures.set(raw, { error: out.error, at: out.at });
		return out;
	};

	// The image through this gateway: the web shows /api/link-preview/image?url=..., so the image host never sees the reader.
	const image = async (raw: string): Promise<Response> => {
		const at = await checked(raw, resolve, allowed);
		if (!at.ok) return json({ error: at.error }, 403);
		const signal = AbortSignal.timeout(timeoutMs);
		let up: Response;
		try {
			up = await pinnedGet(at, { method: "GET", redirect: "manual", credentials: "omit", signal, headers: { accept: "image/*" } });
		} catch {
			return json({ error: "이미지를 가져오지 못했어요" }, 502);
		}
		const type = (up.headers.get("content-type") ?? "").toLowerCase();
		if (!up.ok || !up.body || !type.startsWith("image/")) {
			await up.body?.cancel().catch(() => {});
			return json({ error: "이미지가 아니에요" }, 404);
		}
		const len = Number(up.headers.get("content-length"));
		if (Number.isFinite(len) && len > IMAGE_MAX_BYTES) {
			await up.body.cancel().catch(() => {});
			return json({ error: "이미지가 너무 커요" }, 413);
		}
		let seen = 0;
		const body = up.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, ctl) {
					seen += chunk.byteLength;
					if (seen > IMAGE_MAX_BYTES) ctl.error(new Error("too large"));
					else ctl.enqueue(chunk);
				},
			}),
		);
		return new Response(body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" } });
	};

	// GET /api/link-preview?url=<page> -> the card fields (image = this gateway's image route); GET /api/link-preview/image?url=<image>.
	const route = async (req: Request, url: URL, parts: string[]): Promise<Response | undefined> => {
		if (parts[0] !== "api" || parts[1] !== "link-preview") return undefined;
		const isImage = parts.length === 3 && parts[2] === "image";
		if (parts.length !== 2 && !isImage) return undefined;
		if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "GET only" }, 405);
		const target = url.searchParams.get("url") ?? "";
		if (!target.trim() || target.length > 2048) return json({ error: "url is required" }, 400);
		if (isImage) return image(target);
		const p = await preview(target);
		if (!p.ok) return json({ ok: false, url: p.url, error: p.error }, p.error === HOST_LIMIT ? 403 : 200);
		return json({ ok: true, url: p.url, ...(p.site ? { site: p.site } : {}), ...(p.title ? { title: p.title } : {}), ...(p.description ? { description: p.description } : {}), ...(p.image ? { image: `/api/link-preview/image?url=${encodeURIComponent(p.image)}` } : {}) });
	};

	return { route, preview, image, size: () => mem.size };
}
