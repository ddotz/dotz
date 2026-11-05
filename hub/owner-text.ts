// The one rule of what reaches the owner's screen: a model's text passes ownerText before it is stored (events.ts emit) and before it leaves for
// Discord (discord.ts send, edit, progress), whoever wrote it, so a new path cannot skip it (hub/owner-text-paths.test.ts fails on one that tries). The other
// messengers read the stored event (messenger.ts), and a stored old message passes it on the way to the page (shownEvent), so the page only ever reads canonical
// blocks. The card comes from one grammar: the parser in hub/choices.ts, mirrored by web/js/10-decision-card.js and held to it by hub/owner-text.test.ts.
// No model call. This runs on every message: a text without "결정" or a question leaves at normalizeAsk's first regex.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAsk, normalizeHeaded } from "./ask-normalize.ts";
import { D_OPT, DECISION_HEAD } from "./choices.ts";
import { DATA_DIR, log } from "./config.ts";
import { canonicalDraft } from "./draft-approval.ts";

const FENCE = /^\s*```/;
const QUESTION = /[?？]|까요|나요|주세요/;

// Every "결정:" line that no card can come from: fewer than 2 options before the next head, outside fences.
export function brokenHeads(text: string): string[] {
	const broken: string[] = [];
	let fence = false, head: string | undefined, options = 0;
	const close = () => {
		if (head !== undefined && options < 2) broken.push(head);
	};
	for (const line of text.split("\n")) {
		if (FENCE.test(line)) fence = !fence;
		else if (fence) continue;
		else if (DECISION_HEAD.test(line)) {
			close();
			head = line.trim();
			options = 0;
		} else if (D_OPT.test(line)) options++;
	}
	close();
	return broken;
}

// A question that cannot be a card reads as a question; a statement keeps its words. Either way the owner reads it and can answer in the chat.
const plainHead = (text: string, heads: string[]): string =>
	text.split("\n").map(line => (heads.includes(line.trim()) && QUESTION.test(line) ? line.replace(DECISION_HEAD, "$1") : line)).join("\n");

/** What may reach the owner. onBroken gets each "결정:" line no card came from; only the store passes it, so one message counts once. `gateway`: text the gateway wrote, where only a "결정:" block is one. */
export function ownerText(text: string, onBroken?: (head: string) => void, gateway = false): string {
	if (!text.includes("결정") && !/decision|[?？]|까요|주세요/i.test(text)) return text;
	const out = canonicalDraft(gateway ? normalizeHeaded(text) : normalizeAsk(text));
	const heads = brokenHeads(out);
	if (!heads.length) return out;
	if (onBroken) for (const head of heads) onBroken(head);
	return plainHead(out, heads);
}

const SHAPED = new Set(["out", "lane_report", "result"]);
/** The event kinds whose text is drawn as a message of the assistant. Any new kind that holds model text belongs here (hub/owner-text-paths.test.ts). */
export const ownerKind = (kind: string): boolean => SHAPED.has(kind);

// A bug, not a style issue: the owner got text where he should have had buttons. One line per case in the gateway log and in ask-broken.jsonl, so it can be counted.
let broken = 0;
export const brokenCount = (): number => broken;
export function noteBroken(source: string, head: string): void {
	broken++;
	log(`BUG decision without a card from ${source}: ${head.slice(0, 120)}`);
	try {
		appendFileSync(join(DATA_DIR, "ask-broken.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), source, head })}\n`);
	} catch (e) {
		log(`ask-broken.jsonl not written: ${e}`);
	}
}

/** A stored event as the page reads it: a message from before the rule gets its card now. The store stays as it was; nothing is counted for old text. */
export function shownEvent<E extends { kind: string; source?: unknown; text?: unknown }>(e: E): E {
	if (!ownerKind(e.kind) || typeof e.text !== "string") return e;
	const text = ownerText(e.text, undefined, e.source === "gateway");
	return text === e.text ? e : { ...e, text };
}
