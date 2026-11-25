import { freshAnthropicLimits } from "./budget.ts";
import { debug } from "./debug.ts";
import type { HostApi, HostCtx } from "./host-types.ts";
import { fillsFableWindow } from "./spawn-rules.ts";
import { LONG_USAGE_WAIT_MS } from "./usage-wait.ts";

const IDLE_WAIT_MS = 5_000;
const IDLE_POLL_MS = 100;

/** Pause between two usage reads of a main session that waits on a usage limit (dotz `hub/limit-watch.ts` `LIMIT_WATCH_MS`). */
export const LIMIT_WATCH_MS = 300_000;

/** A long wait that starts this soon after a lift means the lift failed: it is left to omp's own timer (dotz `hub/limit-lift.ts` `TRY_WINDOW_MS`). */
export const TRY_WINDOW_MS = 120_000;

/** What a main session is told when the guard ended its usage-limit wait. */
export const LIMIT_OVER_NOTE =
	"[orchestrator-guard] The usage limit is over: the usage report shows no spent window for this session's model. Continue the task that the usage-limit wait interrupted, from where it stopped, and respawn every worker whose result was a usage-limit 429.";

/** A row of `omp usage --json` reports, reduced to what `limitOver` reads: `scope.tier` names the model tier a window belongs to (`fable`); `status` is `ok`, `warning`, `exhausted` or `unknown`. */
export interface UsageLimit {
	id?: string;
	scope?: { provider?: unknown; windowId?: unknown; tier?: unknown };
	amount?: { remaining?: unknown };
	status?: unknown;
}

const tierWords = (tier: string): string[] =>
	tier
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter(word => word.length >= 3 && word !== "claude");

const tierOf = (limit: UsageLimit): string | undefined => {
	if (typeof limit.scope?.tier === "string" && limit.scope.tier !== "") return limit.scope.tier;
	const tail = typeof limit.id === "string" ? limit.id.split(":").slice(2).join(":") : "";
	return tail === "" ? undefined : tail;
};

const appliesTo = (limit: UsageLimit, model: string): boolean => {
	const tier = tierOf(limit);
	if (tier === undefined) return true;
	const words = tierWords(tier);
	const id = model.toLowerCase();
	return words.length === 0 || id === "" || words.some(word => id.includes(word) || (word === "fable" && fillsFableWindow(id)));
};

const spent = (limit: UsageLimit): boolean => {
	const remaining = limit.amount?.remaining;
	if (typeof remaining === "number" && remaining <= 0) return true;
	return limit.status !== undefined && limit.status !== null && limit.status !== "ok";
};

/**
 * True when the usage report was readable and no window that applies to `model` is spent, i.e. the limit a session waits on is over (dotz `limitsUsable` with `scopeBlocksModels`).
 * A window is spent when `amount.remaining <= 0` or its `status` is anything but `ok`, so `warning` and `unknown` hold a lift back too.
 * A window with a tier (`scope.tier`, else the part of its id after `<provider>:<window>:`) applies only to a model whose id contains one of the tier's words of 3+ letters other than `claude`; the `fable` tier also applies to every model that fills the Fable window (`fillsFableWindow`).
 * An empty `model`, or a tier without such a word, makes it apply to every model. Undefined or empty `limits` (an unreadable report) is never over.
 */
export function limitOver(limits: readonly UsageLimit[] | undefined, model: string): boolean {
	if (limits === undefined || limits.length === 0) return false;
	if (limits.some(limit => typeof limit !== "object" || limit === null)) return false;
	return !limits.some(limit => appliesTo(limit, model) && spent(limit));
}

/** True for a main session (`kind === "main"`) whose retry sleep is longer than `LONG_USAGE_WAIT_MS`: the guard watches its usage instead of leaving it to omp's timer. */
export function limitWatched(kind: unknown, delayMs: unknown): boolean {
	return kind === "main" && typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > LONG_USAGE_WAIT_MS;
}

/** True while a lift at `liftedAt` (ms since the epoch; undefined for none) is younger than `TRY_WINDOW_MS` at `now`. */
export function recentlyLifted(liftedAt: number | undefined, now: number): boolean {
	return liftedAt !== undefined && now >= liftedAt && now - liftedAt < TRY_WINDOW_MS;
}

interface MessageLike {
	role?: unknown;
	stopReason?: unknown;
}

/** The `stopReason` of the last assistant message in `messages` (an `agent_end` event's list), or undefined when there is none. */
export function lastStopReason(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message: MessageLike | null | undefined = messages[index];
		if (message?.role === "assistant") return typeof message.stopReason === "string" ? message.stopReason : undefined;
	}
	return undefined;
}

interface LimitWatch {
	key: string;
	ctx: HostCtx;
	checking: boolean;
	stop: () => void;
}

/**
 * dotz's lift of a usage-limit pause (`hub/limit-watch.ts`, `hub/limit-lift.ts`) for omp main sessions: a usage wait past
 * `LONG_USAGE_WAIT_MS` arms a watch that reads the usage report every `LIMIT_WATCH_MS` and at once on the owner's input;
 * when `limitOver` holds for the session's model the guard aborts omp's wait and starts a turn with `LIMIT_OVER_NOTE`.
 * One lift per episode: a long wait within `TRY_WINDOW_MS` of a lift is left to omp's timer.
 */
export function registerLimitWatch(pi: HostApi): void {
	const watches = new Map<string, LimitWatch>();
	const liftedAt = new Map<string, number>();
	const keyOf = (ctx: HostCtx | undefined) => String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.agent?.id ?? "");
	const modelOf = (ctx: HostCtx) => (typeof ctx.model?.id === "string" ? ctx.model.id : "");

	const disarm = (key: string): void => {
		const watch = watches.get(key);
		if (!watch) return;
		watches.delete(key);
		watch.stop();
	};

	const idleWithin = async (ctx: HostCtx): Promise<boolean> => {
		for (let waited = 0; waited < IDLE_WAIT_MS; waited += IDLE_POLL_MS) {
			if (ctx.isIdle?.() !== false) return true;
			const pause = Promise.withResolvers<void>();
			setTimeout(pause.resolve, IDLE_POLL_MS).unref?.();
			await pause.promise;
		}
		return ctx.isIdle?.() !== false;
	};

	const check = async (watch: LimitWatch): Promise<void> => {
		if (watch.checking) return;
		watch.checking = true;
		try {
			const limits = await freshAnthropicLimits();
			if (watches.get(watch.key) !== watch) return;
			if (keyOf(watch.ctx) !== watch.key) return disarm(watch.key);
			const model = modelOf(watch.ctx);
			const over = limitOver(limits, model);
			debug({ phase: "limit-check", over, model, windows: limits?.length });
			if (!over) return;
			disarm(watch.key);
			liftedAt.set(watch.key, Date.now());
			await watch.ctx.abort?.();
			if (!(await idleWithin(watch.ctx))) return debug({ phase: "limit-lift-busy" });
			debug({ phase: "limit-lift", model });
			pi.sendMessage({ customType: "orchestrator-guard", content: LIMIT_OVER_NOTE, display: true }, { triggerTurn: true });
		} catch (error) {
			debug({ phase: "limit-watch-error", message: String(error) });
		} finally {
			watch.checking = false;
		}
	};

	const arm = (ctx: HostCtx, delayMs: unknown): void => {
		const key = keyOf(ctx);
		const known = watches.get(key);
		if (known) {
			known.ctx = ctx;
			return;
		}
		if (recentlyLifted(liftedAt.get(key), Date.now())) return debug({ phase: "limit-watch-skipped", delayMs });
		liftedAt.delete(key);
		const timer = setInterval(() => check(watch), LIMIT_WATCH_MS);
		timer.unref?.();
		const watch: LimitWatch = { key, ctx, checking: false, stop: () => clearInterval(timer) };
		watches.set(key, watch);
		debug({ phase: "limit-watch-armed", delayMs, model: modelOf(ctx) });
	};

	const guarded = (fn: () => void): void => {
		try {
			fn();
		} catch (error) {
			debug({ phase: "limit-watch-error", message: String(error) });
		}
	};
	const end = (ctx: HostCtx): void => guarded(() => ctx?.agent?.kind === "main" && disarm(keyOf(ctx)));

	pi.on("auto_retry_start", (event, ctx) => guarded(() => limitWatched(ctx?.agent?.kind, event?.delayMs) && arm(ctx, event.delayMs)));
	pi.on("auto_retry_end", (_event, ctx) => end(ctx));
	pi.on("agent_start", (_event, ctx) => end(ctx));
	pi.on("agent_end", (event, ctx) => guarded(() => lastStopReason(event?.messages) === "stop" && end(ctx)));
	pi.on("input", (_event, ctx) =>
		guarded(() => {
			const watch = ctx?.agent?.kind === "main" ? watches.get(keyOf(ctx)) : undefined;
			if (!watch) return;
			watch.ctx = ctx;
			void check(watch);
		}),
	);
	for (const name of ["session_switch", "session_shutdown"] as const) pi.on(name, () => guarded(() => [...watches.keys()].forEach(disarm)));
}
