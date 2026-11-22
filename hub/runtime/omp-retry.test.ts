import { expect, test } from "bun:test";
import { join } from "node:path";
import { eventsFromFrame, type Frame, omp } from "./omp.ts";
import { flush } from "./test-clock.ts";
import type { AgentEvent } from "./types.ts";

const patchable = Bun as unknown as { spawn: unknown };
type Row = { ms: number; from: "hub" | "omp"; frame: Frame & { command?: string } };
const rowsOf = async (name: string): Promise<Row[]> => (await Bun.file(join(import.meta.dir, "fixtures", name)).text()).split("\n").filter(Boolean).map(l => JSON.parse(l));

async function replay(frames: object[]): Promise<AgentEvent[]> {
	let out!: ReadableStreamDefaultController<Uint8Array>;
	const exited = Promise.withResolvers<number>();
	const realSpawn = Bun.spawn;
	patchable.spawn = () => ({ pid: 4243, stdout: new ReadableStream<Uint8Array>({ start: c => void (out = c) }), stdin: { write: () => 0, flush: () => 0 }, exited: exited.promise, kill() {} });
	const proc = omp.start({ role: "orchestrator", cwd: process.env.DOTZ_DIR!, model: "test:low", env: {} });
	patchable.spawn = realSpawn;
	const events: AgentEvent[] = [];
	void (async () => {
		for await (const ev of proc.events) events.push(ev);
	})();
	for (const frame of frames) {
		out.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
		await flush();
	}
	return events.filter(e => e.type !== "alive" && e.type !== "activity");
}

const kinds = (events: AgentEvent[]): string[] => events.map(e => (e.type === "assistant" ? `assistant:${e.stop}` : e.type));

test("a failed request omp retries by itself reaches the hub as one turn that succeeds, not as a failure and a finished turn", async () => {
	const rows = await rowsOf("omp-retry.jsonl");
	const events = await replay(rows.filter(r => r.from === "omp").map(r => r.frame));
	expect(kinds(events).filter(k => k !== "usage" && k !== "spend")).toEqual(["turn_start", "user", "turn_start", "assistant:stop", "turn_end"]);
});

test("a failed request omp does not retry reaches the hub before the turn's end", async () => {
	const failed = { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 Overloaded" } };
	const events = await replay([{ type: "agent_start" }, failed, { type: "turn_end" }, { type: "agent_end", isTerminal: true, yielded: true }]);
	expect(kinds(events)).toEqual(["turn_start", "assistant:error", "turn_end"]);
	expect(events.find(e => e.type === "assistant" && e.stop === "error")).toMatchObject({ error: { kind: "transient" } });
});

test("a rate-limit failure is not held back: the hub pauses at once", async () => {
	const limited = { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 usage limit reached for the week" } };
	expect(kinds(await replay([limited]))).toEqual(["assistant:error"]);
});

test("a non-terminal agent_end is not the end of a turn, a terminal one and one from an older omp are", () => {
	const ended = (f: Frame) => eventsFromFrame({ type: "agent_end", ...f }, new Map()).some(e => e.type === "turn_end");
	expect(ended({ isTerminal: false, yielded: false })).toBe(false);
	expect(ended({ isTerminal: false })).toBe(false);
	expect(ended({ isTerminal: true, yielded: true })).toBe(true);
	expect(ended({ isTerminal: false, yielded: true, awaitingAsyncWork: true })).toBe(true);
	expect(ended({})).toBe(true);
});

test("a prompt omp refuses reaches the hub once as a failed turn, also when no failed message came first", async () => {
	const refused = { type: "prompt_result", id: "o1", agentInvoked: false, status: "error", error: { message: "Could not restore model anthropic/x", retryable: false } };
	expect(await replay([refused])).toEqual([{ type: "assistant", text: "", stop: "error", error: { text: "Could not restore model anthropic/x", kind: undefined, compaction: false } }]);
	const limited = { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 usage limit reached for the week" } };
	const result = { type: "prompt_result", id: "o2", agentInvoked: true, status: "error", error: { message: "429 usage limit reached for the week", retryable: false } };
	expect(kinds(await replay([limited, { type: "agent_end", isTerminal: true, yielded: true }, result]))).toEqual(["assistant:error", "turn_end"]);
	expect(kinds(await replay([{ type: "prompt_result", id: "o3", agentInvoked: true, status: "completed" }]))).toEqual([]);
});

test("a worker waiting for a slot is still running; the words of a finished one are matched whole", () => {
	const status = (s: string) => eventsFromFrame({ type: "subagent_progress", payload: { progress: { id: "w", status: s } } }, new Map()).find(e => e.type === "subagent");
	for (const waiting of ["pending", "queued", "waiting", "running"]) expect(status(waiting)).toMatchObject({ update: { status: "running" } });
	for (const finished of ["done", "completed", "finished", "success"]) expect(status(finished)).toMatchObject({ update: { status: "done" } });
	expect(status("failed")).toMatchObject({ update: { status: "failed" } });
	expect(status("aborted")).toMatchObject({ update: { status: "aborted" } });
});

test("omp cannot abort a compaction over RPC: its commands run in order, so an abort sent during `compact` is read after it ends", async () => {
	const rows = await rowsOf("omp-compact-queue.jsonl");
	const at = (pred: (r: Row) => boolean) => rows.findIndex(pred);
	const answered = (command: string) => at(r => r.from === "omp" && r.frame.type === "response" && r.frame.command === command);
	expect(at(r => r.from === "hub" && r.frame.type === "abort")).toBeGreaterThan(at(r => r.frame.type === "manual_compaction_start"));
	expect(answered("abort")).toBeGreaterThan(answered("compact"));
	expect(answered("get_state")).toBeGreaterThan(answered("compact"));
	expect(omp.caps.abortCompact).toBeUndefined();
});
