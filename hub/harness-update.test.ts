// The in-app harness update with an injected runner and registry: nothing is ever installed for real.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flush } from "./runtime/test-clock.ts";
import { CACHE_FILE, applyHarness, checkHarness, harnessIds, harnessUpdateRoute, jobOf, resetHarnessJobs, type Tools } from "./harness-update.ts";

let dir: string;
const OMO_BIN = "/Users/fake/.bun/bin/omo";
const OMP_BIN = "/Users/fake/.local/bin/omp";
const OMO_REAL = "/Users/fake/.bun/install/global/node_modules/omo-ai/bin/omo.js";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-harness-update-"));
	resetHarnessJobs();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A fake omo install: `omo --version` reports state.version; `bun add -g omo-ai@X` moves it to X or fails.
function fake(o: { version?: string; latest?: string; addCode?: number; busy?: string[]; omp?: string; registryError?: string } = {}) {
	const state = { version: o.version ?? "5.1.48", latest: o.latest ?? "5.1.49", ompVersion: /Current version:\s*(\S+)/.exec(o.omp ?? "")?.[1] ?? "18.12.6", busy: [...(o.busy ?? [])], calls: [] as string[][], restarts: 0 };
	const schedules: (() => void)[] = [];
	const t: Tools = {
		run: async cmd => {
			state.calls.push(cmd);
			if (cmd[0] === OMP_BIN && cmd[1] === "--version") return { code: 0, out: `omp/${state.ompVersion}` };
			if (cmd[1] === "--version") return { code: 0, out: `omo ${state.version} (engine: senpi 2026.10.25-2)` };
			if (cmd[1] === "add") {
				const target = cmd[3]!.split("@")[1]!;
				if (o.addCode) return { code: o.addCode, out: "error: registry unreachable" };
				state.version = target;
				return { code: 0, out: "installed" };
			}
			if (cmd[1] === "update" && cmd.length === 3) return { code: 0, out: o.omp ?? "Current version: 18.12.6\nNew version available: 18.12.9" };
			if (cmd[1] === "update") {
				state.ompVersion = /New version available:\s*(\S+)/.exec(o.omp ?? "")?.[1] ?? state.ompVersion;
				return { code: 0, out: "updated" };
			}
			return { code: 1, out: `unexpected ${cmd.join(" ")}` };
		},
		registry: async () => (o.registryError ? { error: o.registryError } : { version: state.latest }),
		which: bin => (bin === OMO_BIN ? OMO_BIN : bin === OMP_BIN ? OMP_BIN : undefined),
		realpath: p => (p === OMO_BIN ? OMO_REAL : p),
		busy: () => state.busy,
		restart: () => (state.restarts++, "gateway restarts when idle"),
		dataDir: dir,
		bins: { omo: OMO_BIN, omp: OMP_BIN },
		bun: "/opt/bun",
		schedule: fn => void schedules.push(fn),
	};
	const adds = () => state.calls.filter(c => c[1] === "add");
	const cache = () => JSON.parse(readFileSync(join(dir, CACHE_FILE), "utf8")) as Record<string, { current?: string; available?: boolean }>;
	return { state, t, schedules, adds, cache };
}

test("harnessIds lists the harness the gateway actually runs", () => {
	expect(harnessIds()).toEqual(["omo"]);
});

test("a newer omo-ai in the registry shows as available, installed with bun global", async () => {
	const f = fake();
	const [s] = await checkHarness(f.t);
	expect(s).toMatchObject({ id: "omo", name: "OmO", current: "5.1.48", latest: "5.1.49", available: true, installMethod: "bun-global" });
	expect(s.error).toBeUndefined();
});

test("an up-to-date omo is not available and installs nothing", async () => {
	const f = fake({ latest: "5.1.48" });
	const [s] = await checkHarness(f.t);
	expect(s.available).toBe(false);
	expect(s.latest).toBe("5.1.48");
	expect(f.adds()).toEqual([]);
});

test("omp is left alone when another program manages it", async () => {
	const f = fake({ omp: `${OMP_BIN} is installed and kept up to date by Tern; update it from Tern.` });
	const [s] = await checkHarness(f.t, { ids: ["omp"] });
	expect(s).toMatchObject({ id: "omp", name: "omp", available: false, installMethod: "managed", managedBy: "Tern" });
	const job = await applyHarness("omp", f.t);
	expect(job.status).toBe("failed");
	expect(job.message).toContain("Tern");
	expect(f.state.calls.filter(c => c[1] === "update" && c.length === 2)).toEqual([]);
});

test("an available omp installs with `omp update`, verifies and asks for one restart", async () => {
	const f = fake({ omp: "Current version: 18.12.6\nNew version available: 18.12.9" });
	const [s] = await checkHarness(f.t, { ids: ["omp"] });
	expect(s).toMatchObject({ current: "18.12.6", latest: "18.12.9", available: true, installMethod: "omp-update" });
	const job = await applyHarness("omp", f.t);
	expect(job.status).toBe("updated");
	expect(f.state.calls).toContainEqual([OMP_BIN, "update"]);
	expect(f.state.restarts).toBe(1);
});

test("an update installs the exact version, verifies it and asks for one idle restart", async () => {
	const f = fake();
	const job = await applyHarness("omo", f.t);
	expect(job.status).toBe("updated");
	expect(f.adds()).toEqual([["/opt/bun", "add", "-g", "omo-ai@5.1.49"]]);
	expect(job.message).toContain("5.1.48 → 5.1.49");
	expect(f.state.restarts).toBe(1);
	expect(f.cache().omo).toMatchObject({ current: "5.1.49", available: false });
});

test("a failed install keeps the old version and reports it, with no restart", async () => {
	const f = fake({ addCode: 1 });
	const job = await applyHarness("omo", f.t);
	expect(job.status).toBe("failed");
	expect(job.message).toContain("지금 버전(5.1.48)을 그대로 써요");
	expect(f.state.version).toBe("5.1.48");
	expect(f.state.restarts).toBe(0);
	expect(f.state.calls.filter(c => c[1] === "add")).toHaveLength(1);
});

test("busy work defers the install until the gateway is idle", async () => {
	const f = fake({ busy: ["orchestrator", "lane blog"] });
	const job = await applyHarness("omo", f.t);
	expect(job.status).toBe("deferred");
	expect(job.message).toContain("orchestrator");
	expect(f.adds()).toEqual([]);
	expect(f.state.restarts).toBe(0);
	expect(f.schedules).toHaveLength(1);
	f.schedules[0]!();
	expect(f.adds()).toEqual([]);
	expect(f.schedules).toHaveLength(2);
	f.state.busy = [];
	f.schedules[1]!();
	await flush();
	expect(f.adds()).toEqual([["/opt/bun", "add", "-g", "omo-ai@5.1.49"]]);
	expect(jobOf("omo")?.status).toBe("updated");
	expect(f.state.restarts).toBe(1);
});

test("a registry failure keeps the last known latest and still shows it offline", async () => {
	const ok = fake();
	await checkHarness(ok.t, { force: true });
	const offline = fake({ registryError: "네트워크에 연결하지 못했어요" });
	offline.state.version = "5.1.48";
	const cache = JSON.parse(readFileSync(join(dir, CACHE_FILE), "utf8"));
	expect(cache.omo.latest).toBe("5.1.49");
	const [s] = await checkHarness(offline.t, { force: true });
	expect(s.current).toBe("5.1.48");
	expect(s.latest).toBe("5.1.49");
	expect(s.available).toBe(true);
	expect(s.error).toContain("네트워크");
});

test("the route: GET lists the cache, POST check refreshes it and POST apply starts the job", async () => {
	const f = fake();
	const deps = { busy: () => [] as string[], restartIdle: () => "", tools: f.t };
	const get = await harnessUpdateRoute(new Request("http://hub/api/harness/update"), new URL("http://hub/api/harness/update"), deps);
	const listed = (await get!.json()) as { harnesses: { id: string; available: boolean }[]; checking: boolean };
	expect(listed.harnesses.map(h => h.id)).toEqual(["omo"]);
	const check = await harnessUpdateRoute(new Request("http://hub/api/harness/update/check", { method: "POST" }), new URL("http://hub/api/harness/update/check"), deps);
	const refreshed = (await check!.json()) as { harnesses: { available: boolean; latest: string }[] };
	expect(refreshed.harnesses[0]).toMatchObject({ available: true, latest: "5.1.49" });
	const apply = await harnessUpdateRoute(new Request("http://hub/api/harness/update/apply", { method: "POST", body: JSON.stringify({ id: "omo" }) }), new URL("http://hub/api/harness/update/apply"), deps);
	expect(apply!.status).toBe(202);
	await flush();
	expect(jobOf("omo")?.status).toBe("updated");
	const again = await harnessUpdateRoute(new Request("http://hub/api/harness/update/apply", { method: "POST", body: JSON.stringify({ id: "nope" }) }), new URL("http://hub/api/harness/update/apply"), deps);
	expect(again!.status).toBe(400);
});

test("an OmO desktop app copy is reported and never installed over", async () => {
	const f = fake();
	f.t.realpath = () => "/Applications/OmO.app/Contents/Resources/app/bin/omo.js";
	f.t.which = () => "/Applications/OmO.app/Contents/Resources/app/bin/omo";
	const [s] = await checkHarness(f.t);
	expect(s.installMethod).toBe("app");
	expect(s.available).toBe(false);
	const job = await applyHarness("omo", f.t);
	expect(job.status).toBe("failed");
	expect(job.message).toContain("앱에서 업데이트해 주세요");
	expect(f.adds()).toEqual([]);
});
