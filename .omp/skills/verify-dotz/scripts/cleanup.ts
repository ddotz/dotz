import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, readRun } from "./lib.ts";

const runId = process.argv[2];
if (!runId) {
	console.error("usage: bun .omp/skills/verify-dotz/scripts/cleanup.ts <run-id>");
	process.exit(2);
}
const run = readRun(runId);

const groupPids = (): number[] => {
	const r = Bun.spawnSync(["ps", "-axo", "pid=,pgid="], { stdout: "pipe" });
	return r.stdout
		.toString()
		.split("\n")
		.map(line => line.trim().split(/\s+/).map(Number))
		.filter(([pid, pgid]) => pgid === run.pgid && pid !== undefined && pid > 1)
		.map(([pid]) => pid as number);
};

const before = groupPids();
const signal = (sig: NodeJS.Signals): void => {
	try {
		process.kill(-run.pgid, sig);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
};
signal("SIGTERM");
const deadline = Date.now() + 15_000;
while (Date.now() < deadline && (alive(run.pid) || groupPids().length)) await Bun.sleep(200);
if (alive(run.pid) || groupPids().length) {
	signal("SIGKILL");
	await Bun.sleep(500);
}
const left = groupPids();
const listening = Bun.spawnSync(["lsof", "-nP", `-iTCP:${run.port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe" }).stdout.toString().trim();
const report = { runId, pgid: run.pgid, stopped: before, left, gatewayAlive: alive(run.pid), portListeners: listening ? listening.split("\n") : [], at: new Date().toISOString() };
writeFileSync(join(run.dir, "cleanup.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report));
if (left.length || report.gatewayAlive || report.portListeners.length) process.exit(1);
