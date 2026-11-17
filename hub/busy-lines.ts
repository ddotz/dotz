/** What one orchestrator or conversation session says it is busy with: its turn, then its background work, counted from every feed that sees it. */
export type SessionBusy = {
	/** The turn's own line (empty when no turn or compaction runs). */
	turn: string;
	/** Workers OmO's task store lists as running. */
	bgRunning: number;
	/** The omp subagents the session's frames list. */
	subagents: readonly { status: string }[];
	/** What the session's process says is live: the larger of its running subagents and one for `awaitingAsync` (hub/worker-hold.ts). */
	live: number;
	/** A request the session just deferred to a worker the store does not show yet. */
	deferred: boolean;
};

/**
 * The busy lines of one session: its turn, and its background work counted as the largest of the store's count and the process's own.
 * Work no worker explains (a shell job, a service, a monitor that only `awaitingAsync` reports) reads as jobs, not workers.
 */
export function sessionBusyLines(label: string, s: SessionBusy): string[] {
	const count = Math.max(s.bgRunning, s.live);
	const noun = s.bgRunning > 0 || s.subagents.some(a => a.status === "running") ? "workers" : "jobs";
	return [s.turn, count ? `${label} background ${noun} (${count})` : s.deferred ? `${label} background workers` : ""];
}

/** The busy line of a lane: its turn or shell, and the OmO workers its task store lists. */
export function laneBusyLines(name: string, busy: boolean, workers: number): string[] {
	if (busy) return [`lane ${name}${workers ? ` (${workers} background workers)` : ""}`];
	return workers ? [`lane ${name} background workers (${workers})`] : [];
}
