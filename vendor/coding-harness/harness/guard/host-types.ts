import type { RetryStartEvent } from "./usage-wait.ts";

/** A JSON-like object whose members are narrowed where they are read. */
export type Fields = Record<string, unknown>;

/** `value` itself when it is a plain object, else an empty object: reads of an absent or non-object tool input find no field. */
export function fieldsOf(value: unknown): Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

/** `String(value ?? "")`: the text a tool input field stands for, empty when absent. */
export const textOf = (value: unknown): string => String(value ?? "");

/** The `text` of every block of a tool result `content` array, empty string for a block without one. */
export function textBlocks(content: unknown): string[] {
	return (Array.isArray(content) ? content : []).map(block => {
		const text = fieldsOf(block).text;
		return typeof text === "string" ? text : "";
	});
}

/** The `tool_call` and `tool_result` event fields the guard reads. */
export type ToolEvent = {
	toolName?: unknown;
	toolCallId?: unknown;
	input?: unknown;
	content?: unknown;
	details?: unknown;
	isError?: unknown;
};

/** What a `tool_call` handler returns to veto or revise the call. */
export type ToolCallVerdict = { block: true; reason: string } | { input: unknown; additionalContext?: string } | undefined;

/** The part of omp's extension context the guard reads, for hooks and slash commands alike. */
export type HostCtx = {
	cwd?: unknown;
	agent?: { kind?: unknown; id?: unknown };
	hasUI?: unknown;
	ui?: {
		confirm?: (title: string, message: string, options: { timeout: number }) => Promise<unknown>;
		notify?: (text: string, level: "info" | "warning") => void;
	};
	sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown };
	modelRegistry?: { find?: (provider: string, id: string) => unknown };
	getContextUsage?: () => unknown;
	compact?: (options: { suppressContinuation: boolean }) => Promise<unknown>;
	abort?: () => unknown;
	model?: { id?: unknown };
	isIdle?: () => unknown;
};

/** The part of omp's extension API the guard registers on. */
export type HostApi = {
	setLabel?(label: string): void;
	on(event: "session_start", handler: (event: unknown, ctx: HostCtx) => void): void;
	on(event: "session_compact", handler: (event: unknown, ctx: HostCtx) => void): void;
	on(event: "tool_call", handler: (event: ToolEvent, ctx: HostCtx) => Promise<ToolCallVerdict>): void;
	on(event: "tool_result", handler: (event: ToolEvent, ctx: HostCtx) => { content: unknown[] } | undefined): void;
	on(event: "before_provider_request", handler: (event: { payload?: unknown }, ctx: HostCtx) => unknown): void;
	on(event: "context", handler: (event: { messages?: unknown }, ctx: HostCtx) => { messages: unknown[] } | undefined): void;
	on(event: "auto_retry_start", handler: (event: RetryStartEvent, ctx: HostCtx) => void): void;
	on(event: "auto_retry_end" | "agent_start" | "input" | "session_switch" | "session_shutdown", handler: (event: unknown, ctx: HostCtx) => void): void;
	on(event: "agent_end", handler: (event: { messages?: unknown }, ctx: HostCtx) => void): void;
	registerCommand(name: string, command: { description: string; handler(args: unknown, ctx: HostCtx): Promise<unknown> }): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "nextTurn" } | { triggerTurn: true }): void;
	sendUserMessage(text: string, options: { deliverAs: "steer" }): void;
	setModel?(model: unknown): Promise<unknown>;
	setThinkingLevel?(level: string): void;
};
