import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MKDTEMP_IDLE_MS, pruneTempSessions } from "./cleanup.ts";
import { dryRun, gatewayDryRun, liveWrite, throwawayReason } from "./live-guard.ts";
import { Run, realProbesAllowed, withRealProbes } from "./runtime/claude-probes.ts";
import type { RuntimeAdapter } from "./runtime/types.ts";

const LIVE = join(homedir(), ".dotz");

test("an orchestrator or lane the live gateway did not start is a throwaway; the live ones and terminal sessions are not", () => {
	expect(throwawayReason({ env: { DOTZ_ORCHESTRATOR: "1" }, ppid: 100, hubPid: 100 })).toBeUndefined();
	expect(throwawayReason({ env: { DOTZ_LANE: "web" }, ppid: 100, hubPid: 100 })).toBeUndefined();
	expect(throwawayReason({ env: {}, ppid: 5, hubPid: 100 })).toBeUndefined();
	expect(throwawayReason({ env: { DOTZ_ORCHESTRATOR: "1" }, ppid: 777, hubPid: 100 })).toContain("did not start");
	expect(throwawayReason({ env: { DOTZ_ORCHESTRATOR: "1" }, ppid: 777 })).toContain("no live gateway");
	expect(throwawayReason({ env: { DOTZ_LANE: "probe" }, ppid: 100, hubPid: 100 })).toBe("a runtime probe");
	expect(throwawayReason({ env: { DOTZ_DRY_RUN: "1" } })).toBe("DOTZ_DRY_RUN=1");
	expect(throwawayReason({ env: { DOTZ_ORCHESTRATOR: "1", DOTZ_ALLOW_LIVE: "1" }, ppid: 777, hubPid: 100 })).toBeUndefined();
});

test("a throwaway may not write the live data dir, by tool or by shell; reads and its own temp dir are fine", () => {
	expect(liveWrite({ toolName: "write", input: { path: join(LIVE, "state.json") } }, [LIVE])).toContain("state.json");
	expect(liveWrite({ toolName: "edit", input: { path: "~/.dotz/state.json" } }, [LIVE])).toContain("live data dir");
	expect(liveWrite({ toolName: "bash", input: { command: "echo '{}' > ~/.dotz/state.json" } }, [LIVE])).toContain("bash");
	expect(liveWrite({ toolName: "bash", input: { command: "cat ~/.dotz/state.json" } }, [LIVE])).toBeUndefined();
	expect(liveWrite({ toolName: "read", input: { path: join(LIVE, "state.json") } }, [LIVE])).toBeUndefined();
	expect(liveWrite({ toolName: "write", input: { path: "/tmp/dotz-x/state.json" } }, [LIVE])).toBeUndefined();
});

test("a throwaway's gateway call lands in the dry-run sink and says nothing was sent", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-dry-"));
	try {
		const sink = join(dir, "sink.jsonl");
		const r = dryRun("/api/send", { method: "POST", body: JSON.stringify({ target: "worklog", text: "[done] x" }) }, "a copy", sink);
		expect(r).toMatchObject({ delivered: false, dryRun: true });
		const line = JSON.parse(readFileSync(sink, "utf8").trim());
		expect(line).toMatchObject({ method: "POST", path: "/api/send", reason: "a copy" });
		expect(line.body).toContain("worklog");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a gateway on a temp data dir does not connect to Discord unless DOTZ_ALLOW_LIVE=1", () => {
	expect(gatewayDryRun("/tmp/dotz-copy", {})).toContain("temp data dir");
	expect(gatewayDryRun(join(tmpdir(), "x"), {})).toContain("temp data dir");
	expect(gatewayDryRun("/tmp/dotz-copy", { DOTZ_ALLOW_LIVE: "1" })).toBeUndefined();
	expect(gatewayDryRun(LIVE, {})).toBeUndefined();
	expect(gatewayDryRun(LIVE, { DOTZ_DRY_RUN: "1" })).toBe("DOTZ_DRY_RUN=1");
});

test("a real probe process starts only inside a requested check or with DOTZ_E2E=1", async () => {
	let started = 0;
	const adapter = { start: () => (started++, { events: (async function* () {})(), send() {}, kill() {}, exited: Promise.resolve(0) }) } as unknown as RuntimeAdapter;
	const ctx = { cwd: "/tmp/x", model: "m", log() {}, timeoutMs: 1 };
	expect(realProbesAllowed()).toBe(false);
	expect(() => new Run(adapter, ctx, "1", { model: "m" })).toThrow("DOTZ_E2E=1");
	expect(started).toBe(0);
	await withRealProbes(async () => new Run(adapter, ctx, "2", { model: "m" }));
	expect(started).toBe(1);
	expect(realProbesAllowed()).toBe(false);
});

test("sessions of a mkdtemp folder go after an idle hour, other temp folders keep the day", () => {
	const root = mkdtempSync(join(tmpdir(), "dotz-prune-"));
	try {
		const now = Date.now();
		const mk = (name: string, cwd: string) => {
			const d = join(root, name);
			mkdirSync(d);
			const f = join(d, "s.jsonl");
			writeFileSync(f, `${JSON.stringify({ type: "session", cwd })}\n`);
			const t = (now - MKDTEMP_IDLE_MS - 60_000) / 1000;
			utimesSync(f, t, t);
			utimesSync(d, t, t);
		};
		mk("a", "/var/folders/zz/T/dotz-sap-1");
		mk("b", "/tmp/gone-project-xyz");
		const r = pruneTempSessions(root, 86_400_000, now);
		expect(r.removed).toEqual(["a"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
