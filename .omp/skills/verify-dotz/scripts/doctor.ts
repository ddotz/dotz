import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_PORT, alive, call, readRun } from "./lib.ts";

const runId = process.argv[2];
if (!runId) {
	console.error("usage: bun .omp/skills/verify-dotz/scripts/doctor.ts <run-id>");
	process.exit(2);
}
const run = readRun(runId);
const listeners = Bun.spawnSync(["lsof", "-nP", `-iTCP:${run.port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe" }).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
const hubPid = Number(readFileSync(join(run.data, "hub.pid"), "utf8").trim());
const health = await call(run, "/api/health", { as: "agent" });
const anonymous = await fetch(`${run.url}/api/state`, { signal: AbortSignal.timeout(10_000) });
const stateRes = await call(run, "/api/state", { as: "owner" });
const state = (await stateRes.json()) as { name?: string; web_build?: string; discord?: { connected?: boolean; error?: string }; orchestrator?: { status?: string } };
const checks = {
	notOwnerPort: run.port !== OWNER_PORT,
	gatewayAlive: alive(run.pid),
	portOwnedByOurPid: listeners.length === 1 && listeners[0] === run.pid,
	hubPidIsOurs: hubPid === run.pid,
	health200: health.status === 200,
	anonymousRefused: anonymous.status === 403,
	ownerLoggedIn: stateRes.status === 200,
	identityIsVerify: state.name === "verify",
	discordDryRun: state.discord?.connected === false && /dry run/.test(state.discord?.error ?? ""),
	noOrchestrator: state.orchestrator?.status !== "running",
};
const report = { runId, url: run.url, pid: run.pid, port: run.port, data: run.data, code: run.code, tree: run.tree, commit: run.commit, dirtyFiles: run.dirty, webBuild: state.web_build, checks, ok: Object.values(checks).every(Boolean), at: new Date().toISOString() };
writeFileSync(join(run.dir, "doctor.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
if (!report.ok) process.exit(1);
