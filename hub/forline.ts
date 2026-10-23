import { parseDecisions } from "./choices.ts";
import { NAME } from "./config.ts";

// A report's "For <bot>:" / "<bot> 몫:" line is a chore for the orchestrator (empty, "없음", "-", or a real hand-off). The
// orchestrator reads the raw report; the owner's chat view and Discord never show the line (2026-10-23, "땃쥐 몫: 없음").
const NAME_RE = NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FOR_LINE = new RegExp(`^\\s*(?:-\\s+)?(?:For ${NAME_RE}:|${NAME_RE} 몫:)`, "i");
const FENCE = /^\s*```/;

export function dropForLine(text: string): string {
	let fence = false;
	const kept: string[] = [];
	let dropped = false;
	for (const line of text.split("\n")) {
		if (FENCE.test(line)) fence = !fence;
		else if (!fence && FOR_LINE.test(line)) {
			dropped = true;
			continue;
		}
		kept.push(line);
	}
	if (!dropped) return text;
	const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
	return out || text;
}

// A session's [ask] whose only request is its "For <bot>:" line (a real hand-off, no choice block, no question mark elsewhere, not a
// budget question) is a question for the orchestrator, not the owner: it makes no decision, badge or push (2026-10-23).
const NO_REQUEST = /^[\s\-–—.]*(?:없음|none|n\/a)?[\s.]*$/i;
export function orchestratorOnlyAsk(text: string): boolean {
	if (/\/budget-ok/.test(text) || parseDecisions(text).blocks.length) return false;
	const line = text.split("\n").find(l => FOR_LINE.test(l));
	if (!line || NO_REQUEST.test(line.replace(FOR_LINE, ""))) return false;
	return !/[?？]/.test(text.split("\n").filter(l => l !== line).join("\n"));
}
