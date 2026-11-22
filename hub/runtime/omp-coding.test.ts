import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CODING_HARNESS_ENV } from "../../extension/harness-gate.ts";
import { DATA_DIR } from "../config.ts";
import { NICE } from "./agent-proc.ts";
import { EXTENSION, omp, ompArgv } from "./omp.ts";
import { writeOverlay } from "./omp-overlay.ts";
import type { SpawnOpts } from "./types.ts";

type Overlay = {
	skills?: { customDirectories?: string[] };
	workspace?: { additionalDirectories?: string[] };
	disabledExtensions?: string[];
	task?: { disabledAgents?: string[] };
};

const patchable = Bun as unknown as { spawn: unknown };
let root: string;
let payload: string;
let saved: Record<string, string | undefined>;

const touch = (file: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "");
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-omp-coding-"));
	saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "HARNESS_AGENT_HOME", CODING_HARNESS_ENV].map(k => [k, process.env[k]]));
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	delete process.env.HARNESS_AGENT_HOME;
	delete process.env[CODING_HARNESS_ENV];
	for (const rule of ["always", "owner-only"]) touch(join(root, "agent", "rules", `${rule}.md`));
	for (const agent of ["deep-reviewer", "owner-agent"]) touch(join(root, "agent", "agents", `${agent}.md`));
	payload = join(root, "payload");
	for (const f of ["extensions/done-gate.ts", "extensions/orchestrator-guard.ts", "extensions/harness-tools.ts", "harness/gate/bootstrap.ts", "skills/x/SKILL.md", "rules/always.md", "agents/deep-reviewer.md", "AGENTS.md"]) touch(join(payload, f));
});

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const orchestrator = (extra: Partial<SpawnOpts> = {}): SpawnOpts => ({ role: "orchestrator", cwd: join(root, "work"), model: "anthropic/test-orch:low", env: { DOTZ_ORCHESTRATOR: "1" }, ...extra });
const lane = (extra: Partial<SpawnOpts> = {}): SpawnOpts => ({
	role: "lane",
	cwd: join(root, "work"),
	model: "anthropic/test-lane:medium",
	env: { DOTZ_LANE: "alpha" },
	lane: { name: "alpha", dir: join(DATA_DIR, "lanes", "alpha"), workerModel: "anthropic/test-worker:high", compactAt: 300_000, keepRecent: 30_000 },
	...extra,
});
const overlayText = (argv: string[]): string => readFileSync(argv.find(a => a.startsWith("--config="))!.slice("--config=".length), "utf8");
const overlayOf = (argv: string[]): Overlay => Bun.YAML.parse(overlayText(argv)) as Overlay;

test("a coding spawn loads dotz's extension, then the payload's extension files in order, then the payload folder; --no-extensions stays", () => {
	for (const make of [orchestrator, lane]) {
		const argv = ompArgv(make({ codingHarness: payload }));
		const at = argv.indexOf(EXTENSION);
		expect(argv.slice(at - 1, at + 8)).toEqual([
			"--extension",
			EXTENSION,
			"--extension",
			join(payload, "extensions", "done-gate.ts"),
			"--extension",
			join(payload, "extensions", "orchestrator-guard.ts"),
			"--extension",
			join(payload, "extensions", "harness-tools.ts"),
			"--extension",
		]);
		expect(argv[at + 8]).toBe(payload);
		expect(argv.filter(a => a === "--no-extensions")).toHaveLength(1);
		expect(argv.filter(a => a === "--extension")).toHaveLength(5);
	}
});

test("only the payload's extension files that exist are loaded", () => {
	rmSync(join(payload, "extensions", "harness-tools.ts"));
	const files = ompArgv(orchestrator({ codingHarness: payload })).filter(a => a.startsWith(payload) && a.endsWith(".ts"));
	expect(files).toEqual([join(payload, "extensions", "done-gate.ts"), join(payload, "extensions", "orchestrator-guard.ts")]);
});

test("a payload that is not usable throws instead of starting as the assistant harness", () => {
	expect(() => ompArgv(orchestrator({ codingHarness: join(root, "missing") }))).toThrow(/coding harness/);
	expect(() => ompArgv(orchestrator({ codingHarness: "payload" }))).toThrow(/coding harness/);
	rmSync(join(payload, "harness"), { recursive: true });
	expect(() => ompArgv(lane({ codingHarness: payload }))).toThrow(/coding harness/);
});

test("a spawn gets HARNESS_AGENT_HOME and the marker as the payload dir, and none without a payload", () => {
	const spawned: Record<string, string | undefined>[] = [];
	const real = Bun.spawn;
	patchable.spawn = (argv: string[], opts: { env?: Record<string, string | undefined> }) => {
		expect(argv.slice(0, NICE.length)).toEqual(NICE);
		spawned.push(opts.env ?? {});
		return { pid: 4242, stdout: new ReadableStream<Uint8Array>(), stdin: { write: () => 0, flush: () => 0 }, exited: new Promise<number>(() => {}), kill() {} };
	};
	try {
		omp.start(orchestrator({ codingHarness: payload }));
		omp.start(orchestrator());
	} finally {
		patchable.spawn = real;
	}
	expect(spawned[0]).toMatchObject({ HARNESS_AGENT_HOME: payload, [CODING_HARNESS_ENV]: payload, DOTZ_RUNTIME: "omp", DOTZ_ORCHESTRATOR: "1" });
	expect(spawned[1]).not.toHaveProperty("HARNESS_AGENT_HOME");
	expect(spawned[1]).not.toHaveProperty(CODING_HARNESS_ENV);
});

test("a payload variable the gateway inherited reaches no assistant lane and no orchestrator spawned without a payload", () => {
	const spawned: Record<string, string | undefined>[] = [];
	const real = Bun.spawn;
	patchable.spawn = (_argv: string[], opts: { env?: Record<string, string | undefined> }) => {
		spawned.push(opts.env ?? {});
		return { pid: 4242, stdout: new ReadableStream<Uint8Array>(), stdin: { write: () => 0, flush: () => 0 }, exited: new Promise<number>(() => {}), kill() {} };
	};
	process.env.HARNESS_AGENT_HOME = payload;
	process.env[CODING_HARNESS_ENV] = payload;
	try {
		omp.start(lane());
		omp.start(orchestrator());
	} finally {
		patchable.spawn = real;
	}
	expect(spawned).toHaveLength(2);
	for (const env of spawned) {
		expect(env).not.toHaveProperty("HARNESS_AGENT_HOME");
		expect(env).not.toHaveProperty(CODING_HARNESS_ENV);
	}
});

test("the overlay adds the payload's skills folder and the payload folder, and keeps RULES and the owner's AGENTS.md off", () => {
	const overlay = overlayOf(ompArgv(orchestrator({ codingHarness: payload })));
	expect(overlay.skills?.customDirectories).toEqual([join(payload, "skills")]);
	expect(overlay.workspace?.additionalDirectories).toEqual([payload]);
	expect(overlay.disabledExtensions).toContain("rule:RULES");
	expect(overlay.disabledExtensions).toContain("context-file:user:AGENTS.md");
});

test("the payload's rule and agent names are not disabled; the owner's other rules and agents still are", () => {
	const overlay = overlayOf(ompArgv(orchestrator({ codingHarness: payload })));
	expect(overlay.disabledExtensions).not.toContain("rule:always");
	expect(overlay.disabledExtensions).toContain("rule:owner-only");
	expect(overlay.task?.disabledAgents).toEqual(["owner-agent"]);
	const plain = overlayOf(ompArgv(orchestrator()));
	expect(plain.disabledExtensions).toContain("rule:always");
	expect(plain.task?.disabledAgents).toEqual(["deep-reviewer", "owner-agent"]);
});

test("a payload without AGENTS.md or skills adds neither entry", () => {
	rmSync(join(payload, "AGENTS.md"));
	rmSync(join(payload, "skills"), { recursive: true });
	const overlay = overlayOf(ompArgv(orchestrator({ codingHarness: payload })));
	expect(overlay.workspace).toBeUndefined();
	expect(overlay.skills?.customDirectories).toEqual([]);
});

test("without a payload the argv and overlay are what they were: no payload entry and no marker", () => {
	const plain = orchestrator();
	const unset = ompArgv({ ...plain, codingHarness: undefined });
	expect(unset).toEqual(ompArgv(plain));
	expect(unset.filter(a => a === "--extension")).toEqual(["--extension"]);
	expect(overlayText(unset)).toBe(readFileSync(writeOverlay(plain), "utf8"));
	expect(overlayText(unset)).toContain("  customDirectories: []\ncommands:\n");
	expect(overlayText(unset)).not.toContain("workspace:");
	expect(ompArgv(lane()).filter(a => a === "--extension")).toEqual(["--extension"]);
});
