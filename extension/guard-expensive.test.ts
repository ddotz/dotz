// Expensive-model gate: a worker never starts on an expensive model unless the owner asked (I2), the gateway's grants file
// counts as the owner's ask (I3), and an owner-picked expensive main model raises no warning (I4).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS } from "./guard-config.ts";
import { installGuard } from "./guard.ts";

const ENV_KEYS = ["DOTZ_DIR", "DOTZ_CONV", "DOTZ_LANE", "DOTZ_ORCHESTRATOR", "DOTZ_WORKER_PIN_FILE", "DOTZ_OWNER_ASKED_FABLE", "ORCH_GUARD_STATE_DIR"];
let saved: Record<string, string | undefined>;
let dir: string;
beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
	dir = mkdtempSync(join(tmpdir(), "dotz-expensive-"));
	mkdirSync(join(dir, "state"), { recursive: true });
	process.env.DOTZ_DIR = dir;
	process.env.ORCH_GUARD_STATE_DIR = join(dir, "orch");
	for (const k of ["DOTZ_CONV", "DOTZ_LANE", "DOTZ_ORCHESTRATOR", "DOTZ_WORKER_PIN_FILE", "DOTZ_OWNER_ASKED_FABLE"]) delete process.env[k];
	writeFileSync(join(dir, "config.json"), JSON.stringify({ models: { workers: { model: "anthropic/claude-sonnet-5-5", thinking: "medium" } } }));
});
afterEach(() => {
	for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
	rmSync(dir, { recursive: true, force: true });
});

const WORKER = "anthropic-subscription/claude-sonnet-5-5:medium";
const gate = { ...GUARD_DEFAULTS, budget_gate: false, ask_before_expensive: true, expensive_models: ["fable", ":xhigh", ":max"] };
const writeState = (name: string, body: unknown, mtimeSec?: number) => {
	const file = join(dir, "state", name);
	writeFileSync(file, JSON.stringify(body));
	if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
};
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

function setup(config: typeof gate = gate, effort = "medium") {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const notes: string[] = [];
	const pi: any = {
		pi: { getAgentDir: () => join(dir, "agent") },
		logger: { warn: () => {} },
		on: (name: string, fn: any) => (handlers[name] ??= []).push(fn),
		registerCommand: () => {},
		registerTool: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => effort,
	};
	installGuard(pi, config);
	const ctx = { agent: { kind: "main" }, cwd: dir, hasUI: true, model: { provider: "anthropic-subscription", id: "claude-opus-5-5" }, ui: { notify: (m: string) => notes.push(m) }, sessionManager: { getSessionId: () => "s" } };
	const call = (input: any, c: any = ctx) => handlers.tool_call[0]({ toolName: "task", input }, c);
	const request = (model: string, c: any = ctx) => handlers.before_provider_request?.forEach(h => h({ payload: { model } }, c));
	return { handlers, ctx, call, request, notes };
}
const omo = (extra: object) => ({ prompt: "check it\nDone when: reported", ...extra });

test("I2: an expensive explicit model on a call or an item is replaced by the worker model, never blocked; category items lose theirs", async () => {
	const { call } = setup();
	const single = await call(omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-fable-5-2" }));
	expect(single.block).toBeUndefined();
	expect(single.input.model).toBe(WORKER);

	const batch = await call({
		model: "anthropic-subscription/claude-opus-5-5:max",
		tasks: [
			omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-opus-5-5:xhigh" }),
			omo({ category: "deep-low", model: "anthropic-subscription/claude-fable-5-2" }),
			omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-sonnet-5-5:high" }),
			omo({ subagent_type: "oracle" }),
		],
	});
	expect(batch.block).toBeUndefined();
	expect("model" in batch.input).toBe(false);
	expect(batch.input.tasks[0].model).toBe(WORKER);
	expect(batch.input.tasks[3].model).toBe(WORKER);
	expect("model" in batch.input.tasks[1]).toBe(false);
	expect(batch.input.tasks[2].model).toBe("anthropic-subscription/claude-sonnet-5-5:high");
});

test("I2: the default worker model applies when config.json names none", async () => {
	writeFileSync(join(dir, "config.json"), "{}");
	const { call } = setup();
	const r = await call(omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-fable-5-2" }));
	expect(r.input.model).toBe("anthropic-subscription/claude-sonnet-5-5:high");
});

test("I2: an expensive live or own pin of the orchestrator is replaced by the worker model for subagent_type items", async () => {
	process.env.DOTZ_ORCHESTRATOR = "1";
	const { call, ctx } = setup(gate, "max");
	const live = await call(omo({ subagent_type: "oracle" }), { ...ctx, model: { provider: "anthropic-subscription", id: "claude-opus-5-5" } });
	expect(live.input.model).toBe(WORKER);
	const fableLive = await call(omo({ subagent_type: "oracle" }), { ...ctx, model: { provider: "anthropic-subscription", id: "claude-fable-5-2" } });
	expect(fableLive.input.model).toBe(WORKER);
	const pinFile = join(dir, "pin");
	writeFileSync(pinFile, "anthropic-subscription/claude-fable-5-2:high");
	process.env.DOTZ_WORKER_PIN_FILE = pinFile;
	const own = await call(omo({ subagent_type: "oracle" }));
	expect(own.block).toBeUndefined();
	expect(own.input.model).toBe(WORKER);
	const cat = await call(omo({ category: "deep-low", model: "anthropic-subscription/claude-fable-5-2" }));
	expect("model" in cat.input).toBe(false);
});

test("I2: a cheap live pin still pins as before", async () => {
	process.env.DOTZ_ORCHESTRATOR = "1";
	const { call, ctx } = setup(gate, "medium");
	const r = await call(omo({ subagent_type: "oracle" }), ctx);
	expect(r.input.model).toBe("anthropic-subscription/claude-opus-5-5:medium");
});

test("I2: the dispatch-time net still blocks an expensive child model", () => {
	const { handlers } = setup();
	expect(handlers.before_subagent_spawn[0]({ agent: "task", patterns: ["anthropic/claude-fable-5-2"] })).toMatchObject({ block: true });
});

test("I2: guard off leaves the call exactly as it was", async () => {
	const { call } = setup({ ...gate, ask_before_expensive: false });
	const r = await call(omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-fable-5-2" }));
	expect(r.block).toBeUndefined();
	expect(r.input.model).toBe("anthropic-subscription/claude-fable-5-2");
});

test("I3: a live grant for this conversation lets an explicit expensive model through; an expired or foreign one does not", async () => {
	process.env.DOTZ_CONV = "ch:77";
	const { call, handlers } = setup();
	const fable = () => omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-fable-5-2" });
	expect((await call(fable())).input.model).toBe(WORKER);

	writeState("expensive-grants.json", { "ch:77": { until: minutes(30), by: "owner" } }, 1_000);
	const granted = await call(fable());
	expect(granted.block).toBeUndefined();
	expect(granted.input.model).toBe("anthropic-subscription/claude-fable-5-2");
	expect(handlers.before_subagent_spawn[0]({ agent: "task", patterns: ["anthropic/claude-fable-5-2"] })).toBeUndefined();

	writeState("expensive-grants.json", { "ch:77": { until: minutes(-1), by: "owner" } }, 2_000);
	expect((await call(fable())).input.model).toBe(WORKER);

	writeState("expensive-grants.json", { main: { until: minutes(30), by: "owner" }, "ch:78": { until: minutes(30), by: "owner" } }, 3_000);
	expect((await call(fable())).input.model).toBe(WORKER);
});

test("I3: the grant key is main without a conversation and lane:<name> in a lane", async () => {
	writeState("expensive-grants.json", { main: { until: minutes(30), by: "owner" } });
	const fable = () => omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-fable-5-2" });
	expect((await setup().call(fable())).input.model).toBe("anthropic-subscription/claude-fable-5-2");
	process.env.DOTZ_LANE = "probe";
	expect((await setup().call(fable())).input.model).toBe(WORKER);
	writeState("expensive-grants.json", { "lane:probe": { until: minutes(30), by: "owner" } }, 5_000);
	expect((await setup().call(fable())).input.model).toBe("anthropic-subscription/claude-fable-5-2");
});

test("I3: DOTZ_OWNER_ASKED_FABLE still lifts the gate", async () => {
	process.env.DOTZ_OWNER_ASKED_FABLE = "1";
	const r = await setup().call(omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-fable-5-2" }));
	expect(r.input.model).toBe("anthropic-subscription/claude-fable-5-2");
});

test("I4: an owner-picked expensive main model raises no warning; any other one warns once and never tells the agent to switch back", () => {
	const pick = (by: string, model = "anthropic/claude-fable-5-2", thinking = "high") => writeState("model-picks.json", { orchestrator: { model, thinking, by, at: minutes(0) } });
	const warns = (picks?: () => void, effort = "high", model = "claude-fable-5-2") => {
		picks?.();
		const s = setup(gate, effort);
		s.request(model);
		s.request(model);
		return s.notes;
	};
	expect(warns(() => pick("owner"))).toEqual([]);
	expect(warns(() => pick("owner-message:m42"))).toEqual([]);
	for (const notes of [warns(() => pick("fallback")), warns(() => pick("owner", "anthropic/claude-opus-5-5")), warns(() => rmSync(join(dir, "state", "model-picks.json"), { force: true }))]) {
		expect(notes.length).toBe(1);
		expect(notes[0]).toContain("expensive model");
		expect(notes[0]).not.toMatch(/switch back/i);
		expect(notes[0]).toMatch(/ask the owner/i);
	}
	// A max effort pick the owner made on the same model counts; the same model at another effort level does not.
	expect(warns(() => pick("owner", "anthropic/claude-opus-5-5", "max"), "max", "claude-opus-5-5")).toEqual([]);
	expect(warns(() => pick("owner", "anthropic/claude-opus-5-5", "high"), "max", "claude-opus-5-5").length).toBe(1);
});

test("I3: in the main orchestrator a granted job keeps its explicit expensive model through the live pin", async () => {
	process.env.DOTZ_ORCHESTRATOR = "1";
	writeState("expensive-grants.json", { main: { until: minutes(30), by: "owner" } });
	const { call } = setup(gate, "medium");
	const r = await call(omo({ subagent_type: "oracle", model: "anthropic-subscription/claude-fable-5-2" }));
	expect(r.input.model).toBe("anthropic-subscription/claude-fable-5-2");
	const plain = await call(omo({ subagent_type: "oracle" }));
	expect(plain.input.model).toBe("anthropic-subscription/claude-opus-5-5:medium");
});

test("I4: a conversation on main's model counts main's owner pick", () => {
	process.env.DOTZ_CONV = "ch:5";
	writeState("model-picks.json", { orchestrator: { model: "anthropic/claude-fable-5-2", thinking: "high", by: "owner", at: minutes(0) } });
	const s = setup(gate, "high");
	s.request("claude-fable-5-2");
	expect(s.notes).toEqual([]);
});
