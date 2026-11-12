// A deep owner message ("ultrathink", hub/ultrathink.ts) is marked with one line where the session takes the prompt, so a held, replayed
// or queued prompt keeps it. The agent raises the level itself at the start of the turn that carries the line (extension/effort-bound.ts,
// OmO's before_agent_start), so a prompt that waits behind another turn cannot raise the wrong one. Where a raise is not safe the line is a plain hint.
import { keepsCacheOnEffort } from "./mid-effort.ts";

/** Starts with the text extension/effort-bound.ts matches (the extension keeps it as text: it stays off hub imports). */
export const DEEP_RAISE = "[dotz deep turn] The owner asked for deeper reasoning on this turn.";
export const DEEP_HINT = "The owner asked for deeper reasoning on this turn.";

export type DeepSession = {
	/** For the log line, for example "orchestrator" or "lane name". */
	name: string;
	runtime: string;
	/** The model the session is configured to run, not the one it runs now. */
	model: string;
	/** The session runs on a fallback entry: an effort change there would be undone or mean another model. */
	onFallback: boolean;
};

/** `text` with the line appended: the raise line on OmO's configured, cache-keeping model, otherwise the plain hint. One hub.log line says which. */
export function markDeep(text: string, s: DeepSession, log: (line: string) => void): string {
	const why = s.runtime !== "omo" ? `runtime ${s.runtime}` : s.onFallback ? "running on a fallback entry" : !keepsCacheOnEffort(s.runtime, s.model) ? `${s.model} loses the prompt cache on an effort change` : "";
	log(`ultrathink: ${s.name} prompt marked with the ${why ? `hint line (${why})` : "raise line"}`);
	return `${text}\n\n${why ? DEEP_HINT : DEEP_RAISE}`;
}
