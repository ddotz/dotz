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

// kdb-loss-review on the Mac mini (2026-10-29): its turn ended to wait on its own "HTML 워커 종료" monitor (armed two turns before) and a
// background shell; the harness's own lifecycle record says so, and that is what the session waits on.
test("a session waits on what its harness's latest lifecycle record says: a monitor first, else its background shells or subagents", () => {
	const d = join(process.env.DOTZ_DIR!, "todo-monitor");
	mkdirSync(d, { recursive: true });
	const f = join(d, "s.jsonl");
	const life = (state: string, background: unknown[] = [], children = 0) => ({ type: "custom", customType: "session-lifecycle", data: { state, waitingOn: { children, background } } });
	const mons = (...desc: string[]) => ({ source: "terminal-monitors", activeCount: desc.length, items: desc.map(description => ({ description })) });
	const shells = (n: number) => ({ source: "terminal-background-sessions", activeCount: n, items: Array.from({ length: n }, () => ({ label: "cd x && omo -p" })) });
	const write = (rows: unknown[]) => writeFileSync(f, `${rows.map(r => JSON.stringify(r)).join("\n")}\n`);
	write([life("running", [shells(1), mons("HTML 워커 종료")]), life("waiting_background", [shells(1), mons("HTML 워커 종료")])]);
	expect(openMonitor(f)).toBe("HTML 워커 종료");
	write([life("waiting_background", [shells(1), mons("HTML 워커 종료")]), life("running", [shells(1), mons("HTML 워커 종료")])]);
	expect(openMonitor(f)).toBeUndefined();
	write([life("waiting_background", [shells(2)])]);
	expect(openMonitor(f)).toBe("백그라운드 작업 2개");
	write([life("idle", [])]);
	expect(openMonitor(f)).toBeUndefined();
});
