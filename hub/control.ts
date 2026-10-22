// Owner controls shared by the web API, the web chat box and Discord: model/effort switching, provider and quota
// views, and the slash/bang command parser that drives them.
import { DEFAULT_WORKER_MODEL, entryId, NAME, entryOf, FALLBACK_MAX, type FallbackEntry, type FallbackTarget, fallbackChain, isPlain, lanesModel, log, orchestratorModel, parseSelector, selectorOf, setFallbackChain, splitThinking, THINKING_LEVELS, TZ, updateModels, workerModel } from "./config.ts";
import { label, readAliases } from "./account-alias.ts";
import { AccountsError, accountCommand } from "./accounts-api.ts";
import { entryView, hubChain, keyFileOk, keyProviderOk } from "./fallback.ts";
import { HARNESS_NAMES, runtimeFor } from "./runtime/index.ts";
import { homedir } from "node:os";
import { type Compaction, ctxView, describeCompaction, describeCtx, kTokens } from "./context.ts";
import { msg } from "./i18n.ts";
import { RESTART_NOTICE_MS } from "./restart.ts";
import type { AccountSwitch } from "./account-sticky.ts";
import type { AccountReport } from "./usage-account.ts";
import * as discord from "./discord.ts";
import { keepHome } from "./lanestate.ts";
import { abortLane, applyChainChange as applyLaneChain, compactLane, laneLive, laneModels, lanes, restartLane, resumeByName, setLaneModel, stopLane } from "./lanes.ts";
import { abort as abortOrchestrator, applyChainChange as applyOrchestratorChain, applyModelChange, compact as compactOrchestrator, orch, restart as restartOrchestrator } from "./orchestrator.ts";
import { availableModels, cancelLogin, completeLogin, ControlError, listProviders, loginProviders, logoutProvider, type ModelInfo, pendingLogin, quota, startLogin } from "./providers.ts";

export { ControlError };

const ORCHESTRATOR_NOTE =
	"모델이나 추론 강도를 바꿔도 같은 세션에서 바로 이어가요. 추론 강도만 바꾸면 캐시가 그대로고, 모델을 바꾸면 다음 응답 한 번은 캐시를 새로 써서 비용이 더 들어요.";
const WORKERS_NOTE = `Model of the task workers each lane delegates implementation, tests, renders and grind work to (models.workers, default ${DEFAULT_WORKER_MODEL}). Applies to lanes launched or resumed from now on; a lane keeps the model of its running process until it restarts.`;
const COMPACT_NOTE = "Compaction rewrites the conversation into a summary, so the prompt cache is re-written once on the next turn (about 2x the input cost for the new, shorter prefix).";

const providerOf = (model: string) => model.split("/")[0];
function providersInUse(): Set<string> {
	return new Set([orchestratorModel().model, lanesModel().model, parseSelector(workerModel()).model, ...laneModels().map(l => l.model), ...(["orchestrator", "lanes", "workers"] as const).flatMap(t => fallbackChain(t).map(e => parseSelector(e.model).model))].map(providerOf));
}

const FALLBACK_NOTE = "어시스턴트와 세션의 폴백 순서는 저장하면 바로 적용돼요: 기본 모델로 도는 중이면 그대로 바뀌고, 폴백 모델로 돌거나 한도로 멈춰 있으면 같은 세션으로 다시 시작해요(일하는 중이면 끝난 뒤). 서브에이전트 폴백은 다음 시작부터예요. 첫 번째 모델이 요청 단계에서 실패하면(사용량 한도, 장애) 순서대로 다음 모델로 넘어가요.";

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
const HIDDEN_MODEL = /haiku|fable/i;
export const pickable = (list: ModelInfo[]): ModelInfo[] => list.filter(m => !HIDDEN_MODEL.test(m.selector) && !HIDDEN_MODEL.test(m.name ?? ""));
// Pickers show one entry per model as "<Family> <version>" taken from the id, not the provider's free-text name
// ("claude-sonnet-4-20250514" and "claude-sonnet-4-0" are both "Sonnet 4"; "claude-3-5-sonnet-20241022" is "Sonnet 3.5").
// Per family+version the undated alias wins, else the newest snapshot (`keep` wins over both). Opus, Sonnet, then other
// families, newest version first; all but the latest two of a family are marked `older` (folded under '이전 모델').
type ModelChoice = ModelInfo & { family?: string; version?: string; older: boolean };
const DATED = /-(\d{8})$/;
const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
const ver = (major: string, minor?: string): string => (minor && minor !== "0" ? `${major}.${minor}` : major);
function modelIdentity(selector: string): { family: string; version: string } | undefined {
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

type ModelChange = { ok: true; target: string; model: string; thinking: string; applied: "live" | "restarted" | "next-start"; note: string };

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

// OmO sends an effort change as a per-message effort marker on these models (senpi anthropic-messages, compat
// supportsMidConvoEffort; Anthropic docs "Change effort mid-conversation"), so the prompt cache survives it.
const MID_CONVO_EFFORT = /claude-(opus-5|opus-5-5|sonnet-5-5|haiku-5-5|fable-5-1|mythos-5-1)$/;
const keepsCacheOnEffort = (runtime: string, model: string) => runtime === "omo" && MID_CONVO_EFFORT.test(model);

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
		return done(applied, applied === "live" ? `Orchestrator switched to ${selectorOf(next)} on its session. ${ORCHESTRATOR_NOTE}` : applied === "restarted" ? `Orchestrator restarting on ${selectorOf(next)}. ${ORCHESTRATOR_NOTE}` : `Saved. The orchestrator switches to ${selectorOf(next)} when its current turn ends (or on its next start). ${ORCHESTRATOR_NOTE}`);
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
	const cacheKept = next.model === current.model && keepsCacheOnEffort(runtimeFor("lane").id, next.model);
	if (lanes.get(name)!.proc && !force && !cacheKept) throw laneCacheWarning(name);
	const applied = await setLaneModel(name, selectorOf(next));
	return done(applied, applied === "live" ? `Lane ${name} switched to ${selectorOf(next)} on its session.` : applied === "restarted" ? `Lane ${name} restarted on ${selectorOf(next)}, resuming its session.` : `Saved. Lane ${name} uses it when it is next resumed.`);
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
	const known = new Set(fallbackChain(target as FallbackTarget).map(entryId));
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
		// A newly registered API-key entry starts off: the owner switches it on when the key should be spent.
		if (next.key_file && next.enabled === undefined && !known.has(entryId(next))) next.enabled = false;
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

const COMMANDS = ["help", "status", "context", "compact", "lanes", "model", "effort", "restart", "stop", "resume", "abort", "providers", "login", "logout", "quota", "account"];

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

// What a command answers: a compact card for the web chat (title, tone dot, label/value rows, a note, buttons that send a
// command) and `text`, the same answer as plain markdown for Discord and the terminal. Texts live in the i18n catalog.
type CardTone = "ok" | "busy" | "warn" | "err";
type CommandCard = { title: string; tone?: CardTone; facts: { label: string; value: string }[]; note?: string; actions?: { label: string; send: string }[]; text: string };
// At most this many model choices are offered as buttons.
const CARD_CHOICES_MAX = 5;

const T = () => msg().cmd;
function card(title: string, facts: CommandCard["facts"] = [], rest: Pick<CommandCard, "tone" | "note" | "actions"> = {}): CommandCard {
	const text = [
		`**${title}**`,
		...facts.map(f => (f.value.includes("\n") ? `${f.label}\n${f.value}` : `${f.label}: ${f.value}`)),
		...(rest.note ? [rest.note] : []),
		...(rest.actions?.length ? [rest.actions.map(a => `\`${a.send}\``).join("  ")] : []),
	].join("\n");
	return { title, ...rest, facts, text };
}

type Proc = ReturnType<typeof contextView>["processes"][number];
const clock = (ms: number) => new Date(ms).toLocaleString(msg().harness.locale, { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const word = (status: string) => msg().harness.status[status] ?? status;
const toneOf = (status: string): CardTone | undefined => (status === "working" || status === "starting" ? "busy" : status === "rate-limited" ? "warn" : status === "idle" ? "ok" : undefined);
const laneLabel = (name: string) => lanes.get(name)?.title || name;
// "Opus 5.5", not "anthropic/claude-opus-5-5": the family and version the pickers show, else the id's last part.
const modelName = (selector: string) => { const m = parseSelector(selector).model, id = modelIdentity(m); return id ? `${id.family} ${id.version}` : (m.split("/").pop() ?? m); };
const whoIs = (target: string) => (target === "orchestrator" ? NAME : target === "lanes" ? T().newSessions : target === "workers" ? T().subagents : laneLabel(target.replace(/^lane:/, "")));
function ctxValue(p: Proc): string {
	const t = T();
	if (!p.running) return t.notRunning;
	const figure = p.window ? t.usage(`${Math.round(p.percent ?? 0)}%`, kTokens(p.tokens), kTokens(p.window)) : kTokens(p.tokens);
	return [figure, p.compaction.state ? t.compaction[p.compaction.state] : ""].filter(Boolean).join(" · ");
}

// A failed command is an err card: the first line of the reason, with the home folder shortened.
function errorCard(e: unknown, text: string): CommandCard {
	const t = T();
	if (e instanceof ForceRequired) return card(t.failed, [], { tone: "err", note: t.forceNote, actions: [{ label: t.applyAnyway, send: `${text.trim()} --force` }] });
	if (!(e instanceof ControlError)) log(`command ${text.trim().split(/\s+/)[0]} failed: ${e}`);
	const reason = String((e as Error)?.message ?? e).split("\n")[0]!.replaceAll(homedir(), "~");
	return card(t.failed, [], { tone: "err", note: reason });
}

// The "한도" answer: each window's remaining share and reset time, and the last account switch.
// The 한도 card names accounts by the owner's aliases; the raw ids go on one note line, only when they differ.
export function limitsCard(r: AccountReport | undefined, last: AccountSwitch | undefined, aliases = readAliases()): CommandCard {
	const t = T();
	if (!r) return card(t.quotaTitle, [], { tone: "warn", note: t.readFailed });
	const lab = (n: string) => label(n, undefined, aliases);
	const facts = r.limits.map(l => ({ label: t.windows[l.id] ?? l.label, value: [t.left(`${Math.round(l.amount.remaining)}%`), l.window.resetsAt ? t.resets(clock(l.window.resetsAt)) : ""].filter(Boolean).join(" · ") }));
	facts.push({ label: t.account, value: lab(r.account) });
	const moved = last && last.kind !== "start" ? last : undefined;
	if (moved) facts.push({ label: t.lastSwitch, value: `${clock(Date.parse(moved.at))} · ${moved.from ? lab(moved.from) : t.none} → ${lab(moved.to)}` });
	const ids = moved ? [moved.from, moved.to].filter((x): x is string => Boolean(x)) : [r.account];
	const idLine = ids.some(n => lab(n) !== n) ? `${t.accountId}: ${ids.join(" → ")}` : undefined;
	const note = [r.problem ? t.problem[r.problem] : r.limits.length ? undefined : t.noLimits, idLine].filter(Boolean).join("\n") || undefined;
	return card(t.quotaTitle, facts, { tone: r.problem ? "warn" : undefined, note });
}

// The gateway restart lives in main.ts (it owns the message ledger and shutdown); main registers it here.
let gatewayRestart: () => string = () => {
	throw new ControlError("gateway restart is not available in this process");
};
export function setGatewayRestart(fn: () => string): void {
	gatewayRestart = fn;
}

const normalizeTarget = (arg: string) => (arg === "orchestrator" || arg === "lanes" || arg === "workers" ? arg : `lane:${arg.replace(/^lane:/, "")}`);

function currentOf(target: string): { model: string; thinking: string } {
	const cur = target === "orchestrator" ? orchestratorModel() : target === "lanes" ? lanesModel() : target === "workers" ? parseSelector(workerModel()) : lanes.has(target.slice(5)) ? parseSelector(lanes.get(target.slice(5))!.model) : undefined;
	if (!cur) throw new ControlError(`unknown target "${target.replace(/^lane:/, "")}" (orchestrator, lanes, workers, or a lane name; /lanes lists them)`);
	return cur;
}

// Compacts one process: "orchestrator" or a lane name. A working process queues it until its turn ends.
export function compactTarget(arg: string): { target: string; compaction: Compaction; message: string } {
	const orchestrator = arg === "orchestrator";
	const target = orchestrator ? arg : arg.replace(/^lane:/, "");
	const compaction = orchestrator ? compactOrchestrator() : compactLane(target);
	const what = compaction.state === "queued" ? "is working: compaction queued, it starts right after the current turn ends" : compaction.state === "compacting" ? "is compacting now" : describeCompaction(compaction);
	return { target, compaction, message: `${orchestrator ? "orchestrator" : `lane ${target}`} ${what}. ${COMPACT_NOTE}` };
}

// One button per pickable model (the list the model picker shows, newest first), each sending the command that switches `arg`.
async function modelActions(arg: string, current: string): Promise<CommandCard["actions"]> {
	try {
		return modelChoices(await availableModels(), current).filter(m => !m.older && m.selector !== current).slice(0, CARD_CHOICES_MAX).map(m => ({ label: m.name, send: `/model ${arg} ${m.selector}` }));
	} catch (e) {
		log(`model choices unavailable: ${e}`);
		return [];
	}
}

async function targetCard(arg: string, kind: "model" | "effort"): Promise<CommandCard> {
	const t = T(), target = normalizeTarget(arg), cur = currentOf(target);
	const actions = kind === "model" ? await modelActions(arg, cur.model) : THINKING_LEVELS.filter(l => l !== cur.thinking).map(l => ({ label: l, send: `/effort ${arg} ${l}` }));
	return card((kind === "model" ? t.modelTitle : t.effortTitle)(whoIs(target)), [{ label: t.model, value: modelName(cur.model) }, { label: t.effort, value: cur.thinking }], { actions });
}

function changedCard(r: ModelChange): CommandCard {
	const t = T(), unchanged = r.note === "unchanged";
	return card((unchanged ? t.unchanged : t.updated)(whoIs(r.target)), [{ label: t.model, value: modelName(r.model) }, { label: t.effort, value: r.thinking }], { tone: "ok", note: unchanged ? undefined : [t.applied[r.applied] ?? r.applied, r.target === "orchestrator" ? ORCHESTRATOR_NOTE : ""].filter(Boolean).join(". ") });
}

export async function runCommand(text: string): Promise<CommandCard> {
	try {
		return await execute(text);
	} catch (e) {
		return errorCard(e, text);
	}
}

async function execute(text: string): Promise<CommandCard> {
	const cmd = parseCommand(text);
	if (!cmd) throw new ControlError(`unknown command "${text.trim().split(/\s+/)[0]}"; /help lists them`);
	const t = T();
	const isForce = (a: string) => a === "--force" || a === "force";
	const force = cmd.args.some(isForce);
	const [first, second, third] = cmd.args.filter(a => !isForce(a));
	switch (cmd.name) {
		case "help": {
			const h = t.help(THINKING_LEVELS.join(", "), RESTART_NOTICE_MS / 60_000);
			return card(h.title, h.groups.map(g => ({ label: g.label, value: g.items.map(([c, d]) => `${c}  ${d}`).join("\n") })), { note: h.note });
		}
		case "status": {
			const all = [...lanes.values()];
			const o = orchestratorModel();
			const view = contextView().processes;
			const until = orch.status === "rate-limited" && !Number.isNaN(new Date(orch.rateLimitedUntil).getTime()) ? t.until(clock(new Date(orch.rateLimitedUntil).getTime())) : "";
			const discordState = discord.status.enabled ? (discord.status.connected ? t.discord.connected : t.discord.disconnected) : t.discord.off;
			return card(
				t.statusTitle,
				[
					{ label: NAME, value: [word(orch.status), until, ctxValue(view[0])].filter(Boolean).join(" · ") },
					{ label: t.model, value: `${modelName(o.model)} · ${o.thinking}` },
					{ label: t.sessions, value: t.sessionsValue(all.length, word("working"), all.filter(l => l.status === "working").length) },
					...view.slice(1).filter(p => p.running).map(p => ({ label: laneLabel(p.name), value: `${word(p.status)} · ${ctxValue(p)}` })),
					{ label: t.subagents, value: `${modelName(workerModel())} · ${parseSelector(workerModel()).thinking}` },
					{ label: "Discord", value: discordState },
				],
				{ tone: toneOf(orch.status) },
			);
		}
		case "context":
			return card(t.contextTitle, contextView().processes.filter(p => p.kind === "orchestrator" || p.running).map(p => ({ label: p.kind === "orchestrator" ? NAME : laneLabel(p.name), value: ctxValue(p) })), { note: t.compactNote });
		case "compact": {
			if (!first) throw new ControlError("usage: /compact <orchestrator|lane>");
			const r = compactTarget(first);
			const state = r.compaction.state ?? "compacting";
			const who = r.target === "orchestrator" ? NAME : laneLabel(r.target);
			return card(t.compactTitle[state](who), [], { tone: state === "done" ? "ok" : state === "error" ? "err" : "busy", note: state === "error" ? r.compaction.error : t.compactNote });
		}
		case "lanes": {
			const all = [...lanes.values()];
			return card(t.sessionsTitle, all.map(l => ({ label: laneLabel(l.name), value: `${word(l.status)} · ${modelName(l.model)}` })), { note: all.length ? undefined : t.noSessions });
		}
		case "model": {
			if (first && second) {
				const target = normalizeTarget(first);
				const levelOnly = !third && (THINKING_LEVELS as readonly string[]).includes(second);
				return changedCard(await setModel(target, levelOnly ? undefined : second, levelOnly ? second : third, force));
			}
			if (first) return targetCard(first, "model");
			const targets = ["orchestrator", "lanes", "workers", ...lanes.keys()].map(normalizeTarget);
			return card(t.modelsTitle, targets.map(tg => ({ label: whoIs(tg), value: `${currentOf(tg).model} · ${currentOf(tg).thinking}` })), { actions: await modelActions("orchestrator", orchestratorModel().model), note: t.modelsNote });
		}
		case "effort": {
			if (first && second) return changedCard(await setModel(normalizeTarget(first), undefined, second, force));
			return targetCard(first ?? "orchestrator", "effort");
		}
		case "restart":
			if (first === "gateway") {
				gatewayRestart();
				return card(t.restartGateway, [], { tone: "busy", note: t.restartGatewayNote(RESTART_NOTICE_MS / 60_000) });
			}
			if (first === "orchestrator") {
				restartOrchestrator();
				return card(t.restartMain(NAME), [], { tone: "busy" });
			}
			if (!first) throw new ControlError("usage: /restart gateway|orchestrator|<lane>");
			await restartLane(first);
			return card(t.restartSession(laneLabel(first)), [], { tone: "ok" });
		case "stop":
			if (!first) throw new ControlError("usage: /stop <lane>");
			stopLane(first);
			keepHome(lanes.get(first), discord.homeOf(first));
			void discord.releaseLane(first, lanes.get(first)).catch(e => log(`lane ${first} thread release failed: ${e}`));
			return card(t.stopping(laneLabel(first)), [], { tone: "busy" });
		case "resume":
			if (!first) throw new ControlError("usage: /resume <lane> [text]");
			resumeByName(first, cmd.rest.slice(first.length).trim() || undefined);
			return card(t.resumed(laneLabel(first)), [], { tone: "ok" });
		case "abort":
			if (!first || first === "orchestrator") {
				abortOrchestrator();
				return card(t.aborted(NAME), [], { tone: "ok" });
			}
			abortLane(first);
			return card(t.aborted(laneLabel(first)), [], { tone: "ok" });
		case "providers": {
			const { providers: rows, addable } = await providersView();
			const facts = rows.map(p => ({ label: p.name, value: [p.auth === "oauth" ? t.signedIn(p.account) : p.auth === "api_key" ? t.apiKey : t.disconnected, t.models(p.models), p.in_use ? t.inUse : ""].filter(Boolean).join(" · ") }));
			return card(t.providersTitle, facts, {
				note: facts.length ? (addable.length ? t.addable(addable.map(a => a.name).join(", ")) : undefined) : t.noProviders,
				actions: addable.filter(a => a.kind === "oauth").slice(0, CARD_CHOICES_MAX).map(a => ({ label: a.name, send: `/login ${a.id}` })),
			});
		}
		case "login": {
			const code = cmd.rest.slice(first?.length ?? 0).trim();
			const pending = pendingLogin();
			if (!first) return card(t.loginPick, [], { actions: (await loginProviders()).map(p => ({ label: p.name, send: `/login ${p.id}` })) });
			if (first === "cancel") {
				if (!pending) return card(t.loginNone);
				await cancelLogin(pending.provider);
				return card(t.loginCancelled(pending.provider), [], { tone: "ok" });
			}
			if (pending && pending.provider === first && code) {
				const r = await completeLogin(first, pending.id, code);
				if (r.status === "done") return card(t.loginDone(first), [], { tone: "ok" });
				return card(t.loginOpen, r.url ? [{ label: t.link, value: r.url }] : [], { tone: "busy", note: [r.instructions, r.prompt, t.loginMore(first)].filter(Boolean).join("\n") });
			}
			if (pending) throw new ControlError(pending.provider === first ? `${first} login is in progress; finish the approval in the browser or send the code with /login ${first} <code>` : `${pending.provider} login is in progress; /login cancel stops it`, 409);
			const r = await startLogin(first);
			return card(t.loginOpen, r.url ? [{ label: t.link, value: r.url }] : [], {
				tone: "busy",
				note: [r.instructions, r.needs_code ? t.loginCode(first) : t.loginAfter, r.needs_code ? r.prompt : ""].filter(Boolean).join("\n"),
				actions: [{ label: t.cancel, send: "/login cancel" }],
			});
		}
		case "logout":
			if (!first) throw new ControlError("usage: /logout <provider>");
			await logoutProvider(first);
			return card(t.logoutDone(first), [], { tone: "ok", note: t.logoutNote });
		case "quota": {
			const q = await quota();
			const facts = [
				...q.providers.flatMap(p => p.limits.map(l => ({ label: `${p.provider}${p.account ? ` (${label(p.account)})` : ""} · ${l.label}`, value: [l.remaining === null ? t.none : t.left(l.unit === "percent" || l.limit === 100 ? `${Math.round(l.remaining)}%` : kTokens(l.remaining)), l.resets_at ? t.resets(clock(l.resets_at)) : ""].filter(Boolean).join(" · ") }))),
				...q.unavailable.map(u => ({ label: u.provider, value: u.reason })),
			];
			return card(t.quotaTitle, facts, { note: facts.length ? undefined : t.noQuota });
		}
		case "account":
			return accountCommand(cmd.rest).then(s => card(t.accountTitle, [], { note: s }), e => {
				if (e instanceof AccountsError) throw new ControlError(e.message, e.status);
				throw e;
			});
		default:
			throw new ControlError(`unknown command "${cmd.name}"`);
	}
}
