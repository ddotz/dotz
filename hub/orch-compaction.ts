import { log, now } from "./config.ts";
import { type CompactPort, type Ctx, flushCompact, requestCompact } from "./context.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter } from "./runtime/types.ts";

export const COMPACT_DEADLINE_MS = 25 * 60_000;
export const COMPACT_ABORT_GRACE_MS = 60_000;

export type CompactionHost = {
	who: string;
	orch: { status: string; ctx: Ctx };
	proc: () => AgentProcess | undefined;
	adapter: () => RuntimeAdapter | undefined;
	compactAt: () => number;
	instructions: () => string;
	rotate: () => void;
	rotateWhenFree: () => void;
	restart: (why: string) => void;
	compacted: () => void;
};

type Stage = "running" | "asked" | "gaveUp";

/** The compaction policy of one orchestrator session: how a compaction is asked for, how its end is read, and what happens to one that never ends. */
export function createCompaction(h: CompactionHost) {
	let retried = false;
	let checkCompacted = false;
	let stage: Stage = "running";
	let startedAt = 0;
	let askedAt = 0;
	const ctx = (): Ctx => h.orch.ctx;
	const active = (): boolean => ctx().compaction.state === "queued" || ctx().compaction.state === "compacting";
	const port: CompactPort = {
		idle: () => h.orch.status === "idle",
		compact: () => {
			stage = "running";
			startedAt = Date.now();
			h.proc()?.compact(h.instructions());
		},
		refreshUsage: () => h.proc()?.refreshUsage(),
		abort: () => h.proc()?.abortCompaction?.(),
	};
	const mustCompact = (): boolean => h.adapter()?.caps.contextLimit === "compact" && ctx().tokens > h.compactAt();

	return {
		port,
		active,
		reset: (): void => void (retried = false),
		limit(rotateInstead: boolean): void {
			if (!rotateInstead && h.adapter()?.caps.contextLimit === "compact") {
				log(`${h.who} context ${ctx().tokens} tokens > ${h.compactAt()}; compacting in place`);
				requestCompact(ctx(), port);
			} else h.rotate();
		},
		onUsage(tokens: number | undefined): void {
			if (!checkCompacted || tokens === undefined || tokens >= (ctx().compaction.tokensBefore ?? Infinity)) return;
			checkCompacted = false;
			log(`${h.who} compaction left ${tokens} tokens (compaction point ${h.compactAt()})`);
			if (tokens * 2 > h.compactAt()) h.rotateWhenFree();
		},
		onEnd(ev: Extract<AgentEvent, { type: "compaction" }>): void {
			if (ev.state === "done") {
				retried = false;
				checkCompacted = true;
				h.compacted();
			} else if (mustCompact() && /retry compaction/i.test(ev.error) && !retried) {
				retried = true;
				log(`${h.who} compaction raced a session write (${ev.error.slice(0, 120)}); retrying at the next idle point`);
				ctx().compaction = { state: "queued", at: now() };
				if (h.orch.status === "idle") flushCompact(ctx(), port);
			} else if (mustCompact()) {
				log(`${h.who} compaction failed (${ev.error.slice(0, 160)}); moving to a fresh session with a handover`);
				h.rotateWhenFree();
			}
		},
		tick(): void {
			const p = h.proc();
			if (!p || ctx().compaction.state !== "compacting" || stage === "gaveUp") return;
			const ran = Date.now() - startedAt;
			if (ran < COMPACT_DEADLINE_MS) return;
			const minutes = Math.round(ran / 60_000);
			if (stage === "running" && p.abortCompaction) {
				stage = "asked";
				askedAt = Date.now();
				log(`${h.who} compaction has run ${minutes} min; asking the runtime to cancel it`);
				return p.abortCompaction();
			}
			if (stage === "asked" && Date.now() - askedAt < COMPACT_ABORT_GRACE_MS) return;
			stage = "gaveUp";
			log(`${h.who} compaction has run ${minutes} min with no answer; starting over in a new process`);
			if (ctx().tokens > h.compactAt()) h.rotate();
			else h.restart(`compaction did not end in ${minutes} min`);
		},
	};
}
