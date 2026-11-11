// /api/ledger (hub/routes-lanes.ts): the checks at the boundary in front of the ledger store (hub/ledger.ts), and the list as rows of a ```목록 block.
import { msg } from "./i18n.ts";
import { type Ledger, type LedgerItem, type LedgerSource, localDate } from "./ledger.ts";
import { convTargetOf, MAIN } from "./session-key.ts";

const MAX_TEXT = 300;
const WEEK_DAYS = 7;

/** An error with the HTTP status the route answers (400 when none). */
class ApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

const text = (v: unknown, name: string): string => {
	const s = typeof v === "string" ? v.trim() : "";
	if (!s) throw new Error(`${name} required`);
	if (s.length > MAX_TEXT) throw new Error(`${name} must be at most ${MAX_TEXT} characters`);
	return s;
};
const dueDate = (v: unknown): string => {
	const m = typeof v === "string" ? /^(\d{4})-(\d\d)-(\d\d)$/.exec(v) : null;
	const [y, mo, da] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
	const d = new Date(y, mo - 1, da);
	if (!m || d.getMonth() !== mo - 1 || d.getDate() !== da) throw new Error("due must be a real date, YYYY-MM-DD");
	return m[0];
};

/** Rows `what | next · source | MM-DD | state`: a | or a line break inside a cell would split the row. */
function rows(items: LedgerItem[]): string {
	const t = msg().ledger, cell = (s: string) => s.replace(/\s*[|\n]\s*/g, " ");
	if (!items.length) return t.none;
	return items.map(x => [cell(x.what), [x.next && cell(x.next), t.source[x.source.kind]].filter(Boolean).join(" · "), x.due?.slice(5) ?? "", t.state[x.state]].join(" | ")).join("\n");
}

function sourceOf(input: Record<string, unknown>): LedgerSource {
	const mail = input.mail === undefined ? undefined : text(input.mail, "mail");
	const target = convTargetOf(input);
	const project = target && /^(?:ch|th):/.test(target) ? target : undefined;
	return { kind: mail ? "mail" : "conversation", ref: mail ?? target ?? MAIN, ...(project ? { project } : {}) };
}

/**
 * GET /api/ledger?range=week&state=all, POST /api/ledger, PATCH /api/ledger/<id>, POST /api/ledger/<id>/done|cancel. `rest` is the path after "ledger".
 * Returns undefined for a request this does not own; a refusal throws (400, or the status of ApiError).
 */
export function ledgerApi(store: Ledger, method: string, rest: string[], query: URLSearchParams, input: Record<string, unknown>, now = Date.now()): { status: number; body: unknown } | undefined {
	const [id, action] = rest;
	if (!id && method === "GET") {
		const end = localDate(now, WEEK_DAYS);
		const items = store.list().filter(x => (query.get("state") === "all" || x.state === "open") && (query.get("range") !== "week" || !x.due || x.due <= end));
		return { status: 200, body: { items, text: rows(items) } };
	}
	if (!id && method === "POST") {
		const what = text(input.what, "what");
		const due = input.due === undefined || input.due === null ? undefined : dueDate(input.due);
		const next = input.next === undefined || input.next === null ? undefined : text(input.next, "next");
		return { status: 200, body: { ok: true, item: store.add({ what, source: sourceOf(input), ...(due ? { due } : {}), ...(next ? { next } : {}) }) } };
	}
	const edit = method === "PATCH" && !action, close = method === "POST" && (action === "done" || action === "cancel");
	if (!id || !(edit || close)) return undefined;
	const item = store.list().find(x => x.id === id);
	if (!item) throw new ApiError(`no ledger item ${id}`, 404);
	if (item.state !== "open") throw new ApiError(`ledger item ${id} is already ${item.state}`, 409);
	if (close) return { status: 200, body: { ok: true, item: action === "done" ? store.done(id) : store.cancel(id) } };
	const patch: Parameters<Ledger["edit"]>[1] = {};
	if (input.what !== undefined) patch.what = text(input.what, "what");
	if (input.due !== undefined) patch.due = input.due === null ? null : dueDate(input.due);
	if (input.next !== undefined) patch.next = input.next === null ? null : text(input.next, "next");
	if (input.mail !== undefined || input.project !== undefined || input.conv !== undefined) patch.source = sourceOf(input);
	return { status: 200, body: { ok: true, item: store.edit(id, patch) } };
}
