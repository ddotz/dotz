// A 리셋권 (usage-limit reset ticket) is spent by the owner's hand, and nothing gives one back. So a test run never sends the call that spends one:
// the spend functions (hub/codex-usage.ts useResetCredit, hub/claude-reset.ts useClaudeReset, hub/omp-reset.ts useOmpReset) ask here, before
// any request, and refuse when they would reach the real network or the real omp. A test hands them a fake sender, which passes.
// The sender the preload (hub/runtime/test-setup.ts) puts on globalThis.fetch is the real one, marked REAL_NETWORK; a test that wants a fetch replaces it.
export const REAL_NETWORK = "dotzRealNetwork";
export const isRealFetch = (f: unknown): boolean => (f as Record<string, unknown> | undefined)?.[REAL_NETWORK] === true;

/** The answer a spend gives instead of spending, when this is a test run and `real` says its sender is the real one. */
export const testSpendRefusal = (real: boolean): { status: number; body: { error: string } } | undefined =>
	real && process.env.NODE_ENV === "test" ? { status: 409, body: { error: "refused: a test run does not spend a real 리셋권" } } : undefined;
