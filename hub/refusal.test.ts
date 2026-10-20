// OmO returns a refused nested task spawn (its depth limit) as plain tool text, not as an error (omo-task.js, seen
// 2026-10-20 in st_01a15660): the call was recorded as is_error:false and the blocked worker wrote the answer itself.
// dotz reads that refusal as a failed call, from the session file and from live frames alike.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptItems } from "./activity.ts";
import { eventsFromFrame } from "./runtime/omp.ts";

const REFUSAL = "Subagent nesting limit reached: this spawn would run at depth 2, beyond max_depth 1. Do not delegate further - do this work yourself with the tools you already have.";
const result = (toolName: string, text: string) => JSON.stringify({ type: "message", timestamp: "2026-10-20T01:55:00Z", message: { role: "toolResult", toolName, isError: false, content: [{ type: "text", text }] } });

test("a depth-refused task spawn in a session file is a failed call; other task results and other tools are not", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "refusal-")), "s.jsonl");
	writeFileSync(file, [result("task", REFUSAL), result("task", "worker st_1 done: NESTED-OK"), result("bash", REFUSAL)].join("\n"));
	expect((await transcriptItems(file)).map(i => i.is_error)).toEqual([true, false, false]);
});

test("a depth-refused task spawn in a live tool frame is a failed call", () => {
	const rows = (text: string) => eventsFromFrame({ type: "tool_execution_end", toolName: "task", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text }] } } as never, new Map()).flatMap(e => ((e as { row?: { is_error?: boolean } }).row ? [(e as { row: { is_error?: boolean } }).row.is_error] : []));
	expect(rows(REFUSAL)).toEqual([true]);
	expect(rows("spawned st_2")).toEqual([false]);
});
