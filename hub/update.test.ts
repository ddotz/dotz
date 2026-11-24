// The nightly harness update with an injected runner: nothing is ever installed for real.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, DATA_DIR, OMP } from "./config.ts";
import { cardCovers } from "./doctor.ts";
import { update } from "./doctor-checks.ts";
import type { Finding } from "./doctor-types.ts";
import { emit } from "./events.ts";
import { allNotices, resetNoticesForTest } from "./notices.ts";
import { cardAlert, describe, harnessLabel, newer, runHarnessUpdate, type Run, updateHooks } from "./update.ts";

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
const GLOBAL_OMO = "/home/u/.bun/install/global/node_modules/omo-ai/bin/omo.js";
const harness = (o: { mode?: "check" | "install" | "off"; run: Run; latest?: string; omoAt?: string }) => {
	const posts: string[] = [];
	const alerts: string[] = [];
	let restarts = 0;
	const deps = { mode: o.mode ?? "install", run: o.run, latest: async () => o.latest, locate: () => o.omoAt ?? GLOBAL_OMO, harnesses: ["omo"], stateDir: dir, post: (t: string) => void posts.push(t), alert: (t: string) => void alerts.push(t), restart: () => (restarts++, "restarting") };
	return { deps, posts, alerts, restarts: () => restarts };
};
const adds = (calls: string[][]) => calls.filter(c => c[1] === "add");

test("a new omo-ai installs, verifies and asks for one restart", async () => {
	const omo = fakeOmo("5.1.38", { installTo: "5.1.40" });
	const h = harness({ run: omo.run, latest: "5.1.40" });
	const lines = await runHarnessUpdate(h.deps);
	expect(adds(omo.state.calls)).toEqual([[process.execPath, "add", "-g", "omo-ai@latest"]]);
	expect(lines).toEqual(["작업 프로그램 5.1.38 → 5.1.40 올리고 재시작해요 (하던 일이 끝나면)."]);
	expect(h.posts).toEqual(lines);
	expect(h.alerts).toEqual([]);
	expect(h.restarts()).toBe(1);
});

test("an omo on PATH that bun -g does not own is not installed over: one worklog line, no alert", async () => {
	const omo = fakeOmo("5.1.48", { installTo: "5.1.51" });
	const h = harness({ run: omo.run, latest: "5.1.51", omoAt: "/home/u/node_modules/omo-ai/bin/omo.js" });
	const lines = await runHarnessUpdate(h.deps);
	expect(adds(omo.state.calls)).toEqual([]);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("/home/u/node_modules/omo-ai/bin/omo.js");
	expect(h.alerts).toEqual([]);
	expect(h.restarts()).toBe(0);
	// The same latest version is reported once.
	expect(await runHarnessUpdate(h.deps)).toEqual([]);
});

test("a failed install keeps the old version: alert with a choice block in the owner's language, no restart", async () => {
	const omo = fakeOmo("5.1.38", { addCode: 1 });
	const h = harness({ run: omo.run, latest: "5.1.40" });
	const was = cfg.identity;
	cfg.identity = { ...was!, language: "ko" };
	try {
		await runHarnessUpdate(h.deps);
	} finally {
		cfg.identity = was;
	}
	expect(h.restarts()).toBe(0);
	expect(h.posts).toEqual([]);
	expect(h.alerts).toHaveLength(1);
	expect(h.alerts[0]).toContain("5.1.38 → 5.1.40 설치하지 못했어요");
	expect(h.alerts[0]).toContain("**1) 다시 설치해 봐요**");
	expect(omo.state.version).toBe("5.1.38");
});

test("the failed-install card, posted with its id the way the gateway posts it, keeps the doctor from asking about that harness only", async () => {
	resetNoticesForTest();
	const plain: string[] = [];
	const alert = cardAlert(async (target, text, _replyTo, extra) => void emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target, text, ...extra }), text => void plain.push(text));
	await runHarnessUpdate({ ...harness({ run: fakeOmo("5.1.38", { addCode: 1 }).run, latest: "5.1.40" }).deps, alert });
	expect(plain).toEqual([]);
	const cards = allNotices().filter(n => n.kind === "decision");
	expect(cards.map(n => n.decision?.card_id)).toEqual(["update:omo"]);
	const covers = cardCovers(cards, Date.now(), { watch: name => name, harness: harnessLabel });
	const failed = (id: string): Finding => ({ key: `update:${id}`, area: "update", what: "failed", evidence: id, since: 0, level: 1, ask: true });
	expect(covers(failed("omo"))).toBe(true);
	expect(covers(failed("omp"))).toBe(false);
	resetNoticesForTest();
});

function twoFailing(o: { ompTo: string; rollbackCode: number }): Run {
	const v = { omp: "18.12.1", omo: "5.1.38" };
	return async cmd => {
		if (cmd[0] === OMP && cmd[1] === "update") {
			if (cmd[2] === "--check") return { code: 0, out: `Current version: ${v.omp}\nNew version available: 18.13.0` };
			v.omp = o.ompTo;
			return { code: 1, out: "omp: download failed" };
		}
		if (cmd[1] === "--version") return { code: 0, out: cmd[0] === OMP ? `omp/${v.omp}` : `omo ${v.omo} (engine: senpi 2026.10.19)` };
		if (cmd[1] === "add" && cmd[3] === "omo-ai@latest") {
			v.omo = "5.1.39";
			return { code: 1, out: "error: network down" };
		}
		if (cmd[1] === "add") {
			if (o.rollbackCode === 0) v.omo = "5.1.38";
			return { code: o.rollbackCode, out: "rollback" };
		}
		return { code: 1, out: "unexpected" };
	};
}

async function failedCards(run: Run) {
	resetNoticesForTest();
	const was = cfg.identity;
	cfg.identity = { ...was!, language: "ko" };
	try {
		const alert = cardAlert(async (target, text, _replyTo, extra) => void emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target, text, ...extra }), () => undefined);
		await runHarnessUpdate({ ...harness({ run, latest: "5.1.40" }).deps, harnesses: ["omp", "omo"], alert });
		return allNotices().filter(n => n.kind === "decision").map(n => ({ id: n.decision?.card_id, title: n.title, evidence: n.decision?.evidence }));
	} finally {
		cfg.identity = was;
		resetNoticesForTest();
	}
}

test("two harnesses failing in one pass give two open cards, each with its own id, and each says what its install is on now", async () => {
	const cards = await failedCards(twoFailing({ ompTo: "18.12.1", rollbackCode: 0 }));
	expect(cards.sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
		{ id: "update:omo", title: "작업 프로그램 업데이트 · 다시 설치해 볼까요?", evidence: ["버전 5.1.38 → 5.1.40 설치하지 못했어요", "이전 버전으로 되돌렸어요 (지금 5.1.38)", "마지막 출력: error: network down"] },
		{ id: "update:omp", title: "omp 업데이트 · 다시 설치해 볼까요?", evidence: ["버전 18.12.1 → 18.13.0 설치하지 못했어요", "지금 18.12.1 그대로예요", "마지막 출력: omp: download failed"] },
	]);
});

test("a failed rollback says the earlier version was not put back, and an install that moved the version without landing never says it is unchanged", async () => {
	const cards = await failedCards(twoFailing({ ompTo: "18.12.5", rollbackCode: 1 }));
	expect(Object.fromEntries(cards.map(c => [c.id, c.evidence?.[1]]))).toEqual({ "update:omo": "이전 버전으로 되돌리지 못했어요 (지금 5.1.39)", "update:omp": "버전이 바뀌었어요: 설치 전 18.12.1, 지금 18.12.5" });
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

test("a harness whose install failed and that a later pass finds current is no longer told as failing by the doctor; one that failed again still is", async () => {
	const told = async () => (await update({ now: Date.now(), dataDir: DATA_DIR, home: dir })).map(f => f.key);
	await runHarnessUpdate(harness({ run: fakeOmo("5.1.38", { addCode: 1 }).run, latest: "5.1.40" }).deps);
	expect(await told()).toContain("update:omo");
	await runHarnessUpdate(harness({ run: fakeOmo("5.1.40").run, latest: "5.1.40" }).deps);
	expect(await told()).not.toContain("update:omo");
	await runHarnessUpdate(harness({ run: fakeOmo("5.1.40", { installTo: "5.1.41", addCode: 1 }).run, latest: "5.1.41" }).deps);
	expect(await told()).toContain("update:omo");
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
		if (cmd[0] !== OMP) return omo.run(cmd, ms);
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
	expect(describe({ status: "new", current: "5.1.38", latest: "5.1.40" }, "작업 프로그램")).toBe("작업 프로그램 새 버전이 있어요 (5.1.38 → 5.1.40).");
});

test("the update hooks hub/main.ts passes post each card with its id through out, each worklog line to the worklog, and restart the gateway", () => {
	const posts: unknown[][] = [], plain: string[] = [], restarts: unknown[] = [];
	const hooks = updateHooks(async (...a) => void posts.push(a), t => void plain.push(t), o => (restarts.push(o), "queued"));
	const [post, restart, alert] = hooks.harness;
	hooks.self.alert("self card", ["update:self"]);
	alert("omo card", ["update:omo"]);
	hooks.self.worklog("applied");
	post("installed");
	expect({ plain, posts, restarted: [hooks.self.restartIdle(), restart()], restarts }).toEqual({
		plain: [],
		posts: [
			["alert", "self card", undefined, { source: "gateway", nk: "alert", card_ids: ["update:self"] }],
			["alert", "omo card", undefined, { source: "gateway", nk: "alert", card_ids: ["update:omo"] }],
			["worklog", "applied", undefined, { source: "gateway", wk: "update" }],
			["worklog", "installed", undefined, { source: "gateway", wk: "update" }],
		],
		restarted: ["queued", "queued"],
		restarts: [undefined, { auto: true }],
	});
});
