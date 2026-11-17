import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompTurnCut } from "./omp-turn.ts";
import { ompTree } from "./runtime/test-omp-session.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const rowsOf = (fixture: string): { file: string; rows: string[] } => {
	const dir = mkdtempSync(join(tmpdir(), "omp-turn-"));
	dirs.push(dir);
	const { file } = ompTree(fixture, dir);
	return { file, rows: readFileSync(file, "utf8").trimEnd().split("\n") };
};
const upTo = (fixture: string, keep: (row: { type?: string; message?: { role?: string; stopReason?: string } }) => boolean): string => {
	const { file, rows } = rowsOf(fixture);
	const last = rows.findLastIndex(r => keep(JSON.parse(r)));
	writeFileSync(file, `${rows.slice(0, last + 1).join("\n")}\n`);
	return file;
};
const message = (role: string, stop?: string) => (r: { type?: string; message?: { role?: string; stopReason?: string } }) => r.type === "message" && r.message?.role === role && (stop === undefined || r.message.stopReason === stop);

test("a session that ends on its answer, or exited cleanly after it, owes no turn", () => {
	expect(ompTurnCut(rowsOf("finished").file)).toBeUndefined();
	expect(ompTurnCut(rowsOf("killed").file)).toBeUndefined();
	expect(ompTurnCut(upTo("killed", message("assistant", "stop")))).toBeUndefined();
});

test("a process that died after a tool result, or after calling a tool, cut its turn", () => {
	expect(ompTurnCut(upTo("killed", message("toolResult")))).toBe("run");
	expect(ompTurnCut(upTo("killed", message("assistant", "toolUse")))).toBe("run");
});

test("a request no assistant message answered is an unanswered request", () => {
	expect(ompTurnCut(upTo("killed", message("user")))).toBe("request");
});

test("a worker's result that arrived and was never answered cut the turn it woke", () => {
	const file = upTo("finished", message("assistant", "stop"));
	expect(ompTurnCut(file)).toBeUndefined();
	appendFileSync(file, `${JSON.stringify({ type: "custom_message", customType: "async-result", details: { jobs: [] } })}\n`);
	expect(ompTurnCut(file)).toBe("run");
});

test("bookkeeping rows after the last message, and a half-written last row, do not hide the cut", () => {
	const file = upTo("killed", message("toolResult"));
	appendFileSync(file, `${JSON.stringify({ type: "custom", customType: "session_exit", data: { kind: "normal" } })}\n{"type":"message","message":{"role":"assis`);
	expect(ompTurnCut(file)).toBe("run");
});

test("a last row larger than the first read is still found", () => {
	const file = upTo("killed", message("assistant", "toolUse"));
	appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(300_000) }] } })}\n`);
	expect(ompTurnCut(file)).toBe("run");
});

test("a file another runtime wrote says nothing here", () => {
	const { file, rows } = rowsOf("killed");
	writeFileSync(file, `${['{"type":"session","id":"x"}', ...rows.slice(1, -1)].join("\n")}\n`);
	expect(ompTurnCut(file)).toBeUndefined();
});
