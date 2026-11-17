import { classifyProviderError } from "../providers.ts";
import type { Frame } from "./omp.ts";
import type { AgentEvent } from "./types.ts";

const failed = (e: AgentEvent): boolean => e.type === "assistant" && e.stop === "error";
const retryable = (e: AgentEvent): boolean => e.type === "assistant" && e.stop === "error" && e.error.kind === "transient" && !e.error.compaction;
const BETWEEN = ["turn_end", "message_update", "message_start"];

const failureOf = (f: Frame): AgentEvent => {
	const text = typeof f.error === "string" ? f.error : (f.error?.message ?? "prompt failed");
	return { type: "assistant", text: "", stop: "error", error: { text, kind: classifyProviderError(text), compaction: false } };
};

// why(protocol): omp@18.22.0 retries a transient failure itself and sends auto_retry_start after the failed message_end; a refused prompt ends with prompt_result status "error" (docs/rpc.md "Yield vs settled"; frames: hub/runtime/fixtures/omp-retry.jsonl)
/** Passes the events of omp frames on in order: a transient failed request waits for the frame after it and omp's own retry drops it; a prompt that failed without any failed message becomes the same failure event. */
export class RetryGate {
	private held: AgentEvent[] = [];
	private reported = false;

	pass(f: Frame, events: AgentEvent[]): AgentEvent[] {
		const out: AgentEvent[] = [];
		if (this.held.length && !BETWEEN.includes(f.type ?? "")) {
			if (f.type === "auto_retry_start") this.held = [];
			else out.push(...this.release());
		}
		for (const e of events) (f.type === "message_end" && retryable(e) ? this.held : out).push(e);
		if (out.some(failed)) this.reported = true;
		if (f.type === "prompt_result") {
			if (f.status === "error" && !this.reported) out.push(failureOf(f));
			this.reported = false;
		}
		return out;
	}

	release(): AgentEvent[] {
		const out = this.held;
		this.held = [];
		return out;
	}
}
