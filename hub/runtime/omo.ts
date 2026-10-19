// The OmO adapter (oh-my-openagent, the `omo` CLI on senpi, a pi fork like omp): runs `omo --mode rpc`. OmO speaks the
// same pi RPC protocol as omp (prompt/steer/abort/compact/set_model/get_state/get_session_stats; agent, turn, message and
// tool frames; the same session-file entries), so omp.ts's reader is reused and this file holds only what differs:
// spawn arguments, provider names, compaction frame names, task workers that report back into the session instead of a
// live subscription, and closing the rpc host OmO starts for task workers (omo-hosts.ts).
import { parseSelector } from "../config.ts";
import { classifyProviderError } from "../providers.ts";
import { detectBinary } from "./detect.ts";
import { closeHostsOf, OMO, recordStarted } from "./omo-hosts.ts";
import { makeOmoProbes } from "./omo-probes.ts";
import { EXTENSION, type Frame, OmpProcess, recentExchanges } from "./omp.ts";
import type { RuntimeAdapter, SpawnOpts } from "./types.ts";

// In OmO `anthropic` is the API-key provider (billed per token) and `anthropic-subscription` the Claude subscription
// login, which is what omp's `anthropic` is; dotz selectors keep omp's names, so they are mapped here.
export function omoSelector(selector: string): string {
	const { model, thinking } = parseSelector(selector);
	const mapped = model.startsWith("anthropic/") ? `anthropic-subscription/${model.slice("anthropic/".length)}` : model;
	return thinking ? `${mapped}:${thinking}` : mapped;
}

// OmO names its compaction frames compaction_start/compaction_end (omp: auto_compaction_*). A requested compaction is
// answered by the `compact` response already, so its end frame is dropped instead of reporting it twice.
export function translateFrame(f: Frame & { reason?: string }): Frame {
	if (f.type === "compaction_start") return { type: "auto_compaction_start" };
	if (f.type === "compaction_end") return f.reason === "manual" ? { type: "compaction_end_requested" } : { type: "auto_compaction_end", errorMessage: f.errorMessage, aborted: f.aborted };
	// OmO runs shell work in `eval` cells, whose one-line `summary` is the call's intent.
	const said = (f.args as { summary?: unknown } | undefined)?.summary;
	if (f.type === "tool_execution_start" && !f.intent && typeof said === "string") return { ...f, intent: said };
	return f;
}

class OmoProcess extends OmpProcess {
	// OmO has no task-worker subscription: a worker's result comes back into the session as a message.
	watchSubagents(): void {}
}

// OmO's own memory plugin would create a memory agent per cwd and run reflection turns on every dotz process; dotz
// keeps its own memory (state.json, the owner's files), so it is off.
const MEMORY_OFF = "--omo-senpi-memory-disabled";
// The question tool waits for an interactive UI answer that no dotz process gives (it would hang the turn); dotz asks the
// owner in its channels instead.
const NO_ASK = "--no-ask-user";

export function omoArgs(o: SpawnOpts): string[] {
	return [OMO, "--mode", "rpc", "--model", omoSelector(o.model), "--extension", EXTENSION, "--no-model-fallback", MEMORY_OFF, NO_ASK, ...(o.resume ? ["--session", o.resume] : [])];
}

export const omo: RuntimeAdapter = {
	id: "omo",
	// No live worker frames; the hub's own chain switching is omp-only (fallback.ts hubDrivable), and OmO's own chain is off (--no-model-fallback).
	caps: { steer: "native", subagents: "transcript-only", contextNumbers: "exact", compact: "rpc", sessionTranscript: true, promptCacheKeepalive: true, contextLimit: "compact" },
	start(o) {
		const proc = Bun.spawn(omoArgs(o), { cwd: o.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...o.env, DOTZ_RUNTIME: "omo" } });
		recordStarted(proc.pid);
		void proc.exited.then(() => closeHostsOf(proc.pid));
		return new OmoProcess(proc, o.role === "orchestrator" ? "o" : "h", translateFrame);
	},
	classifyError: classifyProviderError,
	recentExchanges,
	detect: () => detectBinary(OMO),
};

(omo as RuntimeAdapter & { probes?: unknown }).probes = makeOmoProbes(omo);
