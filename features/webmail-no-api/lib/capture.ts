// The adapter generator. Step 1 of the feature records the webmail client's own XHR/JSON calls from a logged-in Aside
// session (bin/capture.ts, background only). Step 2, here, turns that recording into a SiteSpec with no hand-coding and no
// personal data in the shipped code: the owner's recording stays in their custom layer, and only field *names* and URL
// *shapes* are inferred. It is a proposal; onboarding tests it live (list + read) before it is used.
import { cookieHostsFor, parseJson, SITE_ID, validateSpec, type FieldMap, type SiteSpec } from "./spec.ts";

export type CapturedRequest = {
	url: string;
	method?: string;
	status?: number;
	contentType?: string;
	responseBody?: string;
	requestBody?: string;
};

// kind: "ok" a usable spec; "no-json" the site made no JSON calls at all (server-rendered HTML pages); "no-list" JSON calls
// but none looked like a mail list; "bad-site" the slug is invalid. readGuessed: no mail was opened during the recording,
// so the read endpoint is a guess the live probe must confirm.
export type CaptureResult = { spec?: SiteSpec; notes: string[]; kind: "ok" | "no-json" | "no-list" | "bad-site"; readGuessed?: boolean };

const FIELD_RE: Record<keyof FieldMap, RegExp> = {
	id: /^(id|idx|uid|seq|no|mailid|mail_id|msgid|msg_id|messageid|message_id|mailno|mailseq)$/i,
	subject: /subject|title|subj/i,
	from: /from|sender|author/i,
	time: /date|time|sent|received|timestamp|created/i,
	read: /^(is_?)?(read|seen|unread)$|read_?(yn|flag)|seen_?flag/i,
	answered: /^(is_?)?(answered|replied)$|(reply|answer)_?(yn|flag)|answered_?flag/i,
};

const isJsonResponse = (r: CapturedRequest): boolean => {
	if (/json/i.test(r.contentType ?? "")) return true;
	return parse(r) !== undefined;
};

const parse = (r: CapturedRequest): unknown => {
	try {
		return parseJson(r.responseBody ?? "");
	} catch {
		return undefined;
	}
};

type ArrayHit = { path: string; items: Record<string, unknown>[] };

// Breadth-first search for arrays of objects anywhere in the JSON, recording the dot path to each.
function findArrays(root: unknown): ArrayHit[] {
	const hits: ArrayHit[] = [];
	const queue: { path: string; value: unknown }[] = [{ path: "", value: root }];
	while (queue.length) {
		const { path, value } = queue.shift()!;
		if (Array.isArray(value)) {
			if (value.length && value.every((v) => v && typeof v === "object" && !Array.isArray(v))) hits.push({ path, items: value as Record<string, unknown>[] });
			continue;
		}
		if (value && typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) queue.push({ path: path ? `${path}.${k}` : k, value: v });
	}
	return hits;
}

function inferFields(items: Record<string, unknown>[]): FieldMap | undefined {
	const keys = Object.keys(items[0]);
	const pick = (which: keyof FieldMap): string | undefined => {
		if (which === "id") return keys.find((k) => k.toLowerCase() === "id") ?? keys.find((k) => FIELD_RE.id.test(k));
		return keys.find((k) => FIELD_RE[which].test(k) && typeof items[0][k] !== "object");
	};
	const id = pick("id");
	if (!id) return undefined;
	const fields: FieldMap = { id };
	for (const which of ["from", "subject", "time", "read", "answered"] as const) {
		const k = pick(which);
		if (k && k !== id && !Object.values(fields).includes(k)) fields[which] = k;
	}
	// A real mail list has at least a subject or a sender plus a date; otherwise it is some other array (folders, flags...).
	if (!(fields.subject || fields.from) || !fields.time) return undefined;
	return fields;
}

// URL path + query as a template: a path segment or query value equal to one of the listed mail ids becomes {id}; the first
// other all-digit path segment becomes {mailbox} (a folder id). The remaining query params are kept as they were sent, so a
// site's own paging and field-selector params are replayed exactly.
function templatize(url: string, ids: Set<string>): { path: string; params: Record<string, string>; mailbox?: string; hasId: boolean } {
	const u = new URL(url);
	let mailbox: string | undefined;
	let hasId = false;
	const segs = u.pathname.split("/").map((seg) => {
		if (ids.has(seg)) {
			hasId = true;
			return "{id}";
		}
		if (/^\d+$/.test(seg) && !mailbox) {
			mailbox = seg;
			return "{mailbox}";
		}
		return seg;
	});
	const params: Record<string, string> = {};
	for (const [k, v] of u.searchParams) {
		if (ids.has(v)) {
			hasId = true;
			params[k] = "{id}";
		} else params[k] = v;
	}
	return { path: segs.join("/"), params, mailbox, hasId };
}

const looksHtmlBody = (v: unknown): boolean => typeof v === "string" && v.length > 120 && /<\/?(p|div|br|span|table|html|body)\b/i.test(v);

function findBodyPath(root: unknown): string | undefined {
	const queue: { path: string; value: unknown }[] = [{ path: "", value: root }];
	let best: { path: string; len: number } | undefined;
	while (queue.length) {
		const { path, value } = queue.shift()!;
		if (looksHtmlBody(value) && (!best || (value as string).length > best.len)) best = { path, len: (value as string).length };
		if (value && typeof value === "object" && !Array.isArray(value)) for (const [k, v] of Object.entries(value as Record<string, unknown>)) queue.push({ path: path ? `${path}.${k}` : k, value: v });
	}
	return best?.path;
}

const withParams = <T extends object>(ep: T, params: Record<string, string>): T => (Object.keys(params).length ? { ...ep, params } : ep);

// A POSTed request body as a template: values equal to a listed mail id become {id}, the search text becomes {q}. JSON
// keeps its shape (a numeric id stays unquoted); a form body keeps its field order.
function bodyTemplate(raw: string | undefined, ids: Set<string>, q?: string): { body: string; bodyType: "json" | "form"; hasId: boolean } | undefined {
	if (!raw) return undefined;
	let hasId = false;
	try {
		const j = JSON.parse(raw);
		const marks: string[] = [];
		const walk = (v: unknown): unknown => {
			if ((typeof v === "string" || typeof v === "number") && ids.has(String(v))) {
				hasId = true;
				marks.push(typeof v === "number" ? "{id}" : '"{id}"');
				return `__WM_${marks.length - 1}__`;
			}
			if (q && v === q) {
				marks.push('"{q}"');
				return `__WM_${marks.length - 1}__`;
			}
			if (Array.isArray(v)) return v.map(walk);
			if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
			return v;
		};
		const body = JSON.stringify(walk(j)).replace(/"__WM_(\d+)__"/g, (_, i) => marks[Number(i)]);
		return { body, bodyType: "json", hasId };
	} catch {
		const form = new URLSearchParams(raw);
		const out: string[] = [];
		for (const [k, v] of form) {
			if (ids.has(v)) {
				hasId = true;
				out.push(`${encodeURIComponent(k)}={id}`);
			} else if (q && v === q) out.push(`${encodeURIComponent(k)}={q}`);
			else out.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
		}
		return { body: out.join("&"), bodyType: "form", hasId };
	}
}

const methodOf = (r: CapturedRequest) => ((r.method ?? "GET").toUpperCase() === "POST" ? "POST" : undefined);
const SEARCH_KEY = /^(q|query|keyword|search|searchword|kwd|searchtext|search_text)$/i;

function bodyQuery(raw: string | undefined): { key: string; value: string } | undefined {
	if (!raw) return undefined;
	try {
		const j = JSON.parse(raw);
		if (j && typeof j === "object") for (const [k, v] of Object.entries(j)) if (SEARCH_KEY.test(k) && typeof v === "string" && v) return { key: k, value: v };
	} catch {
		for (const [k, v] of new URLSearchParams(raw)) if (SEARCH_KEY.test(k) && v) return { key: k, value: v };
	}
	return undefined;
}

// Read endpoints worth one probe each when no mail was opened during the recording, derived from the list URL shape.
export function readCandidates(spec: SiteSpec): SiteSpec["read"][] {
	const listPath = spec.list.path.replace(/\{mailbox\}/g, spec.list.mailbox ?? "{mailbox}");
	const parts = listPath.split("/").filter(Boolean);
	const root = parts.length ? `/${parts[0]}` : "";
	const parent = `/${parts.slice(0, -1).join("/")}`.replace(/\/$/, "");
	const paths = [
		`${listPath}/{id}`,
		`${parent}/{id}`,
		`${root}/mails/{id}`,
		`${root}/mail/{id}`,
		`${root}/messages/{id}`,
		`${root}/message/{id}`,
		"/mails/{id}",
		"/messages/{id}",
	];
	const out: SiteSpec["read"][] = [...new Set(paths)].map((path) => ({ path, bodyPath: "", bodyIsHtml: true }));
	out.push({ path: listPath, params: { id: "{id}" }, bodyPath: "", bodyIsHtml: true });
	return out;
}

// Build a SiteSpec proposal from one session recording. `site` is the slug the owner chose.
export function capture(site: string, requests: CapturedRequest[]): CaptureResult {
	const notes: string[] = [];
	if (!SITE_ID.test(site)) return { kind: "bad-site", notes: ["사이트 이름은 영문 소문자·숫자·-로 40자까지예요"] };
	const json = requests.filter((r) => (r.method ?? "GET").toUpperCase() !== "OPTIONS" && (r.status ?? 200) < 300 && isJsonResponse(r));
	if (!json.length) {
		return {
			kind: "no-json",
			notes: [
				"이 사이트는 메일 목록을 JSON 호출이 아니라 서버가 그린 HTML 화면으로 보내는 것 같아요. 그런 사이트는 호출을 다시 쓰는 방식이 안 맞아요",
				"방법: (1) 사이트에 IMAP/POP 설정이 있으면 zele로 연결하는 게 가장 오래가요 (2) 브라우저 개발자도구에서 받은메일함을 연 뒤 HAR로 저장해 주시면 --har로 다시 시도해요",
			],
		};
	}

	let listReq: CapturedRequest | undefined;
	let listPath = "";
	let fields: FieldMap | undefined;
	let mailIds = new Set<string>();
	let best = -1;
	for (const r of json) {
		for (const hit of findArrays(parse(r))) {
			const f = inferFields(hit.items);
			if (!f) continue;
			const ids = new Set(hit.items.map((it) => String(it[f.id])).filter(Boolean));
			const hasQuery = [...new URL(r.url).searchParams.keys()].some((k) => SEARCH_KEY.test(k)) || !!bodyQuery(r.requestBody);
			const score = ids.size + (hasQuery ? -1000 : 0) + (/mail|inbox|message|list/i.test(new URL(r.url).pathname) ? 5 : 0);
			if (score > best) {
				best = score;
				listReq = r;
				listPath = hit.path;
				fields = f;
				mailIds = ids;
			}
		}
	}
	if (!listReq || !fields) {
		return {
			kind: "no-list",
			notes: [
				`JSON 호출 ${json.length}개는 봤는데 받은메일함 목록(제목·보낸사람·날짜가 있는 배열)처럼 보이는 게 없었어요`,
				"받은메일함이 화면에 보이는 상태에서 다시 시도하거나, 받은메일함을 연 뒤 저장한 HAR을 --har로 주시면 돼요",
			],
		};
	}

	const listUrl = new URL(listReq.url);
	const origin = listUrl.origin;
	const listTpl = templatize(listReq.url, new Set());
	const listBody = methodOf(listReq) ? bodyTemplate(listReq.requestBody, new Set()) : undefined;

	let read: SiteSpec["read"] | undefined;
	for (const r of json) {
		if (r === listReq) continue;
		const tpl = templatize(r.url, mailIds);
		const bt = methodOf(r) ? bodyTemplate(r.requestBody, mailIds) : undefined;
		if (!tpl.hasId && !bt?.hasId) continue;
		const bodyPath = findBodyPath(parse(r));
		if (!bodyPath) continue;
		read = withParams({ path: tpl.path, ...(methodOf(r) ? { method: "POST" as const } : {}), ...(bt ? { body: bt.body, bodyType: bt.bodyType } : {}), bodyPath, bodyIsHtml: true }, tpl.params);
		break;
	}
	const readGuessed = !read;
	if (!read) {
		notes.push("녹화 중에 메일이 열리지 않아서 읽기 주소는 실제 메일로 시험해서 찾을게요");
		read = { path: `${listTpl.path}/{id}`, bodyPath: "body", bodyIsHtml: true };
	}

	let search: SiteSpec["search"] | undefined;
	for (const r of json) {
		const u = new URL(r.url);
		const qp = [...u.searchParams.keys()].find((k) => SEARCH_KEY.test(k));
		const inBody = !qp && methodOf(r) ? bodyQuery(r.requestBody) : undefined;
		if (!qp && !inBody) continue;
		const arr = findArrays(parse(r)).find((h) => inferFields(h.items));
		if (!arr) continue;
		if (inBody) {
			const bt = bodyTemplate(r.requestBody, new Set(), inBody.value)!;
			search = withParams({ path: u.pathname, method: "POST" as const, body: bt.body, bodyType: bt.bodyType, queryParam: inBody.key, listPath: arr.path }, Object.fromEntries(u.searchParams));
		} else {
			const params = Object.fromEntries([...u.searchParams].filter(([k]) => k !== qp));
			search = withParams({ path: u.pathname, queryParam: qp!, listPath: arr.path }, params);
		}
		break;
	}

	const spec: SiteSpec = {
		version: 1,
		site,
		origin,
		cookieHosts: cookieHostsFor(listUrl.hostname),
		headers: { "X-Requested-With": "XMLHttpRequest" },
		list: { ...withParams({ path: listTpl.path }, listTpl.params), ...(methodOf(listReq) ? { method: "POST" as const } : {}), ...(listBody ? { body: listBody.body, bodyType: listBody.bodyType } : {}), ...(listTpl.mailbox ? { mailbox: listTpl.mailbox } : {}), listPath, fields },
		read,
		...(search ? { search } : {}),
	};
	const problem = validateSpec(spec);
	if (problem) return { kind: "no-list", spec, notes: [...notes, `만든 설정이 아직 완전하지 않아요: ${problem}`], readGuessed };
	notes.push(`받은메일함 ${mailIds.size}통, 필드 ${Object.keys(fields).join(", ")}${search ? ", 검색 가능" : ""}`);
	return { kind: "ok", spec, notes, readGuessed };
}
