// `dotz last` (hub/dotz-last-cli.ts): the newest answer of the main conversation as terminal text, read from /api/history.
import type { HubEvent } from "./events.ts";
import type { MessageSpec } from "./message-spec.ts";
import { specOf } from "./message-spec-of.ts";
import { clean, renderTerminal } from "./spec-terminal.ts";
import { parseTone, TONE_EMOJI } from "./tone.ts";

export const lastAnswer = (events: HubEvent[]): string | undefined =>
	events.findLast(e => e.kind === "out" && e.source === "orchestrator" && !e.system && !e.update_key && typeof e.text === "string" && e.text.trim())?.text;

/** The answer with its tone emoji leading (never the [done] marker); a spec draws as ANSI, any other text stays as it is. */
export function answerForTerminal(text: string, color: boolean, spec: (body: string) => MessageSpec | null = specOf): string {
	const { tone, text: body } = parseTone(text);
	const shaped = spec(body.trim());
	return `${tone ? `${TONE_EMOJI[tone]} ` : ""}${shaped ? renderTerminal(shaped, { color }) : clean(body.trim())}`;
}
