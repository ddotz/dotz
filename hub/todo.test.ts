// The todo strip source (hub/todo.ts): the last `todo` tool result of a session jsonl, read from the file's end.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMonitor, readTodo } from "./todo.ts";

const DIR = join(process.env.DOTZ_TEST_DIR!, "todo-sessions");
mkdirSync(DIR, { recursive: true });

const todoLine = (at: string, phases: unknown, tool = "todo") => JSON.stringify({ type: "message", id: at, timestamp: at, message: { role: "toolResult", toolName: tool, content: [{ type: "text", text: "Remaining items" }], details: { phases } } });
const other = (text: string) => JSON.stringify({ type: "message", timestamp: "2026-10-21T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const session = (name: string, lines: string[]) => {
	const file = join(DIR, `${name}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
};
const phases = (done: boolean) => [{ name: "구현", tasks: [{ content: "API 만들기", status: done ? "completed" : "in_progress" }, { content: "테스트", status: "pending" }] }];

test("the last todo result wins, with its phases and time", () => {
	const file = session("last", [todoLine("2026-10-21T01:00:00.000Z", phases(false)), other("working"), todoLine("2026-10-21T02:00:00.000Z", phases(true)), other("the word \"todo\" in prose")]);
	expect(readTodo(file)).toEqual({ phases: phases(true), at: "2026-10-21T02:00:00.000Z" });
});

test("a session with no todo result, another tool's result or a missing file gives no phases", () => {
	expect(readTodo(session("none", [other("hello"), todoLine("2026-10-21T01:00:00.000Z", phases(false), "bash")]))).toEqual({ phases: [] });
	expect(readTodo(join(DIR, "missing.jsonl"))).toEqual({ phases: [] });
	expect(readTodo(undefined)).toEqual({ phases: [] });
	expect(readTodo(session("empty", []))).toEqual({ phases: [] });
});

test("a todo result far from the end of a large file is found by reading growing chunks, and a cut line is skipped", () => {
	const filler = Array.from({ length: 5000 }, (_, i) => other(`line ${i} ${"x".repeat(i % 200)}`));
	const file = session("big", [todoLine("2026-10-21T01:00:00.000Z", phases(false)), ...filler, "{\"broken json"]);
	expect(readTodo(file)).toEqual({ phases: phases(false), at: "2026-10-21T01:00:00.000Z" });
	const newer = session("big-newer", [todoLine("2026-10-21T01:00:00.000Z", phases(false)), ...filler.slice(0, 2500), todoLine("2026-10-21T03:00:00.000Z", phases(true)), ...filler.slice(2500)]);
	expect(readTodo(newer).at).toBe("2026-10-21T03:00:00.000Z");
});

// kdb-loss-review on the Mac mini (2026-10-29 01:53Z): its last turn armed a monitor for its extraction worker and ended with a [run]
// report; the session was waiting on that watch, not resting.
test("a monitor the last turn armed is what the session waits on until its completion comes back; an older standing watch does not count", () => {
	const d = join(process.env.DOTZ_DIR!, "todo-monitor");
	mkdirSync(d, { recursive: true });
	const f = join(d, "s.jsonl");
	const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
	const call = (name: string, args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } });
	const event = (desc: string, tail: string) => ({ type: "custom_message", customType: "senpi-monitor:notification", content: `<system-reminder>Monitor event(${desc}): ${tail}</system-reminder>` });
	const stop = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "[run] 워커를 기다려요" }] } };
	const write = (rows: unknown[]) => writeFileSync(f, `${rows.map(r => JSON.stringify(r)).join("\n")}\n`);
	const standing = call("eval", { language: "js", code: 'await tool.monitor({ description: "zele events", command: "tail -F x", persistent: true })' });
	write([user("old"), standing, stop, user("리뷰해"), call("eval", { language: "js", code: 'return await tool.monitor({ description: "추출 워커 종료 대기", command: "until ! kill -0 1; do sleep 5; done" })' }), stop]);
	expect(openMonitor(f)).toBe("추출 워커 종료 대기");
	write([user("old"), standing, stop, user("리뷰해"), call("monitor", { description: "추출 워커 종료 대기", command: "x" }), stop, event("추출 워커 종료 대기", "DONE\nwatcher completed (exit code 0)"), stop]);
	expect(openMonitor(f)).toBeUndefined();
	write([user("old"), standing, stop, user("다음 일"), stop]);
	expect(openMonitor(f)).toBeUndefined();
});
