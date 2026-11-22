import { basename } from "node:path";
import type { MistakeApi, MistakeCtx } from "./mistakes.ts";

/** Whether this process runs under dotz (the hub sets `DOTZ_RUNTIME` on every runtime it spawns); read at call time. */
export function inDotz(): boolean {
	return (process.env.DOTZ_RUNTIME ?? "") !== "";
}

/**
 * The host surface the done gate touches; the omp binary ships no type declarations. `hasUI` is true when the host gave the
 * extension a UI context (the interactive terminal, RPC with a UI, ACP): such a session takes a turn after a stop lets it finish.
 * Print, JSON and headless runs report false and end with that stop.
 */
export interface Ctx {
	cwd?: string;
	agent?: { kind?: string; id?: string };
	sessionManager?: { getSessionId?(): string };
	hasUI?: boolean;
	ui?: { notify(text: string, level: "info" | "warning"): void };
}

export interface ToolCallEvent {
	toolName?: string;
	toolCallId?: string;
	input?: Record<string, unknown>;
}

export interface ToolResultEvent {
	toolName?: string;
	toolCallId?: string;
	input?: Record<string, unknown>;
	details?: unknown;
	isError?: boolean;
}

export interface ToolResultContext {
	additionalContext: string;
}

export interface StopEvent {
	signal?: AbortSignal;
}

export interface StopResult {
	decision: "block";
	reason: string;
}

/** What a prompt, or a steering or follow-up batch with user work, brings: `reason` is "prompt" for those and "revive" for a parked subagent coming back; `prompt` is the text, which for the continuation after a refused stop is the refusal itself. The event does not start a run. */
export interface BeforeAgentStartEvent {
	reason?: string;
	prompt?: string;
}

/** The end of an agent loop: `willContinue` is true when the loop is not settled, as while the host waits for background jobs or after a refused stop. */
export interface AgentEndEvent {
	willContinue?: boolean;
}

/** A finalized assistant message: `message.content` holds its blocks (`text`, `thinking`, `toolCall`). */
export interface AssistantMessageEvent {
	message?: { content?: unknown };
}

/**
 * What a switch or a branch of the session brings. `reason` names it ("new", "resume" and "fork" for a switch; "branch", "fork" and
 * "btw" for a branch). `previousSessionFile` is the file of the session that was left, absent when it was not on disk; the
 * `ctx` of such an event already belongs to the new session.
 */
export interface SessionChangeEvent {
	reason?: string;
	previousSessionFile?: string;
}

/** What the done gate itself answers to. */
export interface GateHandlers {
	before_agent_start(event: BeforeAgentStartEvent, ctx: Ctx): Promise<void>;
	agent_start(event: unknown, ctx: Ctx): Promise<void>;
	agent_end(event: AgentEndEvent, ctx: Ctx): Promise<void>;
	assistant_message(event: AssistantMessageEvent, ctx: Ctx): Promise<undefined>;
	tool_call(event: ToolCallEvent, ctx: Ctx): Promise<ToolResultContext | undefined>;
	tool_result(event: ToolResultEvent, ctx: Ctx): Promise<ToolResultContext | undefined>;
	session_stop(event: StopEvent, ctx: Ctx): Promise<StopResult | undefined>;
	session_switch(event: SessionChangeEvent, ctx: Ctx): Promise<void>;
	session_branch(event: SessionChangeEvent, ctx: Ctx): Promise<void>;
	session_shutdown(event: unknown, ctx: Ctx): Promise<void>;
}

/** Every event the extension subscribes to: the gate's own, and the context watcher of the mistake obligations. */
export interface Handlers extends GateHandlers {
	context(event: { messages?: unknown }, ctx: MistakeCtx): void;
}

export interface Command {
	description: string;
	handler(args: unknown, ctx: Ctx): Promise<void>;
}

/** A message the gate asks the host to show the user and put before the agent. */
export interface GateMessage {
	customType: string;
	display: boolean;
	content: string;
}

export interface Api extends Pick<MistakeApi, "zod" | "registerTool"> {
	sendMessage(message: GateMessage, options: { deliverAs: "nextTurn" | "aside"; triggerTurn: boolean }): void;
	on<E extends keyof Handlers>(event: E, handler: Handlers[E]): void;
	registerCommand(name: string, command: Command): void;
}

export const isMain = (ctx: Ctx) => ctx.agent?.kind === "main";
export const sessionKey = (ctx: Ctx) => ctx.sessionManager?.getSessionId?.() ?? ctx.agent?.id ?? "main";
export const cwdOf = (ctx: Ctx) => ctx.cwd ?? process.cwd();

/** The id of the session kept in `file`; undefined for a name that is not `<timestamp>_<id>.jsonl`, the way omp names a session file. */
export function sessionIdOfFile(file: string | undefined): string | undefined {
	return file === undefined ? undefined : /^[^_]*_(.+)\.jsonl$/.exec(basename(file))?.[1];
}

export function notify(ctx: Ctx, notice: string, level: "info" | "warning"): void {
	try {
		ctx.ui?.notify(notice, level);
	} catch {
		return;
	}
}
