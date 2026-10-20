// A lane's [done] is checked against task metadata, not its reply text: a worker whose nested task spawn was refused
// (lat-probe2, 2026-10-19) or a failed worker contradicts the claim even when the reply carries the expected answer.
import { expect, test } from "bun:test";
import { taskProblems, type Subagent, type TranscriptItem } from "./activity.ts";

const since = Date.parse("2026-10-19T22:50:00Z");
const sub = (id: string, status: Subagent["status"]): Subagent => ({ id, status, started_at: since + 1000, updated_at: since + 5000 });
const item = (o: Partial<TranscriptItem>): TranscriptItem => ({ ts: "2026-10-19T22:51:00Z", type: "text", text: "", ...o });

test("a refused nested task spawn contradicts a [done] whose text has the expected answer", () => {
	const items = [
		item({ type: "tool_result", tool: "task", is_error: true, text: "nesting limit reached: depth 2 beyond max_depth 1" }),
		item({ type: "text", text: "NESTED-OK" }),
	];
	expect(taskProblems([sub("w1", "done")], [{ id: "w1", items }], since)).toEqual(["w1: task spawn failed: nesting limit reached: depth 2 beyond max_depth 1"]);
});

test("failed or aborted workers contradict it; clean workers, other tool errors and older runs do not", () => {
	const clean = [item({ type: "tool_result", tool: "bash", is_error: true, text: "grep: no match" }), item({ type: "tool_result", tool: "task", is_error: true, ts: "2026-10-19T20:00:00Z", text: "old" })];
	expect(taskProblems([sub("w1", "done")], [{ id: "w1", items: clean }], since)).toEqual([]);
	expect(taskProblems([sub("w2", "failed"), { ...sub("w3", "aborted"), updated_at: since - 1 }], [], since)).toEqual(["worker w2 failed"]);
});
