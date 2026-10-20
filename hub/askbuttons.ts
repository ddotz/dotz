// Decision buttons on an [ask] message (docs/layers.md section 3): one button per option of the message's choice block.
// A click is the owner typing `<n>) <name>` in that channel: the answer goes through the same inbound path (main.ts).
import { log } from "./config.ts";
import { type ChoiceOption, parseChoices } from "./choices.ts";
import type { Interaction } from "./discord.ts";
import { msg } from "./i18n.ts";
import { parseTone } from "./tone.ts";

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

/** Buttons for a message about to be posted: only an [ask] with a choice block gets any, and only on the part (`shown`) that still holds every option, since a click reads its labels from that message. */
export function askComponentsFor(target: string, text: string, shown = text): unknown[] {
	if (parseTone(text).tone !== "ask") return [];
	const options = parseChoices(text).options;
	return parseChoices(shown).options.length === options.length ? askComponents(target, options) : [];
}

export function parseAskId(customId: string): { target: string; n: number } | undefined {
	const m = new RegExp(`^${ASK_PREFIX}:(.+):(\\d{1,2})$`).exec(customId);
	return m ? { target: m[1]!, n: Number(m[2]) } : undefined;
}

type Answer = (target: string, text: string) => void;
let answer: Answer = () => {
	throw new Error("no answer handler");
};
export function setAskAnswer(fn: Answer): void {
	answer = fn;
}

export type AskDeps = {
	owner: string;
	reply: (d: Interaction, type: number, data?: unknown) => Promise<void>;
	answer?: Answer;
};

const ephemeral = (content: string) => ({ content, flags: 64, allowed_mentions: { parse: [] } });

/** Handles one click on an ask button: the owner only; acknowledges by updating the message with every button disabled. */
export async function askInteraction(d: Interaction, deps: AskDeps): Promise<void> {
	const m = msg().auth;
	const parsed = parseAskId(String(d.data?.custom_id ?? ""));
	if (!parsed || d.type !== 3) return deps.reply(d, 4, ephemeral(m.finished));
	const user = String(d.member?.user?.id ?? d.user?.id ?? "");
	if (!deps.owner || user !== deps.owner) {
		log(`ask ${parsed.target} refused user ${user}`);
		return deps.reply(d, 4, ephemeral(m.notOwner));
	}
	const options = parseChoices(String(d.message?.content ?? "")).options;
	const picked = options.find(o => o.n === parsed.n);
	if (!picked) return deps.reply(d, 4, ephemeral(m.finished));
	try {
		(deps.answer ?? answer)(parsed.target, `${picked.n}) ${picked.label}`);
	} catch (e) {
		log(`ask ${parsed.target} answer failed: ${e}`);
		return deps.reply(d, 4, ephemeral(m.answerFailed));
	}
	return deps.reply(d, 7, { components: askComponents(parsed.target, options, true) });
}
