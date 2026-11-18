const HANDLER_DEADLINE_MS = 8_000;
const BASELINE_BUDGET_MS = 20_000;
const STOP_BUDGET_MS = 24_000;
const STOP_DEADLINE_MS = 27_000;
const STAGE_BUDGET_MS = 12_000;
const FEEDBACK_DEADLINE_MS = 5_000;

function capped(name: string, ceiling: number): number {
	const wanted = Number(process.env[name]);
	return Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, ceiling) : ceiling;
}

/** The milliseconds a before_agent_start or tool_call handler may work; omp blocks a tool whose handler runs past its 30 s budget (omp://extensions.md, "Constraints and pitfalls"). An override never raises it. */
export function handlerDeadlineMs(): number {
	return capped("DONE_GATE_HANDLER_DEADLINE_MS", HANDLER_DEADLINE_MS);
}

/** The one deadline a before_agent_start or tool_call handler works within. */
export function handlerDeadline(): AbortSignal {
	return AbortSignal.timeout(handlerDeadlineMs());
}

/** How long a repo's baseline snapshot may run before it fails. An override never raises it. */
export function baselineBudgetMs(): number {
	return capped("DONE_GATE_BASELINE_BUDGET_MS", BASELINE_BUDGET_MS);
}

/** How long one session_stop may wait for a check; the stop's hard deadline cuts it short when that is lower. An override never raises it. */
export function stopBudgetMs(): number {
	return capped("DONE_GATE_STOP_BUDGET_MS", STOP_BUDGET_MS);
}

/** The hard deadline of a whole session_stop handler. omp lets the stop proceed once its handler runs past its 30 s budget (omp://extensions.md, "Constraints and pitfalls"), so the handler has answered by then or the gate's own books disagree with what the host did. An override never raises it. */
export function stopDeadlineMs(): number {
	return capped("DONE_GATE_STOP_DEADLINE_MS", STOP_DEADLINE_MS);
}

/** Half the stop's budget: how long the anti-escape stage and the rules stage each get, side by side with the checks, before they count as errors. */
export function stageBudgetMs(): number {
	return capped("DONE_GATE_STAGE_BUDGET_MS", STAGE_BUDGET_MS);
}

/** The one deadline a tool_result handler's edit feedback works within. */
export function feedbackDeadline(): AbortSignal {
	return AbortSignal.timeout(capped("DONE_GATE_FEEDBACK_DEADLINE_MS", FEEDBACK_DEADLINE_MS));
}

/** The value of `work`, or undefined when `signal` aborts first; the work itself keeps going. */
export async function until<T>(work: Promise<T>, signal: AbortSignal): Promise<{ value: T } | undefined> {
	if (signal.aborted) return undefined;
	const { promise: aborted, resolve } = Promise.withResolvers<undefined>();
	const onAbort = () => resolve(undefined);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([work.then(value => ({ value })), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
