import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { apiKeyBan } from "../apikey-policy.ts";
import { chainAfter, DATA_DIR, fallbackChain, lanesMaxWorkers, parseSelector, selectorOf, workerIdleMin, writeAtomic } from "../config.ts";
import { keyedWorker } from "../fallback.ts";
import { lookupModel, workersOf } from "../lanegates.ts";
import { safeDir } from "../session-key.ts";
import { orchestratorKeepRecent } from "./omo-settings.ts";
import type { SpawnOpts } from "./types.ts";

type Chains = Array<[key: string, models: string[]]>;
type Workers = { task: string; lookup?: string; chains: Chains; limit?: number };

const WORKER_MAX_DEPTH = 2;
const LOOKUP_AGENTS = ["scout", "sonic"];

/** The home omp resolves user-level folders from: env HOME first. */
export const homeDir = (): string => process.env.HOME ?? homedir();

const ompAgentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homeDir(), ".omp", "agent");

/** Every folder omp loads user-level rules from: its agent dir and the `agent`/`agents` providers' home dirs. */
export const userRuleDirs = (): string[] => [join(ompAgentDir(), "rules"), join(homeDir(), ".agent", "rules"), join(homeDir(), ".agents", "rules")];

function ruleNames(dir: string): string[] {
	try {
		return readdirSync(dir).filter(f => /\.mdc?$/.test(f)).map(f => f.replace(/\.mdc?$/, ""));
	} catch {
		return [];
	}
}

const quoted = (items: string[], indent: string): string => items.map(i => `${indent}- ${JSON.stringify(i)}\n`).join("");

function isolationYaml(cwd: string): string {
	const ownOmp = new Set(ruleNames(join(cwd, ".omp", "rules")));
	const ownAgents = new Set([".agent", ".agents"].flatMap(d => ruleNames(join(cwd, d, "rules"))));
	const [agentDirRules, ...homeRuleDirs] = userRuleDirs();
	const fromAgentDir = ruleNames(agentDirRules!).filter(n => !ownOmp.has(n));
	const fromHome = homeRuleDirs.flatMap(ruleNames).filter(n => !ownOmp.has(n) && !ownAgents.has(n));
	const userRules = [...new Set([...fromAgentDir, ...fromHome])].sort();
	const off = ["context-file:user:AGENTS.md", "rule:RULES", ...userRules.map(n => `rule:${n}`)];
	const userSkills = ["enablePiUser", "enableAgentsUser", "enableClaudeUser", "enableCodexUser"].map(k => `  ${k}: false\n`).join("");
	const userCommands = ["enableClaudeUser", "enableOpencodeUser"].map(k => `  ${k}: false\n`).join("");
	return `advisor:\n  enabled: false\nmemory:\n  backend: "off"\nenabledProviders: []\nskills:\n${userSkills}  customDirectories: []\ncommands:\n${userCommands}disabledExtensions:\n${quoted(off, "  ")}`;
}

function retryYaml(chains: Chains): string {
	const entries = chains.map(([key, models]) => (models.length ? `    ${JSON.stringify(key)}:\n${quoted(models, "      ")}` : `    ${JSON.stringify(key)}: []\n`)).join("");
	return `retry:\n  waitForUsageReset: false\n  modelFallback: true\n  fallbackChains:\n${entries}`;
}

const nativeChain = (o: SpawnOpts): string[] => (o.hubSwitches ? [] : (o.fallback ?? []));

export const keyProviderOf = (o: SpawnOpts) => (o.env.DOTZ_KEY_PROVIDER && o.env.DOTZ_KEY_VALUE && !apiKeyBan() ? (JSON.parse(o.env.DOTZ_KEY_PROVIDER) as { id: string; baseModel: string; models: Array<{ id: string }> }) : undefined);

/** The model a process starts on: an API-key entry starts on the entry's own model, to be switched to its key provider before the first prompt. */
export function startModelOf(o: SpawnOpts): string {
	const key = keyProviderOf(o);
	return key ? `${key.baseModel}:${parseSelector(o.model).thinking}` : o.model;
}

function orchestratorWorkers(o: SpawnOpts): Workers {
	const onKey = keyProviderOf(o) ? keyedWorker(o.env) : undefined;
	if (onKey) return { task: workersOf(onKey), chains: [["task", []]] };
	const task = workersOf(o.workers ?? startModelOf(o));
	const after = chainAfter(task, fallbackChain("orchestrator")).filter(e => !e.key_file).map(e => e.model);
	const lookup = lookupModel();
	const lookupChain = [task, ...after].filter(m => selectorOf(parseSelector(m)) !== selectorOf(parseSelector(lookup)));
	return { task, lookup, chains: [["task", after], ["lookup", lookupChain]] };
}

const userAgents = (cwd: string): string[] => {
	const own = new Set(ruleNames(join(cwd, ".omp", "agents")));
	return [...new Set(ruleNames(join(ompAgentDir(), "agents")))].filter(n => !own.has(n)).sort();
};

function workersYaml(w: Workers, cwd: string): string {
	const agents = [["task", "@task"], ...LOOKUP_AGENTS.map(agent => [agent, w.lookup ? "@lookup" : "@task"])];
	const overrides = agents.map(([agent, role]) => `    ${agent}: ${JSON.stringify(role)}\n`).join("");
	const roles = `  task: ${JSON.stringify(w.task)}\n${w.lookup ? `  lookup: ${JSON.stringify(w.lookup)}\n` : ""}`;
	const disabled = userAgents(cwd);
	return `modelRoles:\n${roles}task:\n  agentModelOverrides:\n${overrides}  maxRecursionDepth: ${WORKER_MAX_DEPTH}\n  agentIdleTtlMs: ${workerIdleMin() * 60_000}\n${w.limit ? `  maxConcurrency: ${w.limit}\n` : ""}${disabled.length ? `  disabledAgents:\n${quoted(disabled, "    ")}` : ""}`;
}

function compactionYaml(o: SpawnOpts): string {
	const { lane } = o;
	if (!lane) return `compaction:\n  keepRecentTokens: ${orchestratorKeepRecent()}\n`;
	const thresholds = [...new Set([parseSelector(o.model).model, parseSelector(lane.workerModel).model])].map(m => `    ${JSON.stringify(m)}: ${JSON.stringify(`f${lane.compactAt}`)}\n`).join("");
	return `compaction:\n  modelThresholds:\n${thresholds}  keepRecentTokens: ${lane.keepRecent}\n`;
}

function sessionOf(o: SpawnOpts): { file: string; who: string } {
	if (o.lane) return { file: join(o.lane.dir, "omp-overlay.yml"), who: `lane ${o.lane.name}` };
	const conv = o.env.DOTZ_CONV;
	if (conv) return { file: join(DATA_DIR, "conv-sessions", safeDir(conv), "omp-overlay.yml"), who: `conversation session ${safeDir(conv)}` };
	return { file: join(DATA_DIR, "omp-orchestrator-overlay.yml"), who: "the orchestrator" };
}

/**
 * Writes the `--config` overlay of one omp process and returns its path. Every session (the orchestrator, each conversation
 * session, each lane) has a file of its own, replaced atomically at each spawn, so no start reads a file another one rewrites
 * and a changed setting applies the next time that session starts.
 * Over the owner's own omp settings and context it switches off the advisor and omp's memory, the owner's user-level
 * AGENTS.md, RULES.md, rules (in the omp agent dir and in ~/.agent/rules and ~/.agents/rules), skills and task agents (the repo's own AGENTS.md, rules, skills and agents stay: only the user
 * toggles of the skill and command sources and the foreign user-level discovery sources are turned off), and the wait for a usage reset (the hub
 * handles limits). Fallback chains of the process's model and of its task and lookup roles are what the hub supplied, else
 * an explicit empty chain, so no chain of the owner's settings moves a dotz process.
 * omp picks a chain by the exact model id, then `provider/*`, then the role, so one key cannot carry a chain for the process
 * and another for workers on the same model: when the workers run on the process's own model (an orchestrator whose
 * `workers` is that model, a lane whose worker model equals its model) the process's chain is the one they walk, and the
 * `task` chain written next to it applies only to workers on another model. A hub-driven process therefore has same-model
 * workers with no omp fallback, where OmO walks the worker profile's model list.
 * Task workers get what OmO's worker profiles give them (runtime/omo.ts): the task role is a lane's worker model, or the
 * orchestrator's `workers` (the model it runs on unless that is an expensive one), the scout and sonic agents run the
 * `models.lookups` model in the orchestrator and the worker model in a lane, workers delegate at most two levels deep, an
 * idle worker is parked after lanes.worker_idle_min, a lane runs at most its worker slots at once, and a compacted
 * orchestrator keeps orchestrator.keep_recent. omp has no setting for OmO's child-process runner and execution mode, nor for
 * a rule appended to every worker's prompt.
 */
export function writeOverlay(o: SpawnOpts): string {
	const { file, who } = sessionOf(o);
	const workers: Workers = o.lane ? { task: o.lane.workerModel, chains: [["task", o.lane.workerFallback ?? []]], limit: o.lane.workerSlots ?? lanesMaxWorkers() } : orchestratorWorkers(o);
	const chains: Chains = [[parseSelector(o.model).model, nativeChain(o)], ...workers.chains];
	mkdirSync(dirname(file), { recursive: true });
	writeAtomic(file, `# Written by the dotz gateway each time ${who} starts; passed to omp as --config.\n${isolationYaml(o.cwd)}${workersYaml(workers, o.cwd)}${compactionYaml(o)}${retryYaml(chains)}`);
	return file;
}
