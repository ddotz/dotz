// Decision buttons on an [ask] message (docs/layers.md section 3): one button per option of the message's choice block.
// A click is the owner typing `<n>) <name>` in that channel: the answer goes through the same inbound path (main.ts).
import { DRAFT_EDIT, parseDraftApproval } from "./draft-approval.ts";
import { webLink } from "./weblink.ts";
import { log } from "./config.ts";
import { type ChoiceOption, hasDecisionHead, parseChoices, parseDecisions } from "./choices.ts";
import type { Interaction } from "./discord.ts";
import { escalations } from "./escalate.ts";
import type { Pick } from "./intake.ts";
import { msg } from "./i18n.ts";
import { parseTone, TONE_EMOJI } from "./tone.ts";
import { refOfQuestion } from "./approval-send.ts";
import { useReplies } from "./reply-actions.ts";

export const ASK_PREFIX = "dz-ask";
const SECONDARY = 2;
const LINK = 5;
const ROW = 5;
const LABEL_MAX = 80;
const ID_MAX = 100;

export function askComponents(target: string, options: ChoiceOption[], disabled = false): unknown[] {
	const buttons = options.map(o => ({ type: 2, style: SECONDARY, label: o.label.slice(0, LABEL_MAX), custom_id: `${ASK_PREFIX}:${target}:${o.n}`, disabled }));
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
	const draft = !!parseDraftApproval(text)?.ref;
	const rows = part.options.length === options.length && sameQuestion ? askComponents(target, options) : [];
	// A reply draft's card also opens the web app's 답장 대기, where the same card can be edited by hand (the reply design, mockup 4).
	const open = rows.length && rows.length < ROW && draft ? webLink("/#monitoring/replies") : undefined;
	return open ? [...rows, { type: 1, components: [{ type: 2, style: LINK, label: "웹앱에서 열기", url: open }] }] : rows;
}

/** A button's or form's id; `hash`: the draft version a reply draft's 고치기 form was opened on (its submit is refused for any other). */
export function parseAskId(customId: string): { target: string; n: number; hash?: string } | undefined {
	const m = new RegExp(`^${ASK_PREFIX}:(.+):(\\d{1,2})(?::([0-9a-f]{16}))?$`).exec(customId);
	return m ? { target: m[1]!, n: Number(m[2]), ...(m[3] ? { hash: m[3] } : {}) } : undefined;
}

/** A field of a submitted form, as typed; undefined when the form had no such field. */
const fieldOf = (d: Interaction, id: string): string | undefined => {
	for (const row of d.data?.components ?? []) for (const c of row.components ?? []) if (c.custom_id === id && typeof c.value === "string") return c.value;
	return undefined;
};
const noteOf = (d: Interaction): string => (fieldOf(d, NOTE_FIELD) ?? "").replace(/\s+/g, " ").trim().slice(0, 500);

/** `edit`: the owner's own text from a draft's 고치기 form, when he changed it (saved as written before his words, if any, revise it).
 * Resolves to why the pick was refused, if it was (a draft that changed, a send already waiting). */
type Answer = (target: string, text: string, picks: Pick[], edit?: string) => void | Promise<string | undefined>;
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
const TEXT_FIELD = "text";
// Discord's limit for a text input's value: a longer draft is changed by words only (its form has no text field).
const TEXT_MAX = 4000;
// An option that needs detail (choices.ts detailOf) opens this modal instead of answering; its submit comes back with the same custom_id.
function noteModal(target: string, o: ChoiceOption) {
	return {
		custom_id: `${ASK_PREFIX}:${target}:${o.n}`,
		title: `${o.n}) ${o.label}`.slice(0, 45),
		components: [{ type: 1, components: [{ type: 4, custom_id: NOTE_FIELD, label: msg().auth.noteLabel, style: 2, required: true, min_length: 1, max_length: 500 }] }],
	};
}
// A reply draft's 고치기 (the reply clarity design, amendment A): one form with the draft's text to change by hand and, under it, optional words for
// the AI. Its submit saves the text when he changed it, then revises with his words when he wrote any; neither does nothing. The form's id carries
// the draft's hash (ReplyItem draft.hash) as it was opened: a submit after the draft changed does nothing, so an untouched text never overwrites a newer one.
const DRAFT_CHANGED = "초안이 바뀌었어요. 카드를 다시 열고 고쳐 주세요";
const draftOf = async (content: string): Promise<{ text: string; hash?: string } | undefined> => {
	const ref = parseDraftApproval(content)?.ref ?? refOfQuestion(parseChoices(content).question ?? "");
	return ref ? (await useReplies()?.view(ref))?.draft : undefined;
};
function draftModal(target: string, o: ChoiceOption, draft: { text: string; hash?: string } | undefined) {
	const text = draft?.text;
	const body = text !== undefined && text.length <= TEXT_MAX ? [{ type: 1, components: [{ type: 4, custom_id: TEXT_FIELD, label: "초안", style: 2, required: true, min_length: 1, max_length: TEXT_MAX, value: text }] }] : [];
	return {
		custom_id: `${ASK_PREFIX}:${target}:${o.n}${draft?.hash ? `:${draft.hash}` : ""}`,
		title: `${o.n}) ${o.label}`.slice(0, 45),
		components: [...body, { type: 1, components: [{ type: 4, custom_id: NOTE_FIELD, label: "AI에게 부탁할 내용 (선택)", style: 2, required: false, max_length: 500 }] }],
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
	const content = String(d.message?.content ?? "");
	const { question, options } = parseChoices(content);
	const draft = !!parseDraftApproval(content)?.ref;
	const picked = options.find(o => o.n === parsed.n);
	if (!picked) return deps.reply(d, 4, ephemeral(m.finished));
	let text = `${picked.n}) ${picked.label}`;
	let note = "";
	let edit: string | undefined;
	if (draft && picked.label === DRAFT_EDIT) {
		if (d.type === 3) return deps.reply(d, 9, draftModal(parsed.target, picked, await draftOf(content)));   // nothing changes until the form is submitted
		const now = await draftOf(content);
		if (now && parsed.hash !== now.hash) return deps.reply(d, 4, ephemeral(DRAFT_CHANGED));
		note = noteOf(d);
		const typed = fieldOf(d, TEXT_FIELD);
		if (typed !== undefined && now !== undefined && typed.replace(/\r\n?/g, "\n").trim() !== now.text.trim()) edit = typed;
		if (!note && edit === undefined) return deps.reply(d, 4, ephemeral(m.noteMissing));
		if (note) text += ` - ${note}`;
	} else if (picked.detail) {
		if (d.type === 3) return deps.reply(d, 9, noteModal(parsed.target, picked));   // nothing is sent until the modal is submitted
		note = noteOf(d);
		if (!note) return deps.reply(d, 4, ephemeral(m.noteMissing));
		text += ` - ${note}`;
	} else if (d.type === 5) return deps.reply(d, 4, ephemeral(m.finished));
	let refusal: string | undefined;
	try {
		// A stronger-model card is acted on before the answer reaches the asker, as on the web (hub/routes.ts deliverAnswer).
		await escalations()?.answer({ to: parsed.target, label: picked.label }).catch(e => log(`stronger-model answer failed: ${(e as Error).message}`));
		refusal = (await (deps.answer ?? answer)(parsed.target, text, question ? [{ q: question, n: picked.n, label: picked.label, ...(note ? { note } : {}) }] : [], edit)) ?? undefined;
	} catch (e) {
		log(`ask ${parsed.target} answer failed: ${e}`);
		return deps.reply(d, 4, ephemeral(m.answerFailed));
	}
	// A refused pick changes nothing: the owner hears why and the buttons stay (one response per interaction, so the message is left as is).
	if (refusal) return deps.reply(d, 4, ephemeral(refusal));
	return deps.reply(d, 7, { components: askComponents(parsed.target, options, true) });
}
