// A lane's [done] is checked against task metadata, not its reply text: a worker whose nested task spawn was refused
// (lat-probe2, 2026-10-19) or a failed worker contradicts the claim even when the reply carries the expected answer.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskProblems, workerCheck, type Subagent, type TranscriptItem } from "./activity.ts";

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

// OmO sends no worker frames: its task records (root_session_id = the lane's session) and worker transcripts are on disk.
test("an OmO lane: a grandchild whose spawn was depth-refused (plain text) and a failed worker contradict [done]; other roots do not", async () => {
	const agent = mkdtempSync(join(tmpdir(), "omo-agent-"));
	const root = "01a15704-4608-7f10-91df-15b168f65e57";
	const lane = join(agent, "sessions", "--tmp-x--", `2026-10-20T01-54-20-296Z_${root}.jsonl`);
	mkdirSync(join(agent, "sessions", "--tmp-x--"), { recursive: true });
	writeFileSync(lane, "");
	const store = join(agent, "projects", "x-ece1f6a429db", "senpi-task");
	const task = (id: string, status: string, rootId: string, results: string[] = []) => {
		mkdirSync(join(store, "tasks"), { recursive: true });
		writeFileSync(join(store, "tasks", `${id}.json`), JSON.stringify({ task_id: id, status, root_session_id: rootId, category: "quick", updated_at: "2026-10-19T22:52:00Z" }));
		const dir = join(store, "children", id, "sessions", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "2026-10-19T22-51-00.000Z_a.jsonl"), results.map(text => JSON.stringify({ type: "message", timestamp: "2026-10-19T22:51:30Z", message: { role: "toolResult", toolName: "task", isError: false, content: [{ type: "text", text }] } })).join("\n"));
	};
	task("st_1", "completed", root, ["NESTED-OK [task_id: st_2]"]);
	task("st_2", "completed", root, ["Subagent nesting limit reached: this spawn would run at depth 3, beyond max_depth 2."]);
	task("st_3", "failed", root);
	task("st_9", "failed", "other-root", ["Subagent nesting limit reached: x"]);
	expect(await workerCheck("lane:omo-test", since, lane)).toEqual([
		"worker st_3 (quick) failed",
		"st_2: task spawn failed: Subagent nesting limit reached: this spawn would run at depth 3, beyond max_depth 2.",
	]);
});
