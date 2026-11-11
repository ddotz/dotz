// Owner-facing posts that have not reached the outbox or the send ledger yet (the output-language rewrite runs first and
// may take its whole timeout). The restart gate counts them as busy, and shutdown lands the ones still unfinished at its
// deadline, so a reply is never dropped by a restart (2026-10-21: a 2124-char answer vanished 1.5 s before a restart).
export function createInflight<J>(land: (job: J) => void) {
	const jobs = new Set<J>();
	const waiters: (() => void)[] = [];
	const wake = () => {
		if (!jobs.size) for (const f of waiters.splice(0)) f();
	};

	/** The post starts (before the rewrite). */
	const begin = (job: J) => void jobs.add(job);

	/** The post reached the outbox/ledger itself. False when `flush` already landed it, so the caller must not land it twice. */
	function end(job: J): boolean {
		const mine = jobs.delete(job);
		wake();
		return mine;
	}

	/** Waits up to `waitMs` for the posts to finish, then lands the rest as they are (the original text). Returns how many were landed. */
	async function flush(waitMs: number): Promise<number> {
		if (jobs.size) {
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, waitMs);
				waiters.push(() => (clearTimeout(timer), resolve()));
			});
		}
		const rest = [...jobs];
		jobs.clear();
		for (const job of rest) land(job);
		wake();
		return rest.length;
	}

	return { begin, end, flush, size: () => jobs.size };
}
