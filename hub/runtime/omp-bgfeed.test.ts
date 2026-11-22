import { expect, test } from "bun:test";
import { join } from "node:path";
import { eventsFromFrame, type Frame, omp } from "./omp.ts";
import { advance, flush } from "./test-clock.ts";
import type { AgentEvent, AgentProcess } from "./types.ts";

type Wire = {
	type?: string;
	id?: string;
	command?: string;
	toolName?: string;
	success?: boolean;
	data?: { cancelled?: boolean };
	message?: { customType?: string; details?: { jobs?: { type?: string; status?: string }[] } };
};
type Step = { frame: Wire; events: AgentEvent[]; awaiting: boolean | undefined };
type Session = { proc: AgentProcess; events: AgentEvent[]; written: string[]; feed(frame: string | object): Promise<void>; exit(): Promise<void> };

const patchable = Bun as unknown as { spawn: unknown };
const lines = (await Bun.file(join(import.meta.dir, "fixtures", "omp-rpc.jsonl")).text()).split("\n").filter(Boolean);
const readyAt = lines.flatMap((line, i) => (line.startsWith('{"type":"ready"') ? [i] : []));
const sessions = readyAt.map((from, i) => lines.slice(from, readyAt[i + 1]));
const [twoSpawns, batch, shell] = sessions as [string[], string[], string[]];
const wire = (line: string): Wire => JSON.parse(line);

function startProcess(): Session {
	let out!: ReadableStreamDefaultController<Uint8Array>;
	const written: string[] = [];
	const exited = Promise.withResolvers<number>();
	const realSpawn = Bun.spawn;
	patchable.spawn = () => ({ pid: 4242, stdout: new ReadableStream<Uint8Array>({ start: c => void (out = c) }), stdin: { write: (s: string) => written.push(s), flush: () => 0 }, exited: exited.promise, kill() {} });
	const proc = omp.start({ role: "orchestrator", cwd: process.env.DOTZ_DIR!, model: "test:low", env: {} });
	patchable.spawn = realSpawn;
	const events: AgentEvent[] = [];
	void (async () => {
		for await (const ev of proc.events) events.push(ev);
	})();
	return {
		proc,
		events,
		written,
		feed: async frame => {
			out.enqueue(new TextEncoder().encode(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`));
			await flush();
		},
		exit: async () => {
			exited.resolve(0);
			await flush();
		},
	};
}

async function replay(frames: string[]): Promise<Step[]> {
	const session = startProcess();
	const steps: Step[] = [];
	for (const line of frames) {
		await session.feed(line);
		steps.push({ frame: wire(line), events: session.events.splice(0), awaiting: session.proc.awaitingAsync?.() });
	}
	return steps;
}

const withoutNonce = (id: string): string => id.replace(/~[0-9a-z]+\./, "#");
const stableEvent = (e: AgentEvent): AgentEvent => (e.type === "workers_spawned" ? { ...e, workers: e.workers.map(w => ({ ...w, id: withoutNonce(w.id) })) } : e.type === "workers_done" ? { ...e, ids: e.ids.map(withoutNonce) } : e);
const workerEvents = (steps: Step[]) => steps.flatMap(s => s.events).filter(e => e.type === "workers_spawned" || e.type === "workers_done").map(stableEvent);
const awaitingChanges = (steps: Step[]) => steps.flatMap(({ frame, awaiting }, i) => (awaiting !== (steps[i - 1]?.awaiting ?? false) ? [`${frame.type}:${awaiting}`] : []));
const whileAwaiting = (steps: Step[]) => {
	const from = steps.findIndex(s => s.awaiting);
	return steps.slice(from, from + steps.slice(from).findIndex(s => !s.awaiting));
};
const requestId = (written: string[]): string => {
	const sent: { id: string } = JSON.parse(written.at(-1)!);
	return sent.id;
};

test("the fixture holds three real omp captures, each from its ready frame to its last answer", () => {
	expect(sessions).toHaveLength(3);
	for (const frames of sessions) expect(JSON.parse(frames[0]!)).toMatchObject({ type: "ready", protocolVersion: 1 });
	const count = (frames: string[], type: string) => frames.filter(line => wire(line).type === type).length;
	expect([count(twoSpawns, "tool_execution_end"), count(twoSpawns, "session_settled")]).toEqual([2, 2]);
	expect([count(batch, "tool_execution_end"), count(batch, "session_settled")]).toEqual([1, 1]);
	expect([count(shell, "tool_execution_end"), count(shell, "session_settled")]).toEqual([1, 1]);
});

test("a background task result becomes workers_spawned and the async-result wake becomes workers_done, each under the id of its run", async () => {
	const steps = await replay(twoSpawns);
	expect(workerEvents(steps)).toEqual([
		{ type: "workers_spawned", workers: [{ id: "Napper#1" }] },
		{ type: "workers_done", ids: ["Napper#1"] },
		{ type: "workers_spawned", workers: [{ id: "Sleeper#1" }] },
		{ type: "workers_done", ids: ["Sleeper#1"] },
	]);
	const frames = steps.filter(s => s.events.some(e => e.type === "workers_spawned" || e.type === "workers_done")).map(s => [s.frame.type, s.frame.toolName ?? s.frame.message?.customType]);
	expect(frames).toEqual([
		["tool_execution_end", "task"],
		["message_end", "async-result"],
		["tool_execution_end", "task"],
		["message_end", "async-result"],
	]);
	const jobStatuses = steps.filter(s => s.frame.message?.customType === "async-result" && s.frame.type === "message_end").map(s => s.frame.message?.details?.jobs?.[0]?.status);
	expect(jobStatuses).toEqual(["completed", "failed"]);
});

test("a batch of two background tasks is two workers_spawned ids and one workers_done per delivered result", async () => {
	const steps = await replay(batch);
	expect(workerEvents(steps)).toEqual([
		{ type: "workers_spawned", workers: [{ id: "Alpha#1" }, { id: "Beta#1" }] },
		{ type: "workers_done", ids: ["Alpha#1"] },
		{ type: "workers_done", ids: ["Beta#1"] },
	]);
});

test("awaitingAsync is true from the agent_end that left a job pending until the turn that reads its result ends, and false at the start and after each settle", async () => {
	const steps = await replay(twoSpawns);
	expect(awaitingChanges(steps)).toEqual(["agent_end:true", "agent_end:false", "agent_end:true", "agent_end:false"]);
	const held = whileAwaiting(steps);
	expect(held.map(s => s.frame.type)).toContain("prompt_result");
	expect(held.map(s => `${s.frame.type}:${s.frame.command ?? s.frame.message?.customType ?? ""}`)).toEqual(expect.arrayContaining(["response:get_state", "subagent_lifecycle:", "agent_start:", "message_end:async-result"]));
	expect(held.every(s => s.awaiting)).toBe(true);
	expect(steps.filter(s => s.frame.type === "session_settled").map(s => s.awaiting)).toEqual([false, false]);
	expect(steps.at(-1)!.awaiting).toBe(false);
});

test("awaitingAsync stays true through the first wake of a batch and ends with the turn that has read every result", async () => {
	const steps = await replay(batch);
	expect(awaitingChanges(steps)).toEqual(["agent_end:true", "agent_end:false"]);
	expect(whileAwaiting(steps).filter(s => s.frame.message?.customType === "async-result")).toHaveLength(2);
	expect(steps.find(s => s.frame.type === "session_settled")!.awaiting).toBe(false);
});

test("a background shell job is a spawned and a done worker under its job id, and holds awaitingAsync like a worker until its result is read", async () => {
	const steps = await replay(shell);
	expect(workerEvents(steps)).toEqual([
		{ type: "workers_spawned", workers: [{ id: "bg_1#1" }] },
		{ type: "workers_done", ids: ["bg_1#1"] },
	]);
	expect(awaitingChanges(steps)).toEqual(["agent_end:true", "agent_end:false"]);
	const wake = steps.find(s => s.frame.message?.customType === "async-result")!;
	expect(wake.frame.message?.details?.jobs?.map(j => j.type)).toEqual(["bash"]);
	expect(wake.awaiting).toBe(true);
});

test("awaitingAsync follows agent_end, get_state and session_settled frames and ends with the process", async () => {
	const session = startProcess();
	const awaiting = () => session.proc.awaitingAsync?.();
	expect(awaiting()).toBe(false);
	await session.feed({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
	expect(awaiting()).toBe(true);
	await session.feed({ type: "agent_end", isTerminal: false, yielded: false });
	expect(awaiting()).toBe(true);
	await session.feed({ type: "session_settled" });
	expect(awaiting()).toBe(false);
	await session.feed({ id: "o1", type: "response", command: "get_state", success: true, data: { hasPendingAsyncWork: true, isSettled: false } });
	expect(awaiting()).toBe(true);
	await session.feed({ id: "o2", type: "response", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl" } });
	expect(awaiting()).toBe(true);
	await session.feed({ id: "o3", type: "response", command: "get_state", success: true, data: { hasPendingAsyncWork: false, isSettled: true } });
	expect(awaiting()).toBe(false);
	await session.feed({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
	await session.feed({ type: "agent_end" });
	expect(awaiting()).toBe(false);
	await session.feed({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
	expect(awaiting()).toBe(true);
	await session.exit();
	expect(awaiting()).toBe(false);
	await session.feed({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
	expect(awaiting()).toBe(false);
});

test("cancelWorker sends cancel_subagent and answers with the cancelled flag of omp's response", async () => {
	const session = startProcess();
	const responses = twoSpawns.map(wire).filter(f => f.type === "response" && f.command === "cancel_subagent");
	expect(responses.map(r => r.data?.cancelled)).toEqual([true, false]);
	for (const response of responses) {
		const result = session.proc.cancelWorker!("Sleeper");
		expect(JSON.parse(session.written.at(-1)!)).toMatchObject({ type: "cancel_subagent", subagentId: "Sleeper" });
		await session.feed({ ...response, id: requestId(session.written) });
		expect(await result).toEqual({ cancelled: response.data?.cancelled });
	}
});

test("cancelWorker is false when omp answers an error, when another request is answered, and when no answer comes in time", async () => {
	const session = startProcess();
	const failed = session.proc.cancelWorker!("Sleeper");
	await session.feed({ type: "response", id: requestId(session.written), command: "cancel_subagent", success: false, error: "Subagent not found" });
	expect(await failed).toEqual({ cancelled: false });

	const silent = session.proc.cancelWorker!("Sleeper");
	const answered = { current: false };
	void silent.then(() => void (answered.current = true));
	await session.feed({ type: "response", id: "unrelated", command: "cancel_subagent", success: true, data: { cancelled: true } });
	await advance(9_000);
	expect(answered.current).toBe(false);
	await advance(1_000);
	expect(await silent).toEqual({ cancelled: false });

	const dying = session.proc.cancelWorker!("Sleeper");
	await session.exit();
	expect(await dying).toEqual({ cancelled: false });
	const sent = session.written.length;
	expect(await session.proc.cancelWorker!("Sleeper")).toEqual({ cancelled: false });
	expect(session.written).toHaveLength(sent);
});

test("a subagent update carries the model and thinking level omp resolved for the worker", async () => {
	const updatesOf = (steps: Step[]) => steps.flatMap(s => s.events).flatMap(e => (e.type === "subagent" ? [{ ...e.update, id: withoutNonce(e.update.id) }] : []));
	const updates = updatesOf(await replay(twoSpawns));
	expect(updates.map(u => `${u.id}:${u.status}`)).toEqual(["Napper#1:running", "Napper#1:running", "Napper#1:running", "Napper#1:done", "Napper#1:done", "Sleeper#1:running", "Sleeper#1:running", "Sleeper#1:aborted", "Sleeper#1:aborted"]);
	expect(updates.map(u => u.name)).toEqual(["Napper", "Napper", "Napper", "Napper", "Napper", "Sleeper", "Sleeper", "Sleeper", "Sleeper"]);
	expect(updates.filter(u => u.model !== undefined).map(u => [u.id, u.model, u.thinking])).toEqual([
		["Napper#1", "anthropic/claude-sonnet-5-5:low", "low"],
		["Napper#1", "anthropic/claude-sonnet-5-5:low", "low"],
		["Napper#1", "anthropic/claude-sonnet-5-5:low", "low"],
		["Sleeper#1", "anthropic/claude-sonnet-5-5:low", "low"],
		["Sleeper#1", "anthropic/claude-sonnet-5-5:low", "low"],
	]);
	expect(updates.find(u => u.id === "Napper#1" && u.status === "done" && u.description)?.description).toBe("Run a six-second sleep and reply napped");
	expect(updatesOf(await replay(batch)).map(u => `${u.id}:${u.status}`)).toEqual(["Beta#1:running", "Alpha#1:running", "Alpha#1:done", "Beta#1:done"]);
});

test("a spawn result without a background job, or a failed task call, spawns nothing, and a wake that delivers several jobs names each job once, shell jobs included", () => {
	const result = (text: string, isError = false): Frame => ({ type: "tool_execution_end", toolName: "task", toolCallId: "c", isError, result: { content: [{ type: "text", text }] } });
	const spawned = (frame: Frame) => eventsFromFrame(frame, new Map()).filter(e => e.type === "workers_spawned");
	expect(spawned(result("Spawned agent `Napper` (job `Napper`)."))).toEqual([{ type: "workers_spawned", workers: [{ id: "Napper" }] }]);
	expect(spawned(result("Spawned agent `Napper` (job `Napper`).", true))).toEqual([]);
	expect(spawned(result("Settled: Alpha finished without a background job."))).toEqual([]);
	expect(spawned(result("Spawned 2 background agents using task.\n- `Alpha` (job `Alpha`)\n- `Beta` (job `Beta-2`)\n- `Alpha` (job `Alpha`)"))).toEqual([{ type: "workers_spawned", workers: [{ id: "Alpha" }, { id: "Beta" }] }]);

	const wake = (jobs: object[], content = "wake") => eventsFromFrame({ type: "message_end", message: { role: "custom", customType: "async-result", content, details: { jobs } } }, new Map()).filter(e => e.type === "workers_done");
	const jobs = [
		{ jobId: "Alpha", type: "task", status: "completed", agentId: "Alpha" },
		{ jobId: "bg_1", type: "bash", status: "completed" },
		{ jobId: "Beta-2", type: "task", status: "failed", agentId: "Beta" },
		{ jobId: "Gamma", type: "task", status: "completed", agentId: "Gamma" },
		{ jobId: "Alpha", type: "task", status: "completed", agentId: "Alpha" },
	];
	expect(wake(jobs)).toEqual([{ type: "workers_done", ids: ["Alpha", "bg_1", "Beta", "Gamma"] }]);
	expect(wake([{ jobId: "Solo" }])).toEqual([{ type: "workers_done", ids: ["Solo"] }]);
	expect(wake([{ jobId: "bg_2", type: "eval", status: "completed" }])).toEqual([{ type: "workers_done", ids: ["bg_2"] }]);
	expect(wake([])).toEqual([]);
	expect(wake([{ jobId: "Beta-2", type: "task", status: "failed", agentId: "Beta" }], '<task-result id="Beta" agent="task" status="cancelled">\n</task-result>')).toEqual([{ type: "workers_done", ids: ["Beta"] }]);
});
