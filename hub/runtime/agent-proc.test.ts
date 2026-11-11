import { expect, test } from "bun:test";
import { killAgent, spawnAgent } from "./agent-proc.ts";
import { OmpProcess } from "./omp.ts";

const DEADLINE_MS = 10_000;
const env = { PATH: process.env.PATH };

// Resolves when the stream ends, which happens only once every process holding the pipe is gone (the agent and what it started).
async function endOfStream(proc: { stdout: ReadableStream<Uint8Array> }, deadlineMs: number): Promise<"closed" | "open"> {
	const reader = proc.stdout.getReader();
	const open = new Promise<"open">(resolve => setTimeout(() => resolve("open"), deadlineMs));
	const closed = (async () => {
		for (;;) if ((await reader.read()).done) return "closed" as const;
	})();
	return Promise.race([closed, open]);
}

async function firstLine(proc: { stdout: ReadableStream<Uint8Array> }): Promise<{ line: string; rest: ReadableStream<Uint8Array> }> {
	const reader = proc.stdout.getReader();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
		if (text.includes("\n")) break;
	}
	reader.releaseLock();
	return { line: text.split("\n")[0]!, rest: proc.stdout };
}

const niceOf = (pid: number) => Bun.spawnSync(["ps", "-o", "nice=", "-p", String(pid)]).stdout.toString().trim();
const isGone = (pid: number) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
};

test("a write to an agent that no longer reads its stdin neither throws nor leaves an unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const onRejection = (e: unknown) => unhandled.push(e);
	process.on("unhandledRejection", onRejection);
	const proc = Bun.spawn(["/bin/sh", "-c", "exec <&-; echo ready; exec sleep 300"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
	try {
		const agent = new OmpProcess(proc, "o");
		await firstLine(proc);
		for (let i = 0; i < 5; i++) {
			expect(() => agent.refreshUsage()).not.toThrow();
			expect(() => agent.send("hello", "steer")).not.toThrow();
			await new Promise(resolve => setImmediate(resolve));
		}
		await new Promise(resolve => setImmediate(resolve));
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onRejection);
		proc.kill(9);
	}
});

test("a grandchild of an agent started through spawnAgent runs at nice 10", async () => {
	const agent = spawnAgent(["/bin/sh", "-c", "sleep 300 & echo $!; wait"], { env });
	const { line } = await firstLine(agent);
	const grandchild = Number(line);
	try {
		expect(Number.isInteger(grandchild) && grandchild > 1).toBe(true);
		expect(niceOf(agent.pid)).toBe("10");
		expect(niceOf(grandchild)).toBe("10");
	} finally {
		killAgent(agent, true);
		await agent.exited;
	}
});

test("ending an agent ends the grandchild it started", async () => {
	const agent = spawnAgent(["/bin/sh", "-c", "sleep 300 & echo $!; wait"], { env });
	const { line } = await firstLine(agent);
	const grandchild = Number(line);
	try {
		expect(isGone(grandchild)).toBe(false);
		killAgent(agent);
		await agent.exited;
		expect(await endOfStream(agent, DEADLINE_MS)).toBe("closed");
	} finally {
		if (!isGone(grandchild)) process.kill(grandchild, "SIGKILL");
	}
});

test("an agent that exits by itself takes its grandchild with it", async () => {
	const agent = spawnAgent(["/bin/sh", "-c", "sleep 300 & echo $!; exit 0"], { env });
	const { line } = await firstLine(agent);
	const grandchild = Number(line);
	try {
		await agent.exited;
		expect(await endOfStream(agent, DEADLINE_MS)).toBe("closed");
	} finally {
		if (!isGone(grandchild)) process.kill(grandchild, "SIGKILL");
	}
});

test("a forced kill ends the whole group of an agent that ignores the stop signal", async () => {
	const agent = spawnAgent(["/bin/sh", "-c", "trap '' TERM; sleep 300 & echo $!; wait"], { env });
	const { line } = await firstLine(agent);
	const grandchild = Number(line);
	try {
		killAgent(agent, true);
		await agent.exited;
		expect(await endOfStream(agent, DEADLINE_MS)).toBe("closed");
	} finally {
		if (!isGone(grandchild)) process.kill(grandchild, "SIGKILL");
	}
});
