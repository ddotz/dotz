// Owner controls shared by the web API, the web chat box and Discord: model/effort switching, provider and quota
// views, and the slash/bang command parser that drives them.
import { DEFAULT_WORKER_MODEL, entryId, entryOf, FALLBACK_MAX, type FallbackEntry, type FallbackTarget, fallbackChain, isPlain, lanesModel, log, orchestratorModel, parseSelector, selectorOf, setFallbackChain, splitThinking, THINKING_LEVELS, updateModels, workerModel } from "./config.ts";
import { entryView, hubChain, keyFileOk, keyProviderOk } from "./fallback.ts";
import { HARNESS_NAMES, runtimeFor } from "./runtime/index.ts";
import { type Compaction, ctxView, describeCompaction, describeCtx } from "./context.ts";
import * as discord from "./discord.ts";
import { abortLane, applyChainChange as applyLaneChain, compactLane, laneLive, laneModels, lanes, restartLane, resumeByName, setLaneModel, stopLane } from "./lanes.ts";
import { abort as abortOrchestrator, applyChainChange as applyOrchestratorChain, applyModelChange, compact as compactOrchestrator, orch, restart as restartOrchestrator } from "./orchestrator.ts";
import { availableModels, cancelLogin, completeLogin, ControlError, listProviders, loginProviders, logoutProvider, type ModelInfo, pendingLogin, quota, startLogin } from "./providers.ts";

export { ControlError };

const ORCHESTRATOR_NOTE =
	"모델이나 생각 수준을 바꾸면 오케스트레이터가 새 세션으로 다시 시작해요 (최근 대화는 이어받아요). 다음 응답은 평소보다 비용이 더 들 수 있어요.";
const WORKERS_NOTE = `Model of the task workers each lane delegates implementation, tests, renders and grind work to (models.workers, default ${DEFAULT_WORKER_MODEL}). Applies to lanes launched or resumed from now on; a lane keeps the model of its running process until it restarts.`;
const COMPACT_NOTE = "Compaction rewrites the conversation into a summary, so the prompt cache is re-written once on the next turn (about 2x the input cost for the new, shorter prefix).";

const providerOf = (model: string) => model.split("/")[0];
function providersInUse(): Set<string> {
	return new Set([orchestratorModel().model, lanesModel().model, parseSelector(workerModel()).model, ...laneModels().map(l => l.model), ...(["orchestrator", "lanes", "workers"] as const).flatMap(t => fallbackChain(t).map(e => parseSelector(e.model).model))].map(providerOf));
}

const FALLBACK_NOTE = "오케스트레이터와 레인의 폴백 순서는 저장하면 바로 적용돼요: 기본 모델로 도는 중이면 그대로 바뀌고, 폴백 모델로 돌거나 한도로 멈춰 있으면 같은 세션으로 다시 시작해요(일하는 중이면 끝난 뒤). 작업자 폴백은 다음 시작부터예요. 첫 번째 모델이 요청 단계에서 실패하면(사용량 한도, 장애) 순서대로 다음 모델로 넘어가요.";

// Each layer's fallback chain and the models its running processes answer on right now (model ids, thinking stripped),
// so the settings tab can highlight the one in use.
// Harness-aware: `harness` names the runtime that walks the chain; `conditions` says whether entries may carry conditions,
// caps, revert or a key (the hub drives OmO and omp chains; Claude Code takes a plain --fallback-model list and the task
// workers' chain is bare models only); `providers` limits the models that runtime can run (Claude Code: anthropic only).
function fallbacksView() {
	const running = laneModels().filter(l => l.running);
	const ids = (list: Array<string | undefined>) => [...new Set(list.filter((s): s is string => Boolean(s)).map(s => parseSelector(s).model))];
	const harness = (role: "orchestrator" | "lane", target: FallbackTarget) => {
		const id = runtimeFor(role).id;
		return { harness: { id, name: HARNESS_NAMES[id] ?? id }, conditions: target !== "workers" && id !== "claude", ...(id === "claude" ? { providers: ["anthropic"] } : {}) };
	};
	return {
		max: FALLBACK_MAX,
		orchestrator: { chain: fallbackChain("orchestrator").map(entryView), hub_driven: Boolean(hubChain(runtimeFor("orchestrator").id, fallbackChain("orchestrator"))), active: orch.status === "stopped" ? [] : ids([orch.activeModel]), ...harness("orchestrator", "orchestrator") },
		lanes: { chain: fallbackChain("lanes").map(entryView), hub_driven: Boolean(hubChain(runtimeFor("lane").id, fallbackChain("lanes"))), active: ids(running.map(l => l.active_model)), ...harness("lane", "lanes") },
		workers: { chain: fallbackChain("workers").map(entryView), hub_driven: false, active: ids(running.map(l => l.active_worker_model)), ...harness("lane", "workers") },
	};
}

export async function modelsView() {
	return {
		orchestrator: orchestratorModel(),
		lanes_default: lanesModel(),
		workers: parseSelector(workerModel()),
		lanes: laneModels(),
		thinking_levels: [...THINKING_LEVELS],
		available: await availableModels(),
		pickable: modelChoices(await availableModels()),
		notes: { orchestrator: ORCHESTRATOR_NOTE, workers: WORKERS_NOTE, fallback: FALLBACK_NOTE },
		fallbacks: fallbacksView(),
	};
}

// Per-process context size and compaction state (orchestrator first, then every lane).
export function contextView() {
	return {
		note: COMPACT_NOTE,
		processes: [
			{ name: "orchestrator", kind: "orchestrator", status: orch.status, running: orch.status !== "stopped", model: selectorOf(orchestratorModel()), ...ctxView(orch.ctx) },
			...[...lanes.values()].map(l => ({ name: l.name, kind: "lane", status: l.status, live: laneLive(l), running: Boolean(l.proc), model: l.model, ...ctxView(l.ctx) })),
		],
	};
}

// Model pickers never offer Haiku (owner: never) or Fable (only on the owner's explicit ask; still settable by name).
export const HIDDEN_MODEL = /haiku|fable/i;
export const pickable = (list: ModelInfo[]): ModelInfo[] => list.filter(m => !HIDDEN_MODEL.test(m.selector) && !HIDDEN_MODEL.test(m.name ?? ""));
// Pickers show one entry per model as "<Family> <version>" taken from the id, not the provider's free-text name
// ("claude-sonnet-4-20250514" and "claude-sonnet-4-0" are both "Sonnet 4"; "claude-3-5-sonnet-20241022" is "Sonnet 3.5").
// Per family+version the undated alias wins, else the newest snapshot (`keep` wins over both). Opus, Sonnet, then other
// families, newest version first; all but the latest two of a family are marked `older` (folded under '이전 모델').
export type ModelChoice = ModelInfo & { family?: string; version?: string; older: boolean };
const DATED = /-(\d{8})$/;
const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
const ver = (major: string, minor?: string): string => (minor && minor !== "0" ? `${major}.${minor}` : major);
export function modelIdentity(selector: string): { family: string; version: string } | undefined {
	const id = (selector.split("/").pop() ?? "").replace(DATED, "");
	let m = id.match(/^claude-(\d+)(?:-(\d))?-([a-z]+)$/);
	if (m) return { family: cap(m[3]!), version: ver(m[1]!, m[2]) };
	m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/);
	if (m) return { family: cap(m[1]!), version: ver(m[2]!, m[3]) };
	return undefined;
}
const FAMILY_ORDER = ["Opus", "Sonnet"];
export function modelChoices(list: ModelInfo[], keep?: string): ModelChoice[] {
	const rank = (m: ModelInfo): number => (m.selector === keep ? Infinity : DATED.test(m.selector) ? Number(m.selector.match(DATED)![1]) : 1e9);
	const best = new Map<string, ModelChoice>();
	for (const m of pickable(list)) {
		const idn = modelIdentity(m.selector);
		const c: ModelChoice = { ...m, ...(idn ? { name: `${idn.family} ${idn.version}`, family: idn.family, version: idn.version } : {}), older: false };
		const key = idn ? `${m.provider}|${idn.family}|${idn.version}` : `${m.provider}|${m.name}`;
		const prev = best.get(key);
		if (!prev || rank(c) > rank(prev)) best.set(key, c);
	}
	const fam = (c: ModelChoice): number => (!c.family ? 99 : FAMILY_ORDER.includes(c.family) ? FAMILY_ORDER.indexOf(c.family) : 50);
	const num = (v?: string): number[] => (v ?? "0").split(".").map(Number);
	const out = [...best.values()].sort((a, b) => {
		if (fam(a) !== fam(b)) return fam(a) - fam(b);
		if (a.family !== b.family) return (a.family ?? "").localeCompare(b.family ?? "");
		const [x, y] = [num(a.version), num(b.version)];
		return (y[0]! - x[0]!) || ((y[1] ?? 0) - (x[1] ?? 0));
	});
	const seen = new Map<string, number>();
	for (const c of out) {
		if (!c.family) continue;
		const n = seen.get(c.family) ?? 0;
		seen.set(c.family, n + 1);
		c.older = n >= 2;
	}
	return out;
}

// The composer's chip popovers: model, effort and context of one chat target ("main" or "lane:<name>").
const targetKey = (target: string): string => (target === "main" || target === "orchestrator" ? "orchestrator" : `lane:${target.replace(/^lane:/, "")}`);
export async function targetView(target: string) {
	const key = targetKey(target);
	const lane = key === "orchestrator" ? undefined : lanes.get(key.slice(5));
	if (key !== "orchestrator" && !lane) throw new ControlError(`no lane ${key.slice(5)}`, 404);
	const cur = lane ? parseSelector(lane.model) : orchestratorModel();
	const proc = contextView().processes.find(p => p.name === (lane ? lane.name : "orchestrator"))!;
	const models = modelChoices(await availableModels(), cur.model);
	return {
		target: lane ? `lane:${lane.name}` : "main",
		key,
		model: cur.model,
		thinking: cur.thinking,
		active_model: lane ? lane.activeModel : orch.activeModel,
		running: proc.running,
		busy: lane ? lane.status === "working" || lane.status === "starting" : orch.status === "working",
		context: { tokens: proc.tokens, window: proc.window, percent: proc.percent, compaction: proc.compaction },
		models: models.some(m => m.selector === cur.model) ? models : [...models, ...(await availableModels()).filter(m => m.selector === cur.model).map(m => ({ ...m, older: false }))],
		thinking_levels: [...THINKING_LEVELS],
		note: lane ? "" : ORCHESTRATOR_NOTE,
	};
}
// Changes the target in place: model and/or effort (setModel's rules: a running lane needs force), or compacts its context.
export async function changeTarget(target: string, change: { model?: string; thinking?: string; compact?: boolean; force?: boolean }) {
	const key = targetKey(target);
	if (change.compact) {
		const r = compactTarget(key === "orchestrator" ? key : key.slice(5));
		return { ok: true, target: key, compaction: r.compaction.state, note: r.message };
	}
	return setModel(key, change.model, change.thinking, change.force === true);
}

const ctxLine = (p: { status: string; running: boolean; tokens: number; window: number; percent: number | null; compaction: Compaction }) => {
	const state = describeCompaction(p.compaction);
	return `${p.status} · context ${p.running ? describeCtx(p) : "n/a (not running)"}${state ? ` · ${state}` : ""}`;
};

export const providersView = async () => listProviders(providersInUse());

// Exact selector first; otherwise one unique substring match on selector or display name ("opus", "gpt-5").
function resolveModel(input: string, available: ModelInfo[]): string {
	const q = input.trim().toLowerCase();
	if (!available.length) return input.trim();
	const exact = available.find(m => m.selector.toLowerCase() === q);
	if (exact) return exact.selector;
	const hits = available.filter(m => m.selector.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
	if (hits.length === 1) return hits[0].selector;
	if (!hits.length) throw new ControlError(`unknown model "${input}" (see GET /api/models or /model)`);
	throw new ControlError(`"${input}" matches ${hits.length} models: ${hits.slice(0, 8).map(m => m.selector).join(", ")}${hits.length > 8 ? ", ..." : ""}`);
}

export type ModelChange = { ok: true; target: string; model: string; thinking: string; applied: "live" | "restarted" | "next-start"; note: string };

// A running lane's model or effort change is refused without force: it invalidates that lane's whole message cache.
export class ForceRequired extends ControlError {
	constructor(message: string, readonly contextTokens: number) {
		super(message, 409);
	}
}

function laneCacheWarning(name: string): ForceRequired {
	const ctx = lanes.get(name)!.ctx;
	return new ForceRequired(
		`Lane ${name} is running with a context of ${describeCtx(ctx)}. Anthropic invalidates the message cache when the model or the output effort changes, and omp cannot change effort per message for anthropic (supportsPerMessageEffort=false), so the next turn re-writes that whole context into the cache (about 2x the input price). Nothing was changed. To confirm, repeat the command with --force (API: "force": true).`,
		ctx.tokens,
	);
}

// `modelInput` may carry the thinking level as "<model>:<level>"; an explicit `thinkingInput` wins.
export async function setModel(target: string, modelInput?: string, thinkingInput?: string, force = false): Promise<ModelChange> {
	const split = modelInput ? splitThinking(modelInput) : undefined;
	const model = split?.model;
	const thinking = thinkingInput ?? split?.thinking;
	if (!model && !thinking) throw new ControlError("model or thinking required");
	if (thinking && !(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new ControlError(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	let current: { model: string; thinking: string };
	if (target === "orchestrator") current = orchestratorModel();
	else if (target === "lanes") current = lanesModel();
	else if (target === "workers") current = parseSelector(workerModel());
	else if (target.startsWith("lane:") && lanes.has(target.slice(5))) current = parseSelector(lanes.get(target.slice(5))!.model);
	else throw new ControlError(`target must be "orchestrator", "lanes", "workers" or "lane:<name>" of an existing lane (got "${target}")`);
	const next = { model: model ? resolveModel(model, await availableModels()) : current.model, thinking: thinking ?? current.thinking };
	const done = (applied: ModelChange["applied"], note: string): ModelChange => ({ ok: true, target, ...next, applied, note });
	if (next.model === current.model && next.thinking === current.thinking) return done("live", "unchanged");
	if (target === "orchestrator") {
		updateModels("orchestrator", next);
		const applied = applyModelChange();
		return done(applied, applied === "restarted" ? `Orchestrator restarting on ${selectorOf(next)}. ${ORCHESTRATOR_NOTE}` : `Saved. The orchestrator switches to ${selectorOf(next)} when its current turn ends (or on its next start). ${ORCHESTRATOR_NOTE}`);
	}
	if (target === "lanes") {
		updateModels("lanes", next);
		return done("next-start", "Saved. Lanes launched from now on use it; running lanes keep their model (change one with a lane target).");
	}
	if (target === "workers") {
		updateModels("workers", next);
		return done("next-start", `Saved as models.workers. Lanes launched or resumed from now on run their task workers on ${selectorOf(next)}; a lane already running keeps its workers' model until it restarts.`);
	}
	const name = target.slice(5);
	if (lanes.get(name)!.proc && !force) throw laneCacheWarning(name);
	const applied = await setLaneModel(name, selectorOf(next));
	return done(applied, applied === "restarted" ? `Lane ${name} restarted on ${selectorOf(next)}, resuming its session.` : `Saved. Lane ${name} uses it when it is next resumed.`);
}

// Replaces one layer's fallback chain (applies the next time a process of that layer starts). Entries are checked against
// the model catalog like a model switch is; an entry may carry a thinking suffix, otherwise it inherits the failing turn's.
// Conditions, caps, revert and API keys are the hub's own switching (orchestrator and lanes); the task workers' chain is omp's, bare models only.
export async function setFallback(target: string, chain: unknown[]) {
	if (target !== "orchestrator" && target !== "lanes" && target !== "workers") throw new ControlError(`target must be "orchestrator", "lanes" or "workers" (got "${target}")`);
	if (chain.length > FALLBACK_MAX) throw new ControlError(`at most ${FALLBACK_MAX} fallback models per chain (got ${chain.length})`);
	const available = await availableModels();
	const primary = target === "orchestrator" ? orchestratorModel().model : target === "lanes" ? lanesModel().model : parseSelector(workerModel()).model;
	const seen = new Set<string>();
	const clean: FallbackEntry[] = [];
	const claudeRuns = runtimeFor(target === "orchestrator" ? "orchestrator" : "lane").id === "claude";
	for (const input of chain) {
		const entry = entryOf(input);
		if (!entry) throw new ControlError("each fallback entry needs a model");
		const split = splitThinking(entry.model);
		if (split.thinking && !(THINKING_LEVELS as readonly string[]).includes(split.thinking)) throw new ControlError(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
		const model = resolveModel(split.model, available);
		const next: FallbackEntry = { ...entry, model: split.thinking ? `${model}:${split.thinking}` : model };
		if (target === "workers" && !isPlain(next)) throw new ControlError("the task workers' chain takes bare models only (conditions, caps, revert and API keys apply to the orchestrator and the lanes)");
		if (claudeRuns && !isPlain(next)) throw new ControlError("Claude Code takes a plain fallback list: no conditions, caps, revert or API keys");
		if (claudeRuns && !model.startsWith("anthropic/")) throw new ControlError(`Claude Code runs anthropic models only (got ${model})`);
		if (next.key_file && !keyFileOk(next.key_file)) throw new ControlError(`key_file "${next.key_file}" must name an existing file in <data dir>/secrets/ whose name contains "api-key" or "api_key" (for example anthropic-api-key)`);
		if (next.key_file && !keyProviderOk(next)) throw new ControlError("API-key entries support anthropic, openai and openrouter models, and the key goes over https only to the provider's own API host or a host listed in config.json key_hosts (set base_url and api on the entry for another provider)");
		if (!next.key_file && next.model === primary) continue;
		if (seen.has(entryId(next))) continue;
		seen.add(entryId(next));
		clean.push(next);
	}
	const changed = JSON.stringify(fallbackChain(target as FallbackTarget)) !== JSON.stringify(clean);
	setFallbackChain(target as FallbackTarget, clean);
	// Running processes take the new chain now (an API key added while the subscription is out must work on the next turn).
	const applied = !changed || target === "workers" ? "next-start" : target === "orchestrator" ? applyOrchestratorChain() : (applyLaneChain(), "updated");
	return { ok: true, target, chain: clean.map(entryView), applied, note: FALLBACK_NOTE };
}

const COMMANDS = ["help", "status", "context", "compact", "lanes", "model", "effort", "restart", "stop", "resume", "abort", "providers", "login", "logout", "quota"];

// "/name args" or "!name args" with a known command name; anything else is not a command.
export function parseCommand(text: string): { name: string; args: string[]; rest: string } | undefined {
	const m = text.trim().match(/^[/!]([a-z]+)(?:\s+([\s\S]*))?$/i);
	const name = m?.[1].toLowerCase();
	if (!m || !name || !COMMANDS.includes(name)) return undefined;
	const rest = (m[2] ?? "").trim();
	return { name, args: rest ? rest.split(/\s+/) : [], rest };
}
// A web message shaped like a slash command ("/word" alone or followed by arguments), known or not; file paths do not match.
export const looksLikeCommand = (text: string) => /^\/[a-z]+(\s|$)/i.test(text.trim());

const HELP = `/status                          orchestrator, lanes and Discord state, with context usage
/context                         context tokens / window / % and compaction state per process
/compact <orchestrator|<lane>>   compact that process's context (queued after its current turn if it is working)
/lanes                           each lane: status, model, folder
/model                           models of the orchestrator, lane default, task workers and every lane
/model <target> [<model>] [<thinking>]   show or set; target = orchestrator | lanes | workers | <lane>
/effort <target> <level>         thinking level (${THINKING_LEVELS.join(", ")})
(a running lane's model or effort change is refused without --force: it re-writes that lane's whole prompt cache)
/restart orchestrator|<lane>     restart the agent process, resuming its session
/restart gateway                 restart the whole gateway once the orchestrator and lanes are idle (max 20 min)
/stop <lane>                     stop a lane (resume later)
/resume <lane> [text]            resume a stopped lane, or send text to a running one
/abort [orchestrator|<lane>]     cancel the current turn (default: orchestrator)
/providers                       logins and API keys (masked), models per provider
/login [<provider>]              sign in to a provider (opens a link); /login <provider> <code> finishes it, /login cancel aborts
/logout <provider>               sign out and remove the stored key or login
/quota                           usage limits per provider and model window
Discord also accepts the "!" prefix. A model can be a unique part of its name ("opus").`;

// The gateway restart lives in main.ts (it owns the message ledger and shutdown); main registers it here.
let gatewayRestart: () => string = () => "gateway restart is not available in this process";
export function setGatewayRestart(fn: () => string): void {
	gatewayRestart = fn;
}

const normalizeTarget = (arg: string) => (arg === "orchestrator" || arg === "lanes" || arg === "workers" ? arg : `lane:${arg.replace(/^lane:/, "")}`);

function describe(target: string): string {
	const cur = target === "orchestrator" ? orchestratorModel() : target === "lanes" ? lanesModel() : target === "workers" ? parseSelector(workerModel()) : lanes.has(target.slice(5)) ? parseSelector(lanes.get(target.slice(5))!.model) : undefined;
	if (!cur) throw new ControlError(`unknown target "${target.replace(/^lane:/, "")}" (orchestrator, lanes, workers, or a lane name; /lanes lists them)`);
	return `${target === "lanes" ? "lanes (default)" : target === "workers" ? "workers (task workers of every lane)" : target}: ${cur.model} (thinking ${cur.thinking})`;
}

// Compacts one process: "orchestrator" or a lane name. A working process queues it until its turn ends.
export function compactTarget(arg: string): { target: string; compaction: Compaction; message: string } {
	const orchestrator = arg === "orchestrator";
	const target = orchestrator ? arg : arg.replace(/^lane:/, "");
	const compaction = orchestrator ? compactOrchestrator() : compactLane(target);
	const what = compaction.state === "queued" ? "is working: compaction queued, it starts right after the current turn ends" : compaction.state === "compacting" ? "is compacting now" : describeCompaction(compaction);
	return { target, compaction, message: `${orchestrator ? "orchestrator" : `lane ${target}`} ${what}. ${COMPACT_NOTE}` };
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "-");

export async function runCommand(text: string): Promise<string> {
	const cmd = parseCommand(text);
	if (!cmd) throw new ControlError(`unknown command "${text.trim().split(/\s+/)[0]}"; /help lists them`);
	const isForce = (a: string) => a === "--force" || a === "force";
	const force = cmd.args.some(isForce);
	const [first, second, third] = cmd.args.filter(a => !isForce(a));
	switch (cmd.name) {
		case "help":
			return HELP;
		case "status": {
			const all = [...lanes.values()];
			const o = orchestratorModel();
			const view = contextView().processes;
			return [
				`orchestrator: ${o.model} (thinking ${o.thinking}) · ${ctxLine(view[0])}${orch.status === "rate-limited" ? ` · until ${orch.rateLimitedUntil}` : ""}`,
				`lanes: ${all.length} (${all.filter(l => l.status === "working").length} working) · task workers ${workerModel()}`,
				...view.slice(1).filter(p => p.running).map(p => `  ${p.name}: ${ctxLine(p)}`),
				`discord: ${discord.status.enabled ? (discord.status.connected ? "connected" : "disconnected") : "off"}`,
			].join("\n");
		}
		case "context":
			return [...contextView().processes.map(p => `${p.name.padEnd(14)} ${ctxLine(p)}`), COMPACT_NOTE].join("\n");
		case "compact":
			if (!first) throw new ControlError("usage: /compact <orchestrator|lane>");
			return compactTarget(first).message;
		case "lanes":
			return lanes.size ? [...lanes.values()].map(l => `${l.name}  ${l.status}  ${l.model}  ${l.cwd}`).join("\n") : "no lanes";
		case "model": {
			if (!first) return ["orchestrator", "lanes", "workers", ...lanes.keys()].map(t => describe(normalizeTarget(t))).join("\n");
			const target = normalizeTarget(first);
			if (!second) return describe(target);
			const levelOnly = !third && (THINKING_LEVELS as readonly string[]).includes(second);
			const r = await setModel(target, levelOnly ? undefined : second, levelOnly ? second : third, force);
			return `${r.target}: ${r.model} (thinking ${r.thinking}) - ${r.applied}. ${r.note}`;
		}
		case "effort": {
			if (!first || !second) throw new ControlError("usage: /effort <orchestrator|lanes|lane> <level>");
			const r = await setModel(normalizeTarget(first), undefined, second, force);
			return `${r.target}: ${r.model} (thinking ${r.thinking}) - ${r.applied}. ${r.note}`;
		}
		case "restart":
			if (first === "gateway") return gatewayRestart();
			if (first === "orchestrator") {
				restartOrchestrator();
				return "orchestrator restarting";
			}
			if (!first) throw new ControlError("usage: /restart gateway|orchestrator|<lane>");
			await restartLane(first);
			return `lane ${first} restarted`;
		case "stop":
			if (!first) throw new ControlError("usage: /stop <lane>");
			stopLane(first);
			void discord.releaseLane(first, lanes.get(first)).catch(e => log(`lane ${first} thread release failed: ${e}`));
			return `lane ${first} stopping`;
		case "resume":
			if (!first) throw new ControlError("usage: /resume <lane> [text]");
			resumeByName(first, cmd.rest.slice(first.length).trim() || undefined);
			return `lane ${first} resumed`;
		case "abort":
			if (!first || first === "orchestrator") {
				abortOrchestrator();
				return "orchestrator turn aborted";
			}
			abortLane(first);
			return `lane ${first} turn aborted`;
		case "providers": {
			const { providers: rows, addable } = await providersView();
			const lines = rows.map(p => `${p.id}  ${p.auth === "oauth" ? `로그인${p.account ? ` ${p.account}` : ""}` : p.auth === "api_key" ? `API 키${p.masked ? ` ${p.masked}` : ""}` : "연결 안 됨"}  모델 ${p.models}개${p.in_use ? "  사용 중" : ""}`);
			if (addable.length) lines.push("", `추가할 수 있는 공급자: ${addable.map(a => a.id).join(", ")}`);
			return lines.join("\n") || "공급자가 없어요";
		}
		case "login": {
			const code = cmd.rest.slice(first?.length ?? 0).trim();
			const pending = pendingLogin();
			if (!first) {
				const names = await loginProviders();
				return `사용법: /login <공급자> (진행 중인 로그인 취소: /login cancel)\n${names.map(p => `${p.id}  ${p.name}`).join("\n")}`;
			}
			if (first === "cancel") {
				if (!pending) return "진행 중인 로그인이 없어요";
				await cancelLogin(pending.provider);
				return `${pending.provider} 로그인을 취소했어요`;
			}
			if (pending && pending.provider === first && code) {
				const r = await completeLogin(first, pending.id, code);
				return r.status === "done" ? `${first} 로그인이 끝났어요` : `${r.url ? `${r.url}\n` : ""}${r.instructions ? `${r.instructions}\n` : ""}${r.prompt ?? "다음 값이 더 필요해요"}\n/login ${first} <값> 으로 보내 주세요`;
			}
			if (pending) throw new ControlError(pending.provider === first ? `${first} 로그인이 진행 중이에요. 브라우저에서 승인을 마치거나 코드를 /login ${first} <코드> 로 보내 주세요` : `${pending.provider} 로그인이 진행 중이에요. /login cancel 로 취소해 주세요`, 409);
			const r = await startLogin(first);
			return [
				r.url ? `아래 주소를 열어 로그인해 주세요 (10분 안에):\n${r.url}` : "",
				r.instructions ?? "",
				r.needs_code ? `이 기기에서 열었다면 자동으로 끝나요. 다른 기기라면 이동한 주소창의 전체 주소(또는 코드)를 /login ${first} <주소 또는 코드> 로 보내 주세요.${r.prompt ? `\n(${r.prompt})` : ""}` : "승인이 끝나면 /providers 에 나타나요.",
				"취소: /login cancel",
			].filter(Boolean).join("\n");
		}
		case "logout":
			if (!first) throw new ControlError("사용법: /logout <공급자>");
			await logoutProvider(first);
			return `${first} 로그아웃했어요. 이미 실행 중인 작업은 다시 시작할 때까지 이전 로그인을 쓸 수 있어요`;
		case "quota": {
			const q = await quota();
			const lines = q.providers.flatMap(p => [p.account ? `${p.provider} (${p.account})` : p.provider, ...p.limits.map(l => `  ${l.label} [${l.window}]: ${l.used ?? "?"}/${l.limit ?? "?"} ${l.unit} used, ${l.remaining ?? "?"} left, resets ${when(l.resets_at)} (${l.status})`)]);
			for (const u of q.unavailable) lines.push(`${u.provider}: ${u.reason}`);
			return lines.join("\n") || "사용량 정보가 없어요";
		}
		default:
			throw new ControlError(`unknown command "${cmd.name}"`);
	}
}
