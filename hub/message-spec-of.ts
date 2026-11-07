// What a surface calls at its send boundary: the page has its own bot name, so this one line stays out of the code it shares (hub/message-spec-derive.ts).
// A numbered list right under a question is a choice to hub/choices.ts, and its buttons need that text as written (hub/askbuttons.ts): such a message has no Choice element, so it stays text.
import { parseChoices } from "./choices.ts";
import { NAME } from "./config.ts";
import { type MessageSpec, specChildren } from "./message-spec.ts";
import { deriveSpec, resolveSpecFence } from "./message-spec-derive.ts";

export function specOf(text: string): MessageSpec | null {
	const shown = resolveSpecFence(text), spec = deriveSpec(shown, NAME);
	return spec && parseChoices(shown).options.length && !specChildren(spec).some(e => e.type === "Choice") ? null : spec;
}
