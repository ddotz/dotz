// For the update gate runner (hub/update-gate-run.ts), kept apart so a test can import it without running the gate.

// The limits of one inner run of the gate, driven with a clock of its own by the test.
// The run waits for the heavy test slot (hub/runtime/test-slot.ts) behind other sessions' runs, and a holder may keep it 20 minutes, so
// the run's limit counts from the moment it holds the slot, not from the spawn: waiting must never fail the gate. Waiting has a finite
// bound of its own, so the gate cannot hang for good. Real time (performance.now, Bun.sleep): the gate itself runs under the test preload's fake clock.
export type RunGuard = {
	/** Resolves when the child has exited (the guard then ends). */
	exited: Promise<unknown>;
	/** Does the child hold the slot now? */
	held: () => boolean;
	kill: () => void;
	/** How long the child may run once it holds the slot. */
	runMs: number;
	/** How long it may go without the slot, from spawn. */
	waitMs: number;
	pollMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<unknown>;
};

/** Kills the child at a limit and says which: "run" (held the slot for runMs), "wait" (never got it within waitMs); undefined when it exited first. */
export async function guardRun(g: RunGuard): Promise<"run" | "wait" | undefined> {
	const now = g.now ?? (() => performance.now());
	const sleep = g.sleep ?? ((ms: number) => Bun.sleep(ms));
	const start = now();
	let heldAt: number | undefined;
	for (;;) {
		if ((await Promise.race([sleep(g.pollMs ?? 1000).then(() => "tick"), g.exited.then(() => "exit")])) === "exit") return undefined;
		const t = now();
		heldAt ??= g.held() ? t : undefined;
		if (heldAt !== undefined ? t - heldAt >= g.runMs : t - start >= g.waitMs) {
			g.kill();
			return heldAt !== undefined ? "run" : "wait";
		}
	}
}


// The files whose tests failed or that errored while loading, from bun's output (a "path.test.ts:" header starts each file's block).
export function failedFiles(out: string): string[] {
	const bad = new Set<string>();
	let file = "";
	for (const line of out.split("\n")) {
		const h = /^([\w./-]+\.test\.ts):$/.exec(line.trim());
		if (h) file = h[1]!;
		else if (file && (/^\(fail\)/.test(line) || /^(\w*)?error:/i.test(line.trim()) || /^# Unhandled error/.test(line))) bad.add(file);
	}
	return [...bad];
}

