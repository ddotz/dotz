// The OmO adapter (oh-my-openagent, the `omo` CLI on senpi, a pi fork like omp): runs `omo --mode rpc`. OmO speaks the
// same pi RPC protocol as omp (prompt/steer/abort/compact/set_model/get_state/get_session_stats; agent, turn, message and
// tool frames; the same session-file entries), so omp.ts's reader is reused and this file holds only what differs:
// spawn arguments, provider names, compaction frame names, task workers that report back into the session instead of a
// live subscription, and closing the rpc host OmO starts for task workers (omo-hosts.ts).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stickyEnv } from "../account-sticky.ts";
import { apiKeyBan, withoutApiKeys } from "../apikey-policy.ts";
import { chainAfter, fallbackChain, lanesMaxWorkers, log, orchestratorModel, parseSelector, selectorOf, workerIdleMin, writeAtomic } from "../config.ts";
import { keyedWorker } from "../fallback.ts";
import { classifyProviderError } from "../providers.ts";
import { detectBinary } from "./detect.ts";
import { closeHostsOf, OMO, recordStarted } from "./omo-hosts.ts";
import { makeOmoProbes } from "./omo-probes.ts";
import { senpiLauncher } from "./senpi-bin.ts";
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
// OmO runs task workers in a shared rpc host by default, which loads only OmO's own extensions and has none of the
// lane's environment, so a worker got none of dotz (no output caps, no owner rules: a worker's unranged read stayed at
// 51K chars, 2026-10-20). As child processes of the lane they inherit its extensions (dotz included) and environment
// (DOTZ_LANE, OMO_PROFILE for nested workers); extension/index.ts gives a worker the caps, the rules and the 5-minute cache.
// The execution mode is pinned too: with this runner OmO's "auto" picks in-process, where a worker loads no dotz either
// (and its grep tool failed to load its native module, measured 2026-10-20).
export const WORKER_TASK = { max_depth: WORKER_MAX_DEPTH, process_runner: "child-process", default_execution_mode: "process" };
// Memory (each worker is a bun senpi ~600 MB plus its claude child ~400 MB, measured 2026-10-21): a lane runs at most
// `limit` workers at once (OmO queues the rest; its defaults were 5 per group and 8 in all), and a finished worker
// is released after lanes.worker_idle_min minutes instead of OmO's 15. A released worker still resumes from its session file.
// `limit` is hub/limits.ts for this machine when the lane process is spawned (lanes.max_workers caps it); the profile is
// written just before the spawn, so the number applies at spawn and is not re-checked per worker.
export const workerTask = (limit?: number) => ({ ...WORKER_TASK, resident_idle_timeout_ms: workerIdleMin() * 60_000, ...(limit ? { default_concurrency: limit, global_concurrency: limit } : {}) });
// Appended to every worker category's prompt: a blocked worker once wrote the expected answer itself and the lane
// reported success (2026-10-19 lat-probe2).
export const WORKER_RULE =
	"dotz worker rule: if a step you need is refused or fails (a tool error, a denied or refused task spawn, a missing permission) and you cannot do it another real way, stop and report [fail] with what was blocked and the exact reason. Never write the expected output, a guessed result or a placeholder in its place. Keep tool output small: read big files in ranges (offset/limit) and bound searches and diffs (grep -m, head, git diff --stat or one path), since every result stays in your context and is re-read on each later turn.";
// The user config OmO itself reads: ~/.omo/omo.jsonc when it exists, else omo.json (OmO's own lookup, omo-task.js). dotz once
// wrote omo.json only and skipped a machine with omo.jsonc, so there the orchestrator's workers ran on the owner's own
// categories (Mac mini, 2026-10-27: "omo.jsonc exists; dotz-orchestrator-workers is not written" at every start).
export function omoConfigFile(env: Record<string, string | undefined> = process.env): string {
	if (env.OMO_USER_CONFIG) return env.OMO_USER_CONFIG;
	const dir = join(env.HOME ?? homedir(), ".omo");
	return existsSync(join(dir, "omo.jsonc")) ? join(dir, "omo.jsonc") : join(dir, "omo.json");
}
export const workerProfileName = (workerModel: string) => `dotz-workers-${workerModel.replace(/[^A-Za-z0-9.-]+/g, "-")}`;
const categoryModel = (selector: string) => {
	const { model, thinking } = parseSelector(omoSelector(selector));
	return { model, reasoning: thinking };
};

// JSONC (OmO's config format: comments, trailing commas) edited as text, so the owner's comments and layout stay: only
// `profiles.<name>` is replaced or inserted.
type Tok = { k: string; s: number; e: number };
function jsoncTokens(t: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	while (i < t.length) {
		const c = t[i]!;
		if (/\s/.test(c) || c === "\uFEFF") i++;
		else if (c === "/" && t[i + 1] === "/") i = t.includes("\n", i) ? t.indexOf("\n", i) : t.length;
		else if (c === "/" && t[i + 1] === "*") {
			const end = t.indexOf("*/", i + 2);
			if (end < 0) throw new Error("unterminated comment");
			i = end + 2;
		} else if (c === '"') {
			let j = i + 1;
			while (j < t.length && t[j] !== '"') j += t[j] === "\\" ? 2 : 1;
			if (j >= t.length) throw new Error("unterminated string");
			out.push({ k: "s", s: i, e: j + 1 });
			i = j + 1;
		} else if ("{}[]:,".includes(c)) out.push({ k: c, s: i, e: ++i });
		else {
			let j = i;
			while (j < t.length && !/[\s{}[\]:,"/]/.test(t[j]!)) j++;
			out.push({ k: "v", s: i, e: j });
			i = j;
		}
	}
	return out;
}
/** The JSON value of a JSONC text (comments and trailing commas dropped); throws on anything JSON.parse refuses. */
export function parseJsonc(t: string): unknown {
	const toks = jsoncTokens(t);
	return JSON.parse(toks.filter((x, i) => !(x.k === "," && (toks[i + 1]?.k === "}" || toks[i + 1]?.k === "]"))).map(x => t.slice(x.s, x.e)).join(""));
}
const afterValue = (toks: Tok[], p: number): number => {
	if (toks[p]?.k !== "{" && toks[p]?.k !== "[") return p + 1;
	let depth = 0;
	for (let q = p; q < toks.length; q++) {
		if (toks[q]!.k === "{" || toks[q]!.k === "[") depth++;
		else if ((toks[q]!.k === "}" || toks[q]!.k === "]") && --depth === 0) return q + 1;
	}
	throw new Error("unbalanced brackets");
};
// The member `key` of the object opening at token `open`: its value token, or where a new member goes.
function member(t: string, toks: Tok[], open: number, key: string): { value?: number; empty: boolean } {
	let p = open + 1;
	const empty = toks[p]?.k === "}";
	while (p < toks.length && toks[p]!.k !== "}") {
		if (toks[p]!.k === ",") {
			p++;
			continue;
		}
		if (toks[p]!.k === "s" && toks[p + 1]?.k === ":" && JSON.parse(t.slice(toks[p]!.s, toks[p]!.e)) === key) return { value: p + 2, empty };
		p = afterValue(toks, p + 2);
	}
	return { empty };
}
const indentAt = (t: string, at: number) => /^[ \t]*/.exec(t.slice(t.lastIndexOf("\n", at - 1) + 1))![0];
/** `text` with `profiles.<name>` set to `value`, everything else (comments included) as it was. */
export function setJsoncProfile(text: string, name: string, value: unknown): string {
	const src = text.trim() ? text : "{}\n";
	const toks = jsoncTokens(src);
	if (toks[0]?.k !== "{") throw new Error("the config is not an object");
	parseJsonc(src);
	// The file's own indent unit (the owner's omo.jsonc uses two spaces), tab for an empty file.
	const unit = /\n([ \t]+)\S/.exec(src)?.[1] ?? "\t";
	const put = (open: number, key: string, v: unknown): string => {
		const m = member(src, toks, open, key);
		const pad = indentAt(src, toks[open]!.s) + unit;
		const json = JSON.stringify(v, null, unit).replace(/\n/g, `\n${pad}`);
		if (m.value !== undefined) {
			const end = afterValue(toks, m.value) - 1;
			return src.slice(0, toks[m.value]!.s) + json + src.slice(toks[end]!.e);
		}
		const at = toks[open]!.e;
		return `${src.slice(0, at)}\n${pad}${JSON.stringify(key)}: ${json}${m.empty ? `\n${indentAt(src, toks[open]!.s)}` : ","}${src.slice(at)}`;
	};
	const profiles = member(src, toks, 0, "profiles");
	if (profiles.value === undefined) return put(0, "profiles", { [name]: value });
	if (toks[profiles.value]!.k !== "{") throw new Error("profiles is not an object");
	return put(profiles.value, name, value);
}

// Returns the profile name, or undefined when the file cannot be edited (not readable JSONC, or `profiles` is not an object):
// the process then runs its workers on OmO's defaults. The file is the one OmO reads (omoConfigFile), omo.jsonc included.
function writeProfile(name: string, profile: Record<string, unknown>, file: string): string | undefined {
	let next: string;
	try {
		next = setJsoncProfile(existsSync(file) ? readFileSync(file, "utf8") : "", name, profile);
	} catch (e) {
		log(`omo: ${file} cannot be edited (${(e as Error).message}); ${name} is not written, task workers keep OmO's defaults`);
		return undefined;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeAtomic(file, next);
	return name;
}

export function writeWorkerProfile(lane: { workerModel: string; workerFallback?: string[]; workerSlots?: number }, file = omoConfigFile()): string | undefined {
	const models = [lane.workerModel, ...(lane.workerFallback ?? [])].map(categoryModel);
	return writeProfile(workerProfileName(lane.workerModel), { task: workerTask(lane.workerSlots ?? lanesMaxWorkers()), memory: { enabled: false }, categories: Object.fromEntries(WORKER_CATEGORIES.map(c => [c, { models, prompt_append: WORKER_RULE }])) }, file);
}

// The orchestrator's own task workers had the same gap: OmO's shared rpc host, no dotz, no output caps. Its profile
// moves them into child processes (WORKER_TASK) and turns OmO memory off as for lane workers, and every category runs on
// the orchestrator's own model and effort, then the orchestrator's fallbacks, on the subscription login: work the
// orchestrator defers from a conversation (mail, kakao, a monitor, main) runs on the model the owner talks to (owner
// 2026-10-27: "그 안에서 대화를 할때는 메인 오케스트레이터와 동일한 모델로 진행되어야해"). OmO refuses a `model` beside a
// `category` on a task call, so for category workers this profile is the pin; subagent_type workers are pinned on the call
// (extension/guard.ts pinOmoTaskModel). Without categories they took OmO's defaults, whose
// provider list goes on to `anthropic` (the API key): with the subscription account rate-limited, the orchestrator's
// unspecified-high workers started on a dead API key and failed with 401 "invalid x-api-key" (2026-10-21 00:55 KST).
// API-key fallback entries are left out: a worker never falls back to a key, except when the process itself runs on a keyed
// entry whose `workers` switch is on: the caller then passes that key provider's worker model as `worker` and no chain. A
// child gets the parent's extensions, not its --exclude-tools, so the workers keep every tool.
// (`worker` is the key provider's copy of the worker model, `<provider>-apikey/<id>`, which the child registers itself.)
export const ORCHESTRATOR_WORKERS = "dotz-orchestrator-workers";
// Lookup work runs lighter (owner 2026-10-27): the `quick` category (and the read-only explore/librarian subagent types,
// pinned in extension/guard.ts LOOKUP_PIN) runs Sonnet 5.5 medium on the subscription login, then the orchestrator's own
// models; every other category keeps the orchestrator's model. On an API-key entry (`lookup` null) lookups follow the worker.
export const LOOKUP_MODEL = "anthropic/claude-sonnet-5-5:medium";
export const LOOKUP_CATEGORIES = ["quick"];
export function writeOrchestratorProfile(file = omoConfigFile(), worker = selectorOf(orchestratorModel()), chain = fallbackChain("orchestrator"), lookup: string | null = LOOKUP_MODEL): string | undefined {
	const models = [worker, ...chainAfter(worker, chain).filter(e => !e.key_file).map(e => e.model)].map(categoryModel);
	const lookups = lookup ? [categoryModel(lookup), ...models].filter((m, i, all) => all.findIndex(x => x.model === m.model && x.reasoning === m.reasoning) === i) : models;
	return writeProfile(ORCHESTRATOR_WORKERS, { task: workerTask(), memory: { enabled: false }, categories: Object.fromEntries(WORKER_CATEGORIES.map(c => [c, { models: LOOKUP_CATEGORIES.includes(c) ? lookups : models, prompt_append: WORKER_RULE }])) }, file);
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
// keeps its own memory (state.json, the owner's files), so it is off. Task workers do not inherit the flag, so the lane's
// worker profile turns it off for them (memory.enabled false). Measured 2026-10-20 on a quick worker's first request: 36,054
// -> 34,968 tokens, and no memory binding or projection pin in its session. The rest of the base is OmO's system prompt,
// tool definitions and the skills list (~4.6K, kept: lanes and workers do read skills).
const MEMORY_OFF = "--omo-senpi-memory-disabled";
// The question tool waits for an interactive UI answer that no dotz process gives (it would hang the turn); dotz asks the
// owner in its channels instead.
const NO_ASK = "--no-ask-user";

// Every dotz session's replies are chat messages for the owner. senpi's `chat` prompt surface drops the routing line, the
// Ask / For you / Now / Next handoff block and the todo handoff cues, which otherwise leaked into owner-facing replies
// (web, 2026-10-22; worst on the API-key fallback model). Task workers inherit it; MODE.md says the same for older hosts.
export const PROMPT_SURFACE_ENV = { SENPI_PROMPT_SURFACE: "chat" };

// An API-key fallback entry runs as its own provider, which only exists once the dotz extension has registered it from
// DOTZ_KEY_PROVIDER (hub/fallback.ts keyEnv): the process starts on the entry's own model and is switched to the key
// provider's copy before the first prompt (RPC commands run in order), as on omp.
const keyProviderOf = (o: SpawnOpts) => (o.env.DOTZ_KEY_PROVIDER && o.env.DOTZ_KEY_VALUE && !apiKeyBan() ? (JSON.parse(o.env.DOTZ_KEY_PROVIDER) as { id: string; baseModel: string; models: Array<{ id: string }> }) : undefined);

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
// The model the orchestrator's task workers run on: the one this process starts on (a fallback entry included), not the
// config's primary; on an API-key entry whose workers stay on the subscription, that entry's subscription model.
export function orchestratorWorkerModel(o: SpawnOpts): string {
	const key = keyProviderOf(o);
	if (!key) return o.model;
	const thinking = parseSelector(o.model).thinking;
	return thinking ? `${key.baseModel}:${thinking}` : key.baseModel;
}

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
		const onKey = keyedWorker(o.env);
		const key = keyProviderOf(o);
		const profile = o.lane ? writeWorkerProfile(o.lane) : o.role === "orchestrator" ? (onKey ? writeOrchestratorProfile(undefined, onKey, [], null) : writeOrchestratorProfile(undefined, orchestratorWorkerModel(o))) : undefined;
		const launcher = senpiLauncher();
		// stickyEnv() is the account at spawn; a running process follows later switches by itself (the dotz extension re-pins it at each turn).
		const proc = Bun.spawn(omoArgs(o), { cwd: o.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: withoutApiKeys({ PI_CACHE_RETENTION: "long", ...(process.env.SENPI_BIN || !launcher ? {} : { SENPI_BIN: launcher }), ...process.env, ...stickyEnv(), ...o.env, ...PROMPT_SURFACE_ENV, ...(profile ? { OMO_PROFILE: profile } : {}), DOTZ_RUNTIME: "omo" }) });
		recordStarted(proc.pid);
		void proc.exited.then(() => closeHostsOf(proc.pid));
		const agent = new OmoProcess(proc, o.role === "orchestrator" ? "o" : "h", translateFrame);
		if (key) agent.setModel(`${key.id}/${key.models[0].id}`);
		return agent;
	},
	classifyError: classifyProviderError,
	recentExchanges,
	detect: () => detectBinary(OMO),
};

(omo as RuntimeAdapter & { probes?: unknown }).probes = makeOmoProbes(omo);
