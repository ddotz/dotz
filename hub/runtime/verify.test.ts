// The runtime checklist: verdict rules, the adjustment of non-core items, and the guarded switch (`use`).
import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR } from "../config.ts";
import { advance, flush } from "./test-clock.ts";
import { adjustItems, CHECKLIST, type CheckItem, type Detected, lastReport, type Probe, refusalFor, UseRefused, useRuntime, verdictOf, verifyRuntime } from "./verify.ts";
import type { RuntimeAdapter } from "./types.ts";

// Stand-in adapter: verify.ts only needs its presence and the probes passed in the options.
const stub = { id: "claude", caps: {}, start() { throw new Error("not used"); }, classifyError: () => undefined, recentExchanges: () => undefined } as unknown as RuntimeAdapter;
const pass: Probe = async () => ({ result: "ok", note: "통과" });
const allOk = Object.fromEntries(CHECKLIST.map(c => [c.id, pass]));
const detected = (id: string, version = "1.0.0"): Detected[] => [{ id: id as never, label: id, installed: true, version, hasAdapter: true, usable: true }];
const item = (id: string, result: CheckItem["result"]): CheckItem => ({ ...CHECKLIST.find(c => c.id === id)!, result, note: "" });

afterEach(() => {
	rmSync(join(DATA_DIR, "runtime-checks"), { recursive: true, force: true });
	delete cfg.runtime;
	delete cfg.orchestrator?.runtime;
	delete cfg.lanes?.runtime;
});

test("a failing or unsupported core item blocks, non-core ones only adjust", () => {
	expect(verdictOf(CHECKLIST.map(c => ({ ...c, result: "ok" as const, note: "" })))).toBe("ok");
	expect(verdictOf([item("turn", "fail"), item("handover", "ok")])).toBe("blocked");
	expect(verdictOf([item("deny_lines", "unsupported")])).toBe("blocked");
	expect(verdictOf([item("handover", "adapted"), item("turn", "ok")])).toBe("adjusted");
	const adjusted = adjustItems([item("workers_spawn", "unsupported"), item("handover", "fail"), item("turn", "ok")]);
	expect(adjusted.map(i => i.result)).toEqual(["disabled", "adapted", "ok"]);
	expect(adjusted[0].note).toContain("원인");
	expect(verdictOf(adjusted)).toBe("adjusted");
});

test("verifyRuntime: all probes pass -> ok and the report is saved", async () => {
	const r = await verifyRuntime("claude", { adapter: stub, probes: allOk, version: "1.0.0", timeoutMs: 1000 });
	expect(r.verdict).toBe("ok");
	expect(r.items.map(i => i.id)).toEqual(CHECKLIST.map(c => c.id));
	expect(lastReport("claude")?.verdict).toBe("ok");
	expect(lastReport("claude")?.version).toBe("1.0.0");
});

test("verifyRuntime: missing non-core probes are adjusted, a throwing core probe blocks", async () => {
	const core = Object.fromEntries(CHECKLIST.filter(c => c.core).map(c => [c.id, pass]));
	const adjusted = await verifyRuntime("claude", { adapter: stub, probes: core, version: "1", timeoutMs: 1000 });
	expect(adjusted.verdict).toBe("adjusted");
	expect(adjusted.items.find(i => i.id === "workers_spawn")?.result).toBe("disabled");
	expect(adjusted.items.find(i => i.id === "handover")?.result).toBe("adapted");
	const blocked = await verifyRuntime("claude", { adapter: stub, probes: { ...core, resume: async () => { throw new Error("boom"); } }, version: "1", timeoutMs: 1000 });
	expect(blocked.verdict).toBe("blocked");
	expect(blocked.items.find(i => i.id === "resume")).toMatchObject({ result: "fail", note: "boom" });
});

test("verifyRuntime: a probe that never answers fails after its timeout", async () => {
	const hang: Probe = () => new Promise(() => {});
	const p = verifyRuntime("claude", { adapter: stub, probes: { ...allOk, turn: hang }, version: "1", timeoutMs: 50 });
	await flush();
	await advance(100);
	const r = await p;
	expect(r.items.find(i => i.id === "turn")?.result).toBe("fail");
	expect(r.verdict).toBe("blocked");
});

test("verifyRuntime: no adapter -> every item fails and the verdict is blocked", async () => {
	const r = await verifyRuntime("codex", { probes: {}, version: "0.1" });
	expect(r.items.every(i => i.result === "fail" && i.note === "어댑터 없음")).toBe(true);
	expect(r.items.filter(i => i.core).every(i => i.result === "fail" && i.note === "어댑터 없음")).toBe(true);
	expect(r.verdict).toBe("blocked");
});

test("use: refused without a report, with a blocked report, and for a stale version", async () => {
	expect(await useRuntime("claude", ["orchestrator"], detected("claude")).catch(e => e)).toBeInstanceOf(UseRefused);
	await verifyRuntime("claude", { adapter: stub, probes: {}, version: "1.0.0" });
	expect(lastReport("claude")?.verdict).toBe("blocked");
	await expect(useRuntime("claude", ["orchestrator"], detected("claude"))).rejects.toThrow("막혔어요");
	await verifyRuntime("claude", { adapter: stub, probes: allOk, version: "1.0.0" });
	await expect(useRuntime("claude", ["orchestrator"], detected("claude", "1.1.0"))).rejects.toThrow("버전");
	expect(cfg.orchestrator?.runtime).toBeUndefined();
});

test("use: an ok report writes the runtime keys and keeps the rest of config.json", async () => {
	await verifyRuntime("claude", { adapter: stub, probes: allOk, version: "1.0.0" });
	const before = await Bun.file(join(DATA_DIR, "config.json")).json();
	expect(await useRuntime("claude", ["orchestrator", "lanes"], detected("claude"))).toEqual(["orchestrator", "lanes"]);
	const disk = await Bun.file(join(DATA_DIR, "config.json")).json();
	expect(disk.orchestrator.runtime).toBe("claude");
	expect(disk.lanes.runtime).toBe("claude");
	expect(disk.models).toEqual(before.models);
	expect(disk.discord).toEqual(before.discord);
	await useRuntime("omp", ["orchestrator", "lanes"]);
	expect((await Bun.file(join(DATA_DIR, "config.json")).json()).orchestrator.runtime).toBe("omp");
});

test("refusalFor: omp needs no report; uninstalled and adapterless runtimes are refused", () => {
	expect(refusalFor("omp", undefined, undefined)).toBeUndefined();
	expect(refusalFor("omo", { id: "omo", label: "", installed: false, hasAdapter: false, usable: false }, undefined)).toBe("설치되어 있지 않아요");
	expect(refusalFor("codex", { id: "codex", label: "", installed: true, hasAdapter: false, usable: false }, undefined)).toBe("이 하네스용 어댑터가 없어요");
	expect(existsSync(join(DATA_DIR, "runtime-checks", "omp.json"))).toBe(false);
});
