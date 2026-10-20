// One config shape for model choice + fallback order (`models.<target>`), and the move of the pre-2026-10-20 keys into it.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, cfg, fallbackChain, lanesModel, migrateModels, orchestratorModel, updateModels, workerModel } from "./config.ts";

const legacy = () => ({
	identity: { name: "t" },
	orchestrator: { model: "anthropic/o", thinking: "low", runtime: "omo", rotate_tokens: 9, fallback: ["anthropic/o2", { model: "anthropic/o3", when: "quota" }] },
	lanes: { model: "anthropic/l", thinking: "high", max_active: 3, worker_model: "anthropic/w:xhigh", fallback: ["anthropic/l2"], worker_fallback: ["anthropic/w2"] },
});

test("legacy keys move into models; every other key stays; a second pass changes nothing", () => {
	const disk: Record<string, any> = legacy();
	expect(migrateModels(disk)).toBe(true);
	expect(disk.models).toEqual({
		orchestrator: { model: "anthropic/o", thinking: "low", fallback: ["anthropic/o2", { model: "anthropic/o3", when: "quota" }] },
		lanes: { model: "anthropic/l", thinking: "high", fallback: ["anthropic/l2"] },
		workers: { model: "anthropic/w", thinking: "xhigh", fallback: ["anthropic/w2"] },
	});
	expect(disk.orchestrator).toEqual({ runtime: "omo", rotate_tokens: 9 });
	expect(disk.lanes).toEqual({ max_active: 3 });
	expect(disk.identity).toEqual({ name: "t" });
	const again = JSON.stringify(disk);
	expect(migrateModels(disk)).toBe(false);
	expect(JSON.stringify(disk)).toBe(again);
});

test("a value already in models wins; a worker model without a level keeps no level", () => {
	const disk: Record<string, any> = { orchestrator: { model: "anthropic/old" }, lanes: { worker_model: "anthropic/w" }, models: { orchestrator: { model: "anthropic/new" } } };
	expect(migrateModels(disk)).toBe(true);
	expect(disk.models).toEqual({ orchestrator: { model: "anthropic/new" }, workers: { model: "anthropic/w" } });
	expect(disk.orchestrator).toEqual({});
});

test("reading an old config.json migrates it on disk and keeps the old file as a backup", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-models-"));
	const before = JSON.stringify(legacy(), null, 2);
	writeFileSync(join(dir, "config.json"), before);
	const code = `const c = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))}); console.log(JSON.stringify({ o: c.orchestratorModel(), w: c.workerModel(), f: c.fallbackChain("lanes") }));`;
	const p = Bun.spawn(["bun", "-e", code], { env: { ...process.env, DOTZ_DIR: dir }, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	expect(await p.exited).toBe(0);
	expect(JSON.parse(out)).toEqual({ o: { model: "anthropic/o", thinking: "low" }, w: "anthropic/w:xhigh", f: [{ model: "anthropic/l2" }] });
	const disk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
	expect(disk.models.workers).toEqual({ model: "anthropic/w", thinking: "xhigh", fallback: ["anthropic/w2"] });
	expect(disk.lanes).toEqual({ max_active: 3 });
	const backups = readdirSync(dir).filter(n => n.startsWith("config.json.bak-models-"));
	expect(backups).toHaveLength(1);
	expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe(before);
});

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
