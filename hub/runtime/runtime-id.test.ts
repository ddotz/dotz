import { afterEach, expect, test } from "bun:test";
import { cfg } from "../config.ts";
import { runtimeFor } from "./index.ts";
import { configuredRuntime, DEFAULT_RUNTIME, RUNTIME_IDS, rolesOn, runtimeIdOf } from "./runtime-id.ts";

const was = { runtime: cfg.runtime, orchestrator: cfg.orchestrator, lanes: cfg.lanes };
afterEach(() => {
	cfg.runtime = was.runtime;
	cfg.orchestrator = was.orchestrator;
	cfg.lanes = was.lanes;
});

test("runtimeIdOf names the runtime runtimeFor runs, for omo, omp, claude and an unknown name, for both roles", () => {
	for (const id of [...RUNTIME_IDS, "nope", "constructor", "toString"]) {
		cfg.runtime = id;
		for (const role of ["orchestrator", "lane"] as const) expect(runtimeIdOf(role)).toBe(runtimeFor(role).id);
	}
	cfg.runtime = "nope";
	expect(runtimeIdOf("orchestrator")).toBe(DEFAULT_RUNTIME);
	expect(configuredRuntime("lane")).toBe("nope");
});

test("a role's own runtime wins over the shared one, and each role is answered on its own", () => {
	cfg.runtime = "omo";
	cfg.orchestrator = { runtime: "omp" };
	cfg.lanes = { runtime: "claude" };
	expect([runtimeIdOf("orchestrator"), runtimeIdOf("lane")]).toEqual(["omp", "claude"]);
	expect([runtimeFor("orchestrator").id, runtimeFor("lane").id]).toEqual(["omp", "claude"]);
	expect([rolesOn("omp"), rolesOn("claude"), rolesOn("omo")]).toEqual([true, true, false]);
	cfg.lanes = {};
	expect([runtimeIdOf("lane"), rolesOn("omo")]).toEqual(["omo", true]);
	cfg.runtime = undefined;
	cfg.orchestrator = undefined;
	expect([runtimeIdOf("orchestrator"), runtimeIdOf("lane")]).toEqual([DEFAULT_RUNTIME, DEFAULT_RUNTIME]);
});
