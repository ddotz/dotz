// The generic webmail adapter: list, read and search a site, and prepare (never send) a draft, using only the captured
// SiteSpec and an injected context. It knows nothing about any specific mail site; the spec supplies every URL, field path
// and header. Minimal fields are requested through `list.params`, and a conditional-request cache lives in the watch state.
import { endpointUrl, getPath, type SiteSpec } from "./spec.ts";
import { headers, fetchList, type LoginState } from "./session.ts";
import { type Ctx } from "./config.ts";

export type Mail = { id: string; from: string; subject: string; time: string; read: boolean };
export type Detail = { id: string; body: string; raw: unknown };

const str = (v: unknown): string => (v == null ? "" : typeof v === "string" ? v : String(v));

export function mapMails(spec: SiteSpec, body: unknown): Mail[] {
	const arr = getPath(body, spec.list.listPath);
	if (!Array.isArray(arr)) return [];
	const f = spec.list.fields;
	return arr.map((item) => ({
		id: str(getPath(item, f.id)),
		from: f.from ? str(getPath(item, f.from)) : "",
		subject: f.subject ? str(getPath(item, f.subject)) : "",
		time: f.time ? str(getPath(item, f.time)) : "",
		read: f.read ? Boolean(getPath(item, f.read)) : false,
	})).filter((m) => m.id);
}

export async function list(ctx: Ctx, spec: SiteSpec): Promise<{ state: LoginState; mails: Mail[] }> {
	const cookie = await ctx.cookieHeader(spec);
	const state = await fetchList(ctx, spec, cookie);
	return { state, mails: state.kind === "ok" ? mapMails(spec, state.body) : [] };
}

export async function read(ctx: Ctx, spec: SiteSpec, id: string): Promise<Detail> {
	const cookie = await ctx.cookieHeader(spec);
	const url = endpointUrl(spec.origin, spec.read, { id });
	const r = await ctx.fetch(url, { method: spec.read.method ?? "GET", headers: headers(spec, cookie, { Accept: "application/json" }), signal: AbortSignal.timeout(30_000) });
	const text = await r.text();
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`read ${id}: response was not JSON (session may be lost)`);
	}
	const bodyRaw = str(getPath(raw, spec.read.bodyPath));
	return { id, body: spec.read.bodyIsHtml ? htmlToText(bodyRaw) : bodyRaw, raw };
}

export async function search(ctx: Ctx, spec: SiteSpec, q: string): Promise<Mail[]> {
	if (!spec.search) throw new Error("이 사이트 스펙에는 검색 엔드포인트가 없어요");
	const cookie = await ctx.cookieHeader(spec);
	const hasToken = /\{q\}/.test(spec.search.path);
	const ep = hasToken ? spec.search : { ...spec.search, params: { ...(spec.search.params ?? {}), [spec.search.queryParam]: q } };
	const url = endpointUrl(spec.origin, ep, { q });
	const r = await ctx.fetch(url, { method: spec.search.method ?? "GET", headers: headers(spec, cookie, { Accept: "application/json" }), signal: AbortSignal.timeout(30_000) });
	const text = await r.text();
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`search: response was not JSON (session may be lost)`);
	}
	const listPath = spec.search.listPath ?? spec.list.listPath;
	return mapMails({ ...spec, list: { ...spec.list, listPath } }, raw);
}

export type Draft = { id: string; to: string; cc?: string; subject: string; body: string; created: string };

// Build a draft record only. This function never contacts the server; sending is a separate, owner-approved step
// (bin/mail.ts send, guarded) so nothing leaves the account without an explicit OK.
export function makeDraft(now: number, input: { to: string; cc?: string; subject: string; body: string }): Draft {
	const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12);
	const rand = Math.floor(now % 0xffff).toString(16).padStart(4, "0");
	return { id: `d-${stamp}-${rand}`, to: input.to.trim(), ...(input.cc ? { cc: input.cc.trim() } : {}), subject: input.subject, body: input.body, created: new Date(now).toISOString() };
}

// Minimal, dependency-free HTML -> readable text: drop script/style, turn block tags into newlines, strip remaining tags,
// decode the common entities. Enough for a chat/thread preview; the full original HTML stays in `raw`.
export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\b[^>]*>|<\/(p|div|tr|li|h\d|table)>/gi, "\n")
		.replace(/<\/t[dh]>/gi, "\t")
		.replace(/<[^>]+>/g, "")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
