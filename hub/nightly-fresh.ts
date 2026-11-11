// The nightly fresh start of a session (hygiene.ts asks at lanes.nightly_at): the main session starts a new conversation with a handover
// every night (orchestrator.nightly_fresh, on unless false), any session when its file is past lanes.rotate_mb. It starts only when the
// session is at rest (hub/context.ts restBlockers, the test the compaction ahead of time uses); when it is not, it asks again every minute
// until NIGHTLY_RETRY_MS have passed, then gives the night up with one log line. When the session's last compaction summary is stale (a real
// exchange came after it), the start compacts first, through the compaction ahead of time (an owner message aborts it), and rotates once it has ended,
// so the handover carries a fresh summary. A compaction does not touch lastTurnEnd, so the quiet time of the session goes on counting while it runs
// and the rotation follows on the first minute tick after it ends.
import { log } from "./config.ts";
import type { Ctx, RestFacts } from "./context.ts";
import { restBlockers } from "./context.ts";
import { trackTimer } from "./shutdown.ts";

// Owner messages in the 19 days of session files (2026-10-19 .. 11-11): none between 04:30 and 07:42 (first morning one on 10-22, 07:49 on 10-23, the
// others after 09:30); the night's own work ends by about 05:35 (the 04:18..05:18 gateway restarts, one compaction at 05:32 on 11-05). Two hours from
// 04:30 end at 06:30: it waits out that work and still ends an hour before the earliest morning message seen, so a late start never lands on the owner.
export const NIGHTLY_RETRY_MS = 2 * 3_600_000;
export const NIGHTLY_TICK_MS = 60_000;
/** Compactions one night may start (an owner message aborts one; the second abort, or a night stale again after the second, gives the night up). */
export const NIGHTLY_COMPACT_STARTS = 2;

export type NightlyStart = { tokens: number; before: number; after: number; chars: number; why: string; compacted?: number };

export type NightlyDeps = {
	who: string;
	/** Starts fresh every night whatever the file size (the main session with orchestrator.nightly_fresh on). */
	every: () => boolean;
	/** Size of the session file; undefined when there is no live session to start over. */
	bytes: () => number | undefined;
	facts: () => RestFacts;
	/** Whether the session's last compaction summary is out of date (read from the session file); absent: never stale. */
	stale?: () => boolean;
	/** Starts a compaction ahead of time (hub/context.ts requestAhead); false when none could be started. */
	compact?: () => boolean;
	ctx: () => Ctx;
	rotate: () => void;
	/** Open owner requests in the gateway's ledger right now. */
	open: () => number;
	log?: (line: string) => void;
};

export function createNightly(d: NightlyDeps) {
	const say = d.log ?? log;
	let want: { since: number; why: string; blocked: string; starts: number; t0?: number; seconds?: number } | undefined;
	let fired: { tokens: number; before: number; why: string; compacted?: number } | undefined;
	let timer: Timer | undefined;
	let last: NightlyStart | undefined;

	const stopTimer = (): void => void (clearInterval(timer), (timer = undefined));
	function giveUp(reason: string): undefined {
		want = undefined;
		stopTimer();
		say(`nightly hygiene: ${d.who} fresh start skipped tonight, ${reason}`);
		return undefined;
	}
	function attempt(): string | undefined {
		const w = want;
		if (!w) return undefined;
		const c = d.ctx().compaction;
		if (w.t0 !== undefined && c.state !== "queued" && c.state !== "compacting") {
			// The compaction this start asked for has ended: done (rotate below), failed, or aborted by an owner message (the owner's turn runs first).
			w.seconds = Math.round((Date.now() - w.t0) / 1000);
			w.t0 = undefined;
			if (c.state === "error") return giveUp(`its compaction failed (${c.error ?? "unknown error"})`);
			if (c.state !== "done" && w.starts >= NIGHTLY_COMPACT_STARTS) return giveUp(`its compaction was aborted by an owner message ${w.starts} times`);
			if (c.state !== "done") w.seconds = undefined;
		}
		const facts = d.facts();
		const blockers = restBlockers(facts, d.ctx());
		if (blockers.length) {
			w.blocked = blockers.join("; ");
			return undefined;
		}
		if (facts.canAbort && d.compact && d.stale?.()) {
			if (w.starts >= NIGHTLY_COMPACT_STARTS) return giveUp(`the summary was stale again after ${w.starts} compactions`);
			w.starts++;
			if (d.compact()) {
				w.t0 = Date.now();
				return undefined;
			}
		}
		want = undefined;
		stopTimer();
		fired = { tokens: d.ctx().tokens, before: d.open(), why: w.why, compacted: w.seconds };
		d.rotate();
		return `${d.who} ${w.why}: rotated to a fresh session with a handover`;
	}

	/** hygiene.ts at the nightly time: what it did right now, or undefined (nothing to do, or waiting for rest). */
	function ask(limitBytes: number): string | undefined {
		const bytes = d.bytes();
		if (bytes === undefined) return undefined;
		const big = bytes > limitBytes;
		if (!big && !d.every()) return undefined;
		want = { starts: 0, since: Date.now(), why: big ? `session file ${+(bytes / 1e6).toFixed(2)} MB > ${+(limitBytes / 1e6).toFixed(0)} MB` : "nightly fresh start", blocked: "" };
		const done = attempt();
		if (!done && !timer) {
			timer = setInterval(tick, NIGHTLY_TICK_MS);
			timer.unref();
			trackTimer(`nightly fresh ${d.who}`, timer);
		}
		return done;
	}

	/** Each minute while a start is waiting for rest. */
	function tick(): void {
		const w = want;
		if (!w) return stopTimer();
		if (Date.now() - w.since > NIGHTLY_RETRY_MS) {
			return void giveUp(`not at rest for ${Math.round(NIGHTLY_RETRY_MS / 3_600_000)} h (${w.blocked})`);
		}
		const done = attempt();
		if (done) say(`nightly hygiene: ${done}`);
	}

	/** start() of the new session, after its first prompts went out: the one log line of a nightly start. */
	function started(chars: number): NightlyStart | undefined {
		const f = fired;
		fired = undefined;
		want = undefined;
		stopTimer();
		if (!f) return undefined;
		last = { tokens: f.tokens, before: f.before, after: d.open(), chars, why: f.why, compacted: f.compacted };
		say(`${d.who} nightly start (${f.why}): ${last.tokens} tokens before, ${last.after} of ${last.before} open request(s) carried${last.after === last.before ? ", ledger entries equal" : ", ledger entries DIFFER"}, handover ${chars} characters, ${f.compacted === undefined ? "no compaction first" : `compaction first ${f.compacted} s`}`);
		return last;
	}

	return { ask, tick, started, waiting: () => want !== undefined, lastStart: () => last };
}
