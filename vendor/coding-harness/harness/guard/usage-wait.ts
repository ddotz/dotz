/** Longest retry sleep (ms) a worker may sit through; omp's own `retry.maxDelayMs` default is the same 5 minutes. */
export const LONG_USAGE_WAIT_MS = 300_000;

/** The slice of omp's extension context the usage-wait handler reads. */
export interface WaitCtx {
	agent?: { kind?: unknown; id?: unknown };
	abort?: () => unknown;
}

/** The `auto_retry_start` fields the guard reads. */
export interface RetryStartEvent {
	delayMs?: unknown;
	errorMessage?: unknown;
}

/** True for a worker (`kind === "sub"`) whose retry sleep is longer than `LONG_USAGE_WAIT_MS`: it must hand its 429 back instead of holding a task slot until the provider reset. */
export function usageWaitAborts(kind: unknown, delayMs: unknown): boolean {
	return kind === "sub" && typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > LONG_USAGE_WAIT_MS;
}
