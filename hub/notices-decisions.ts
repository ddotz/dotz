// The decisions an event asks of the owner. A part of the notice store split out of hub/notices.ts, code unchanged.
import { log, now } from "./config.ts";
import { decisionText, hasDecisionHead, parseDecisions } from "./choices.ts";
import { type DraftApproval, parseDraftApproval, quotedDraft } from "./draft-approval.ts";
import { askDefaults, askedDraft, asksSendWithoutDraft, DRAFT_OPTIONS, lastQuestion } from "./ask-options.ts";
import { unreadQuestions } from "./ask-normalize.ts";
import { eventTarget, historyEvents, type HubEvent } from "./events.ts";
import { shortTitle } from "./notice-title.ts";
import { parseTone, stripHandoff } from "./tone.ts";
import type { CardEdit, DecisionOpt } from "./notices-types.ts";
import { RUN_DECISION } from "./notices-schedule.ts";
import { ALERT_ANSWER_WINDOW_MS, ANSWER_WINDOW_MS, TEXT_MAX, authorOf, laneTone, refOf } from "./notices-rules.ts";
import { say } from "./notices-read.ts";

const BUDGET_OPTIONS: DecisionOpt[] = [
	{ n: 1, label: "네, 진행해 주세요", desc: "", rec: true, say: "진행해" },
	{ n: 2, label: "아니요, 하지 마세요", desc: "", rec: false, say: "하지 마" },
];
const hashOf = (s: string) => {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	return h.toString(36);
};
const firstLine = (text: string) => {
	const l = text.split("\n").map(s => s.replace(/^\s*\[[^\]\n]{1,10}\][ \t]*/, "").replace(/[*_`#>]/g, "").trim()).find(Boolean) ?? "";
	return shortTitle(l);
};

type Draft = { title: string; detail: string; options: DecisionOpt[]; to: string; replyTo: string; group: number; place: number; key: string; by?: string; ref?: string; draft?: DraftApproval; assumed?: true; evidence?: string[]; edit?: CardEdit };

// The quoted draft in the newest assistant message of a conversation before `before` (the draft the thread's send question is about).
function threadDraft(conv: string, before: string): string | undefined {
	for (const m of historyEvents(conv, 40, before).reverse()) {
		const q = m.kind === "out" && typeof m.text === "string" ? quotedDraft(m.text) : undefined;
		if (q) return q;
	}
	return undefined;
}

// The decisions an event asks of the owner: an [ask] from the assistant or a session, or any message holding a choice block
// (2+ options), split by its decision blocks.
// The `[file]` lines of a message, wherever it put them (parseTone drops them from the body): every question of the message carries all of them,
// so the question sheet can show the pictures whichever question it opens.
function messageFiles(raw: string): string {
	let fence = false;
	const out: string[] = [];
	for (const l of raw.split("\n")) {
		if (/^\s*```/.test(l)) fence = !fence;
		else if (!fence && /^\s*\[file\]\s+\S/.test(l)) out.push(l.trim());
	}
	return out.slice(0, 10).map(l => `\n${l}`).join("");
}

const namesEach = (ids: unknown, n: number): ids is string[] => Array.isArray(ids) && ids.length === n && ids.every(i => typeof i === "string" && i !== "") && new Set(ids).size === n;
const isEdit = (v: unknown): v is CardEdit => {
	const c = v as Record<string, unknown> | null;
	return typeof c === "object" && c !== null && typeof c.file === "string" && c.file !== "" && Number.isInteger(c.line) && Number(c.line) > 0 && typeof c.from === "string" && typeof c.to === "string";
};
function cardMetaOf(meta: unknown, id: string): { edit?: CardEdit; keep: number[] } {
	const m = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>)[id] : undefined;
	const one = typeof m === "object" && m !== null ? (m as Record<string, unknown>) : {};
	const keep = Array.isArray(one.keep) ? one.keep.filter((n): n is number => Number.isInteger(n)) : [];
	return { ...(isEdit(one.edit) ? { edit: { file: one.edit.file, line: one.edit.line, from: one.edit.from, to: one.edit.to } } : {}), keep };
}
/** The decisions an event asks of the owner. A gateway post may name its cards (`card_ids`, one id per card in their order): a card with an id is keyed by it
 *  (`dec:<to>:id:<id>`) and carries it as `card_id`; a list that does not name every card once is dropped. Any other post's ids are ignored. Such a post's
 *  `card_meta` (by card id) gives a card the edit it proposes and marks its options that change nothing (`keep`); no other post can set either. */
export function decisionsOf(e: HubEvent): (Draft & { card_id?: string })[] {
	const ds = drafted(e), ids = e.source === "gateway" ? e.card_ids : undefined;
	if (ids === undefined || !ds.length || !namesEach(ids, ds.length)) return ds;
	return ds.map((d, i) => {
		const { edit, keep } = cardMetaOf(e.card_meta, ids[i]!);
		return { ...d, key: `dec:${d.to}:id:${ids[i]}`, card_id: ids[i], options: d.options.map(o => (keep.includes(o.n) ? { ...o, keep: true as const } : o)), ...(edit ? { edit } : {}) };
	});
}

/** Logs a gateway post whose `card_ids` were dropped; `ds` is what decisionsOf made of it. Only the store's feed calls it, so the line is written once per post however many readers ask for its decisions. */
export function noteDroppedIds(e: HubEvent, ds: { card_id?: string }[]): void {
	if (e.source === "gateway" && e.card_ids !== undefined && ds.length && !ds[0]!.card_id) log(`card ids of ${e.ts} dropped: ${JSON.stringify(e.card_ids)} does not name its ${ds.length} card(s) once each`);
}

function drafted(e: HubEvent): Draft[] {
	if (e.kind === "out") {
		const src = String(e.source ?? "");
		// The gateway's own alert (a token audit, a failed update) may ask a question too; its other posts never do.
		if (e.update_key || e.target === "worklog" || (src !== "orchestrator" && !src.startsWith("lane:") && !(src === "gateway" && e.target === "alert"))) return [];
	} else if (e.kind !== "lane_report") return [];
	const p = parseTone(stripHandoff(String(e.text ?? "")));
	const body = p.text.trim();
	if (p.tone === "ask" && laneTone(e, "ask", body) === "") return [];
	const pc = parseDecisions(body);
	// An [ask] is a decision; so is any other message (a [done] answer, a lane report, no marker) holding a "결정:" choice block with 2+
	// options. A plain numbered list without "결정:" is not. The gateway's own alert keeps its older, looser rule.
	const gatewayAlert = e.kind === "out" && e.source === "gateway" && e.target === "alert";
	if (!body || (p.tone !== "ask" && !hasDecisionHead(pc.blocks) && !(gatewayAlert && pc.blocks.length))) return [];
	const to = eventTarget(e) ?? "main";
	// A mail thread's send question without the draft: the thread's latest drafted quote goes above it, so the owner can decide on it.
	const quoted = !pc.blocks.length && to.startsWith("mail:") && asksSendWithoutDraft(body) ? threadDraft(to, e.ts) : undefined;
	const detail = quoted ? `${quoted.slice(0, Math.max(0, TEXT_MAX - body.length - 1))}\n${body}`.slice(0, TEXT_MAX) : body.slice(0, TEXT_MAX);
	const line = firstLine(body);
	// A send question that quotes its draft is a draft approval even without the choice block: it gets the draft and the draft options.
	const askDraft = !pc.blocks.length ? askedDraft(detail) : undefined;
	const sendDraft = pc.blocks.length === 1 ? parseDraftApproval(body) : askDraft;
	const by = authorOf(e), ref = refOf(e);
	const files = sendDraft || askDraft ? "" : messageFiles(stripHandoff(String(e.text ?? "")));
	const withFiles = (s: string): string => s.slice(0, Math.max(0, TEXT_MAX - files.length)) + files;
	const draft = (title: string, given: DecisionOpt[], group: number, idx: number): Draft => ({ title, detail: withFiles(detail), options: askDraft ? DRAFT_OPTIONS.map(o => ({ ...o })) : given, to, replyTo: e.ts, group, place: idx, ...(by ? { by } : {}), ...(ref ? { ref } : {}), key: `dec:${to}:${hashOf(`${idx}|${title}|${(askDraft ? DRAFT_OPTIONS : given).map(o => o.label).join("/")}${sendDraft ? `|${sendDraft.to}|${sendDraft.subject ?? ""}|${sendDraft.body}` : ""}`)}`, ...(sendDraft ? { draft: sendDraft } : {}) });
	const unread = askDraft ? [] : unreadQuestions(stripHandoff(String(e.text ?? "")));
	// No choice block (a plain question, often in a mail or work thread): the budget question's buttons, else yes / no or send defaults (ask-options.ts).
	if (!pc.blocks.length) {
		if (to.startsWith("lane:") && /\/budget-ok/.test(body)) return [draft(line || "답변이 필요해요", BUDGET_OPTIONS, 1, 0)];
		if (unread.length) return unread.map((q, i) => draft(shortTitle(q), [], unread.length, i));
		const options = askDefaults(body, to.startsWith("mail:"));
		const asked = lastQuestion(body);
		return [{ ...draft((asked && shortTitle(asked)) || line || "답변이 필요해요", options, 1, 0), ...(options.length ? { assumed: true as const } : {}) }];
	}
	const many = pc.blocks.length > 1;
	const group = pc.blocks.length + unread.length;
	// Several decisions are several notices: each carries its own text, so opening one never shows the others under its title.
	const own = many && pc.blocks.every(b => b.headed);
	const cards = pc.blocks.map((b, i) => {
		const title = b.title || (many ? `결정 ${i + 1}` : pc.question || line);
		const d = draft(title, b.options.map(o => ({ ...o })), group, i);
		const evidence = sendDraft || askDraft ? undefined : b.evidence;
		return own || evidence ? { ...d, detail: withFiles(decisionText(body, i) || title), ...(evidence ? { evidence } : {}) } : d;
	});
	return [...cards, ...unread.map((q, i) => draft(shortTitle(q), [], group, pc.blocks.length + i))];
}

export const expiresAtOf = (d: { to: string; by?: string; draft?: DraftApproval }, at: string): string | undefined => {
	if (d.draft || d.to.startsWith("auth:")) return undefined;
	const from = Date.parse(at);
	return new Date((Number.isNaN(from) ? Date.parse(now()) : from) + (d.by === "gateway" || d.to === "alert" ? ALERT_ANSWER_WINDOW_MS : ANSWER_WINDOW_MS)).toISOString();
};
/** A question card that 자세히 / 나중에, the close labels, the half-time reminder and the asker's note apply to: no send approval, login request or schedule run. */
export const plainCard = (d: { to: string; draft?: DraftApproval }): boolean => !d.draft && !d.to.startsWith("auth:") && !d.to.startsWith(RUN_DECISION);

// The label a button answer shows (the sent text may be longer): set while its message is on the way, since that message settles the notice too.
export const sending = new Map<string, string>();
/** The answers the gateway holds for their undo window by notice id (hub/notices-answers.ts holdDecision), and `on`: false once an orderly stop sent them, so a later answer goes out at once. */
export const holds = { on: true, by: new Map<string, { timer: Timer; go: () => Promise<void> }>() };
