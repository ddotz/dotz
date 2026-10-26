// The reverse proxy of a tool app (hub/user-apps.ts): /apps/<id>/… -> the app's own loopback server. Nothing is rewritten
// unless the manifest asks for it (`web.mode`):
//   prefix   the app already serves under the gateway's prefix (relative URLs, or its own base path): the request is passed
//            with the prefix stripped, answers as they come.
//   rewrite  the app was written for "/": root-absolute URLs in html/css answers get the prefix, Set-Cookie Path and Location
//            point back under /apps/<id>/, and a small first script patches fetch / XMLHttpRequest / WebSocket for the paths the
//            app's own script writes at run time. Absolute ws:// URLs and location assignments are not rewritten: an app that
//            needs those must serve under the prefix.
// A websocket upgrade is bridged to the same upstream path (Bun's server.upgrade + a client WebSocket per connection), so an
// app like mydocs keeps its editor channel. Bodies stream both ways.
import type { Server, ServerWebSocket } from "bun";
import type { UserApp } from "./user-apps.ts";

export type AppWsData = { app: string; target: string; queue: (string | Uint8Array)[]; up?: WebSocket };

/** `/apps/mydocs/a/b` -> { id: "mydocs", rest: "/a/b" }; anything under /apps/ that is not this shape is undefined. */
export function proxyMatch(pathname: string): { id: string; rest: string } | undefined {
	if (!pathname.startsWith("/apps/")) return undefined;
	const cut = pathname.indexOf("/", "/apps/".length);
	const id = cut < 0 ? pathname.slice("/apps/".length) : pathname.slice("/apps/".length, cut);
	if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return undefined;
	return { id, rest: cut < 0 ? "/" : pathname.slice(cut) };
}

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const stripHops = (h: Headers): Headers => {
	const out = new Headers();
	for (const [k, v] of h) if (!HOP.has(k.toLowerCase())) out.append(k, v);
	return out;
};
const normalizeBase = (base: string): string => `${base.replace(/\/+$/, "")}/`;

/** The upstream URL for a proxied request: web.url + web.path + what comes after /apps/<id>. */
export function upstreamUrl(app: UserApp, rest: string, search = ""): string {
	const web = app.web!;
	const tail = rest === "/" ? "/" : rest;
	return `${web.url}${web.path.replace(/\/$/, "")}${tail}${search}`;
}

/** Root-absolute and the app origin's own URLs -> the gateway prefix (a URL already under it is left alone). */
function prefixUrl(raw: string, base: string, origin: string): string {
	if (!raw) return raw;
	if (raw.startsWith(origin)) return base + raw.slice(origin.length).replace(/^\//, "");
	if (/^\/(?!\/)/.test(raw) && !raw.startsWith(base)) return base + raw.slice(1);
	return raw;
}

const SHIM = (base: string) => `<script>(function(){var P=${JSON.stringify(base.replace(/\/$/, ""))};function f(u){return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.indexOf(P+"/")!==0?P+u:u}
var wf=window.fetch;if(wf)window.fetch=function(i,o){try{if(typeof i==="string")i=f(i);else if(i&&i.url){var u=f(i.url);if(u!==i.url)i=new Request(u,i)}}catch(e){}return wf.call(this,i,o)};
var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=f(u);return xo.apply(this,a)};
var W=window.WebSocket;if(W){var S=function(u,p){return new W(f(u),p)};S.prototype=W.prototype;window.WebSocket=S}})();</script>`;

/** html: the attributes the browser resolves against the origin, plus the run-time shim right after <head>. */
export function rewriteHtml(html: string, base: string, origin: string): string {
	const b = normalizeBase(base);
	let out = html.replace(/(\s(?:src|href|action|poster)=)(["'])(\/[^"'<>]*)\2/gi, (m, attr, q, url) => {
		const fixed = prefixUrl(url, b, origin);
		return fixed === url ? m : `${attr}${q}${fixed}${q}`;
	});
	const shim = SHIM(b);
	if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, m => m + shim);
	else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, m => m + shim);
	else out = shim + out;
	return out;
}

/** css: url(/…) and @import "/…". */
export const rewriteCss = (css: string, base: string, origin: string): string =>
	css.replace(/url\(\s*(["']?)(\/[^"')\s]*)\1\s*\)/gi, (m, q, url) => {
		const fixed = prefixUrl(url, normalizeBase(base), origin);
		return fixed === url ? m : `url(${q}${fixed}${q})`;
	});

function rewriteSetCookie(value: string, base: string): string {
	const b = normalizeBase(base);
	return value
		.split(";")
		.map((part, i) => {
			const t = part.trim();
			if (i > 0 && /^path=/i.test(t)) return ` Path=${b}`;
			if (/^domain=/i.test(t)) return "";
			return part;
		})
		.filter(Boolean)
		.join(";");
}

const TEXTUAL = /(?:^text\/html|^text\/css|^application\/xhtml\+xml)/i;

// The gateway's own credentials and the owner's identity stay at the gateway; the app gets only the browser's request.
const PRIVATE = (k: string): boolean => k === "x-dotz-token" || k === "x-dotz-peer" || k.startsWith("tailscale-");

// tailscale serve signs every request from the owner's device, whichever page sent it: a page of another origin must not
// open an app's websocket or send it a state-changing request with that identity (same rule as pty.ts).
const sameOrigin = (req: Request): boolean => {
	const origin = req.headers.get("origin");
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.get("host");
	} catch {
		return false;
	}
};

/** The proxied answer, streaming, with only the headers a browser needs. */
export async function proxyRequest(req: Request, url: URL, app: UserApp, match: { id: string; rest: string }, srv?: Server<unknown>): Promise<Response | undefined> {
	const base = `/apps/${app.id}`;
	const target = upstreamUrl(app, match.rest, url.search);
	if (!app.web) return new Response("this app has no web ui", { status: 404 });
	const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
	if ((upgrade || (req.method !== "GET" && req.method !== "HEAD")) && !sameOrigin(req)) return new Response("cross-origin request refused", { status: 403 });
	if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
		const ws = app.web.url.replace(/^http:/, "ws:");
		const wsTarget = `${ws}${app.web.path === "/" ? "" : app.web.path.replace(/\/$/, "")}${match.rest === "/" ? "/" : match.rest}${url.search}`;
		if (!srv) return new Response("websocket proxy is not available in this process", { status: 501 });
		const ok = srv.upgrade(req, { data: { app: app.id, target: wsTarget, queue: [] } satisfies AppWsData });
		return ok ? undefined : new Response("websocket upgrade failed", { status: 400 });
	}
	const headers = stripHops(new Headers(req.headers));
	for (const k of [...headers.keys()]) if (PRIVATE(k.toLowerCase())) headers.delete(k);
	if (app.web.mode === "rewrite") headers.delete("accept-encoding");
	headers.set("x-forwarded-host", url.host);
	headers.set("x-forwarded-proto", "http");
	headers.set("x-forwarded-prefix", base);
	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method: req.method,
			headers,
			body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
			redirect: "manual",
			signal: AbortSignal.timeout(60_000),
		});
	} catch (e) {
		const why = e instanceof Error && /abort|timeout/i.test(e.message) ? "응답이 없어요" : "앱이 떠 있지 않은 것 같아요";
		return new Response(`${app.label}: ${why}\n${target}`, { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
	}
	const out = stripHops(new Headers(upstream.headers));
	const type = upstream.headers.get("content-type") ?? "";
	const rewrite = app.web.mode === "rewrite" && TEXTUAL.test(type);
	// rewrite mode injects an inline script the app's own policy would block; otherwise the app's policy stands.
	if (rewrite) {
		out.delete("content-security-policy");
		out.delete("content-security-policy-report-only");
	}
	for (const k of [...out.keys()]) if (k.toLowerCase().startsWith("access-control-")) out.delete(k);
	const loc = out.get("location");
	if (loc) out.set("location", prefixUrl(loc, normalizeBase(base), app.web.url));
	const cookies = upstream.headers.getSetCookie();
	if (cookies.length) {
		out.delete("set-cookie");
		for (const c of cookies) out.append("set-cookie", app.web.mode === "rewrite" ? rewriteSetCookie(c, base) : c);
	}
	const body = upstream.body;
	if (!rewrite || !body) return new Response(req.method === "HEAD" ? null : body, { status: upstream.status, statusText: upstream.statusText, headers: out });
	const text = await upstream.text();
	out.delete("content-encoding");
	out.delete("content-length");
	const fixed = /^text\/css/i.test(type) ? rewriteCss(text, base, app.web.url) : rewriteHtml(text, base, app.web.url);
	return new Response(req.method === "HEAD" ? null : fixed, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

/** The Bun.serve websocket handlers that bridge an upgraded app connection to its upstream websocket. */
export const appProxySocket = {
	open(ws: ServerWebSocket<AppWsData>) {
		let up: WebSocket;
		try {
			up = new WebSocket(ws.data.target);
		} catch {
			ws.close(1011, "upstream websocket failed");
			return;
		}
		ws.data.up = up;
		up.onopen = () => {
			for (const m of ws.data.queue.splice(0)) up.send(m);
		};
		up.onmessage = m => {
			try {
				ws.send(typeof m.data === "string" ? m.data : new Uint8Array(m.data as ArrayBuffer));
			} catch {}
		};
		up.onclose = () => {
			try {
				ws.close();
			} catch {}
		};
		up.onerror = () => {
			try {
				ws.close(1011, "upstream websocket error");
			} catch {}
		};
	},
	message(ws: ServerWebSocket<AppWsData>, msg: string | Uint8Array) {
		const up = ws.data.up;
		if (up && up.readyState === WebSocket.OPEN) up.send(msg);
		else ws.data.queue.push(msg);
	},
	close(ws: ServerWebSocket<AppWsData>) {
		try {
			ws.data.up?.close();
		} catch {}
	},
};
