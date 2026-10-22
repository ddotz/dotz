// A "site spec" is the generalized, personal-data-free description of one webmail site's own XHR/JSON API, captured from a
// logged-in browser session (lib/capture.ts). It holds no company name, host, account or mail content by itself: every
// install writes its own spec into the custom layer (DATA_DIR/custom/webmail/<site>/spec.json). The adapter (lib/adapter.ts)
// speaks a site only through this spec, so the shipped code never knows any specific mail site.

export type FieldMap = {
	// JSON paths, relative to one list item, of the fields the adapter needs. `id` is required (it is the baseline key the
	// watch de-duplicates on); the rest are best-effort and shown to the owner.
	id: string;
	from?: string;
	subject?: string;
	time?: string;
	read?: string; // truthy = already read
};

export type Endpoint = {
	// URL path with `{...}` templates filled at call time: {mailbox}, {id}, {q}, {page}. A path starting with http(s):// is
	// used as-is; otherwise it is resolved against `origin`.
	path: string;
	method?: "GET" | "POST";
	// Extra query params merged into the URL (minimal-fields selectors belong here, e.g. {"fields":"id,subject,date"}).
	params?: Record<string, string>;
	// Request body template for sites whose client POSTs (form or JSON), with the same {...} tokens as the path.
	body?: string;
	bodyType?: "json" | "form";
};

export type SiteSpec = {
	version: 1;
	site: string; // slug, [a-z0-9][a-z0-9-]{0,39}
	origin: string; // "https://<host>"; owner-provided, never shipped
	cookieHosts: string[]; // cookie host_key values whose cookies the adapter sends (e.g. ["mail.example.com", ".example.com"])
	headers?: Record<string, string>; // request headers the site's own XHR sends (e.g. X-Requested-With, Accept)
	list: Endpoint & {
		mailbox?: string; // default {mailbox} token
		listPath: string; // JSON path to the array of mails in the response, e.g. "mails" or "data.items"
		fields: FieldMap;
	};
	read: Endpoint & {
		bodyPath: string; // JSON path to the mail body in the detail response
		bodyIsHtml?: boolean; // body is HTML and should be rendered to text
	};
	search?: Endpoint & {
		queryParam: string; // query-string parameter that carries the search text (filled from {q} if path has it, else added)
		listPath?: string; // defaults to list.listPath
	};
	// Draft/send endpoint. The adapter NEVER calls this on its own: it only prepares a draft. Sending is a separate,
	// owner-approved step (see feature.md and the send guard).
	send?: Endpoint & { draftOnly: true };
};

export const SITE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// JSON as a web client receives it. Some sites prefix their XHR JSON with an anti-hijacking guard (")]}',", "while(1);",
// "for(;;);") that the page strips before parsing; do the same so those sites are not mistaken for logged out.
export function parseJson(text: string): unknown {
	const t = text.replace(/^\uFEFF/, "").replace(/^\s*(\)\]\}',?|while\s*\(1\);|for\s*\(;;\);)\s*/, "");
	return JSON.parse(t);
}

// Cookie host_key values to read for a host: the host itself and each parent domain that is not a public suffix. A
// two-letter country code with a generic second level (co.kr, co.jp, com.au, ac.uk ...) is a suffix, so for
// mail.example.co.kr the parents are example.co.kr only, never co.kr.
const GENERIC_SLD = /^(co|com|net|org|ac|go|or|ne|re|gov|edu|mil|pe|ltd|plc)$/;
export function cookieHostsFor(host: string): string[] {
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes(".")) return [host];
	const labels = host.split(".");
	const tld = labels[labels.length - 1];
	const minLabels = tld.length === 2 && labels.length >= 3 && GENERIC_SLD.test(labels[labels.length - 2]) ? 3 : 2;
	const out = [host, `.${host}`];
	for (let i = 1; labels.length - i >= minLabels; i++) out.push(`.${labels.slice(i).join(".")}`, labels.slice(i).join("."));
	return [...new Set(out)];
}

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1";

// Read a dot path ("a.b.c") out of a parsed JSON value. Returns undefined when any step is missing. No array indexing: the
// list array is addressed by `listPath` and iterated by the caller.
export function getPath(obj: unknown, path: string): unknown {
	if (!path) return obj;
	let cur: unknown = obj;
	for (const key of path.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

// Fill `{token}` placeholders in a path. Unknown tokens are left as-is (so a malformed spec fails loudly at fetch time
// rather than silently hitting a wrong URL).
export function fillPath(path: string, tokens: Record<string, string | number | undefined>): string {
	return path.replace(/\{(\w+)\}/g, (m, k) => (tokens[k] === undefined ? m : encodeURIComponent(String(tokens[k]))));
}

// Absolute URL for one endpoint call, with templates filled and `params` merged into the query string.
export function endpointUrl(origin: string, ep: Endpoint, tokens: Record<string, string | number | undefined> = {}): string {
	const filled = fillPath(ep.path, tokens);
	const base = /^https?:\/\//i.test(filled) ? filled : origin.replace(/\/+$/, "") + (filled.startsWith("/") ? "" : "/") + filled;
	if (!ep.params || !Object.keys(ep.params).length) return base;
	const u = new URL(base);
	for (const [k, v] of Object.entries(ep.params)) u.searchParams.set(k, v.replace(/\{(\w+)\}/g, (m, t) => (tokens[t] === undefined ? m : String(tokens[t]))));
	return u.toString();
}

const fillRaw = (s: string, tokens: Record<string, string | number | undefined>) => s.replace(/\{(\w+)\}/g, (m, k) => (tokens[k] === undefined ? m : String(tokens[k])));

// fetch() init pieces for one endpoint call: method, filled body and its content type.
export function requestInit(ep: Endpoint, tokens: Record<string, string | number | undefined> = {}): { method: string; body?: string; contentType?: string } {
	const method = ep.method ?? (ep.body ? "POST" : "GET");
	if (!ep.body || method === "GET") return { method };
	return { method, body: fillRaw(ep.body, tokens), contentType: ep.bodyType === "json" ? "application/json" : "application/x-www-form-urlencoded; charset=UTF-8" };
}

// Boundary check of a spec read from disk or produced by capture. Returns an owner-facing Korean problem string, or
// undefined when the spec is usable.
export function validateSpec(s: any): string | undefined {
	if (!s || typeof s !== "object") return "스펙이 JSON 객체가 아니에요";
	if (s.version !== 1) return "version은 1이어야 해요";
	if (!SITE_ID.test(String(s.site ?? ""))) return "site는 [a-z0-9-] (최대 40자)여야 해요";
	let origin: URL;
	try {
		origin = new URL(String(s.origin ?? ""));
	} catch {
		return "origin이 올바른 URL이 아니에요";
	}
	if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLocalHost(origin.hostname))) return "origin은 https여야 해요";
	if (!Array.isArray(s.cookieHosts) || !s.cookieHosts.length || !s.cookieHosts.every((h: unknown) => typeof h === "string" && h.trim())) return "cookieHosts에 쿠키 호스트를 하나 이상 넣어야 해요";
	if (!s.list || typeof s.list.path !== "string" || !s.list.path) return "list.path가 비어 있어요";
	if (typeof s.list.listPath !== "string" || !s.list.listPath) return "list.listPath(메일 배열 경로)가 비어 있어요";
	if (!s.list.fields || typeof s.list.fields.id !== "string" || !s.list.fields.id) return "list.fields.id가 비어 있어요";
	if (!s.read || typeof s.read.path !== "string" || !s.read.path) return "read.path가 비어 있어요";
	if (typeof s.read.bodyPath !== "string" || !s.read.bodyPath) return "read.bodyPath가 비어 있어요";
	if (s.search && (typeof s.search.path !== "string" || typeof s.search.queryParam !== "string")) return "search에는 path와 queryParam이 필요해요";
	if (s.send && !s.send.draftOnly) return "send에는 draftOnly: true가 있어야 해요 (전송은 승인 단계에서만)";
	return undefined;
}
