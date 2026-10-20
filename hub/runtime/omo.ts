// The OmO adapter (oh-my-openagent, the `omo` CLI on senpi, a pi fork like omp): runs `omo --mode rpc`. OmO speaks the
// same pi RPC protocol as omp (prompt/steer/abort/compact/set_model/get_state/get_session_stats; agent, turn, message and
// tool frames; the same session-file entries), so omp.ts's reader is reused and this file holds only what differs:
// spawn arguments, provider names, compaction frame names, task workers that report back into the session instead of a
// live subscription, and closing the rpc host OmO starts for task workers (omo-hosts.ts).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { apiKeyBan, withoutApiKeys } from "../apikey-policy.ts";
import { log, parseSelector, writeAtomic } from "../config.ts";
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

// OmO task workers take their model from OmO's categories (the user omo.json), never from the spawn, so a lane's worker
// model goes into a dotz-owned profile there: every category on that model, then its fallbacks (with WORKER_RULE and
// WORKER_MAX_DEPTH below), and the lane process
// starts with OMO_PROFILE naming the profile. A profile applies only where OMO_PROFILE names it, so the owner's own OmO
// sessions keep their categories. Without it a lane's `quick` worker ran on OmO's default (Haiku, seen 2026-10-20).
export const WORKER_CATEGORIES = ["quick", "unspecified-low", "unspecified-high", "deep-low", "deep-high", "ultrabrain", "artistry", "writing", "visual-engineering", "architect"];
// OmO's task.max_depth defaults to 1: a lane's worker (depth 1) was refused every spawn of its own (depth 2), and the
// refusal came back as plain text. The profile lets a worker delegate one level further; deeper spawns stay refused.
export const WORKER_MAX_DEPTH = 2;
// Appended to every worker category's prompt: a blocked worker once wrote the expected answer itself and the lane
// reported success (2026-10-19 lat-probe2).
export const WORKER_RULE =
	"dotz worker rule: if a step you need is refused or fails (a tool error, a denied or refused task spawn, a missing permission) and you cannot do it another real way, stop and report [fail] with what was blocked and the exact reason. Never write the expected output, a guessed result or a placeholder in its place.";
export const omoConfigFile = () => process.env.OMO_USER_CONFIG ?? join(process.env.HOME ?? homedir(), ".omo", "omo.json");
export const workerProfileName = (workerModel: string) => `dotz-workers-${workerModel.replace(/[^A-Za-z0-9.-]+/g, "-")}`;
const categoryModel = (selector: string) => {
	const { model, thinking } = parseSelector(omoSelector(selector));
	return { model, reasoning: thinking };
};

// Returns the profile name, or undefined when the file cannot be written (OmO reads omo.jsonc first, and dotz does not
// rewrite a commented file; an unreadable omo.json is left alone): the lane then runs its workers on OmO's categories.
export function writeWorkerProfile(lane: { workerModel: string; workerFallback?: string[] }, file = omoConfigFile()): string | undefined {
	const name = workerProfileName(lane.workerModel);
	if (existsSync(file.replace(/\.json$/, ".jsonc"))) {
		log(`omo: ${file}c exists; lane workers keep OmO's own category models`);
		return undefined;
	}
	let doc: Record<string, unknown> = {};
	try {
		if (existsSync(file)) doc = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		log(`omo: ${file} is not readable JSON (${(e as Error).message}); lane workers keep OmO's own category models`);
		return undefined;
	}
	const models = [lane.workerModel, ...(lane.workerFallback ?? [])].map(categoryModel);
	const profiles = { ...(doc.profiles as Record<string, unknown> | undefined), [name]: { task: { max_depth: WORKER_MAX_DEPTH }, categories: Object.fromEntries(WORKER_CATEGORIES.map(c => [c, { models, prompt_append: WORKER_RULE }])) } };
	mkdirSync(dirname(file), { recursive: true });
	writeAtomic(file, `${JSON.stringify({ ...doc, profiles }, null, 2)}\n`);
	return name;
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
	// dotz selectors keep omp's provider names (`anthropic` = the subscription); OmO's `anthropic` bills the API key.
	setModel(selector: string): void {
		super.setModel(omoSelector(selector));
	}
}

// OmO's own memory plugin would create a memory agent per cwd and run reflection turns on every dotz process; dotz
// keeps its own memory (state.json, the owner's files), so it is off.
const MEMORY_OFF = "--omo-senpi-memory-disabled";
// The question tool waits for an interactive UI answer that no dotz process gives (it would hang the turn); dotz asks the
// owner in its channels instead.
const NO_ASK = "--no-ask-user";

// An API-key fallback entry runs as its own provider, which only exists once the dotz extension has registered it from
// DOTZ_KEY_PROVIDER (hub/fallback.ts keyEnv): the process starts on the entry's own model and is switched to the key
// provider's copy before the first prompt (RPC commands run in order), as on omp.
const keyProviderOf = (o: SpawnOpts) => (o.env.DOTZ_KEY_PROVIDER && !apiKeyBan() ? (JSON.parse(o.env.DOTZ_KEY_PROVIDER) as { id: string; baseModel: string; models: Array<{ id: string }> }) : undefined);

// Light profile (measured 2026-10-20 over RPC, first-turn prompt on Sonnet 5.5: orchestrator 39.7K -> 35.9K, lane 35.8K ->
// 34.5K): tools no dotz process uses are left out. The goal loop (dotz drives turns and checks [done] itself) and the
// HTML viewer (nothing renders it) go everywhere; the orchestrator, which edits no code and delegates through lanes and
// task, also drops the LSP tools, workpool and PTY resize. Skills, context files, rules, memory and task stay: lanes and
// the orchestrator use them (the retain nudge names the memory tool).
const EXCLUDED_TOOLS = ["create_goal", "get_goal", "update_goal", "show_html_page"];
const ORCHESTRATOR_EXCLUDED = ["lsp_diagnostics", "lsp_find_references", "lsp_goto_definition", "lsp_prepare_rename", "lsp_rename", "lsp_symbols", "workpool", "bash_resize"];
const excludedTools = (role: SpawnOpts["role"]) => [...EXCLUDED_TOOLS, ...(role === "orchestrator" ? ORCHESTRATOR_EXCLUDED : [])].join(",");

// --no-model-fallback: OmO's own chain would follow the owner's global settings; the hub drives every chain of an OmO
// process itself (hub/fallback.ts hubChain), restarting it on the same session with the next model.
export function omoArgs(o: SpawnOpts): string[] {
	const key = keyProviderOf(o);
	const model = key ? `${key.baseModel}:${parseSelector(o.model).thinking}` : o.model;
	return [OMO, "--mode", "rpc", "--model", omoSelector(model), "--extension", EXTENSION, "--no-model-fallback", MEMORY_OFF, NO_ASK, "--exclude-tools", excludedTools(o.role), ...(o.resume ? ["--session", o.resume] : [])];
}

export const omo: RuntimeAdapter = {
	id: "omo",
	// No live worker frames; every fallback chain is switched by the hub (fallback.ts hubChain), OmO's own chain is off (--no-model-fallback).
	// OmO writes the 1h prompt cache when started with PI_CACHE_RETENTION=long (start below; measured 2026-10-20: a full cache
	// read after a 6.7-minute gap), so the idle keepalive pays off as on omp. OmO's usage records never show it: senpi's
	// claude-sdk-oauth stream drops the cacheWrite1h field, so nothing here reads that field.
	caps: { steer: "native", subagents: "transcript-only", contextNumbers: "exact", compact: "rpc", sessionTranscript: true, promptCacheKeepalive: true, contextLimit: "compact" },
	start(o) {
		const profile = o.lane ? writeWorkerProfile(o.lane) : undefined;
		const proc = Bun.spawn(omoArgs(o), { cwd: o.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: withoutApiKeys({ PI_CACHE_RETENTION: "long", ...process.env, ...o.env, ...(profile ? { OMO_PROFILE: profile } : {}), DOTZ_RUNTIME: "omo" }) });
		recordStarted(proc.pid);
		void proc.exited.then(() => closeHostsOf(proc.pid));
		const agent = new OmoProcess(proc, o.role === "orchestrator" ? "o" : "h", translateFrame);
		const key = keyProviderOf(o);
		if (key) agent.setModel(`${key.id}/${key.models[0].id}`);
		return agent;
	},
	classifyError: classifyProviderError,
	recentExchanges,
	detect: () => detectBinary(OMO),
};

(omo as RuntimeAdapter & { probes?: unknown }).probes = makeOmoProbes(omo);
