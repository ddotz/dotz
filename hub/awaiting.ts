// Owner messages waiting for an answer, per conversation: `ref` is the message, `by` the request (reply_to) of the prompt that
// carries it (a burst of messages is one prompt, answered by the last one's id).
export type Waiting = { ref: string; by?: string };

/**
 * What an answer to `replyTo` settles. A conversation that has no per-message answers (`all`: the web) or an answer that names
 * no request settles everything waiting there. Otherwise only the request it answers settles, with the other messages of its
 * burst: an answer to one request must not mark an older, still unanswered one as answered (2026-10-23, cbfba25d).
 */
export function settleWaiting(open: Waiting[], replyTo: string | undefined, all: boolean): { done: Waiting[]; keep: Waiting[] } {
	if (all || !replyTo) return { done: open, keep: [] };
	const groups = new Set(open.filter(w => w.ref === replyTo || w.by === replyTo).map(w => w.by ?? w.ref));
	const hit = (w: Waiting) => groups.has(w.by ?? w.ref);
	return { done: open.filter(hit), keep: open.filter(w => !hit(w)) };
}
