import type { HubEvent } from "./events.ts";
import { msg } from "./i18n.ts";
import type { Notice, NoticeTone } from "./notices-types.ts";
import { clean } from "./notices-rules.ts";
import { matchItems, matchTitle, scheduleLine, watchReasonKo } from "./watchtext.ts";

/** A bell row of a schedule run, in the shape the notice store's upsert takes. */
export type RunRow = { kind: "watch"; tone: NoticeTone; title: string; text: string; open: string; at: string; key?: string; nk?: "schedule"; read?: boolean; unread?: boolean };
/** The longest first sentence a task's result row (and its push) carries. */
export const SENTENCE_MAX = 120;
/** The key of a run's one row: the fire makes it, the answer, the held line and the failure decision rewrite it. */
export const runKey = (run: string): string => `schedule:${run}`;
/** The decision of a failed run answers to `schedule:<run>` (hub/routes.ts deliverAnswer), never to a model turn; its text is the schedule's name. */
export const RUN_DECISION = "schedule:";
/** The conversation a card stands in: its asker's, or for a failed run's card (asked by no conversation) the one its schedule fires into. */
export const cardConv = (n: Notice): string => (n.decision!.to.startsWith(RUN_DECISION) ? n.open : n.decision!.to);
const FALLBACK_TITLE = "예약";

/** The first sentence of an answer, without list or quote marks and a closing period. */
export function firstSentence(text: string): string {
	const line = text.split("\n").map(l => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
	const said = (/^.+?[.!?。](?=\s|$)/u.exec(line)?.[0] ?? line).replace(/[.。]$/, "");
	return said.length > SENTENCE_MAX ? `${said.slice(0, SENTENCE_MAX - 1)}…` : said;
}

/** The row a schedule fire makes: a task's run reads 돌아가는 중, born read (no start notice, no push); a reminder rings under its name. */
export function fireRow(e: HubEvent): RunRow | undefined {
	if (e.kind !== "schedule" || e.source === "gateway" || e.source === "zele") return undefined;
	const channel = typeof e.channel === "string" ? e.channel : "";
	const open = !channel || channel === "chat" || channel === "web" ? "main" : channel;
	const run = typeof e.run === "string" && e.run ? e.run : undefined;
	const title = typeof e.name === "string" && e.name.trim() ? e.name.trim() : FALLBACK_TITLE;
	if (run && e.sk === "task") return { kind: "watch", tone: "", title, text: msg().scheduleRun.running, open, at: e.ts, key: runKey(run), nk: "schedule", read: true };
	return { kind: "watch", tone: "", title, text: clean(scheduleLine(String(e.text ?? ""), { raw: false })).text, open, at: e.ts, ...(run ? { key: runKey(run) } : {}) };
}

/** The task run an orchestrator answer posts the result of (the prompt's run label rides the out event as `run` and `sk`). */
export const taskRunOf = (e: HubEvent): string | undefined => (e.kind === "out" && typeof e.run === "string" && e.run && e.sk === "task" ? e.run : undefined);

/** A task run's row once its answer is posted: the first sentence, at the answer. `loud`: an [ask] / [fail] or a choice block, which notifies on its own, so the row is born read. */
export function answerRow(e: HubEvent, run: string, prev: Pick<Notice, "title" | "text" | "open" | "decision"> | undefined, loud: boolean): RunRow {
	const open = prev?.open ?? (typeof e.target === "string" && e.target !== "chat" && e.target !== "web" ? e.target : "main");
	const title = (prev?.decision ? prev.text : prev?.title) ?? FALLBACK_TITLE;
	return { kind: "watch", tone: "", title, text: firstSentence(clean(e.text).text) || msg().scheduleRun.nothing, open, at: e.ts, key: runKey(run), nk: "schedule", ...(loud ? { read: true } : { unread: true }) };
}

const MATCHED = `: ${watchReasonKo("matched /./")}`;
/** A report stored before a schedule was said by its short name and a match that lists items by its count (2026-11-10) reads as a new one does. */
export function restored(n: Notice): string {
	if (n.kind !== "watch") return n.text;
	if (n.title === FALLBACK_TITLE) return clean(scheduleLine(n.text, { raw: false })).text;
	const [head = "", ...rest] = n.text.split("\n");
	const title = head.endsWith(MATCHED) ? matchTitle(rest.join("\n")) : undefined;
	return title ? [`${head.slice(0, -MATCHED.length)}: ${title}`, matchItems(rest.join("\n"), title)].join("\n") : n.text;
}
