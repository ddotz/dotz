type LoopStatus = "inactive" | "active" | "paused";
interface ModeState {
	loop: { status: LoopStatus };
}
type LoopLimit = { kind: "iterations"; iterations: number } | { kind: "duration"; durationMs: number };
/** The loop request shape omp's `ctx.sessionModes.set` accepts. */
export type LoopRequest = { mode: "loop"; action: "enter"; prompt: string; limit?: LoopLimit; condition: { command: string; until: boolean } } | { mode: "loop"; action: "exit" };
/** omp's answer to `ctx.sessionModes.set`. */
export type SetResult = { ok: true; changed: boolean; state?: ModeState } | { ok: false; code: string; message: string; state: ModeState };
interface SessionModes {
	getState(): ModeState;
	set(request: LoopRequest): Promise<SetResult>;
}
export interface Ctx {
	agent?: { kind?: string };
	sessionModes?: SessionModes;
}
interface SchemaNode {
	optional(): SchemaNode;
	describe?(text: string): SchemaNode;
}
interface Schema {
	object(shape: Record<string, SchemaNode>): SchemaNode;
	enum(values: string[]): SchemaNode;
	string(): SchemaNode;
	number(): SchemaNode;
	boolean(): SchemaNode;
}
export interface ToolParams {
	action: "enter" | "exit";
	prompt?: string;
	condition?: { command?: string; until?: boolean };
	iterations?: number;
	minutes?: number;
}
interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}
/** The part of omp's extension `agent_end` event this tool reads: `willContinue` is true while the run goes on (a retry, a compaction continuation, a stop-time reminder), and the last assistant message's `stopReason` tells an Esc or an error from a finished turn. */
export interface AgentEnd {
	willContinue?: boolean;
	messages?: readonly unknown[];
}

/** How a run's `agent_end` ends the queued request: `wait` while the run continues, `drop` when the user aborted or the turn errored, `apply` when the run is over. */
export function endOf(event: AgentEnd): "wait" | "drop" | "apply" {
	if (event.willContinue === true) return "wait";
	const last = [...(event.messages ?? [])].reverse().find(message => typeof message === "object" && message !== null && "role" in message && message.role === "assistant");
	const reason = typeof last === "object" && last !== null && "stopReason" in last ? last.stopReason : undefined;
	return reason === "aborted" || reason === "error" ? "drop" : "apply";
}
export interface Api {
	zod: Schema;
	setLabel?(label: string): void;
	on(event: "agent_end", handler: (event: AgentEnd, ctx: Ctx) => Promise<void> | void): void;
	on(event: "session_switch", handler: () => void): void;
	sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: SchemaNode;
		execute(id: string, params: ToolParams, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<ToolResult>;
	}): void;
}

const FALLBACK = "Use a background bash job (`timeout: 0`) or eval `agent()`/`wait()` waves instead.";
const BUSY_RETRIES = 40;
const BUSY_DELAY_MS = 250;

const DESCRIPTION =
	"Enter or exit omp loop mode. omp refuses mode changes while a turn runs, so the request is queued and applied when the run ends (dropped if you press Esc, the turn errors, or the session switches); on enter, `prompt` is then sent to start the first iteration and repeated after every turn. `condition` is an object `{command, until}`: `command` is a shell command run after each turn; with `until: true` (default) the loop stops once it exits 0, with `until: false` it runs while it exits 0. Optional bound: `iterations` (total runs of the prompt, at least 2) or `minutes`. End the turn after calling enter. TUI main session only; refused in print/RPC/ACP and in subagents. Used by the ulw playbooks autonomous-run, hillclimb, autopilot-stack, autopilot-full and multi-phase-plan; never by workers.";

function text(message: string, details: Record<string, unknown>, isError: boolean): ToolResult {
	return { content: [{ type: "text", text: message }], details, isError };
}

function refuse(reason: string): ToolResult {
	return text(`loop: refused, ${reason} ${FALLBACK}`, { ok: false }, true);
}

/** Validates a `loop` tool call and turns it into the omp mode request, or a refusal. */
export function toRequest(params: ToolParams, ctx: Ctx): LoopRequest | ToolResult {
	if (ctx.agent?.kind !== "main") return refuse("loop mode is for the main session only, not subagents or workers.");
	if (!ctx.sessionModes) return refuse("this session has no mode control (loop mode needs the interactive TUI; print, RPC, ACP and subagent sessions have none).");
	if (params.action === "exit") return { mode: "loop", action: "exit" };
	const command = params.condition?.command?.trim();
	if (!command) return refuse("action enter needs `condition.command`: a shell command that checks the stop state; an unchecked loop never ends.");
	const prompt = params.prompt?.trim();
	if (!prompt) return refuse("action enter needs a `prompt`: the text sent at the start of every iteration.");
	if (params.iterations !== undefined && params.minutes !== undefined) return refuse("give `iterations` or `minutes`, not both.");
	const request: LoopRequest = { mode: "loop", action: "enter", prompt, condition: { command, until: params.condition?.until ?? true } };
	if (params.iterations !== undefined) {
		if (!Number.isSafeInteger(params.iterations) || params.iterations < 2) return refuse("`iterations` counts every run of the prompt and must be an integer of at least 2; one run needs no loop.");
		request.limit = { kind: "iterations", iterations: params.iterations - 1 };
	} else if (params.minutes !== undefined) {
		if (!Number.isFinite(params.minutes) || params.minutes <= 0) return refuse("`minutes` must be positive.");
		request.limit = { kind: "duration", durationMs: Math.round(params.minutes * 60_000) };
	}
	return request;
}

/** Applies a queued request once the turn has ended, retrying while omp reports `busy`; returns the message for the session. */
export async function applyQueued(request: LoopRequest, ctx: Ctx, sleep: (ms: number) => Promise<void>): Promise<{ ok: boolean; message: string }> {
	const modes = ctx.sessionModes;
	if (!modes) return { ok: false, message: `loop: this session lost mode control before the turn ended; loop mode was not changed. ${FALLBACK}` };
	for (let attempt = 1; ; attempt++) {
		const result = await modes.set(request);
		if (result.ok) {
			const status = modes.getState().loop.status;
			return { ok: true, message: `loop: ${request.action === "enter" ? "entered" : "exited"}; loop is ${status}.` };
		}
		if (result.code !== "busy" || attempt >= BUSY_RETRIES) return { ok: false, message: `loop: omp refused the ${request.action} (${result.code}): ${result.message} ${FALLBACK}` };
		await sleep(BUSY_DELAY_MS);
	}
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

export default function loopMode(pi: Api) {
	const z = pi.zod;
	let queued: LoopRequest | undefined;
	pi.setLabel?.("Loop mode");
	pi.on("session_switch", () => {
		queued = undefined;
	});
	pi.on("agent_end", async (event, ctx) => {
		const end = endOf(event);
		if (end === "wait") return;
		const request = queued;
		queued = undefined;
		if (!request || end === "drop") return;
		const outcome = await applyQueued(request, ctx, sleep);
		if (outcome.ok && request.action === "enter") return pi.sendUserMessage(request.prompt);
		if (!outcome.ok) pi.sendUserMessage(outcome.message);
	});
	pi.registerTool({
		name: "loop",
		label: "Loop mode",
		description: DESCRIPTION,
		parameters: z.object({
			action: z.enum(["enter", "exit"]),
			prompt: z.string().optional(),
			condition: z.object({ command: z.string(), until: z.boolean().optional() }).optional(),
			iterations: z.number().optional(),
			minutes: z.number().optional(),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const request = toRequest(params, ctx);
			if ("content" in request) return request;
			queued = request;
			return text(`loop: ${params.action} queued; it applies when this turn ends${request.action === "enter" ? ", then the prompt starts the first iteration" : ""}. End the turn now.`, { ok: true, queued: request }, false);
		},
	});
}
