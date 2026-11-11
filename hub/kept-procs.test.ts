// A routine idle park keeps what is useful of an agent's processes, with real processes. The listing is injected (`ps -p` of the
// pids the test itself started), the clock is injected, and every process the tests start is ended by pid.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe, parseRows, processTable, reapLeftovers, treeEnded, useForTest, useKeptHooks, markPark } from "./agent-tree.ts";
import { IDLE_BOUND_MS, RECENT_BUSY_MS, cpuSeconds, pickKept, withCpu } from "./kept-procs.ts";
import { killAgent, spawnAgent } from "./runtime/agent-proc.ts";

const DEADLINE_MS = 15_000;
const dir = mkdtempSync(join(tmpdir(), "kept-procs-"));
const file = join(dir, "agent-trees.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let shown: number[] = [];
let started: number[] = [];
const lines: [string, string][] = [];
const stopped = new Set<string>();
const psOf = async (): Promise<string> => {
	const p = Bun.spawn(["ps", "-o", "pid=,ppid=,rss=,time=,lstart=", "-p", shown.join(",")], { stdout: "pipe", stderr: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
	const text = await new Response(p.stdout).text();
	await p.exited;
	return text;
};
beforeEach(() => {
	for (const pid of started) if (!isGone(pid)) process.kill(pid, "SIGKILL");
	started = [];
	shown = [];
	lines.length = 0;
	stopped.clear();
	useForTest(file, () => (shown.length ? psOf() : Promise.resolve("")));
	useKeptHooks({ say: (owner, text) => void lines.push([owner, text]), ended: owner => stopped.has(owner) });
});
afterAll(() => {
	for (const pid of started) if (!isGone(pid)) process.kill(pid, "SIGKILL");
});

function isGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}
const bounded = <T>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("deadline")), DEADLINE_MS).unref())]);
const table = async () => parseRows(await processTable(0));
const recordOf = () => JSON.parse(readFileSync(file, "utf8")) as { kept: { owner: string; kids: { pid: number }[] }[] };

// The agent's shell starts a server that listens (a plain child, in the agent's group) and a sleeper that does nothing.
const AGENT = `
const srv = Bun.spawn([process.execPath, "-e", "Bun.serve({ port: 0, fetch: () => new Response('x') }); console.log('up'); setInterval(() => {}, 1e6);"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
await srv.stdout.getReader().read();
const idle = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
console.log(srv.pid + " " + idle.pid);
await new Promise(r => process.stdin.once("data", r));
process.exit(0);
`;

async function startAgent(owner: string, o: { observed?: boolean; keep?: number[] } = {}) {
	const agent = spawnAgent([process.execPath, "-e", AGENT], { env: { PATH: process.env.PATH, DOTZ_CONV: owner } });
	const reader = agent.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await bounded(reader.read());
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const [srv, idle] = text.trim().split(" ").map(Number) as [number, number];
	started.push(agent.pid, srv, idle);
	shown = [process.pid, agent.pid, srv, idle, ...(o.keep ?? [])];
	if (o.observed !== false) await observe(await table());
	return { agent, srv, idle };
}

// What an idle park does to the agent: the mark, then the plain stop.
async function park(agent: ReturnType<typeof spawnAgent>) {
	markPark(agent.pid);
	killAgent(agent);
	await agent.exited;
	await bounded(treeEnded(agent.pid));
}

test("an idle park leaves the child that listens, ends the one that does nothing, and records it under the session", async () => {
	const { agent, srv, idle } = await startAgent("conv-a");
	await park(agent);
	expect(isGone(srv)).toBe(false);
	expect(isGone(idle)).toBe(true);
	expect(recordOf().kept.map(k => [k.owner, k.kids.map(x => x.pid)])).toEqual([["conv-a", [srv]]]);
	expect(lines).toEqual([]); // keeping says nothing
}, 30_000);

test("a child started since the last listing, in the agent's group, is judged the same way", async () => {
	const { agent, srv, idle } = await startAgent("conv-b", { observed: false });
	await park(agent);
	expect(isGone(srv)).toBe(false);
	expect(isGone(idle)).toBe(true);
}, 30_000);

test("a stopped or deleted session ends its kept child, with one line", async () => {
	const { agent, srv } = await startAgent("conv-c");
	await park(agent);
	shown = [process.pid, srv];
	await observe(await table());
	expect(isGone(srv)).toBe(false); // the session still exists: nothing happens at the next listing
	stopped.add("conv-c");
	await bounded(observe(await table()));
	expect(isGone(srv)).toBe(true);
	expect(lines.map(l => l[0])).toEqual(["conv-c"]);
	expect(lines[0]![1].length).toBeGreaterThan(0);
	expect(recordOf().kept).toEqual([]);
}, 30_000);

test("a kept child nobody used for the long bound ends with one line; before the bound it stays", async () => {
	const { agent, srv } = await startAgent("conv-d");
	await park(agent);
	shown = [process.pid, srv];
	await bounded(observe(await table(), Date.now() + IDLE_BOUND_MS - 60_000));
	expect(isGone(srv)).toBe(false);
	await bounded(observe(await table(), Date.now() + IDLE_BOUND_MS + 60_000));
	expect(isGone(srv)).toBe(true);
	expect(lines.map(l => l[0])).toEqual(["conv-d"]);
}, 30_000);

test("a crash-style exit ends everything the agent started", async () => {
	const { agent, srv, idle } = await startAgent("conv-e");
	killAgent(agent, true);
	await agent.exited;
	await bounded(treeEnded(agent.pid));
	expect(isGone(srv)).toBe(true);
	expect(isGone(idle)).toBe(true);
	expect(recordOf().kept).toEqual([]);
}, 30_000);

test("a refused park mark taken back leaves a later crash ending everything", async () => {
	const { agent, srv } = await startAgent("conv-f");
	markPark(agent.pid);
	markPark(agent.pid, false);
	killAgent(agent, true);
	await agent.exited;
	await bounded(treeEnded(agent.pid));
	expect(isGone(srv)).toBe(true);
}, 30_000);

test("a resumed session owns its kept child again: its next exit ends it", async () => {
	const first = await startAgent("conv-g");
	await park(first.agent);
	const second = await startAgent("conv-g", { keep: [first.srv] });
	expect(isGone(first.srv)).toBe(false); // resuming does not touch it
	expect(recordOf().kept.map(k => k.owner)).toEqual(["conv-g"]);
	killAgent(second.agent, true);
	await second.agent.exited;
	await bounded(treeEnded(second.agent.pid));
	expect(isGone(first.srv)).toBe(true);
	expect(isGone(second.srv)).toBe(true);
	expect(lines.map(l => l[0])).toEqual(["conv-g"]);
}, 30_000);

test("a resumed session that rests again keeps what still listens", async () => {
	const first = await startAgent("conv-h");
	await park(first.agent);
	const second = await startAgent("conv-h", { keep: [first.srv] });
	await park(second.agent);
	expect(isGone(first.srv)).toBe(false);
	expect(isGone(second.srv)).toBe(false);
	expect(isGone(second.idle)).toBe(true);
	expect(recordOf().kept[0]!.kids.map(k => k.pid).sort()).toEqual([first.srv, second.srv].sort());
}, 30_000);

test("a gateway start ends the kept processes a dead gateway left and says so under their session", async () => {
	const starter = Bun.spawn(["/bin/sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!"], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const kid = { pid: Number((await new Response(starter.stdout).text()).trim()) };
	await starter.exited;
	started.push(kid.pid);
	shown = [kid.pid];
	const start = (await table()).find(r => r.pid === kid.pid)!.start;
	const dead = Bun.spawn(["/usr/bin/true"]);
	await dead.exited;
	writeFileSync(file, JSON.stringify({ gateway: { pid: dead.pid, start: "Tue Jan 1 00:00:00 2019" }, agents: [], kept: [{ owner: "conv-i", at: 0, what: "bun :1", kids: [{ pid: kid.pid, start }] }] }));
	expect(await bounded(reapLeftovers())).toEqual([kid.pid]);
	expect(isGone(kid.pid)).toBe(true);
	expect(lines.map(l => l[0])).toEqual(["conv-i"]);
}, 30_000);

test("useful means a port or CPU in the last minutes; the port check is quick and a busy process needs no check", async () => {
	const { agent, srv, idle } = await startAgent("conv-j");
	try {
		const rows = (await table()).filter(r => [srv, idle].includes(r.pid));
		const t0 = performance.now();
		const found = await pickKept(rows, [], Date.now());
		const took = performance.now() - t0;
		console.log(`park-time port check: ${took.toFixed(0)} ms for ${rows.length} processes`);
		expect(found.keep.map(r => r.pid)).toEqual([srv]);
		expect(found.what).toContain("bun");
		const now = Date.now();
		const busy = await pickKept(rows, [{ pid: idle, start: rows.find(r => r.pid === idle)!.start, busyAt: now - RECENT_BUSY_MS + 1000 }], now);
		expect(busy.keep.map(r => r.pid).sort()).toEqual([srv, idle].sort());
		const stale = await pickKept(rows.filter(r => r.pid === idle), [{ pid: idle, start: "x", busyAt: now - RECENT_BUSY_MS - 1000 }], now);
		expect(stale.keep).toEqual([]);
	} finally {
		killAgent(agent, true);
	}
}, 30_000);

test("CPU time read from the listing marks a process busy only when it grew", () => {
	expect(cpuSeconds("276:21.39")).toBeCloseTo(16581.39);
	expect(cpuSeconds("1:02:03.45")).toBeCloseTo(3723.45);
	expect(cpuSeconds("Thu")).toBeUndefined();
	const p = (cpu: number, start = "A") => [{ pid: 7, ppid: 1, start, cpu }];
	const first = withCpu([], p(10), 1000);
	expect(first[0]!.busyAt).toBeUndefined();
	expect(withCpu(first, p(10.05), 2000)[0]!.busyAt).toBeUndefined();
	expect(withCpu(first, p(10.5), 2000)[0]!.busyAt).toBe(2000);
	expect(withCpu(withCpu(first, p(10.5), 2000), p(10.5), 3000)[0]!.busyAt).toBe(2000);
	expect(withCpu(withCpu(first, p(10.5), 2000), p(99, "B"), 3000)[0]!.busyAt).toBeUndefined(); // another process on the same pid
});
