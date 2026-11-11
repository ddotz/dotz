// An install updated from before model-picks.json: the model settings it already had are the owner's, recorded once at the gateway's start
// (the update migrations), so an owner-set expensive main raises no "ask the owner" notice. A target that already has a record keeps it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS } from "../extension/guard-config.ts";
import { ownerPickedHere } from "../extension/guard-expensive.ts";
import { runMigrations } from "./migrations.ts";

const KEPT = { dotz: process.env.DOTZ_DIR, legacy: process.env.DOTZ_LEGACY_SECRETS, conv: process.env.DOTZ_CONV, lane: process.env.DOTZ_LANE };
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-picks-baseline-"));
	process.env.DOTZ_DIR = dir;
	process.env.DOTZ_LEGACY_SECRETS = "";
	delete process.env.DOTZ_CONV;
	delete process.env.DOTZ_LANE;
});
afterEach(() => {
	for (const [k, v] of [["DOTZ_DIR", KEPT.dotz], ["DOTZ_LEGACY_SECRETS", KEPT.legacy], ["DOTZ_CONV", KEPT.conv], ["DOTZ_LANE", KEPT.lane]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
	rmSync(dir, { recursive: true, force: true });
});

const put = (rel: string, value: unknown) => {
	mkdirSync(join(dir, rel, ".."), { recursive: true });
	writeFileSync(join(dir, rel), JSON.stringify(value));
};
const picks = () => JSON.parse(readFileSync(join(dir, "state", "model-picks.json"), "utf8"));
const gate = { ...GUARD_DEFAULTS, ask_before_expensive: true, expensive_models: ["fable", ":xhigh", ":max"] };
const start = async () => {
	const logs: string[] = [];
	await runMigrations({ dataDir: dir, ask: () => {}, notify: () => {}, log: s => void logs.push(s) });
	return logs;
};

test("a start without model records takes the configured models and a session's own model as the owner's, once", async () => {
	put("config.json", { models: { orchestrator: { model: "anthropic/claude-fable-5-2", thinking: "high" }, workers: { model: "anthropic/claude-sonnet-5-5" } } });
	put("conv-sessions/ch-9/state.json", { key: "ch:9", primary: "ch:9", ownModel: "anthropic/claude-opus-5-5:max" });
	put("conv-sessions/ch-10/state.json", { key: "ch:10", primary: "ch:10" });
	expect(ownerPickedHere("claude-fable-5-2", "high", gate)).toBe(false);

	const logs = await start();
	const p = picks();
	expect(p.orchestrator).toMatchObject({ model: "anthropic/claude-fable-5-2", thinking: "high", by: "owner" });
	expect(typeof p.orchestrator.evidence).toBe("string");
	expect(p.workers).toMatchObject({ model: "anthropic/claude-sonnet-5-5", by: "owner" });
	expect(p["ch:9"]).toMatchObject({ model: "anthropic/claude-opus-5-5", thinking: "max", by: "owner" });
	expect(Object.keys(p).sort()).toEqual(["ch:9", "orchestrator", "workers"]);
	expect(logs.filter(l => l.includes("model-picks")).length).toBe(1);
	expect(logs.some(l => l.startsWith("model change"))).toBe(false);
	expect(ownerPickedHere("claude-fable-5-2", "high", gate)).toBe(true);
	process.env.DOTZ_CONV = "ch:9";
	expect(ownerPickedHere("claude-opus-5-5", "max", gate)).toBe(true);

	// Once: a record dropped later is not made again on the next start.
	put("state/model-picks.json", {});
	await start();
	expect(picks()).toEqual({});
});

test("a target that already has a record keeps it, a fallback one included", async () => {
	put("config.json", { models: { orchestrator: { model: "anthropic/claude-fable-5-2", thinking: "high" }, lanes: { model: "anthropic/claude-sonnet-5-5", thinking: "high" } } });
	const fallback = { model: "anthropic/claude-fable-5-2", thinking: "high", by: "fallback", at: "2026-11-01T00:00:00.000Z" };
	put("state/model-picks.json", { orchestrator: fallback });
	await start();
	const p = picks();
	expect(p.orchestrator).toEqual(fallback);
	expect(p.lanes).toMatchObject({ model: "anthropic/claude-sonnet-5-5", thinking: "high", by: "owner" });
	expect(ownerPickedHere("claude-fable-5-2", "high", gate)).toBe(false);
});

test("an install that never set a model gets no record", async () => {
	put("config.json", {});
	await start();
	expect(() => picks()).toThrow();
});
