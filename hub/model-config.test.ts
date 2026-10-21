// One config shape for model choice + fallback order (`models.<target>`).
import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE, cfg, fallbackChain, lanesModel, orchestratorModel, updateModels, workerModel } from "./config.ts";

const saved = { text: readFileSync(CONFIG_FILE, "utf8"), models: cfg.models };
afterAll(() => {
	writeFileSync(CONFIG_FILE, saved.text);
	cfg.models = saved.models;
});

test("updateModels writes one target's block (model, thinking, fallback) and the accessors read it", () => {
	updateModels("workers", { model: "anthropic/w9", thinking: "low", fallback: ["anthropic/w10"] });
	updateModels("lanes", { fallback: [{ model: "anthropic/l9", when: "error" }] });
	expect(workerModel()).toBe("anthropic/w9:low");
	expect(fallbackChain("workers")).toEqual([{ model: "anthropic/w10" }]);
	expect(fallbackChain("lanes")).toEqual([{ model: "anthropic/l9", when: "error" }]);
	expect(lanesModel()).toEqual({ model: "anthropic/test-lane", thinking: "medium" });
	expect(orchestratorModel()).toEqual({ model: "anthropic/test-orch", thinking: "low" });
	const disk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	expect(disk.models.workers).toEqual({ model: "anthropic/w9", thinking: "low", fallback: ["anthropic/w10"] });
	expect(disk.models.lanes).toEqual({ model: "anthropic/test-lane", thinking: "medium", fallback: [{ model: "anthropic/l9", when: "error" }] });
	expect(disk.lanes.worker_model).toBeUndefined();
});
