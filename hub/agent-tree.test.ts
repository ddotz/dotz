// Real child processes for the kill paths; the identity rules run on a listing the test hands over. The listing is injected
// (`ps -p` of the pids the test itself started), so no test reads or signals anything else on the machine.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe, parseRows, processTable, reapLeftovers, stillThere, treeEnded, useForTest, type Row } from "./agent-tree.ts";
import { killAgent, spawnAgent } from "./runtime/agent-proc.ts";

const DEADLINE_MS = 15_000;
const env = { PATH: process.env.PATH };
const dir = mkdtempSync(join(tmpdir(), "agent-tree-"));
const file = join(dir, "agent-trees.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let shown: number[] = [];
const psOf = async (args: string[]): Promise<string> => {
	const p = Bun.spawn(["ps", ...args, "-p", shown.join(",")], { stdout: "pipe", stderr: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
	const text = await new Response(p.stdout).text();
	await p.exited;
	return text;
};
beforeEach(() => {
	shown = [];
	useForTest(file, () => (shown.length ? psOf(["-o", "pid=,ppid=,rss=,lstart="]) : Promise.resolve("")));
});

const isGone = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
};
const bounded = <T>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("deadline")), DEADLINE_MS).unref())]);
const cleanup = (...pids: number[]) => {
	for (const pid of pids) if (!isGone(pid)) process.kill(pid, "SIGKILL");
};
const startOf = async (pid: number): Promise<string> => parseRows(await processTable(0)).find(r => r.pid === pid)!.start;

// A process that left its starter on purpose: its own session, and its parent has exited so it belongs to pid 1.
async function released(): Promise<number> {
	const p = Bun.spawn(["/bin/sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!"], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", env });
	const pid = Number((await new Response(p.stdout).text()).trim());
	await p.exited;
	return pid;
}

// The agent starts what its shell tool starts: `kid` in a new session, still its child; `daemon` released to pid 1 before anything is recorded.
const AGENT = `
const kid = Bun.spawn(["sleep", "300"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const d = Bun.spawn(["/bin/sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!"], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
const daemon = (await new Response(d.stdout).text()).trim();
console.log(kid.pid + " " + daemon);
await new Promise(r => process.stdin.once("data", r));
process.exit(0);
`;

async function startAgent() {
	const agent = spawnAgent([process.execPath, "-e", AGENT], { env });
	const reader = agent.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await bounded(reader.read());
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const [kid, daemon] = text.trim().split(" ").map(Number) as [number, number];
	shown = [process.pid, agent.pid, kid, daemon];
	observe(parseRows(await processTable(0)));
	return { agent, kid, daemon };
}

test("a force-killed agent ends what its shell tool started in a new session, and leaves the process it had already released", async () => {
	const { agent, kid, daemon } = await startAgent();
	try {
		const groups = new Map((await psOf(["-o", "pid=,pgid="])).trim().split("\n").map(l => l.trim().split(/\s+/).map(Number) as [number, number]));
		expect(groups.get(agent.pid)).toBe(agent.pid);
		expect(groups.get(kid)).not.toBe(agent.pid); // outside the agent's group, as a PTY-backed command is
		const record = JSON.parse(readFileSync(file, "utf8"));
		expect(record.agents.find((a: { pid: number }) => a.pid === agent.pid).kids.map((k: { pid: number }) => k.pid)).toEqual([kid]);
		killAgent(agent, true);
		await agent.exited;
		await bounded(treeEnded(agent.pid));
		expect(isGone(kid)).toBe(true);
		expect(isGone(daemon)).toBe(false);
	} finally {
		cleanup(kid, daemon);
	}
}, 30_000);

test("an agent that exits by itself takes what its shell tool started with it", async () => {
	const { agent, kid, daemon } = await startAgent();
	try {
		agent.stdin.write("go\n");
		await agent.stdin.flush();
		await agent.exited;
		await bounded(treeEnded(agent.pid));
		expect(isGone(kid)).toBe(true);
		expect(isGone(daemon)).toBe(false);
	} finally {
		cleanup(kid, daemon);
	}
}, 30_000);

test("only a process that is provably the recorded one is ended", () => {
	const row = (pid: number, ppid: number, start: string): Row => ({ pid, ppid, rss: 0, start });
	const rows = [row(10, 1, "A"), row(11, 1, "B2"), row(12, 777, "C"), row(13, 10, "D"), row(14, 1, "E"), row(process.pid, 1, "G"), row(1, 0, "I")];
	const recorded = [
		{ pid: 10, start: "A" }, // same pid and start, handed to pid 1
		{ pid: 11, start: "B" }, // the pid now belongs to a process with another start time
		{ pid: 12, start: "C" }, // adopted by a process that is not recorded
		{ pid: process.pid, start: "G" }, // the gateway itself
		{ pid: 1, start: "I" },
		{ pid: 99, start: "Z" }, // gone
	];
	expect(stillThere(rows, recorded).map(r => r.pid)).toEqual([10, 13]); // 13 started later by 10; 14 was never recorded
});

test("a record left by a dead gateway makes the next start end the leftover and nothing else", async () => {
	const [leftover, bystander, reused] = [await released(), await released(), await released()];
	const dead = Bun.spawn(["/usr/bin/true"]);
	await dead.exited;
	try {
		shown = [leftover, bystander, reused];
		const start = await startOf(leftover);
		const agent = { pid: dead.pid, start: "Tue Jan  1 00:00:00 2019", kids: [{ pid: leftover, start }, { pid: reused, start: "Tue Jan  1 00:00:00 2019" }] };
		writeFileSync(file, JSON.stringify({ gateway: { pid: dead.pid, start: "Tue Jan  1 00:00:00 2019" }, agents: [agent] }));
		expect(await bounded(reapLeftovers())).toEqual([leftover]);
		expect(isGone(leftover)).toBe(true);
		expect(isGone(bystander)).toBe(false);
		expect(isGone(reused)).toBe(false);
	} finally {
		cleanup(leftover, bystander, reused);
	}
}, 30_000);

test("a record whose gateway still runs is left alone", async () => {
	const [gateway, kid] = [await released(), await released()];
	try {
		shown = [gateway, kid];
		writeFileSync(file, JSON.stringify({ gateway: { pid: gateway, start: await startOf(gateway) }, agents: [{ pid: gateway, start: await startOf(gateway), kids: [{ pid: kid, start: await startOf(kid) }] }] }));
		expect(await bounded(reapLeftovers())).toEqual([]);
		expect(isGone(kid)).toBe(false);
	} finally {
		cleanup(gateway, kid);
	}
}, 30_000);
