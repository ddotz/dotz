// The instruction the gateway gives the engine when it compacts the orchestrator's session (RPC compact.customInstructions).
// Without it OmO's update prompt keeps the previous summary byte for byte and appends the new messages, so the summary only
// grows: measured 2026-11-11 on the main session, 17 compactions took it from 14.5K to 116K characters and a compaction from
// 1m46s to 9m09s, while the work in it was mostly finished. This one caps it and says what stays, what shrinks to a line
// and where the finished work is already recorded.

// Hard size target of the whole summary, in characters: about 3.5K tokens. The owner's open requests are not in it: the gateway keeps
// them (hub/open-ledger.ts) and re-sends them after every compaction and in a new session's first prompt.
export const SUMMARY_MAX_CHARS = 10_000;
// Where finished work is already kept (the data folder), so the summary points there instead of copying it.
export const ARCHIVE_FILES = ["state.json", "inbox.jsonl", "outbox.jsonl", "tasks-closed.jsonl"] as const;

export function compactInstructions(): string {
	return [
		`SIZE: the whole <summary> is at most ${SUMMARY_MAX_CHARS} characters, whatever size the previous summary has. These instructions override rule R3 and every "preserve byte-for-byte", "never rewrite" and "append" line above: rewrite the previous summary shorter, do not append to it.`,
		"DO NOT list or quote owner messages, open or answered: the gateway keeps the open requests and re-sends them after this summary. KEEP only the live goal chain and its order, the agreements and \"do not act until\" gates, the in-flight code state (worktree, branch, commits, failing checks), the exact next steps with their commands, and file pointers (paths, session ids).",
		"EXCEPT an owner instruction that still binds future work and is not an open request (a standing rule given in passing): one line each, its message id and the owner's words.",
		`DROP finished work: nothing, or one pointer line to the file that already holds it (${ARCHIVE_FILES.join(", ")} in the data folder).`,
		"DO NOT repeat the contract, owner rules, lessons or features: the gateway re-sends them after every compaction.",
		"DEAD ENDS: one line per attempt that already failed, with why, so it is not tried again.",
		"Mark each fact checked or assumed; write \"unverified\" for anything not checked, never invent an observation.",
		"Truncated or large output: keep the narrow command or file path that fetches it again, not its content.",
		"DONE WHEN: list the completion conditions of the current work.",
		"Over the limit, cut in this order: finished work, content of large results, old dead ends; keep to the end the next steps, code state, done-when list and binding owner instructions.",
	].join("\n\n");
}
