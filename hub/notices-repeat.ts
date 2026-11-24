import { TZ } from "./config.ts";
import { REASK_MS, TEXT_MAX } from "./notices-rules.ts";
import { RUN_DECISION } from "./notices-schedule.ts";
import type { Decision, DecisionOpt, Notice } from "./notices-types.ts";
import { sameWatchSubject, watchOptions } from "./watch-ask.ts";

const dayOf = (iso: string): string => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ, month: "2-digit", day: "2-digit" });

/** The line a re-asked question carries: how many times it was asked and the day of the first ask. */
export const askedLine = (asked: NonNullable<Decision["asked"]>): string => `${asked.n}번째 알려요 · 처음 알린 날 ${dayOf(asked.first)}`;

/** A question put again while its notice still holds the earlier ask is the same question asked once more. Drafts, login requests and schedule runs are never counted,
 *  nor an ask again inside REASK_MS of the notice's last change: that is one delivery arriving twice (a session's mid-turn line and its turn-end report) or the same
 *  ask reworded. A card that expired was asked a whole answer window earlier, so an ask after its expiry is counted however soon it comes. */
export function askedAgain(old: Notice | undefined, d: { to: string; draft?: unknown }, at: string): Decision["asked"] | undefined {
	const prev = old?.decision;
	if (!prev || d.draft || d.to.startsWith("auth:") || d.to.startsWith(RUN_DECISION) || (!prev.expired && Date.parse(at) - Date.parse(old.updated) < REASK_MS)) return undefined;
	return { n: (prev.asked?.n ?? 1) + 1, first: prev.asked?.first ?? old.ts };
}

/** The notice text with the ask count under it, cut so the whole stays within the stored text size. */
export function withAskedLine(text: string, asked: Decision["asked"]): string {
	if (!asked) return text;
	const line = askedLine(asked);
	return `${text.slice(0, Math.max(0, TEXT_MAX - line.length - 2))}\n\n${line}`;
}

/** Two titles that ask about one thing: the same words, or the issue question of one watch (its reason may count more failures each time). */
export const sameQuestion = (a: string, b: string): boolean => a === b || sameWatchSubject(a, b);

/** The options of a question as the card keeps them: a watch issue's reconnect button carries the action that answers it without a model turn. */
export const optionsOf = (d: { title: string; options: DecisionOpt[] }): DecisionOpt[] => watchOptions(d.title, d.options);
