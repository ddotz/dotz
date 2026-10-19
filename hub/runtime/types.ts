// The seam between the hub's policy (state machines, pause/retry, watchdog, rotation, handover) and one agent runtime.
// The hub only sends commands through an AgentProcess and only reads AgentEvents; frame formats, spawn arguments,
// per-run config files and session-file layout belong to the adapter of that runtime (omp.ts, claude.ts).
import type { Activity } from "../events.ts";
import type { ProviderErrorKind } from "../providers.ts";

export type RuntimeId = "omp" | "claude" | "codex" | "opencode";
export type Role = "orchestrator" | "lane";

// What the hub may rely on without asking the runtime; hub code reads these instead of testing for a runtime id.
export interface RuntimeCaps {
	steer: "native" | "interrupt-only" | "queue-only"; // inserting a message into a running turn
	subagents: "live" | "transcript-only" | "none"; // task workers reported while they run
	contextNumbers: "exact" | "estimate" | "none"; // token count and window of the session
	compact: "rpc" | "slash" | "none"; // how a compaction is requested
	sessionTranscript: boolean; // recentExchanges() can read a saved session
	promptCacheKeepalive: boolean; // an idle ping inside the provider's cache TTL pays off
}

// One row of the terminal view, before the hub stamps time and source on it and scrubs secrets.
export type ActivityRow = Omit<Activity, "ts" | "kind" | "source">;

// A task worker's state as the runtime reported it, normalised; the hub keeps the list (activity.ts).
export type SubagentUpdate = { id: string; agent?: string; description?: string; status: "running" | "done" | "failed" | "aborted"; tool?: string; intent?: string; transcript?: string };

export type AgentError = {
	text: string;
	kind: ProviderErrorKind | undefined;
	// The turn died inside a compaction: recovered by restarting on the same session, not by the retry policy.
	compaction: boolean;
};

export type AgentEvent =
	// Any output at all arrived from the process (first event of every frame): the stall detector's life sign.
	| { type: "alive" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	// A user message entered the session (the owner's prompt, a note, a gateway prompt).
	| { type: "user"; text: string }
	// An assistant message ended; `text` is its text blocks, `stop` how it ended.
	| { type: "assistant"; text: string; stop: "stop" | "length" | "aborted" | "other" }
	| { type: "assistant"; text: string; stop: "error"; error: AgentError }
	| { type: "activity"; row: ActivityRow }
	| { type: "subagent"; update: SubagentUpdate }
	// The runtime switched to the next model of a fallback chain after a request failed; `worker` when it was a task worker's model.
	| { type: "fallback"; from: string; to: string; reason?: string; worker?: boolean }
	// What one finished model request consumed (`usd` only when the runtime could price it); the hub counts it against per-entry spend caps.
	| { type: "spend"; tokens: number; usd?: number }
	// New context numbers; either field may be missing.
	| { type: "usage"; tokens?: number; window?: number }
	// `done`/`error` with requested=true answer a compact(); an error with requested=false is a compaction the runtime ran by itself.
	| { type: "compaction"; state: "done"; tokensBefore?: number }
	| { type: "compaction"; state: "error"; error: string; requested: boolean }
	// The session this process runs in (a file path for omp), as answered by refreshSession().
	| { type: "session"; ref: string };

export type SendMode = "prompt" | "steer" | "followUp";

export interface AgentProcess {
	readonly pid: number | undefined;
	// Settles when the process is gone, independent of the event stream, so a stalled stream never delays exit handling.
	readonly exited: Promise<number>;
	// Read once, from the start; ends when the process closes its output.
	readonly events: AsyncIterable<AgentEvent>;
	// prompt: a new turn; followUp: queued behind a running turn; steer: injected into the running turn.
	send(text: string, mode: SendMode): void;
	abort(): void;
	// The hub calls this only when the process is idle (a runtime may cut a running turn short to compact).
	compact(): void;
	// Ask for fresh context numbers / the session reference; answered by a usage / session event.
	refreshUsage(): void;
	refreshSession(): void;
	// Start receiving task-worker updates (subagent events).
	watchSubagents(): void;
	// `force` is the unignorable kill; the hub decides when to escalate.
	kill(force?: boolean): void;
}

export interface SpawnOpts {
	role: Role;
	cwd: string;
	// The model selector as the hub stores it (omp: `provider/id:thinking`).
	model: string;
	// Session reference to resume (a file path for omp); fresh session when absent.
	resume?: string;
	// Added to the hub's own environment (role markers read by the dotz extension).
	env: Record<string, string>;
	// Model selectors tried in order after `model` fails at request time; empty/absent = no fallback.
	fallback?: string[];
	// The hub switches models itself (conditional entries, spend caps): the runtime must not walk a fallback chain of its own for this process.
	hubSwitches?: boolean;
	// Lane-only: where the runtime may keep per-run files, and the lane's worker/compaction settings.
	lane?: { name: string; dir: string; workerModel: string; workerFallback?: string[]; compactAt: number; keepRecent: number };
}

// What a runtime's `detect()` finds on this machine; `reason` says why it is not installed. `plugins` lists add-ons the
// runtime is known to be extended with (by plugin name), present or not.
export type DetectResult = { installed: boolean; version?: string; path?: string; reason?: string; plugins?: Record<string, boolean> };

export interface RuntimeAdapter {
	id: RuntimeId;
	caps: RuntimeCaps;
	start(o: SpawnOpts): AgentProcess;
	classifyError(text: string): ProviderErrorKind | undefined;
	// The most recent user messages and final answers of a saved session, the body of a handover into a fresh one; undefined when unreadable.
	recentExchanges(sessionRef: string): string | undefined;
	// Is the runtime's CLI installed here, and which version (a short `--version` run); never throws.
	detect(): Promise<DetectResult>;
}
