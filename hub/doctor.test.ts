import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose, loadStore, morningTime, nextAt, nightTime, runMorning, runNight, shouldTell, storeFile, type Deps } from "./doctor.ts";
import { countTraces, gateway, logins, sessions, update, watches } from "./doctor-checks.ts";
import { THRESHOLDS as T } from "./doctor-limits.ts";
import type { DoctorCheck, Finding } from "./doctor-types.ts";
import * as audit from "./token-audit.ts";

const H = 3600e3, D = 24 * H;
const T0 = Date.parse("2026-11-10T08:00:00Z");
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dotz-doctor-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const finding = (over: Partial<Finding> = {}): Finding => ({ key: "gateway:restarts", area: "gateway", what: "WHAT-A", evidence: "hub.log", since: T0, level: 4, ...over });

function rig(initial: Finding[] = [], at = "auto") {
	const state = { now: T0, found: initial, at, ran: 0, sent: [] as { text: string; decision: boolean }[], logs: [] as string[] };
	const check: DoctorCheck = () => (state.ran++, state.found);
	const deps: Deps = { now: () => state.now, dataDir: dir, home: dir, at: () => state.at, checks: [check], send: (text, decision) => void state.sent.push({ text, decision }), log: l => state.logs.push(l) };
	const day = async () => {
		await runNight(deps);
		await runMorning(deps);
		state.now += D;
	};
	return { state, deps, day };
}

describe("morning delivery", () => {
	test("a quiet day sends nothing and posts nowhere", async () => {
		const r = rig([]);
		await r.day();
		expect(r.state.sent).toEqual([]);
		expect(r.state.logs.some(l => l.startsWith("doctor:"))).toBe(true);
	});

	test("one notable finding is exactly one morning item; the same finding the next day is not told again", async () => {
		const r = rig([finding()]);
		await r.day();
		expect(r.state.sent).toHaveLength(1);
		expect(r.state.sent[0]!.text).toContain("WHAT-A");
		expect(r.state.sent[0]!.decision).toBe(false);
		await r.day();
		expect(r.state.sent).toHaveLength(1);
	});

	test("a finding that grew 1.5x is told again, a smaller growth is not", async () => {
		const r = rig([finding({ level: 4 })]);
		await r.day();
		r.state.found = [finding({ level: 5 })];
		await r.day();
		expect(r.state.sent).toHaveLength(1);
		r.state.found = [finding({ level: 6 })];
		await r.day();
		expect(r.state.sent).toHaveLength(2);
	});

	test("a finding still present a week after it was told is told again", async () => {
		const r = rig([finding()]);
		await r.day();
		for (let i = 0; i < T.repeatDays - 1; i++) await r.day();
		expect(r.state.sent).toHaveLength(1);
		await r.day();
		expect(r.state.sent).toHaveLength(2);
	});

	test("a resolved finding is dropped, and when it comes back it is new", async () => {
		const r = rig([finding()]);
		await r.day();
		r.state.found = [];
		await r.day();
		expect(loadStore(dir).told).toEqual({});
		r.state.found = [finding()];
		await r.day();
		expect(r.state.sent).toHaveLength(2);
	});

	test("the first-seen time survives later runs", async () => {
		const r = rig([finding()]);
		await r.day();
		r.state.found = [finding({ since: T0 + 5 * D })];
		await r.day();
		expect(loadStore(dir).findings["gateway:restarts"]!.since).toBe(T0);
	});

	test("self-fixed findings alone are one line without a decision", async () => {
		const r = rig([finding({ key: "watches:fixed:a", fixed: true, what: "FIXED-A" }), finding({ key: "watches:fixed:b", fixed: true, what: "FIXED-B" })]);
		await r.day();
		expect(r.state.sent).toHaveLength(1);
		const { text, decision } = r.state.sent[0]!;
		expect(decision).toBe(false);
		expect(text).toContain("FIXED-A");
		expect(text).toContain("FIXED-B");
		expect(text.split("\n").filter(Boolean)).toHaveLength(1);
	});

	test("a finding with a decision carries a choice block, one without does not", async () => {
		const decide = { question: "Q-DECIDE", options: [{ name: "OPT-ONE", result: "R1" }, { name: "OPT-TWO", result: "R2" }] };
		const r = rig([finding({ key: "disk:low", area: "disk", what: "DISK", decide }), finding()]);
		await r.day();
		const { text, decision } = r.state.sent[0]!;
		expect(decision).toBe(true);
		expect(text).toContain("**1) OPT-ONE**");
		expect(text).toContain("**2) OPT-TWO**");
		expect(text.match(/\*\*\d\)/g)).toHaveLength(2);
	});

	test("a finding without a decision has no choice block", async () => {
		const r = rig([finding()]);
		await r.day();
		expect(r.state.sent[0]!.text).not.toContain("**1)");
	});

	test("a message that failed to land is not marked as told", async () => {
		const r = rig([finding()]);
		r.deps.send = () => ({ delivered: false, reason: "down" });
		await expect(runMorning(r.deps)).rejects.toThrow();
		expect(loadStore(dir).told).toEqual({});
	});

	test("a check that throws keeps its earlier findings instead of reading as fixed", async () => {
		const r = rig([finding()]);
		await r.day();
		const gatewayLike: DoctorCheck = async () => {
			throw new Error("boom");
		};
		Object.defineProperty(gatewayLike, "name", { value: "gateway" });
		r.deps.checks = [gatewayLike];
		await runNight(r.deps);
		expect(Object.keys(loadStore(dir).findings)).toEqual(["gateway:restarts"]);
		expect(r.state.logs.some(l => l.includes("boom"))).toBe(true);
	});
});

describe("doctor_at off and the old timers", () => {
	test("off: no run, no send, no result file", async () => {
		const r = rig([finding()], "off");
		await r.day();
		expect(r.state.ran).toBe(0);
		expect(r.state.sent).toEqual([]);
		expect(existsSync(storeFile(dir))).toBe(false);
	});

	test("the token audit has no timer or alert starter left", () => {
		expect("startTokenAudit" in audit).toBe(false);
		expect(typeof audit.runAudit).toBe("function");
		expect(typeof audit.auditSummaryLine).toBe("function");
	});

	test("morning time: off, a fixed time, auto with and without zele", () => {
		expect(morningTime("off", 9)).toBeUndefined();
		expect(morningTime("7:05", 9)).toBe("07:05");
		expect(morningTime("auto", 9)).toBe("09:00");
		expect(morningTime("auto", undefined)).toBe("08:00");
		expect(morningTime("nonsense", undefined)).toBe("08:00");
		expect(nightTime("04:30")).toBe("04:30");
		expect(nightTime("off")).toBeUndefined();
	});

	test("the next occurrence of a time is later than now, within a day", () => {
		const next = nextAt("04:30", T0);
		expect(next).toBeGreaterThan(T0);
		expect(next - T0).toBeLessThanOrEqual(D);
	});

	test("repeat rule on its own", () => {
		const f = finding({ level: 6 });
		expect(shouldTell(f, undefined, T0)).toBe(true);
		expect(shouldTell(f, { at: T0, level: 4 }, T0 + H)).toBe(true);
		expect(shouldTell(f, { at: T0, level: 5 }, T0 + H)).toBe(false);
		expect(compose({ version: 1, lastRun: T0, memo: {}, findings: { [f.key]: f }, told: { [f.key]: { at: T0, level: 6 } } }, T0 + H)).toBeUndefined();
	});
});

const logLine = (at: number, text: string) => `${new Date(at).toISOString()} ${text}\n`;

describe("checks read files only", () => {
	test("gateway: restarts in 24 h, and traces added since the last look", async () => {
		const restart = (ago: number) => logLine(T0 - ago, "gateway restart (1 request(s) coalesced, waited 2s)");
		writeFileSync(join(dir, "hub.log"), restart(H) + restart(2 * H) + restart(3 * H) + restart(30 * H));
		writeFileSync(join(dir, "gateway.err.log"), "old\nerror: old\n    at a (x.ts:1)\n");
		const memo: Record<string, unknown> = {};
		const ctx = { now: T0, dataDir: dir, home: dir, memo };
		const first = await gateway(ctx);
		expect(first.map(f => f.key)).toEqual(["gateway:restarts"]);
		expect(first[0]!.level).toBe(3);
		writeFileSync(join(dir, "gateway.err.log"), "old\nerror: old\n    at a (x.ts:1)\nerror: new\n    at b (y.ts:2)\n    at c (y.ts:3)\n");
		const second = await gateway(ctx);
		expect(second.find(f => f.key === "gateway:crashes")?.level).toBe(1);
		expect((await gateway(ctx)).some(f => f.key === "gateway:crashes")).toBe(false);
	});

	test("two restarts are not a finding", async () => {
		writeFileSync(join(dir, "hub.log"), logLine(T0 - H, "gateway restart (1 request(s) coalesced, waited 2s)") + logLine(T0 - 2 * H, "gateway restart (1 request(s) coalesced, waited 2s)"));
		expect(await gateway({ now: T0, dataDir: dir, home: dir })).toEqual([]);
	});

	test("trace counting is by trace, not by frame", () => {
		expect(countTraces("x\n  at a\n  at b\ny\n  at c\n")).toBe(2);
		expect(countTraces("no trace here\n")).toBe(0);
	});

	test("sessions: a running lane with no progress and an unclosed error", async () => {
		const lane = (name: string, body: object, ageMs: number) => {
			mkdirSync(join(dir, "lanes", name), { recursive: true });
			const file = join(dir, "lanes", name, "lane.json");
			writeFileSync(file, JSON.stringify({ name, ...body }));
			utimesSync(file, new Date(T0 - ageMs), new Date(T0 - ageMs));
		};
		const old = new Date(T0 - 10 * H).toISOString();
		lane("stalled", { status: "working", startedAt: old, lastReportAt: old }, 10 * H);
		lane("active", { status: "working", startedAt: old, lastReportAt: old }, H);
		lane("broke", { status: "exited", died: { at: new Date(T0 - 2 * D).toISOString(), code: 1 } }, 2 * D);
		lane("closed", { status: "exited", died: { at: new Date(T0 - 2 * D).toISOString(), code: 1 }, claim: { state: "verified" } }, 2 * D);
		lane("fresh-error", { status: "exited", died: { at: new Date(T0 - H).toISOString(), code: 1 } }, H);
		const found = await sessions({ now: T0, dataDir: dir, home: dir });
		expect(found.map(f => f.key).sort()).toEqual(["sessions:error", "sessions:stuck"]);
		expect(found.find(f => f.key === "sessions:stuck")!.evidence).toBe("stalled");
		expect(found.find(f => f.key === "sessions:error")!.evidence).toBe("broke");
	});

	test("logins and watches: a long-lost login, a failing watch, a self-heal that worked", async () => {
		const w = (id: string, state: object, extra: object = {}) => ({ id, name: id, ...extra, state: { fails: 0, ...state } });
		writeFileSync(join(dir, "watches.json"), JSON.stringify([
			w("login-a", { fails: 5, failSince: T0 - 13 * H, kind: "login" }, { session: { url: "u" } }),
			w("login-b", { fails: 5, failSince: T0 - 2 * H, kind: "login" }, { session: { url: "u" } }),
			w("flaky", { fails: 3, failSince: T0 - H }),
			w("long", { fails: 1, failSince: T0 - 30 * H }),
			w("fine", { fails: 2, failSince: T0 - H }),
			w("stopped", { fails: 9, failSince: T0 - 40 * H }, { paused: true }),
		]));
		writeFileSync(join(dir, "hub.log"), logLine(T0 - H, "watch healed-one self-heal: the check passes again") + logLine(T0 - 30 * H, "watch healed-old self-heal: the check passes again"));
		const ctx = { now: T0, dataDir: dir, home: dir };
		expect((await logins(ctx)).map(f => f.key)).toEqual(["logins:login-a"]);
		const found = await watches(ctx);
		expect(found.filter(f => !f.fixed).map(f => f.key).sort()).toEqual(["watches:flaky", "watches:long"]);
		expect(found.filter(f => f.fixed).map(f => f.key)).toEqual(["watches:fixed:healed-one"]);
	});

	test("update: a failure with no later success is still failed", async () => {
		const fail = " 설치하지 못했어요(network)";
		writeFileSync(join(dir, "hub.log"), [
			logLine(T0 - 5 * H, `omo update: OmO 1 → 2${fail}`),
			logLine(T0 - 4 * H, `omp update: omp 1 → 2${fail}`),
			logLine(T0 - 3 * H, "omp update: omp 1 → 2 올리고 재시작해요 (하던 일이 끝나면)."),
			logLine(T0 - 2 * H, "self-update #4: failed: x"),
		].join(""));
		const found = await update({ now: T0, dataDir: dir, home: dir });
		expect(found.map(f => f.key).sort()).toEqual(["update:omo", "update:self"]);
	});
});
