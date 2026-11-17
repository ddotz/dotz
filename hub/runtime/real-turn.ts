import { isNote } from "../i18n.ts";
import { stripSteerMark } from "../steer-mark.ts";
import { isLater, isSilent } from "../tone.ts";

export type SessionMessage = { role?: string; stopReason?: string; content?: string | Array<{ type?: string; text?: string; name?: string; arguments?: { path?: unknown } }> };

/**
 * The text of a real exchange in a saved omp or OmO session (what a handover and the summary-staleness check count), undefined
 * for what is not one: a reply that did not end its turn, an empty message, a keepalive ping, "ok", a `[later]` or silent
 * answer, a note, a lane message.
 */
export function realTurn(m: SessionMessage): string | undefined {
	if (m.role === "assistant" && m.stopReason !== "stop" && m.stopReason !== "length") return undefined;
	const t = stripSteerMark(Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join("") : (m.content ?? "")).trim();
	if (!t || t.startsWith("[keepalive]") || t === "ok" || (m.role === "assistant" && (isLater(t) || isSilent(t))) || isNote(t, "youAre") || t.includes("\n[dotz lane ")) return undefined;
	return t;
}
