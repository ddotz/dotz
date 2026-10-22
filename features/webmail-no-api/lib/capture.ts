// The adapter generator. Step 1 of the feature records the webmail client's own XHR/JSON calls from a logged-in Aside
// session (bin/capture.ts, background only). Step 2, here, turns that recording into a SiteSpec with no hand-coding and no
// personal data in the shipped code: the owner's recording stays in their custom layer, and only field *names* and URL
// *shapes* are inferred. It is a proposal — setup shows it and the owner confirms before it is used.
import { SITE_ID, validateSpec, type FieldMap, type SiteSpec } from "./spec.ts";

export type CapturedRequest = {
	url: string;
	method?: string;
	status?: number;
	contentType?: string;
	responseBody?: string;
};

export type CaptureResult = { spec?: SiteSpec; notes: string[] };

const FIELD_RE: Record<keyof FieldMap, RegExp> = {
	id: /^(id|idx|uid|seq|no|mailid|msgid|messageid)$/i,
	subject: /subject|title|subj/i,
	from: /from|sender|author|fromaddr|sendernm/i,
	time: /date|time|sent|received|timestamp|regdate/i,
	read: /read|seen|unread|isread|is_read/i,
};

const isJsonResponse = (r: CapturedRequest): boolean => {
	if (/json/i.test(r.contentType ?? "")) return true;
	const b = (r.responseBody ?? "").trimStart();
	return b.startsWith("{") || b.startsWith("[");
};

const parse = (r: CapturedRequest): unknown => {
	try {
		return JSON.parse(r.responseBody ?? "");
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
		const exact = keys.find((k) => which === "id" && k.toLowerCase() === "id");
		if (exact) return exact;
		return keys.find((k) => FIELD_RE[which].test(k));
	};
	const id = pick("id");
	if (!id) return undefined;
	const fields: FieldMap = { id };
	for (const which of ["from", "subject", "time", "read"] as const) {
		const k = pick(which);
		if (k) fields[which] = k;
	}
	// A real mail list has at least a subject or a sender plus a date; otherwise it is some other array (folders, flags...).
	if (!(fields.subject || fields.from) || !fields.time) return undefined;
	return fields;
}

// Replace a path segment that equals one of the listed mail ids with {id}; a different numeric segment becomes {mailbox}.
function templatize(url: string, ids: Set<string>): { path: string; mailbox?: string } {
	const u = new URL(url);
	let mailbox: string | undefined;
	const segs = u.pathname.split("/").map((seg) => {
		if (ids.has(seg)) return "{id}";
		if (/^\d+$/.test(seg) && !mailbox) {
			mailbox = seg;
			return "{mailbox}";
		}
		return seg;
	});
	return { path: segs.join("/"), mailbox };
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

// Build a SiteSpec proposal from one session recording. `site` is the slug the owner chose. Headers worth replaying
// (X-Requested-With, custom auth-less markers) are taken from the list request.
export function capture(site: string, requests: CapturedRequest[]): CaptureResult {
	const notes: string[] = [];
	if (!SITE_ID.test(site)) return { notes: ["site 슬러그는 [a-z0-9-] (최대 40자)여야 해요"] };
	const json = requests.filter((r) => (r.method ?? "GET").toUpperCase() !== "OPTIONS" && (r.status ?? 200) < 300 && isJsonResponse(r));
	if (!json.length) return { notes: ["JSON 응답을 담은 XHR 기록이 없어요. 로그인한 상태에서 받은메일함을 열고 메일을 한 통 열어 본 뒤 다시 캡처해 주세요"] };

	let listReq: CapturedRequest | undefined;
	let listPath = "";
	let fields: FieldMap | undefined;
	let mailIds = new Set<string>();
	for (const r of json) {
		for (const hit of findArrays(parse(r))) {
			const f = inferFields(hit.items);
			if (!f) continue;
			const ids = new Set(hit.items.map((it) => String(it[f.id])).filter(Boolean));
			if (ids.size > (mailIds.size || 0) || !listReq) {
				listReq = r;
				listPath = hit.path;
				fields = f;
				mailIds = ids;
			}
		}
	}
	if (!listReq || !fields) return { notes: ["받은메일함 목록처럼 보이는 응답(제목·보낸사람·날짜가 있는 배열)을 찾지 못했어요"] };

	const origin = new URL(listReq.url).origin;
	const host = new URL(listReq.url).hostname;
	const cookieHosts = [host, `.${host.split(".").slice(-2).join(".")}`];
	const listTpl = templatize(listReq.url, new Set());
	const headersToReplay: Record<string, string> = {};

	let read: SiteSpec["read"] | undefined;
	for (const r of json) {
		if (r === listReq) continue;
		const tpl = templatize(r.url, mailIds);
		if (!/\{id\}/.test(tpl.path)) continue;
		const bodyPath = findBodyPath(parse(r));
		if (!bodyPath) continue;
		read = { path: tpl.path, bodyPath, bodyIsHtml: true };
		break;
	}
	if (!read) {
		notes.push("메일 본문 응답을 못 찾아서 read 엔드포인트는 비워 뒀어요. 메일을 한 통 연 상태에서 다시 캡처하면 채워져요");
		read = { path: `${listTpl.path.replace(/\/[^/]*$/, "")}/{id}`, bodyPath: fields.subject ?? "body", bodyIsHtml: true };
	}

	let search: SiteSpec["search"] | undefined;
	for (const r of json) {
		const u = new URL(r.url);
		const qp = [...u.searchParams.keys()].find((k) => /^(q|query|keyword|search|searchword|kwd)$/i.test(k));
		if (!qp) continue;
		const arr = findArrays(parse(r)).find((h) => inferFields(h.items));
		if (!arr) continue;
		search = { path: u.pathname, queryParam: qp, listPath: arr.path };
		break;
	}

	const spec: SiteSpec = {
		version: 1,
		site,
		origin,
		cookieHosts,
		...(Object.keys(headersToReplay).length ? { headers: headersToReplay } : { headers: { "X-Requested-With": "XMLHttpRequest" } }),
		list: { path: listTpl.path, ...(listTpl.mailbox ? { mailbox: listTpl.mailbox } : {}), listPath, fields },
		read,
		...(search ? { search } : {}),
	};
	const problem = validateSpec(spec);
	if (problem) return { spec, notes: [...notes, `스펙이 아직 완전하지 않아요: ${problem}`] };
	notes.push(`받은메일함 ${mailIds.size}통, 필드 ${Object.keys(fields).join(", ")}${search ? ", 검색 가능" : ""}`);
	return { spec, notes };
}
