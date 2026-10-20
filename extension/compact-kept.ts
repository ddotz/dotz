// The thinking of turns a compaction keeps verbatim. OmO keeps the last ~20K estimated tokens of a session as they were;
// on the subscription lane every request after a compaction re-sends them as flattened history, thinking included as
// plain text (senpi prompt-bridge contentToText). Those turns are finished and covered by the summary, and the
// Anthropic API itself leaves earlier turns' thinking out on most models, so their thinking blocks are dropped from
// the request (measured 2026-10-20 on a copy of the orchestrator session: 28 blocks, 11K chars in the kept turns).
// What the model did and saw stays: text, tool calls and tool results are untouched, and so is the thinking of the turn
// still running (assistant messages after the last user message, which a mid-turn compaction can keep). The result is
// the same on every request, so the prompt cache holds. Images are not handled here: the subscription replay already
// replaces images from answered tool calls with a note (senpi cold-seed-images).

type Block = { type?: string; [k: string]: unknown };
type Msg = { role?: string; timestamp?: unknown; content?: unknown; [k: string]: unknown };

const THINKING = new Set(["thinking", "redacted_thinking"]);
const isUserTurn = (m: Msg) => m?.role === "user" || m?.role === "custom";
// The context event already carries the summary as the user message senpi sends (messages.ts COMPACTION_SUMMARY_PREFIX).
export const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";
const isSummary = (m: Msg) =>
	m?.role === "compactionSummary" ||
	(m?.role === "user" && Array.isArray(m.content) && (m.content as Block[])[0]?.type === "text" && String((m.content as Block[])[0].text).startsWith(SUMMARY_PREFIX));

// The messages with the kept finished turns' thinking left out, or undefined when nothing changes.
export function dropKeptThinking(messages: Msg[]): Msg[] | undefined {
	const at = messages.findLastIndex(isSummary);
	const cutoff = at >= 0 ? messages[at].timestamp : undefined;
	if (typeof cutoff !== "number") return undefined;
	const lastUser = messages.findLastIndex(isUserTurn);
	let changed = false;
	const out = messages.map((m, i) => {
		if (i <= at || i >= lastUser || m?.role !== "assistant" || typeof m.timestamp !== "number" || m.timestamp >= cutoff || !Array.isArray(m.content)) return m;
		const blocks = m.content as Block[];
		const kept = blocks.filter(b => !THINKING.has(String(b?.type)));
		if (kept.length === blocks.length || kept.length === 0) return m;
		changed = true;
		return { ...m, content: kept };
	});
	return changed ? out : undefined;
}

export function installCompactKept(pi: { on: (name: string, fn: (event: any) => any, options?: { mutatesMessages?: boolean }) => void }): void {
	pi.on(
		"context",
		(event: any) => {
			const messages = Array.isArray(event?.messages) ? dropKeptThinking(event.messages) : undefined;
			return messages ? { messages } : undefined;
		},
		{ mutatesMessages: false },
	);
}
