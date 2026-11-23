import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, DATA_DIR, DEFAULTS } from "../config.ts";
import { DEFAULT_LOOKUP_MODEL } from "../lanegates.ts";
import { NICE } from "./agent-proc.ts";
import { omoArgs } from "./omo.ts";
import { EXTENSION, omp, OmpProcess } from "./omp.ts";
import { flush } from "./test-clock.ts";
import type { SpawnOpts } from "./types.ts";

const patchable = Bun as unknown as { spawn: unknown };
const CONFIG = join(DATA_DIR, "config.json");
const KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY"];
const KEY_PROVIDER = { id: "anthropic-apikey", baseModel: "anthropic/test-key", models: [{ id: "test-key" }] };

type Started = { argv: string[]; cwd?: string; env: Record<string, string | undefined>; writes: string[] };

let root: string;
let started: Started[];
let realSpawn: unknown;
let savedConfig: string;
let savedCfg: Pick<typeof cfg, "models" | "lanes" | "orchestrator">;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-omp-spawn-"));
	savedConfig = readFileSync(CONFIG, "utf8");
	savedCfg = { models: cfg.models, lanes: cfg.lanes, orchestrator: cfg.orchestrator };
	savedEnv = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_CACHE_RETENTION", ...KEY_VARS].map(k => [k, process.env[k]]));
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent", "rules"), { recursive: true });
	for (const f of ["owner-a.md", "owner-b.mdc", "notes.txt"]) writeFileSync(join(root, "agent", "rules", f), "x");
	started = [];
	realSpawn = Bun.spawn;
	patchable.spawn = (argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }) => {
		const writes: string[] = [];
		started.push({ argv: argv.slice(NICE.length), cwd: opts.cwd, env: opts.env ?? {}, writes });
		return { pid: 4242, stdout: new ReadableStream<Uint8Array>(), stdin: { write: (s: string) => writes.push(s), flush: () => 0 }, exited: new Promise<number>(() => {}), kill() {} };
	};
});

afterEach(() => {
	patchable.spawn = realSpawn;
	writeFileSync(CONFIG, savedConfig);
	Object.assign(cfg, savedCfg);
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(root, { recursive: true, force: true });
});

const orchestrator = (extra: Partial<SpawnOpts> = {}): SpawnOpts => ({ role: "orchestrator", cwd: DATA_DIR, model: "anthropic/test-orch:low", env: { DOTZ_ORCHESTRATOR: "1" }, ...extra });
const conversation = (key: string, extra: Partial<SpawnOpts> = {}): SpawnOpts => orchestrator({ env: { DOTZ_ORCHESTRATOR: "1", DOTZ_CONV: key }, ...extra });
const lane = (name: string, extra: Partial<SpawnOpts> = {}, workerFallback?: string[]): SpawnOpts => ({
	role: "lane",
	cwd: join(root, name, "work"),
	model: "anthropic/test-lane:medium",
	env: { DOTZ_LANE: name },
	lane: { name, dir: join(DATA_DIR, "lanes", name), workerModel: "anthropic/test-worker:high", workerFallback, compactAt: 300_000, keepRecent: 30_000 },
	...extra,
});
const configOf = (argv: string[]): string => argv.find(a => a.startsWith("--config="))!.slice("--config=".length);
const overlayOf = (argv: string[]): string => readFileSync(configOf(argv), "utf8");
const text = (lines: string[]): string => `${lines.join("\n")}\n`;
const setAllowApiKey = (allow: boolean): void => {
	const config = JSON.parse(savedConfig);
	writeFileSync(CONFIG, JSON.stringify({ ...config, guard: { ...config.guard, allow_api_key: allow } }));
};
const keyEnv = { DOTZ_KEY_PROVIDER: JSON.stringify(KEY_PROVIDER), DOTZ_KEY_VALUE: "sk-key", DOTZ_KEY_FILE: "key-file" };

const ISOLATION = [
	"advisor:",
	"  enabled: false",
	"memory:",
	'  backend: "off"',
	"enabledProviders: []",
	"skills:",
	"  enablePiUser: false",
	"  enableAgentsUser: false",
	"  enableClaudeUser: false",
	"  enableCodexUser: false",
	"  customDirectories: []",
	"commands:",
	"  enableClaudeUser: false",
	"  enableOpencodeUser: false",
	"disabledExtensions:",
	'  - "context-file:user:AGENTS.md"',
	'  - "rule:RULES"',
];

const PINS = ["startup:", "  checkUpdate: false", "magicKeywords:", "  enabled: false", "github:", "  enabled: false", "async:", "  enabled: true", "  widgets: false", "secrets:", "  enabled: true"];
const TASK_PINS = ["  isolation:", "    enabled: true", "    apply: false", "    merge: patch", "  maxRuntimeMs: 0", "  softRequestBudget: 200", "  maxEffort: high"];

test("every omp agent loads only the dotz extension: --no-extensions, then one --extension, for the orchestrator, a conversation session and a lane", () => {
	omp.start(orchestrator());
	omp.start(conversation("mail:acme-1"));
	omp.start(lane("alpha"));
	const head = (model: string) => [expect.any(String), "--mode", "rpc", "--model", model, "--no-extensions", "--extension", EXTENSION];
	expect(started.map(s => s.argv.slice(0, 8))).toEqual([head("anthropic/test-orch:low"), head("anthropic/test-orch:low"), head("anthropic/test-lane:medium")]);
	for (const { argv } of started) {
		expect(argv.filter(a => a === "--extension")).toHaveLength(1);
		expect(argv).toHaveLength(9);
	}
});

test("the system note and the session to resume still follow the overlay in the argv", () => {
	omp.start(lane("alpha", { systemNote: "steer note", resume: "/s/a.jsonl" }));
	expect(started[0]!.argv.slice(8)).toEqual([`--config=${join(DATA_DIR, "lanes", "alpha", "omp-overlay.yml")}`, "--append-system-prompt", "steer note", "--resume", "/s/a.jsonl"]);
});

test("each session has an overlay file of its own, so a conversation session's start never rewrites the orchestrator's", () => {
	omp.start(orchestrator({ fallback: ["anthropic/orch-fb"] }));
	omp.start(conversation("mail:acme-1", { model: "anthropic/test-conv:low", fallback: ["anthropic/conv-fb"] }));
	omp.start(conversation("th:42", { model: "anthropic/test-conv:low" }));
	omp.start(lane("alpha"));
	omp.start(lane("beta"));
	const files = started.map(s => configOf(s.argv));
	expect(files).toEqual([
		join(DATA_DIR, "omp-orchestrator-overlay.yml"),
		join(DATA_DIR, "conv-sessions", "mail_acme-1", "omp-overlay.yml"),
		join(DATA_DIR, "conv-sessions", "th_42", "omp-overlay.yml"),
		join(DATA_DIR, "lanes", "alpha", "omp-overlay.yml"),
		join(DATA_DIR, "lanes", "beta", "omp-overlay.yml"),
	]);
	expect(new Set(files).size).toBe(files.length);
	const [orch, conv] = [overlayOf(started[0]!.argv), overlayOf(started[1]!.argv)];
	expect(orch).toContain('"anthropic/orch-fb"');
	expect(orch).not.toContain("conv-fb");
	expect(conv).toContain('"anthropic/conv-fb"');
	expect(conv).not.toContain("orch-fb");
});

test("the orchestrator's overlay switches the owner's advisor, memory, user context and usage-reset wait off, runs its workers on its own model and its lookups on the lookup model, and empties the chains the hub did not supply", () => {
	omp.start(orchestrator());
	expect(overlayOf(started[0]!.argv)).toBe(
		text([
			"# Written by the dotz gateway each time the orchestrator starts; passed to omp as --config.",
			...ISOLATION,
			'  - "rule:owner-a"',
			'  - "rule:owner-b"',
			...PINS,
			"modelRoles:",
			'  task: "anthropic/test-orch:low"',
			`  lookup: ${JSON.stringify(DEFAULT_LOOKUP_MODEL)}`,
			"task:",
			"  agentModelOverrides:",
			'    task: "@task"',
			'    scout: "@lookup"',
			'    sonic: "@lookup"',
			"  maxRecursionDepth: 2",
			"  agentIdleTtlMs: 300000",
			...TASK_PINS,
			"compaction:",
			"  idleEnabled: false",
			`  keepRecentTokens: ${DEFAULTS.orch_keep_recent}`,
			"retry:",
			"  waitForUsageReset: false",
			"  modelFallback: true",
			"  fallbackChains:",
			'    "anthropic/test-orch": []',
			'    "task": []',
			'    "lookup":',
			'      - "anthropic/test-orch:low"',
		]),
	);
});

test("a conversation session's overlay says whose it is, carries its own chain and keeps the workers of main", () => {
	omp.start(conversation("th:42", { model: "anthropic/test-conv:low", workers: "anthropic/main-worker:high", fallback: ["anthropic/fb-1", "anthropic/fb-2"] }));
	const overlay = overlayOf(started[0]!.argv);
	expect(overlay.split("\n")[0]).toBe("# Written by the dotz gateway each time conversation session th_42 starts; passed to omp as --config.");
	expect(overlay).toContain('modelRoles:\n  task: "anthropic/main-worker:high"\n');
	expect(overlay).toEndWith(text(["retry:", "  waitForUsageReset: false", "  modelFallback: true", "  fallbackChains:", '    "anthropic/test-conv":', '      - "anthropic/fb-1"', '      - "anthropic/fb-2"', '    "task": []', '    "lookup":', '      - "anthropic/main-worker:high"']));
});

test("a lane's overlay keeps its worker model and compaction settings and gets the same isolation; its task role's chain is the hub's or empty", () => {
	omp.start(lane("alpha"));
	omp.start(lane("beta", {}, ["anthropic/worker-fb"]));
	const body = [
		'modelRoles:\n  task: "anthropic/test-worker:high"',
		`task:\n  agentModelOverrides:\n    task: "@task"\n    scout: "@task"\n    sonic: "@task"\n  maxRecursionDepth: 2\n  agentIdleTtlMs: 300000\n${TASK_PINS.join("\n")}`,
		'compaction:\n  idleEnabled: false\n  modelThresholds:\n    "anthropic/test-lane": "f300000"\n    "anthropic/test-worker": "f300000"\n  keepRecentTokens: 30000',
	].join("\n");
	const overlay = (name: string, chains: string[]) =>
		text([`# Written by the dotz gateway each time lane ${name} starts; passed to omp as --config.`, ...ISOLATION, '  - "rule:owner-a"', '  - "rule:owner-b"', ...PINS, body, "retry:", "  waitForUsageReset: false", "  modelFallback: true", "  fallbackChains:", ...chains]);
	expect(overlayOf(started[0]!.argv)).toBe(overlay("alpha", ['    "anthropic/test-lane": []', '    "task": []']));
	expect(overlayOf(started[1]!.argv)).toBe(overlay("beta", ['    "anthropic/test-lane": []', '    "task":', '      - "anthropic/worker-fb"']));
});

test("the orchestrator's workers run on the model the hub names and its lookups on models.lookups; each chain is the orchestrator's chain after that model, API-key entries left out", () => {
	const chain = ["anthropic/fb-1", { model: "anthropic/keyed", key_file: "k" }, "anthropic/test-worker", "anthropic/fb-2"];
	cfg.models = { ...cfg.models, lookups: { model: "anthropic/test-lookup", thinking: "low" }, orchestrator: { ...cfg.models?.orchestrator, fallback: chain } } as typeof cfg.models;
	omp.start(orchestrator({ workers: "anthropic/test-worker:high", fallback: ["anthropic/proc-fb"] }));
	const overlay = overlayOf(started[0]!.argv);
	expect(overlay).toContain('modelRoles:\n  task: "anthropic/test-worker:high"\n  lookup: "anthropic/test-lookup:low"\ntask:\n  agentModelOverrides:\n    task: "@task"\n    scout: "@lookup"\n    sonic: "@lookup"\n');
	expect(overlay).toEndWith(text(["  fallbackChains:", '    "anthropic/test-orch":', '      - "anthropic/proc-fb"', '    "task":', '      - "anthropic/fb-1"', '      - "anthropic/fb-2"', '    "lookup":', '      - "anthropic/test-worker:high"', '      - "anthropic/fb-1"', '      - "anthropic/fb-2"']));
	cfg.models = { ...cfg.models, lookups: { model: "anthropic/test-worker", thinking: "high" } } as typeof cfg.models;
	omp.start(orchestrator({ workers: "anthropic/test-worker:high" }));
	expect(overlayOf(started[1]!.argv)).toEndWith(text(['    "lookup":', '      - "anthropic/fb-1"', '      - "anthropic/fb-2"']));
});

test("an API-key entry whose workers use the key runs the orchestrator's workers on the key provider's model, with no lookup role and no chain; under the API-key ban the workers follow the process's model", () => {
	const env = { DOTZ_ORCHESTRATOR: "1", ...keyEnv, DOTZ_KEY_PROVIDER: JSON.stringify({ ...KEY_PROVIDER, worker: { id: "test-worker-key", thinking: "high" } }), DOTZ_KEY_WORKERS: "1" };
	setAllowApiKey(true);
	omp.start(orchestrator({ env }));
	const keyed = overlayOf(started[0]!.argv);
	expect(keyed).toContain('modelRoles:\n  task: "anthropic-apikey/test-worker-key:high"\ntask:\n  agentModelOverrides:\n    task: "@task"\n    scout: "@task"\n    sonic: "@task"\n');
	expect(keyed).not.toContain("lookup");
	expect(keyed).toEndWith(text(['    "anthropic/test-orch": []', '    "task": []']));
	setAllowApiKey(false);
	omp.start(orchestrator({ env }));
	const banned = overlayOf(started[1]!.argv);
	expect(banned).toContain('modelRoles:\n  task: "anthropic/test-orch:low"\n');
	expect(banned).not.toContain("apikey");
});

test("the orchestrator's overlay keeps orchestrator.keep_recent when it compacts: the configured value, raised to its minimum, else the default", () => {
	const keepRecent = (keep?: number) => {
		cfg.orchestrator = { ...cfg.orchestrator, keep_recent: keep };
		omp.start(orchestrator());
		return overlayOf(started.at(-1)!.argv).match(/keepRecentTokens: (\d+)/)![1];
	};
	expect([keepRecent(), keepRecent(24_000), keepRecent(1_000)]).toEqual([String(DEFAULTS.orch_keep_recent), "24000", "5000"]);
});

test("task workers delegate two levels deep, are parked after lanes.worker_idle_min, and a lane runs at most its worker slots at once", () => {
	cfg.lanes = { ...cfg.lanes, worker_idle_min: 2 };
	const alpha = lane("alpha");
	omp.start({ ...alpha, lane: { ...alpha.lane!, workerSlots: 3 } });
	omp.start(lane("beta"));
	cfg.lanes = { ...cfg.lanes, max_workers: 4 };
	omp.start(lane("gamma"));
	omp.start(orchestrator());
	const limits = (i: number) => overlayOf(started[i]!.argv).match(/^ {2}(?:maxRecursionDepth|agentIdleTtlMs|maxConcurrency): \d+$/gm);
	const two = ["  maxRecursionDepth: 2", "  agentIdleTtlMs: 120000"];
	expect(limits(0)).toEqual([...two, "  maxConcurrency: 3"]);
	expect(limits(1)).toEqual(two);
	expect(limits(2)).toEqual([...two, "  maxConcurrency: 4"]);
	expect(limits(3)).toEqual(two);
});

test("the overlay turns off the user-level skill and command sources omp has a switch for and the foreign sources the owner opted in, and leaves every project switch alone", () => {
	omp.start(orchestrator());
	const lines = overlayOf(started[0]!.argv).split("\n");
	for (const line of ["enabledProviders: []", "  enablePiUser: false", "  enableAgentsUser: false", "  enableClaudeUser: false", "  enableCodexUser: false", "  customDirectories: []", "  enableOpencodeUser: false"]) expect(lines).toContain(line);
	expect(lines.filter(l => /Project/.test(l))).toEqual([]);
});

test("a fallback list the hub supplies is the chain of the process's model; the hub driving the switches means no chain at all", () => {
	omp.start(orchestrator({ fallback: ["anthropic/a", "anthropic/b"] }));
	expect(overlayOf(started[0]!.argv)).toContain('    "anthropic/test-orch":\n      - "anthropic/a"\n      - "anthropic/b"\n');
	omp.start(orchestrator({ fallback: ["anthropic/a"], hubSwitches: true }));
	expect(overlayOf(started[1]!.argv)).toContain('    "anthropic/test-orch": []\n');
});

test("the repo's own rules stay: a rule the lane's repo defines under the owner's rule name is not disabled, and a missing owner rules folder disables only the two fixed ids", () => {
	const repoRules = join(root, "gamma", "work", ".omp", "rules");
	mkdirSync(repoRules, { recursive: true });
	writeFileSync(join(repoRules, "owner-b.md"), "the repo's own rule");
	omp.start(lane("gamma"));
	const disabled = (argv: string[]) => overlayOf(argv).split("\n").filter(l => l.startsWith('  - "'));
	expect(disabled(started[0]!.argv)).toEqual(['  - "context-file:user:AGENTS.md"', '  - "rule:RULES"', '  - "rule:owner-a"']);
	process.env.PI_CODING_AGENT_DIR = join(root, "no-such-agent-dir");
	omp.start(orchestrator());
	expect(disabled(started[1]!.argv)).toEqual(['  - "context-file:user:AGENTS.md"', '  - "rule:RULES"']);
});

test("user rules under ~/.agent/rules and ~/.agents/rules are disabled like the omp agent folder's; a repo rule of the same name in .agent/rules, .agents/rules or .omp/rules keeps a home rule enabled, but only .omp/rules exempts the omp agent folder's rule, which outranks .agent(s)", () => {
	for (const dir of [".agent", ".agents"]) mkdirSync(join(root, "home", dir, "rules"), { recursive: true });
	for (const f of ["home-a.md", "home-shared.mdc", "notes.txt"]) writeFileSync(join(root, "home", ".agent", "rules", f), "x");
	for (const f of ["home-b.md", "owner-a.md", "home-repo.md"]) writeFileSync(join(root, "home", ".agents", "rules", f), "x");
	const repoRules = join(root, "eps", "work", ".agent", "rules");
	mkdirSync(repoRules, { recursive: true });
	writeFileSync(join(repoRules, "home-repo.md"), "the repo's own rule");
	writeFileSync(join(repoRules, "owner-b.md"), "loses to the owner's agent-folder rule of the same name");
	omp.start(lane("eps"));
	const disabled = overlayOf(started[0]!.argv).split("\n").filter(l => l.startsWith('  - "rule:'));
	expect(disabled).toEqual(['  - "rule:RULES"', '  - "rule:home-a"', '  - "rule:home-b"', '  - "rule:home-shared"', '  - "rule:owner-a"', '  - "rule:owner-b"']);
});

test("workers on the process's own model walk the process's chain at the same thinking level; at another level the process's key carries its level and the task chain is theirs alone", () => {
	cfg.models = { ...cfg.models, orchestrator: { ...cfg.models?.orchestrator, fallback: ["anthropic/fb-1", "anthropic/test-orch", "anthropic/fb-2"] } } as typeof cfg.models;
	omp.start(conversation("same-a", { fallback: ["anthropic/proc-fb"] }));
	omp.start(conversation("same-b", { fallback: ["anthropic/proc-fb"], hubSwitches: true }));
	omp.start(lane("zeta", { model: "anthropic/test-worker:low" }, ["anthropic/worker-fb"]));
	omp.start(lane("eta", { model: "anthropic/test-worker:high" }, ["anthropic/worker-fb"]));
	omp.start(conversation("apart", { fallback: ["anthropic/proc-fb"], workers: "anthropic/test-orch:high" }));
	const chains = (i: number) => overlayOf(started[i]!.argv).split("retry:\n")[1]!;
	expect(overlayOf(started[0]!.argv)).toContain('modelRoles:\n  task: "anthropic/test-orch:low"\n');
	expect(chains(0)).toContain(text(["  fallbackChains:", '    "anthropic/test-orch":', '      - "anthropic/proc-fb"', '    "task":', '      - "anthropic/fb-1"', '      - "anthropic/fb-2"']));
	expect(chains(1)).toContain(text(["  fallbackChains:", '    "anthropic/test-orch": []', '    "task":', '      - "anthropic/fb-1"', '      - "anthropic/fb-2"']));
	expect(chains(2)).toContain(text(["  fallbackChains:", '    "anthropic/test-worker:low": []', '    "task":', '      - "anthropic/worker-fb"']));
	expect(chains(3)).toContain(text(["  fallbackChains:", '    "anthropic/test-worker": []', '    "task":', '      - "anthropic/worker-fb"']));
	expect(chains(4)).toContain(text(["  fallbackChains:", '    "anthropic/test-orch:low":', '      - "anthropic/proc-fb"', '    "task":']));
});

test("the owner's task agents are disabled for dotz workers, except one the lane's repo defines under the same name", () => {
	mkdirSync(join(root, "agent", "agents"), { recursive: true });
	for (const f of ["deep-reviewer.md", "owner-scout.md", "notes.txt"]) writeFileSync(join(root, "agent", "agents", f), "x");
	const repoAgents = join(root, "delta", "work", ".omp", "agents");
	mkdirSync(repoAgents, { recursive: true });
	writeFileSync(join(repoAgents, "owner-scout.md"), "the repo's own agent");
	omp.start(orchestrator());
	omp.start(lane("delta"));
	expect(overlayOf(started[0]!.argv)).toContain('  disabledAgents:\n    - "deep-reviewer"\n    - "owner-scout"\n');
	expect(overlayOf(started[1]!.argv)).toContain('  disabledAgents:\n    - "deep-reviewer"\n');
	expect(overlayOf(started[1]!.argv)).not.toContain('"owner-scout"');
});

test("under the API-key ban no key reaches the process: not the key variables, not the key provider, and the model stays the entry's own", () => {
	setAllowApiKey(false);
	for (const k of KEY_VARS) process.env[k] = "sk-ant-secret";
	omp.start(lane("alpha", { env: { DOTZ_LANE: "alpha", ...keyEnv } }));
	const { argv, env, writes } = started[0]!;
	for (const k of [...KEY_VARS, "DOTZ_KEY_PROVIDER", "DOTZ_KEY_VALUE", "DOTZ_KEY_FILE"]) expect(env).not.toHaveProperty(k);
	expect(env.DOTZ_LANE).toBe("alpha");
	expect(argv[argv.indexOf("--model") + 1]).toBe("anthropic/test-lane:medium");
	expect(writes).toEqual([]);
});

test("with API keys allowed the key variables and the API-key entry still work: the process starts on the entry's model and is switched to its key provider", () => {
	setAllowApiKey(true);
	for (const k of KEY_VARS) process.env[k] = "sk-ant-secret";
	omp.start(lane("alpha", { env: { DOTZ_LANE: "alpha", ...keyEnv } }));
	const { argv, env, writes } = started[0]!;
	for (const k of KEY_VARS) expect(env[k]).toBe("sk-ant-secret");
	expect(env.DOTZ_KEY_VALUE).toBe("sk-key");
	expect(argv[argv.indexOf("--model") + 1]).toBe("anthropic/test-key:medium");
	expect(writes.map(w => JSON.parse(w))).toEqual([{ id: "h1", type: "set_model", provider: "anthropic-apikey", modelId: "test-key" }]);
});

test("every omp process is marked DOTZ_RUNTIME=omp and asks for the 1h prompt cache unless the gateway's own environment says otherwise", () => {
	delete process.env.PI_CACHE_RETENTION;
	omp.start(orchestrator());
	omp.start(lane("alpha"));
	process.env.PI_CACHE_RETENTION = "short";
	omp.start(conversation("th:42"));
	expect(started.map(s => [s.env.DOTZ_RUNTIME, s.env.PI_CACHE_RETENTION])).toEqual([["omp", "long"], ["omp", "long"], ["omp", "short"]]);
	expect(started[0]!.env.DOTZ_ORCHESTRATOR).toBe("1");
	expect(started[1]!.env.DOTZ_LANE).toBe("alpha");
	expect(started.map(s => s.cwd)).toEqual([DATA_DIR, join(root, "alpha", "work"), DATA_DIR]);
});

const frames = (call: (p: OmpProcess) => void): Record<string, unknown>[] => {
	const written: string[] = [];
	const proc = { stdin: { write: (s: string) => written.push(s), flush: () => 0 }, stdout: new ReadableStream<Uint8Array>(), exited: Promise.resolve(0) };
	call(new OmpProcess(proc as unknown as ConstructorParameters<typeof OmpProcess>[0], "o"));
	return written.map(line => JSON.parse(line));
};

test("the owner's stop reaches omp as abort_and_restore_queue, which withdraws its queued messages; an abort the hub sends by itself stays a plain abort", () => {
	expect(frames(p => p.abort(true))).toEqual([{ id: "o1", type: "abort_and_restore_queue" }]);
	expect(frames(p => p.abort(false))).toEqual([{ id: "o1", type: "abort" }]);
	expect(frames(p => p.abort())).toEqual([{ id: "o1", type: "abort" }]);
});

test("an omp that rejects abort_and_restore_queue is sent a plain abort, so the owner's stop still stops; its answer to anything else changes nothing", async () => {
	const written: string[] = [];
	let out!: ReadableStreamDefaultController<Uint8Array>;
	const proc = { stdin: { write: (s: string) => written.push(s), flush: () => 0 }, stdout: new ReadableStream<Uint8Array>({ start: c => void (out = c) }), exited: new Promise<number>(() => {}) };
	const agent = new OmpProcess(proc as unknown as ConstructorParameters<typeof OmpProcess>[0], "o");
	void (async () => {
		for await (const _ of agent.events);
	})();
	const reply = async (frame: object) => {
		out.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
		await flush();
	};
	const sent = () => written.map(w => JSON.parse(w));
	agent.abort(true);
	await reply({ id: "o1", type: "response", command: "abort_and_restore_queue", success: true, data: { steering: [{ text: "queued" }], followUp: [] } });
	await reply({ id: "o7", type: "response", command: "get_state", success: false, error: "not now" });
	expect(sent()).toEqual([{ id: "o1", type: "abort_and_restore_queue" }]);
	await reply({ id: "o1", type: "response", command: "abort_and_restore_queue", success: false, error: "Unknown command" });
	expect(sent()).toEqual([{ id: "o1", type: "abort_and_restore_queue" }, { id: "o2", type: "abort" }]);
	await reply({ id: "o1", type: "response", command: "abort_and_restore_queue", success: false, error: "Unknown command" });
	expect(sent()).toHaveLength(3);
});

test("OmO's spawn arguments are what they were: its own extension flag and fallback switch, no omp isolation flags", () => {
	const orchestratorArgs = omoArgs({ role: "orchestrator", cwd: "/tmp", model: "anthropic/claude-opus-5-5:medium", env: {}, systemNote: "note", resume: "/s/a.jsonl" }).slice(1);
	expect(orchestratorArgs).toEqual([
		"--mode", "rpc", "--model", "anthropic-subscription/claude-opus-5-5:medium", "--extension", EXTENSION, "--no-model-fallback", "--omo-senpi-memory-disabled", "--no-ask-user", "--approve",
		"--exclude-tools", "create_goal,get_goal,update_goal,show_html_page,lsp_diagnostics,lsp_find_references,lsp_goto_definition,lsp_prepare_rename,lsp_rename,lsp_symbols,workpool,bash_resize",
		"--append-system-prompt", "note", "--session", "/s/a.jsonl",
	]);
	const laneArgs = omoArgs({ role: "lane", cwd: "/tmp", model: "anthropic/claude-opus-5-5:medium", env: {} }).slice(1);
	expect(laneArgs).toEqual([
		"--mode", "rpc", "--model", "anthropic-subscription/claude-opus-5-5:medium", "--extension", EXTENSION, "--no-model-fallback", "--omo-senpi-memory-disabled", "--no-ask-user",
		"--exclude-tools", "create_goal,get_goal,update_goal,show_html_page",
	]);
});

test("every omp agent finds /sbin tools: launchd's PATH without /usr/sbin and /sbin gets both appended after the owner's own folders (an isolated worker's ovnfs runs mount_nfs from /sbin)", () => {
	const savedPath = process.env.PATH;
	try {
		process.env.PATH = "/opt/homebrew/bin:/usr/bin:/bin";
		omp.start(orchestrator());
		omp.start(conversation("ch:1"));
		omp.start(lane("alpha"));
		expect(started.map(s => s.env.PATH)).toEqual(Array(3).fill("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
		started = [];
		process.env.PATH = "/sbin:/usr/bin:/usr/sbin";
		omp.start(orchestrator());
		expect(started[0]!.env.PATH).toBe("/sbin:/usr/bin:/usr/sbin");
	} finally {
		process.env.PATH = savedPath;
	}
});
