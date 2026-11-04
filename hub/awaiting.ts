// Owner messages waiting for an answer, per conversation: `ref` is the message, `by` the request (reply_to) of the prompt that
// carries it (a burst of messages is one prompt, answered by the last one's id).
export type Waiting = { ref: string; by?: string };

/**
 * What an answer to `replyTo` settles. A conversation that has no per-message answers (`all`: the web) or an answer that names
 * no request settles everything waiting there. Otherwise only the request it answers settles, with the other messages of its
 * burst: an answer to one request must not mark an older, still unanswered one as answered (2026-10-23, cbfba25d).
 * `still`: requests with a turn or a worker's result of their own still to come stay waiting even then, unless this answer names them
 * (2026-11-04 web 23e38963: the answer to another request closed it, so its worker's result had no request left to go to).
 */
export function settleWaiting(open: Waiting[], replyTo: string | undefined, all: boolean, still: string[] = []): { done: Waiting[]; keep: Waiting[] } {
	if (all || !replyTo) {
		const held = new Set(still);
		if (replyTo) held.delete(replyTo);
		const stays = (w: Waiting) => held.has(w.ref) || (w.by !== undefined && held.has(w.by));
		return { done: open.filter(w => !stays(w)), keep: open.filter(stays) };
	}
	const groups = new Set(open.filter(w => w.ref === replyTo || w.by === replyTo).map(w => w.by ?? w.ref));
	const hit = (w: Waiting) => groups.has(w.by ?? w.ref);
	return { done: open.filter(hit), keep: open.filter(w => !hit(w)) };
}
