import { expect, test } from "bun:test";
import { eventsFromFrame, type Frame } from "./omp.ts";
import { RunKeys } from "./omp-runs.ts";
import type { AgentEvent } from "./types.ts";

const run = (keys: RunKeys, f: Frame): AgentEvent[] => keys.rekey(eventsFromFrame(f, new Map())).filter(e => e.type !== "alive" && e.type !== "activity");
const send = (receipts: { to: string; outcome: string }[], isError = false): Frame => ({ type: "tool_execution_end", toolName: "write", toolCallId: "t1", isError, result: { content: [{ type: "text", text: "Delivered." }], details: { message: { op: "send", from: "Main", to: receipts[0]?.to, receipts } } } });
const status = (id: string, s: string): Frame => ({ type: "subagent_lifecycle", payload: { id, agent: "task", status: s } });
const keyOf = (e: AgentEvent | undefined): string => (e?.type === "workers_spawned" ? e.workers[0]!.id : e?.type === "workers_steered" ? e.ids[0]! : "");
const updateId = (e: AgentEvent | undefined): string => (e?.type === "subagent" ? e.update.id : "");
const nameOf = (key: string): string => key.replace(/~.*/, "");

test("a background shell job's tool result is a spawned worker under its job id, and its wake is a done worker under the same id", () => {
	const keys = new RunKeys();
	const started: Frame = { type: "tool_execution_end", toolName: "bash", toolCallId: "t1", result: { content: [{ type: "text", text: "Backgrounded as job bg_1" }], details: { async: { state: "running", jobId: "bg_1", type: "bash" } } } };
	const [spawned] = run(keys, started);
	expect(spawned).toMatchObject({ type: "workers_spawned" });
	const wake: Frame = { type: "message_end", message: { role: "custom", customType: "async-result", content: "done", details: { jobs: [{ jobId: "bg_1", type: "bash", status: "completed" }] } } };
	const done = run(keys, wake);
	expect(done[0]).toEqual({ type: "workers_done", ids: [keyOf(spawned)] });
	expect(nameOf(keyOf(spawned))).toBe("bg_1");
});

test("a finished task job and an eval or bash job in one async-result are each a done worker", () => {
	const keys = new RunKeys();
	const wake: Frame = { type: "message_end", message: { role: "custom", customType: "async-result", content: "done", details: { jobs: [{ jobId: "Alpha", type: "task", agentId: "Alpha", status: "completed" }, { jobId: "bg_2", type: "eval", status: "completed" }] } } };
	const done = run(keys, wake).find(e => e.type === "workers_done");
	expect(done?.type === "workers_done" && done.ids.map(nameOf)).toEqual(["Alpha", "bg_2"]);
});

test("a message injected into a running worker is workers_steered under that worker's current run", () => {
	const keys = new RunKeys();
	run(keys, status("Napper", "running"));
	const [steered] = run(keys, send([{ to: "Napper", outcome: "injected" }]));
	expect(steered).toMatchObject({ type: "workers_steered" });
	const [update] = run(keys, status("Napper", "running"));
	expect(update).toMatchObject({ type: "subagent", update: { id: keyOf(steered) } });
});

test("a message that wakes an ended worker starts its next run: spawned under the new key the worker's frames then use, whichever comes first", () => {
	const keys = new RunKeys();
	run(keys, status("Reviver", "running"));
	const [first] = run(keys, status("Reviver", "done"));
	const [woken] = run(keys, send([{ to: "Reviver", outcome: "woken" }]));
	expect(woken).toMatchObject({ type: "workers_spawned" });
	expect(keyOf(woken)).not.toBe(updateId(first));
	expect(run(keys, status("Reviver", "running"))[0]).toMatchObject({ type: "subagent", update: { id: keyOf(woken) } });

	const early = new RunKeys();
	run(early, status("Reviver", "running"));
	run(early, status("Reviver", "done"));
	const [live] = run(early, status("Reviver", "running"));
	const [after] = run(early, send([{ to: "Reviver", outcome: "woken" }]));
	expect(keyOf(after)).toBe(updateId(live));
});

test("a failed send, an errored write and a plain write name no worker", () => {
	const keys = new RunKeys();
	expect(run(keys, send([{ to: "Ghost", outcome: "failed" }]))).toEqual([]);
	expect(run(keys, send([{ to: "Napper", outcome: "injected" }], true))).toEqual([]);
	expect(run(keys, { type: "tool_execution_end", toolName: "write", toolCallId: "t2", result: { content: [{ type: "text", text: "ok" }], details: {} } })).toEqual([]);
});
