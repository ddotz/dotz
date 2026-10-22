// The generic webmail adapter: list, read and search a site, and prepare (never send) a draft, using only the captured
// SiteSpec and an injected context. It knows nothing about any specific mail site; the spec supplies every URL, field path
// and header. Minimal fields are requested through `list.params`, and a conditional-request cache lives in the watch state.
import { endpointUrl, getPath, parseJson, requestInit, type Endpoint, type SiteSpec } from "./spec.ts";
import { headers, fetchList, type LoginState } from "./session.ts";
import { type Ctx } from "./config.ts";

export type Mail = { id: string; from: string; subject: string; time: string; read: boolean };
export type Detail = { id: string; body: string; raw: unknown };

const str = (v: unknown): string => (v == null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

export function mapMails(spec: SiteSpec, body: unknown): Mail[] {
	const arr = getPath(body, spec.list.listPath);
	if (!Array.isArray(arr)) return [];
	const f = spec.list.fields;
	return arr.map((item) => ({
		id: str(getPath(item, f.id)),
		from: f.from ? str(getPath(item, f.from)) : "",
		subject: f.subject ? str(getPath(item, f.subject)) : "",
		time: f.time ? str(getPath(item, f.time)) : "",
		read: f.read ? truthyRead(getPath(item, f.read)) : false,
	})).filter((m) => m.id);
}

// Sites encode "read" as booleans, 0/1, or letters ("Y"/"N"); only the clearly-true forms count as read.
const truthyRead = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && /^(1|y|yes|true|read|seen)$/i.test(v.trim()));

export async function list(ctx: Ctx, spec: SiteSpec): Promise<{ state: LoginState; mails: Mail[] }> {
	const cookie = await ctx.cookieHeader(spec);
	const state = await fetchList(ctx, spec, cookie);
	return { state, mails: state.kind === "ok" ? mapMails(spec, state.body) : [] };
}

async function getJson(ctx: Ctx, spec: SiteSpec, ep: Endpoint, tokens: Record<string, string | undefined>, what: string): Promise<unknown> {
	const cookie = await ctx.cookieHeader(spec);
	const { method, body, contentType } = requestInit(ep, tokens);
	const h = headers(spec, cookie, { Accept: "application/json", ...(contentType ? { "Content-Type": contentType } : {}) });
	const r = await ctx.fetch(endpointUrl(spec.origin, ep, tokens), { method, headers: h, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(30_000) });
	if (r.status >= 300 && r.status < 400) throw new Error(`${what}: 로그인이 풀린 것 같아요 (HTTP ${r.status})`);
	if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
	const text = await r.text();
	try {
		return parseJson(text);
	} catch {
		throw new Error(`${what}: JSON이 아닌 응답이 왔어요 (로그인이 풀렸거나 주소가 달라요)`);
	}
}

export async function read(ctx: Ctx, spec: SiteSpec, id: string): Promise<Detail> {
	const raw = await getJson(ctx, spec, spec.read, { id, mailbox: spec.list.mailbox }, `메일 ${id} 읽기`);
	const bodyRaw = getPath(raw, spec.read.bodyPath);
	if (bodyRaw === undefined) throw new Error(`메일 ${id} 읽기: 응답에 ${spec.read.bodyPath} 필드가 없어요`);
	const text = str(bodyRaw);
	return { id, body: spec.read.bodyIsHtml ? htmlToText(text) : text, raw };
}

// Fallback when capture saw no mail being opened: try likely read endpoints with a real mail id and keep the first one
// whose JSON holds a body-like field. Each candidate is one GET; nothing is written.
export async function probeRead(ctx: Ctx, spec: SiteSpec, id: string, candidates: SiteSpec["read"][]): Promise<SiteSpec["read"] | undefined> {
	for (const c of candidates) {
		try {
			const raw = await getJson(ctx, spec, c, { id, mailbox: spec.list.mailbox }, "probe");
			const bodyPath = c.bodyPath && getPath(raw, c.bodyPath) !== undefined ? c.bodyPath : findTextField(raw);
			if (bodyPath) return { ...c, bodyPath, bodyIsHtml: true };
		} catch {
			continue;
		}
	}
	return undefined;
}

const BODY_KEY = /^(body|content|contents|html|text|message|mail_?body|bodyhtml|htmlbody)$/i;
export function findTextField(root: unknown): string | undefined {
	const queue: { path: string; value: unknown }[] = [{ path: "", value: root }];
	let best: { path: string; score: number } | undefined;
	while (queue.length) {
		const { path, value } = queue.shift()!;
		if (typeof value === "string" && path) {
			const key = path.split(".").pop()!;
			const named = BODY_KEY.test(key), html = /<\/?(p|div|br|span|table)\b/i.test(value);
			const score = value.length + (named ? 10_000 : 0) + (html ? 5_000 : 0);
			if ((named || html || value.length >= 20) && (!best || score > best.score)) best = { path, score };
		}
		if (value && typeof value === "object" && !Array.isArray(value)) for (const [k, v] of Object.entries(value as Record<string, unknown>)) queue.push({ path: path ? `${path}.${k}` : k, value: v });
	}
	return best?.path;
}

export async function search(ctx: Ctx, spec: SiteSpec, q: string): Promise<Mail[]> {
	if (!spec.search) throw new Error("이 사이트는 검색 호출을 아직 못 찾았어요. 받은메일함에서 한 번 검색한 뒤 다시 캡처하면 생겨요");
	const hasToken = /\{q\}/.test(spec.search.path) || /\{q\}/.test(spec.search.body ?? "");
	const ep = hasToken ? spec.search : { ...spec.search, params: { ...(spec.search.params ?? {}), [spec.search.queryParam]: q } };
	const raw = await getJson(ctx, spec, ep, { q, mailbox: spec.list.mailbox }, "검색");
	const listPath = spec.search.listPath ?? spec.list.listPath;
	return mapMails({ ...spec, list: { ...spec.list, listPath } }, raw);
}

export type Draft = { id: string; to: string; cc?: string; subject: string; body: string; created: string };

// Build a draft record only. This function never contacts the server; sending is a separate, owner-approved step
// (bin/mail.ts send, guarded) so nothing leaves the account without an explicit OK.
export function makeDraft(now: number, input: { to: string; cc?: string; subject: string; body: string }): Draft {
	const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12);
	const rand = crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, "0");
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
