import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { answerEn, answerKo } from "./answer-text.ts";
import { DECISION_HEAD, unnumbered } from "./choices.ts";
import { DATA_DIR } from "./config.ts";
import { answerOfMessage } from "./events.ts";
import { msg } from "./i18n.ts";
import type { CardEdit, DecisionOpt, Notice } from "./notices-types.ts";
import { items } from "./notices-store.ts";

const PKG = join(import.meta.dir, "..");
const PROPOSES_EDIT = /^prompt:(?:review|enforced):/;

const titled = (q: string, conv: unknown): Notice | undefined => {
	const title = DECISION_HEAD.exec(q)?.[1] ?? q;
	return items.findLast(n => !!n.decision && n.title === title && (conv === undefined || n.decision.to === conv));
};

/** The card an answer names: by its notice id (the web's answer), else the newest card of that conversation titled as its one pick (a Discord button). */
export function answeredCard(p: { decision?: unknown; picks?: unknown; channel?: unknown }): Notice | undefined {
	if (typeof p.decision === "string" && p.decision) return items.find(n => n.id === p.decision && !!n.decision);
	const picks = Array.isArray(p.picks) ? p.picks : [];
	return picks.length === 1 && typeof picks[0]?.q === "string" ? titled(picks[0].q, typeof p.channel === "string" ? p.channel : undefined) : undefined;
}

const isApply = (o: DecisionOpt): boolean => [answerKo.answerApply, answerEn.answerApply].includes(unnumbered(o.label).trim());

function confirmed(card: Notice): { edit?: CardEdit } | undefined {
	if (card.decision?.card_id || !card.ref) return undefined;
	const asked = answerOfMessage(card.ref);
	const source = asked && (asked.decision ? items.find(n => n.id === asked.decision) : asked.picks.length === 1 ? titled(asked.picks[0]!.q, asked.conv) : undefined);
	const d = source?.decision, picked = asked?.picks.length === 1 ? d?.options.find(o => o.n === asked.picks[0]!.n) : undefined;
	if (!d?.card_id || !PROPOSES_EDIT.test(d.card_id) || !picked || picked.keep) return undefined;
	return d.edit ? { edit: d.edit } : {};
}

const lineHolds = (e: CardEdit): boolean => existsSync(e.file) && readFileSync(e.file, "utf8").split("\n")[e.line - 1] === e.from;

const reachOf = (file: string): string => {
	const m = msg();
	return file.startsWith(`${DATA_DIR}/`) ? m.answerReachData : file.startsWith(`${PKG}/`) ? m.answerReachPackage : m.answerReachOther;
};

/**
 * The short line an answer closes `card` with when it starts no model turn, undefined when the answer goes to the model: an option the gateway marked as
 * changing nothing (`keep`, only a gateway post can set it), or Apply on a confirm card whose proposed line no longer reads as the card showed.
 */
export function noTurnLine(card: Notice, o: DecisionOpt): string | undefined {
	if (o.keep) return msg().answerKept;
	const edit = isApply(o) ? confirmed(card)?.edit : undefined;
	return edit && !lineHolds(edit) ? msg().answerStale(edit.file, edit.line) : undefined;
}

/**
 * The lines the answer of `card` with option `n` hands the model in place of the start of its message: the card's title, its own evidence and the picked
 * option with its result line, for a card of a message with several cards or one with evidence lines. The apply option of a gateway card that proposes an
 * edit adds that edit in full (or says the record no longer holds it) and the instruction to change nothing and post one confirm card; Apply on that confirm
 * card adds the instruction to make exactly the edits it showed. Empty: the answer reads as before.
 */
export function answerLines(card: Notice, n: number): string[] {
	const m = msg(), d = card.decision, o = d?.options.find(x => x.n === n);
	if (!d || !o) return [];
	const own = m.answerCard(card.title, d.evidence ?? [], `${o.n}) ${unnumbered(o.label)}`, o.desc);
	if (d.card_id && PROPOSES_EDIT.test(d.card_id) && !o.keep) return [...own, ...(d.edit ? m.answerEdit({ ...d.edit, reach: reachOf(d.edit.file) }) : [m.answerEditGone]), m.answerConfirmFirst(m.answerApply, m.answerLeave)];
	const asked = isApply(o) ? confirmed(card) : undefined;
	if (asked) return [...own, m.answerConfirmed, ...(asked.edit ? [...m.answerEdit({ ...asked.edit, reach: reachOf(asked.edit.file) }), m.answerChecked(asked.edit.file, asked.edit.line)] : [])];
	return d.group > 1 || d.evidence?.length ? own : [];
}
