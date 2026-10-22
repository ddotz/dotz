// The nightly harness update with an injected runner: nothing is ever installed for real.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, newer, runHarnessUpdate, type Run } from "./update.ts";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dotz-update-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A fake omo install: `omo --version` reports `version`; `bun add -g` moves it to `installTo` (or fails).
function fakeOmo(version: string, opts: { installTo?: string; addCode?: number } = {}) {
	const state = { version, calls: [] as string[][] };
	const run: Run = async cmd => {
		state.calls.push(cmd);
		if (cmd[1] === "--version") return { code: 0, out: `omo ${state.version} (engine: senpi 2026.10.19)` };
		if (cmd[1] === "add") {
			if (opts.installTo && cmd[3] === "omo-ai@latest") state.version = opts.installTo;
			if (cmd[3] === `omo-ai@${version}`) state.version = version;
			return { code: opts.addCode ?? 0, out: opts.addCode ? "error: network down" : "installed" };
		}
		return { code: 1, out: "unexpected" };
	};
	return { state, run };
}
const harness = (o: { mode?: "check" | "install" | "off"; run: Run; latest?: string }) => {
	const posts: string[] = [];
	const alerts: string[] = [];
	let restarts = 0;
	const deps = { mode: o.mode ?? "install", run: o.run, latest: async () => o.latest, harnesses: ["omo"], stateDir: dir, post: (t: string) => void posts.push(t), alert: (t: string) => void alerts.push(t), restart: () => (restarts++, "restarting") };
	return { deps, posts, alerts, restarts: () => restarts };
};
const adds = (calls: string[][]) => calls.filter(c => c[1] === "add");

test("a new omo-ai installs, verifies and asks for one restart", async () => {
	const omo = fakeOmo("5.1.38", { installTo: "5.1.40" });
	const h = harness({ run: omo.run, latest: "5.1.40" });
	const lines = await runHarnessUpdate(h.deps);
	expect(adds(omo.state.calls)).toEqual([[process.execPath, "add", "-g", "omo-ai@latest"]]);
	expect(lines).toEqual(["실행 하네스 5.1.38 → 5.1.40 올리고 재시작해요 (하던 일이 끝나면)."]);
	expect(h.posts).toEqual(lines);
	expect(h.alerts).toEqual([]);
	expect(h.restarts()).toBe(1);
});

test("a failed install keeps the old version: alert with a choice block, no restart", async () => {
	const omo = fakeOmo("5.1.38", { addCode: 1 });
	const h = harness({ run: omo.run, latest: "5.1.40" });
	await runHarnessUpdate(h.deps);
	expect(h.restarts()).toBe(0);
	expect(h.posts).toEqual([]);
	expect(h.alerts).toHaveLength(1);
	expect(h.alerts[0]).toContain("5.1.38 → 5.1.40 설치하지 못했어요");
	expect(h.alerts[0]).toContain("결정: 업데이트를 어떻게 할까요?");
	expect(h.alerts[0]).toContain("**1) 다시 설치해 봐요**");
	expect(omo.state.version).toBe("5.1.38");
});

test("an install that does not verify is rolled back to the old version", async () => {
	const omo = fakeOmo("5.1.38", { installTo: "5.1.39" });
	// The install exits 0 but leaves a version that is not the one npm called latest and is newer: accepted.
	let h = harness({ run: omo.run, latest: "5.1.40" });
	await runHarnessUpdate(h.deps);
	expect(h.restarts()).toBe(1);
	// An install that exits non-zero after moving the version is put back with an exact-version install.
	const broken = fakeOmo("5.1.38", { installTo: "5.1.40", addCode: 1 });
	h = harness({ run: broken.run, latest: "5.1.40" });
	await runHarnessUpdate(h.deps);
	expect(adds(broken.state.calls).map(c => c[3])).toEqual(["omo-ai@latest", "omo-ai@5.1.38"]);
	expect(broken.state.version).toBe("5.1.38");
	expect(h.restarts()).toBe(0);
	expect(h.alerts).toHaveLength(1);
});

test("an up-to-date omo does nothing", async () => {
	const omo = fakeOmo("5.1.40");
	const h = harness({ run: omo.run, latest: "5.1.40" });
	expect(await runHarnessUpdate(h.deps)).toEqual([]);
	expect(adds(omo.state.calls)).toEqual([]);
	expect(h.posts).toEqual([]);
	expect(h.alerts).toEqual([]);
	expect(h.restarts()).toBe(0);
});

test("a registry that does not answer installs nothing", async () => {
	const omo = fakeOmo("5.1.38");
	const h = harness({ run: omo.run, latest: undefined });
	expect(await runHarnessUpdate(h.deps)).toEqual([]);
	expect(adds(omo.state.calls)).toEqual([]);
	expect(h.restarts()).toBe(0);
});

test("check mode posts a new version once and never installs; off does nothing", async () => {
	const omo = fakeOmo("5.1.38");
	const h = harness({ mode: "check", run: omo.run, latest: "5.1.40" });
	expect(await runHarnessUpdate(h.deps)).toHaveLength(1);
	expect(await runHarnessUpdate(h.deps)).toEqual([]);
	expect(adds(omo.state.calls)).toEqual([]);
	expect(h.restarts()).toBe(0);
	const off = harness({ mode: "off", run: omo.run, latest: "5.1.40" });
	expect(await runHarnessUpdate(off.deps)).toEqual([]);
});

test("omp and omo both updating share one restart request", async () => {
	const omo = fakeOmo("5.1.38", { installTo: "5.1.40" });
	let ompVersion = "18.12.1";
	const run: Run = async (cmd, ms) => {
		if (cmd[0] !== "omp") return omo.run(cmd, ms);
		if (cmd[1] === "update" && cmd[2] === "--check") return { code: 0, out: `Current version: ${ompVersion}\nNew version available: 18.13.0` };
		if (cmd[1] === "update") return (ompVersion = "18.13.0"), { code: 0, out: "updated" };
		return { code: 0, out: `omp/${ompVersion}` };
	};
	const h = harness({ run, latest: "5.1.40" });
	const lines = await runHarnessUpdate({ ...h.deps, harnesses: ["omp", "omo"] });
	expect(lines).toHaveLength(2);
	expect(lines[0]).toStartWith("omp 18.12.1 → 18.13.0");
	expect(h.restarts()).toBe(1);
});

test("version order and the owner-facing check line", () => {
	expect(newer("5.1.40", "5.1.38")).toBe(true);
	expect(newer("5.1.38", "5.1.38")).toBe(false);
	expect(newer("5.1.9", "5.1.10")).toBe(false);
	expect(describe({ status: "new", current: "5.1.38", latest: "5.1.40" }, "실행 하네스")).toBe("실행 하네스 새 버전이 있어요 (5.1.38 → 5.1.40).");
});
