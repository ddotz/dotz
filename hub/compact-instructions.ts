// The instruction the gateway gives the engine when it compacts the orchestrator's session (RPC compact.customInstructions).
// Without it OmO's update prompt keeps the previous summary byte for byte and appends the new messages, so the summary only
// grows: measured 2026-11-11 on the main session, 17 compactions took it from 14.5K to 116K characters and a compaction from
// 1m46s to 9m09s, while the work in it was mostly finished. This one caps it and says what stays, what shrinks to a line
// and where the finished work is already recorded.

// Hard size target of the whole summary, in characters: about 8K tokens, a thirtieth of the compaction point.
export const SUMMARY_MAX_CHARS = 24_000;
// Where finished work is already kept (the data folder), so the summary points there instead of copying it.
export const ARCHIVE_FILES = ["state.json", "inbox.jsonl", "outbox.jsonl", "tasks-closed.jsonl"] as const;

export function compactInstructions(): string {
	return [
		`SIZE: the whole <summary> is at most ${SUMMARY_MAX_CHARS} characters, whatever size the previous summary has. These instructions override rule R3 and every "preserve byte-for-byte", "never rewrite" and "append" line above: rewrite the previous summary shorter, do not append to it.`,
		"KEEP in full, the owner's words verbatim: every request still open or unanswered, every owner instruction that still binds future work, every pending decision, and the open work with the identifiers (session ids, paths, branches) needed to continue it.",
		`DROP what is finished and answered: one line each (what, outcome, id or path) or only a pointer to the file that already holds it (${ARCHIVE_FILES.join(", ")} in the data folder). Do not quote an owner message whose request is answered.`,
		"DO NOT repeat the contract, owner rules, lessons or features: the gateway re-sends them after every compaction.",
	].join("\n\n");
}
