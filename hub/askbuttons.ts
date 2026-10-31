// Decision buttons on an [ask] message (docs/layers.md section 3): one button per option of the message's choice block.
// A click is the owner typing `<n>) <name>` in that channel: the answer goes through the same inbound path (main.ts).
import { log } from "./config.ts";
import { type ChoiceOption, hasDecisionHead, parseChoices, parseDecisions } from "./choices.ts";
import type { Interaction } from "./discord.ts";
import type { Pick } from "./intake.ts";
import { msg } from "./i18n.ts";
import { parseTone, TONE_EMOJI } from "./tone.ts";

export const ASK_PREFIX = "dz-ask";
const PRIMARY = 1;
const SECONDARY = 2;
const ROW = 5;
const LABEL_MAX = 80;
const ID_MAX = 100;

export function askComponents(target: string, options: ChoiceOption[], disabled = false): unknown[] {
	const buttons = options.map(o => ({ type: 2, style: o.recommended ? PRIMARY : SECONDARY, label: o.label.slice(0, LABEL_MAX), custom_id: `${ASK_PREFIX}:${target}:${o.n}`, disabled }));
	if (!buttons.length || buttons.some(b => b.custom_id.length > ID_MAX)) return [];
	const rows: unknown[] = [];
	for (let i = 0; i < buttons.length; i += ROW) rows.push({ type: 1, components: buttons.slice(i, i + ROW) });
	return rows;
}

/** Buttons for an [ask] or headed decision, only on the part that still holds its question and every option. */
export function askComponentsFor(target: string, text: string, shown = text): unknown[] {
	if (parseTone(text).tone !== "ask" && !hasDecisionHead(parseDecisions(text).blocks)) return [];
	const { question, options } = parseChoices(text);
	const part = parseChoices(shown);
	const sameQuestion = !question || part.question === question || part.question === `${TONE_EMOJI.ask} ${question}`;
	return part.options.length === options.length && sameQuestion ? askComponents(target, options) : [];
}

export function parseAskId(customId: string): { target: string; n: number } | undefined {
	const m = new RegExp(`^${ASK_PREFIX}:(.+):(\\d{1,2})$`).exec(customId);
	return m ? { target: m[1]!, n: Number(m[2]) } : undefined;
}

const noteOf = (d: Interaction): string => {
	for (const row of d.data?.components ?? []) for (const c of row.components ?? []) if (c.custom_id === NOTE_FIELD && typeof c.value === "string") return c.value.replace(/\s+/g, " ").trim().slice(0, 500);
	return "";
};

type Answer = (target: string, text: string, picks: Pick[]) => void;
let answer: Answer = () => {
	throw new Error("no answer handler");
};
export function setAskAnswer(fn: Answer): void {
	answer = fn;
}

type AskDeps = {
	owner: string;
	reply: (d: Interaction, type: number, data?: unknown) => Promise<void>;
	answer?: Answer;
};

const NOTE_FIELD = "note";
// An option that needs detail (choices.ts detailOf) opens this modal instead of answering; its submit comes back with the same custom_id.
function noteModal(target: string, o: ChoiceOption) {
	return {
		custom_id: `${ASK_PREFIX}:${target}:${o.n}`,
		title: `${o.n}) ${o.label}`.slice(0, 45),
		components: [{ type: 1, components: [{ type: 4, custom_id: NOTE_FIELD, label: msg().auth.noteLabel, style: 2, required: true, min_length: 1, max_length: 500 }] }],
	};
}

const ephemeral = (content: string) => ({ content, flags: 64, allowed_mentions: { parse: [] } });

/** Handles one click on an ask button: the owner only; acknowledges by updating the message with every button disabled. */
export async function askInteraction(d: Interaction, deps: AskDeps): Promise<void> {
	const m = msg().auth;
	const parsed = parseAskId(String(d.data?.custom_id ?? ""));
	if (!parsed || (d.type !== 3 && d.type !== 5)) return deps.reply(d, 4, ephemeral(m.finished));
	const user = String(d.member?.user?.id ?? d.user?.id ?? "");
	if (!deps.owner || user !== deps.owner) {
		log(`ask ${parsed.target} refused user ${user}`);
		return deps.reply(d, 4, ephemeral(m.notOwner));
	}
	const { question, options } = parseChoices(String(d.message?.content ?? ""));
	const picked = options.find(o => o.n === parsed.n);
	if (!picked) return deps.reply(d, 4, ephemeral(m.finished));
	let text = `${picked.n}) ${picked.label}`;
	let note = "";
	if (picked.detail) {
		if (d.type === 3) return deps.reply(d, 9, noteModal(parsed.target, picked));   // nothing is sent until the modal is submitted
		note = noteOf(d);
		if (!note) return deps.reply(d, 4, ephemeral(m.noteMissing));
		text += ` - ${note}`;
	} else if (d.type === 5) return deps.reply(d, 4, ephemeral(m.finished));
	try {
		(deps.answer ?? answer)(parsed.target, text, question ? [{ q: question, n: picked.n, label: picked.label, ...(note ? { note } : {}) }] : []);
	} catch (e) {
		log(`ask ${parsed.target} answer failed: ${e}`);
		return deps.reply(d, 4, ephemeral(m.answerFailed));
	}
	return deps.reply(d, 7, { components: askComponents(parsed.target, options, true) });
}
