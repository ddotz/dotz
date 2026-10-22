// Session handling for a site the adapter reaches only through a browser login (no API, no zele). Two concerns live here:
// telling "logged in" from "logged out" out of a list response, and keeping the server-side session alive cheaply.
//
// Keep-alive mirrors what the owner's working setup learned: a bare fetch that carries the stored cookies extends the
// server's sliding session and costs almost nothing, but it does NOT persist rotating Set-Cookie cookies, so a real tab
// load every refresh_hours (done by the gateway's `session` watch, not here) is still needed. The cheap request uses
// conditional headers (If-None-Match / If-Modified-Since) so an unchanged inbox comes back 304 with no body: zero parsing,
// minimal bytes.
import { endpointUrl, getPath, parseJson, requestInit, type SiteSpec } from "./spec.ts";
import { UA, type Ctx } from "./config.ts";

export type LoginState = { kind: "ok"; body: unknown } | { kind: "loggedout"; why: string } | { kind: "error"; msg: string };

export function headers(spec: SiteSpec, cookie: string, extra: Record<string, string> = {}): Record<string, string> {
	return { Cookie: cookie, "User-Agent": UA, ...(spec.headers ?? {}), ...extra };
}

// Only a JSON body with the mails array at `listPath` counts as logged in. HTTP 200 alone does not: a login page also
// answers 200, so a 200 whose body looks like a login/HTML page is treated as logged out.
export function classifyList(spec: SiteSpec, status: number, body: string): LoginState {
	if (status >= 300 && status < 400) return { kind: "loggedout", why: `redirect ${status}` };
	if (status === 401 || status === 403) return { kind: "loggedout", why: `status ${status}` };
	try {
		const json = parseJson(body);
		if (Array.isArray(getPath(json, spec.list.listPath))) return { kind: "ok", body: json };
		return { kind: "loggedout", why: `json without ${spec.list.listPath} (status ${status})` };
	} catch {
		// Not JSON. A login/auth page served as 200 is the common logout signal.
		if (status === 200 && /login|signin|sign-in|password|passwd|username|authenticate|로그인/i.test(body)) return { kind: "loggedout", why: "login page" };
		return { kind: "error", msg: `status ${status}, non-json body` };
	}
}

// One list call as the site's own client makes it (method, body and its content type from the spec).
export function listRequest(spec: SiteSpec, cookie: string, extra: Record<string, string> = {}): { url: string; init: RequestInit } {
	const tokens = { mailbox: spec.list.mailbox, page: 1 };
	const { method, body, contentType } = requestInit(spec.list, tokens);
	const h = headers(spec, cookie, { Accept: "application/json", ...(contentType ? { "Content-Type": contentType } : {}), ...extra });
	return { url: endpointUrl(spec.origin, spec.list, tokens), init: { method, headers: h, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(30_000) } };
}

export async function fetchList(ctx: Ctx, spec: SiteSpec, cookie: string): Promise<LoginState> {
	const { url, init } = listRequest(spec, cookie);
	try {
		const r = await ctx.fetch(url, init);
		return classifyList(spec, r.status, await r.text());
	} catch (e) {
		return { kind: "error", msg: String(e).slice(0, 200) };
	}
}

export type KeepaliveResult = { status: "ok" | "notmodified" | "loggedout" | "error"; etag?: string; lastModified?: string; body?: unknown; note: string };

// A cheap conditional request against the list endpoint. 304 Not Modified is the best outcome (session extended, nothing
// transferred or parsed). A validator (ETag / Last-Modified) from the previous call is sent back so the server can answer
// 304; the new validators are returned for the caller to persist.
export async function keepalive(ctx: Ctx, spec: SiteSpec, cookie: string, prev: { etag?: string; lastModified?: string } = {}): Promise<KeepaliveResult> {
	const cond: Record<string, string> = {};
	if (prev.etag) cond["If-None-Match"] = prev.etag;
	if (prev.lastModified) cond["If-Modified-Since"] = prev.lastModified;
	const { url, init } = listRequest(spec, cookie, cond);
	try {
		const r = await ctx.fetch(url, init);
		const etag = r.headers.get("etag") ?? undefined;
		const lastModified = r.headers.get("last-modified") ?? undefined;
		if (r.status === 304) return { status: "notmodified", etag: etag ?? prev.etag, lastModified: lastModified ?? prev.lastModified, note: "304 not modified" };
		const c = classifyList(spec, r.status, await r.text());
		if (c.kind === "ok") return { status: "ok", etag, lastModified, body: c.body, note: "200 ok" };
		if (c.kind === "loggedout") return { status: "loggedout", note: c.why };
		return { status: "error", note: c.msg };
	} catch (e) {
		return { status: "error", note: String(e).slice(0, 200) };
	}
}
