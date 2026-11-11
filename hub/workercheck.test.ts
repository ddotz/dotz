// A lane's [done] is checked against task metadata, not its reply text: a worker whose nested task spawn was refused
// (lat-probe2, 2026-10-19) or a failed worker contradicts the claim even when the reply carries the expected answer.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentDetail, taskProblems, workerCheck, type Subagent, type TranscriptItem } from "./activity.ts";

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

// The orchestrator's background work opens the subagent sheet (/api/subagents/<id>), but OmO reports no worker live, so its
// content comes from the task store: the record of that session's worker and the newest part of its transcript.
test("an OmO worker's sheet shows its record and the tail of its transcript; another session's worker and odd ids show nothing", async () => {
	const agent = mkdtempSync(join(tmpdir(), "omo-agent-"));
	const root = "01a16458-6a84-7d5c-aac8-f3466403e960";
	const orch = join(agent, "sessions", "--x--", `2026-10-28T10-00-00-000Z_${root}.jsonl`);
	mkdirSync(join(agent, "sessions", "--x--"), { recursive: true });
	writeFileSync(orch, "");
	const store = join(agent, "projects", ".dotz-11b62020b284", "senpi-task");
	mkdirSync(join(store, "tasks"), { recursive: true });
	const rec = (id: string, rootId: string) => writeFileSync(join(store, "tasks", `${id}.json`), JSON.stringify({ task_id: id, status: "running", root_session_id: rootId, category: "quick", description: "폰 진행 줄 정렬 패치 반영", started_at: "2026-10-28T12:28:58.094Z", updated_at: "2026-10-28T12:29:03.001Z" }));
	rec("st_01a1827c", root);
	rec("st_other", "01a00000-0000-7000-8000-000000000000");
	const dir = join(store, "children", "st_01a1827c", "sessions", "st_01a1827c");
	mkdirSync(dir, { recursive: true });
	const msg = (role: string, content: unknown, extra = {}) => JSON.stringify({ type: "message", timestamp: "2026-10-28T12:30:00Z", message: { role, content, ...extra } });
	// Megabytes of earlier work: the sheet reads only the newest part of the file.
	const filler = Array.from({ length: 3000 }, (_, i) => msg("toolResult", [{ type: "text", text: `old ${i} ${"x".repeat(400)}` }], { toolName: "read" }));
	writeFileSync(join(dir, `2026-10-28T12-28-58-874Z_01a1827c-2e7a-7be6-88b3-a2734f896216.jsonl`), [
		JSON.stringify({ type: "session" }),
		msg("user", "Task: align the phone progress line"),
		...filler,
		msg("assistant", [{ type: "toolCall", name: "bash", intent: "테스트 실행", arguments: { command: "bun test" } }]),
		// OmO's eval carries its intent as `summary`.
		msg("assistant", [{ type: "toolCall", name: "eval", arguments: { language: "js", summary: "전체 테스트 실행", code: "await 1" } }]),
		msg("assistant", [{ type: "text", text: "푸시했어요: abc1234" }]),
	].join("\n"));

	const d = await subagentDetail("orchestrator", "st_01a1827c", orch);
	expect(d && { id: d.id, agent: d.agent, description: d.description, status: d.status }).toEqual({ id: "st_01a1827c", agent: "quick", description: "폰 진행 줄 정렬 패치 반영", status: "running" });
	expect(d!.items.slice(-3).map(i => [i.type, i.text])).toEqual([["tool_call", "bash: 테스트 실행"], ["tool_call", "eval: 전체 테스트 실행"], ["text", "푸시했어요: abc1234"]]);
	expect(d!.items.length).toBeLessThanOrEqual(200);
	expect(d!.items.some(i => i.text.startsWith("old 0 "))).toBe(false);
	expect(await subagentDetail("orchestrator", "st_other", orch)).toBeUndefined();
	expect(await subagentDetail("orchestrator", "../tasks/st_01a1827c", orch)).toBeUndefined();
	expect(await subagentDetail("orchestrator", "st_01a1827c", undefined)).toBeUndefined();
});
