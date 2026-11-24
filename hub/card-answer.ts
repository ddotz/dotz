import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { AGENT_AUTHOR } from "./agent-author.ts";
import { answerEn, answerKo } from "./answer-text.ts";
import { DECISION_HEAD, unnumbered } from "./choices.ts";
import { DATA_DIR, now } from "./config.ts";
import { eventTarget, type HubEvent } from "./events.ts";
import { msg } from "./i18n.ts";
import { promptCardEn, promptCardKo } from "./prompt-card-text.ts";
import type { CardEdit, DecisionOpt, Notice } from "./notices-types.ts";
import { PROPOSES_EDIT, answersOption } from "./notices-rules.ts";
import { items, save } from "./notices-store.ts";
import { onDecision } from "./notices-wiring.ts";

const PKG = join(import.meta.dir, "..");
const CHANGES = [promptCardKo.promptReviewApply, promptCardEn.promptReviewApply, promptCardKo.promptRemove, promptCardEn.promptRemove];
const proposesEdit = (card: Notice): boolean => PROPOSES_EDIT.test(card.decision?.card_id ?? "");
const changes = (card: Notice, o: DecisionOpt): boolean => proposesEdit(card) && !o.keep && CHANGES.includes(unnumbered(o.label).trim());
const isApply = (o: DecisionOpt): boolean => [answerKo.answerApply, answerEn.answerApply].includes(unnumbered(o.label).trim());
const postedAt = (n: Notice): string => n.at ?? n.ts;

const titled = (q: string, conv: string | undefined): Notice | undefined => {
	const title = DECISION_HEAD.exec(q)?.[1] ?? q;
	return items.findLast(n => !!n.decision && n.title === title && (conv === undefined || n.decision.to === conv));
};

function answeredCard(p: { decision?: unknown; picks?: unknown; channel?: unknown }): Notice | undefined {
	const picks = Array.isArray(p.picks) ? p.picks : [], named = typeof p.decision === "string" ? p.decision : picks.length === 1 ? picks[0]?.decision : undefined;
	if (typeof named === "string" && named) return items.find(n => n.id === named && !!n.decision);
	return picks.length === 1 && typeof picks[0]?.q === "string" ? titled(picks[0].q, typeof p.channel === "string" ? eventTarget(p as HubEvent) : undefined) : undefined;
}

const shownOf = (file: string): string => {
	const root = [DATA_DIR, PKG].find(r => file.startsWith(`${r}/`));
	return root ? relative(root, file) : file;
};
const lineHolds = (e: CardEdit): boolean => existsSync(e.file) && readFileSync(e.file, "utf8").split(/\r?\n/)[e.line - 1] === e.from;

const reachOf = (file: string): string => {
	const m = msg();
	return file.startsWith(`${DATA_DIR}/`) ? m.answerReachData : file.startsWith(`${PKG}/`) ? m.answerReachPackage : m.answerReachOther;
};

function confirmsOf(card: Notice): Notice["confirms"] {
	const d = card.decision;
	if (!d || card.by !== "orchestrator") return undefined;
	const shows = (e?: CardEdit) => !e || [card.title, card.text, ...(d.evidence ?? [])].some(l => l.includes(e.from.trim()));
	const tied = (n: Notice) => items.some(c => c !== card && c.confirms?.id === n.id && postedAt(c) > n.confirm_ask!.at);
	const asked = items.filter(n => n.confirm_ask && n.decision?.to === d.to && n.confirm_ask.at < postedAt(card) && shows(n.confirm_ask.edit) && !tied(n)).sort((a, b) => a.confirm_ask!.at.localeCompare(b.confirm_ask!.at)).at(-1);
	return asked && { id: asked.id, ...(asked.confirm_ask!.edit ? { edit: asked.confirm_ask!.edit } : {}) };
}

onDecision(card => {
	const tie = confirmsOf(card);
	if (tie) card.confirms = tie;
});

/**
 * The short line an answer closes `card` with when it starts no model turn, undefined when the answer goes to the model: an option the gateway marked as
 * changing nothing (`keep`, only a gateway post can set it), or Apply on a confirm card whose proposed line no longer reads as the card showed. The file is
 * named as the card shows it.
 */
export function noTurnLine(card: Notice, o: DecisionOpt): string | undefined {
	if (o.keep) return msg().answerKept;
	const edit = isApply(o) ? card.confirms?.edit : undefined;
	return edit && !lineHolds(edit) ? msg().answerStale(shownOf(edit.file), edit.line) : undefined;
}

/** The option the owner's typed words name on a card of an edit chain (a gateway card that proposes an edit, or its confirm card); undefined on any other card or when the words name no single option. */
export function typedOption(card: Notice, text: string): DecisionOpt | undefined {
	if (!proposesEdit(card) && !card.confirms) return undefined;
	const hit = card.decision?.options.filter(o => answersOption([o], text)) ?? [];
	return hit.length === 1 ? hit[0] : undefined;
}

function answerLines(card: Notice, n: number, at: string, agent: boolean): string[] {
	const m = msg(), d = card.decision, o = d?.options.find(x => x.n === n);
	if (!d || !o) return [];
	const own = m.answerCard(card.title, d.evidence ?? [], `${o.n}) ${unnumbered(o.label)}`, o.desc);
	if (!agent && changes(card, o)) {
		card.confirm_ask = { at, ...(d.edit ? { edit: d.edit } : {}) };
		save();
		return [...own, ...(d.edit ? m.answerEdit({ ...d.edit, reach: reachOf(d.edit.file) }) : [m.answerEditGone]), m.answerConfirmFirst(m.answerApply, m.answerLeave)];
	}
	const asked = !agent && isApply(o) ? card.confirms : undefined;
	if (asked?.edit && !lineHolds(asked.edit)) return [...own, m.answerStaleTurn(m.answerStale(shownOf(asked.edit.file), asked.edit.line))];
	if (asked) return [...own, m.answerConfirmed, ...(asked.edit ? [...m.answerEdit({ ...asked.edit, reach: reachOf(asked.edit.file) }), m.answerChecked(asked.edit.file, asked.edit.line)] : [])];
	return d.group > 1 || d.evidence?.length ? own : [];
}

/**
 * The lines an owner message that answered a card hands the model in place of the start of its message: a button's one pick, or the words typed in a
 * conversation that closed a card of an edit chain. The card's title, its own evidence and the picked option with its result line, for a card of a message
 * with several cards or one with evidence lines. The change option of a gateway card that proposes an edit adds that edit in full (or says the record no
 * longer holds it) and the instruction to change nothing and post one confirm card, and starts the tie to that card; Apply on the confirm card adds the
 * instruction to make exactly the edits it showed, with the line checked now, or says the line changed and nothing may be edited. An agent's answer
 * (AGENT_AUTHOR) gets neither instruction. Empty: the answer reads as before.
 */
export function cardAnswerLines(p: { ts?: unknown; author?: unknown; text?: unknown; decision?: unknown; picks?: unknown; channel?: unknown }): string[] {
	const at = typeof p.ts === "string" ? p.ts : now(), agent = p.author === AGENT_AUTHOR;
	const picks = Array.isArray(p.picks) ? p.picks : [];
	if (picks.length === 1) {
		const card = answeredCard(p);
		return card ? answerLines(card, Number(picks[0].n), at, agent) : [];
	}
	if (typeof p.ts !== "string") return [];
	const said = String(p.text ?? "");
	return items.flatMap(n => {
		const o = n.decision?.answered_at === p.ts ? typedOption(n, said) : undefined;
		return o ? answerLines(n, o.n, at, agent) : [];
	});
}
