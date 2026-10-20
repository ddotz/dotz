// DOTZ_DIR points at the throwaway config of the bun test preload (hub/runtime/test-setup.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as discord from "./discord.ts";
import { denyLines, fallbackChain, harnessProjects } from "./harnessprojects.ts";
import type { HarnessNode } from "./harness.ts";
import { lanes, type Lane } from "./lanes.ts";
import { lanesModel, workerModel } from "./config.ts";

let dir = "";
const node = (id: string): HarnessNode => ({ id, kind: "gateway", group: "flow", label: id, summary: "", desc: "", facts: [], settings: [] });
// A running lane (its process up), so it counts as live unless a test says otherwise.
const lane = (name: string, cwd: string, extra: Partial<Lane> = {}): Lane => ({ name, cwd, model: `${lanesModel().model}:${lanesModel().thinking}`, status: "idle", startedAt: "", reports: 0, ctx: {} as Lane["ctx"], lastText: "", proc: {} as Lane["proc"], ...extra });
const projects = (disk: Record<string, any> = {}) => harnessProjects({ disk, mName: s => s, gateway: node("gateway"), orchestrator: node("orchestrator") });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-proj-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	lanes.clear();
	for (const k of ["lanes", "homes", "work", "threads"] as const) discord.channels[k] = {};
});

test("fallbackChain reads the config schema: selector strings and condition objects, junk and bad conditions dropped", () => {
	expect(fallbackChain(["a/b", { model: "c/d", when: "quota", cap: { period: "month", usd: 50 }, revert: true }, { model: "e/f", when: "rate-limit", cap: "20%" }, { nope: 1 }, 5, ""])).toEqual([{ model: "a/b" }, { model: "c/d", when: "quota", cap: { period: "month", usd: 50 }, revert: true }, { model: "e/f" }]);
	expect(fallbackChain(undefined)).toEqual([]);
});

test("denyLines reads the Blocked commands section only", () => {
	const text = "# x\n- deny: ignored | not in the section\n## Blocked commands\n- deny: rm\\s+-rf | no\n## Other\n- deny: also ignored | no\n";
	expect(denyLines(text).map(m => [m[1], m[2]])).toEqual([["rm\\s+-rf", "no"]]);
});

test("a lane with a work channel or a home channel is a project; a channel-less lane is not", () => {
	lanes.set("solo", lane("solo", dir));
	lanes.set("work-lane", lane("work-lane", dir));
	lanes.set("home-lane", lane("home-lane", dir));
	discord.channels.lanes = { "work-lane": "10", "home-lane": "21" };
	discord.channels.homes = { "home-lane": "20" };
	discord.channels.work = { "10": "site", "20": "api" };
	discord.channels.threads = { "21": { parent: "20", name: "[run] auth" } };
	const got = projects();
	expect(got.map(p => p.id)).toEqual(["home-lane", "work-lane"]);
	expect(got[0]!.channels.map(c => [c.name, c.kind])).toEqual([["api", "home"], ["[run] auth", "thread"]]);
	expect(got[1]!.channels.map(c => [c.name, c.kind])).toEqual([["site", "work"]]);
});

test("an ended lane (exited, or its process gone) is not a project, even with a channel; its data stays", () => {
	lanes.set("live", lane("live", dir));
	lanes.set("exited", lane("exited", dir, { status: "exited", proc: undefined }));
	lanes.set("dead", lane("dead", dir, { status: "idle", proc: undefined }));
	discord.channels.lanes = { live: "1", exited: "2", dead: "3" };
	discord.channels.work = { "1": "one", "2": "two", "3": "three" };
	expect(projects().map(p => p.id)).toEqual(["live"]);
	expect([...lanes.keys()].sort()).toEqual(["dead", "exited", "live"]);
});

test("fields say what overrides the global default and keep the global value", () => {
	const g = lanesModel(), w = workerModel();
	lanes.set("a", lane("a", dir, { model: `${g.model}:xhigh`, workerModel: "other/worker:low", runtime: "custom" } as Partial<Lane>));
	lanes.set("b", lane("b", dir));
	discord.channels.lanes = { a: "1", b: "2" };
	discord.channels.work = { "1": "one", "2": "two" };
	const [a, b] = projects({ lanes: { runtime: "omp" }, models: { lanes: { fallback: ["x/y"] } } });
	expect(a!.fields.model).toEqual({ value: g.model, source: "global" });
	expect(a!.fields.effort).toEqual({ value: "xhigh", source: "project", global: g.thinking });
	expect(a!.fields.worker_model.source).toBe("project");
	expect(a!.fields.worker_model.global).toBe(w.slice(0, w.lastIndexOf(":")));
	expect(a!.fields.runtime).toEqual({ value: "custom", source: "project", global: "omp" });
	expect(a!.fields.fallback).toEqual({ value: [{ model: "x/y" }], source: "global" });
	expect(a!.overrides).toBe(4);
	expect(b!.overrides).toBe(0);
});

test("project folder: instruction files by name/size/heading only, deny lines, skills; setup logins by name", () => {
	mkdirSync(join(dir, ".omp", "skills", "ship"), { recursive: true });
	writeFileSync(join(dir, "AGENTS.md"), "# Guide\nSECRET-BODY\n\n## Blocked commands\n- deny: git push | CI only\n");
	writeFileSync(join(dir, ".omp", "skills", "ship", "SKILL.md"), "---\nname: ship\ndescription: Ship it\n---\n");
	lanes.set("a", lane("a", dir));
	discord.channels.lanes = { a: "1" };
	discord.channels.work = { "1": "one" };
	const [p] = projects();
	expect(p!.files.find(f => f.name === "AGENTS.md")).toMatchObject({ heading: "Guide" });
	expect(JSON.stringify(p)).not.toContain("SECRET-BODY");
	expect(p!.deny).toEqual([{ pattern: "git push", reason: "CI only", file: "AGENTS.md" }]);
	expect(p!.features).toEqual([{ kind: "skill", name: "ship", what: "Ship it" }]);
	expect(p!.map.nodes.some(n => n.id === "p-lane")).toBe(true);
	expect(p!.map.nodes.find(n => n.id === "gateway")!.settings).toEqual([]);
});

test("lanes working in a /tmp scratch folder are not listed as projects", () => {
	lanes.set("real", lane("real", dir));
	lanes.set("fix5-block", lane("fix5-block", "/tmp/dotz-fix5-block"));
	lanes.set("lat-probe", lane("lat-probe", "/private/tmp/dotz-latprobe"));
	discord.channels.lanes = { real: "10", "fix5-block": "11", "lat-probe": "12" };
	expect(projects().map(p => p.name)).toEqual(["real"]);
});
