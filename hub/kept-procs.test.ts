// A routine idle park keeps what is useful of what the owner's shell tool started, with real processes. The listing is injected
// (`ps -p` of the pids the test itself started), the clock is injected, and every process the tests start is ended by pid.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe, parseRows, processTable, reapLeftovers, treeEnded, useForTest, useKeptHooks, markPark } from "./agent-tree.ts";
import { IDLE_BOUND_MS, RECENT_BUSY_MS, cpuSeconds, pickKept, withCpu } from "./kept-procs.ts";
import { killAgent, spawnAgent } from "./runtime/agent-proc.ts";

const DEADLINE_MS = 15_000;
const dir = mkdtempSync(join(tmpdir(), "kept-procs-"));
const file = join(dir, "agent-trees.json");
const SERVER = "Bun.serve({ port: 0, fetch: () => new Response('x') }); console.log('up ' + process.pid); setInterval(() => {}, 1e6);";
// A stand-in for the runtime's own host: it listens, and its path holds the runtime's folder.
const HOST = join(dir, ".omo", "agent", "runtime", "host.ts");
mkdirSync(join(dir, ".omo", "agent", "runtime"), { recursive: true });
writeFileSync(HOST, SERVER);
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

// The agent's shell tool starts a server that listens (under a shell, in a session of its own as a PTY command is), the runtime's own
// host that listens (no shell, same session rule) and a sleeper that does nothing. It prints: shell, server, host, sleeper.
const AGENT = `
const own = { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true };
const first = async p => Number((new TextDecoder().decode((await p.stdout.getReader().read()).value)).split(" ")[1]);
const shell = Bun.spawn(["/bin/sh", "-c", '"$0" -e "$1"; :', process.execPath, ${JSON.stringify(SERVER)}], own);
const host = Bun.spawn([process.execPath, ${JSON.stringify(HOST)}], own);
const srv = await first(shell);
await first(host);
const idle = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
console.log(shell.pid + " " + srv + " " + host.pid + " " + idle.pid);
await new Promise(r => process.stdin.once("data", r));
process.exit(0);
`;

async function startAgent(owner: string, o: { keep?: number[] } = {}) {
	const agent = spawnAgent([process.execPath, "-e", AGENT], { env: { PATH: process.env.PATH, DOTZ_CONV: owner } });
	const reader = agent.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await bounded(reader.read());
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const [shell, srv, host, idle] = text.trim().split(" ").map(Number) as [number, number, number, number];
	started.push(agent.pid, shell, srv, host, idle);
	shown = [process.pid, agent.pid, shell, srv, host, idle, ...(o.keep ?? [])];
	await observe(await table());
	return { agent, shell, srv, host, idle };
}

// What an idle park does to the agent: the mark, then the plain stop.
async function park(agent: ReturnType<typeof spawnAgent>) {
	markPark(agent.pid);
	killAgent(agent);
	await agent.exited;
	await bounded(treeEnded(agent.pid));
}

test("an idle park keeps the server the shell started, ends the runtime's host that listens and the sleeper, and records it under the session", async () => {
	const { agent, shell, srv, host, idle } = await startAgent("conv-a");
	await park(agent);
	expect(isGone(srv)).toBe(false);
	expect(isGone(shell)).toBe(false); // the wrapper passes its end on to the server
	expect(isGone(host)).toBe(true);
	expect(isGone(idle)).toBe(true);
	expect(recordOf().kept.map(k => [k.owner, k.kids.map(x => x.pid).sort()])).toEqual([["conv-a", [shell, srv].sort()]]);
	expect(lines).toEqual([]); // keeping says nothing
}, 30_000);

test("a stopped or deleted session ends its kept child, with one line", async () => {
	const { agent, shell, srv } = await startAgent("conv-c");
	await park(agent);
	shown = [process.pid, shell, srv];
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
	const { agent, shell, srv } = await startAgent("conv-d");
	await park(agent);
	shown = [process.pid, shell, srv];
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
	const second = await startAgent("conv-g", { keep: [first.shell, first.srv] });
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
	const second = await startAgent("conv-h", { keep: [first.shell, first.srv] });
	await park(second.agent);
	expect(isGone(first.srv)).toBe(false);
	expect(isGone(second.srv)).toBe(false);
	expect(isGone(second.idle)).toBe(true);
	expect(recordOf().kept[0]!.kids.map(k => k.pid).sort()).toEqual([first.shell, first.srv, second.shell, second.srv].sort());
}, 30_000);

// What a new gateway finds in the record: the old one is gone (a restart, a self-update or a crash look the same).
function oldGatewayGone(): void {
	const rec = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...rec, gateway: { pid: 2 ** 22 - 1, start: "Tue Jan 1 00:00:00 2019" } }));
	useForTest(file, () => (shown.length ? psOf() : Promise.resolve("")));
	useKeptHooks({ say: (owner, text) => void lines.push([owner, text]), ended: owner => stopped.has(owner) });
}

test("a gateway restart adopts the kept processes of a session that still exists, with their record, and signals none", async () => {
	const { agent, shell, srv } = await startAgent("conv-k");
	await park(agent);
	const before = JSON.parse(readFileSync(file, "utf8")).kept[0];
	shown = [process.pid, shell, srv];
	oldGatewayGone();
	expect(await bounded(reapLeftovers())).toEqual([]);
	expect(isGone(srv)).toBe(false);
	expect(isGone(shell)).toBe(false);
	await bounded(observe(await table()));
	const after = recordOf().kept[0] as unknown as typeof before;
	expect([after.owner, after.at, after.what]).toEqual([before.owner, before.at, before.what]);
	expect(after.kids.map((k: { pid: number }) => k.pid).sort()).toEqual([shell, srv].sort());
	expect(lines).toEqual([]);
	stopped.add("conv-k"); // the adopted record is the live one: the owner's end now ends them
	await bounded(observe(await table()));
	expect(isGone(srv)).toBe(true);
	expect(lines.map(l => l[0])).toEqual(["conv-k"]);
}, 30_000);

test("a gateway restart ends the kept processes of a session that is gone, with one line", async () => {
	const { agent, shell, srv } = await startAgent("conv-l");
	await park(agent);
	shown = [process.pid, shell, srv];
	oldGatewayGone();
	stopped.add("conv-l");
	expect((await bounded(reapLeftovers())).sort()).toEqual([shell, srv].sort());
	expect(isGone(srv)).toBe(true);
	expect(lines.map(l => l[0])).toEqual(["conv-l"]);
}, 30_000);

test("a gateway start ends what the agents of a dead gateway left, and adopts nothing for them", async () => {
	const starter = Bun.spawn(["/bin/sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!"], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const kid = { pid: Number((await new Response(starter.stdout).text()).trim()) };
	await starter.exited;
	started.push(kid.pid);
	shown = [kid.pid];
	const start = (await table()).find(r => r.pid === kid.pid)!.start;
	const dead = Bun.spawn(["/usr/bin/true"]);
	await dead.exited;
	writeFileSync(file, JSON.stringify({ gateway: { pid: dead.pid, start: "Tue Jan 1 00:00:00 2019" }, agents: [{ pid: 2 ** 22 - 1, start: "x", kids: [{ pid: kid.pid, start }] }], kept: [] }));
	expect(await bounded(reapLeftovers())).toEqual([kid.pid]);
	expect(isGone(kid.pid)).toBe(true);
	expect(lines).toEqual([]);
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
