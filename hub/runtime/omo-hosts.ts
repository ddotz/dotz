// OmO rpc hosts dotz caused, and closing them. An `omo --mode rpc` process that spawns a task worker makes OmO start a
// shared rpc host for it (`cli.js --internal-rpc-host-supervisor` + `--mode rpc --multi-session`, its own shard socket
// keyed by the owning process). That host is detached (ppid 1) and only exits after 15 idle minutes, so every short-lived
// omo process dotz runs (runtime checks, probes, restarts) used to leave one behind. dotz records each omo process it
// starts; when one exits its hosts are stopped, and a sweep (gateway start, then every 10 minutes: the session-doctor
// duty 오모냥 has) stops hosts of recorded processes that died while the gateway was down. Hosts of the owner's own OmO
// sessions are never touched: only hosts whose owner pid is one dotz recorded.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, log, writeAtomic } from "../config.ts";

export const OMO = process.env.DOTZ_OMO ?? "omo";
// The real path of a bun global omo-ai install (`bun add -g` reaches only this copy), shared by both update paths.
export const BUN_GLOBAL_OMO = /\/install\/global\/node_modules\/(omo-ai)\//;
const agentDir = () => process.env.OMO_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".omo", "agent");
const recordFile = () => join(DATA_DIR, "omo-processes.json");

type Started = { pid: number; at: number };
type Host = { socket: string; ownerPid: number; ownerStart: number };

function records(): Started[] {
	try {
		const list = JSON.parse(readFileSync(recordFile(), "utf8"));
		return Array.isArray(list) ? list.filter(r => Number.isInteger(r?.pid) && Number.isFinite(r?.at)) : [];
	} catch {
		return [];
	}
}
const save = (list: Started[]) => writeAtomic(recordFile(), `${JSON.stringify(list)}\n`);

export function recordStarted(pid: number | undefined): void {
	if (!pid) return;
	save([...records().filter(r => r.pid !== pid), { pid, at: Date.now() }]);
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

// Every rpc host OmO registered: <agent>/rpc-host-daemon/<shard>/{endpoint.json, generations/<id>/owner.json}.
export function listHosts(root = join(agentDir(), "rpc-host-daemon")): Host[] {
	if (!existsSync(root)) return [];
	const hosts: Host[] = [];
	for (const shard of readdirSync(root)) {
		const dir = join(root, shard);
		try {
			const socket = JSON.parse(readFileSync(join(dir, "endpoint.json"), "utf8")).socket;
			const gens = join(dir, "generations");
			for (const gen of existsSync(gens) ? readdirSync(gens) : []) {
				const owner = JSON.parse(readFileSync(join(gens, gen, "owner.json"), "utf8")).owner;
				if (typeof socket === "string" && Number.isInteger(owner?.pid)) hosts.push({ socket, ownerPid: owner.pid, ownerStart: Date.parse(owner.startTime) || 0 });
			}
		} catch {
			// a shard being written or torn down right now; the next sweep sees it whole
		}
	}
	return hosts;
}

// Hosts started by the recorded process: same pid, and the owner's start time within a minute of when dotz spawned it
// (a pid reused later by some other process does not match).
export const hostsOf = (rec: Started, hosts: Host[]) => hosts.filter(h => h.ownerPid === rec.pid && (!h.ownerStart || Math.abs(h.ownerStart - rec.at) < 60_000));

// --force: the owner has exited, so the worker sessions a plain stop refuses on ("sessions_live") are its leftovers.
async function stopHost(socket: string): Promise<boolean> {
	const p = Bun.spawn([OMO, "host", "stop", "--force", "--socket", socket], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) log(`omo host stop ${socket} failed (${code}): ${(err || out).trim().slice(0, 200)}`);
	return code === 0;
}

// Stops the hosts of one recorded process that has exited, then forgets it.
export async function closeHostsOf(pid: number | undefined): Promise<number> {
	if (!pid) return 0;
	const rec = records().find(r => r.pid === pid);
	if (!rec) return 0;
	let stopped = 0;
	let failed = 0;
	for (const h of hostsOf(rec, listHosts())) {
		if (await stopHost(h.socket)) stopped++;
		else failed++;
	}
	// A host that would not stop keeps the record, so the next sweep tries again.
	if (!failed) save(records().filter(r => r.pid !== pid));
	if (stopped) log(`omo: stopped ${stopped} rpc host(s) left by pid ${pid}`);
	return stopped;
}

// The doctor pass: hosts of recorded processes that are gone (the gateway died before their exit was handled).
export async function sweepHosts(): Promise<number> {
	let stopped = 0;
	for (const rec of records()) if (!alive(rec.pid)) stopped += await closeHostsOf(rec.pid);
	// OmO's own cleanup of endpoint records whose host is provably dead (as 오모냥's session doctor does).
	if (stopped) await Bun.spawn([OMO, "host", "gc", "--json"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 20_000 }).exited;
	return stopped;
}

let swept = false;
export function startHostSweep(): void {
	if (swept) return;
	swept = true;
	const run = () => void sweepHosts().catch(e => log(`omo host sweep failed: ${String(e)}`));
	run();
	setInterval(run, 10 * 60_000).unref();
}
