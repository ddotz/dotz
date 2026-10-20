// Tool-result caps in lanes and their workers: an unranged read is cut at a line boundary with the offset to go on from,
// shell output keeps its head and tail with a note in the middle, small or ranged results and images stay as they are.
import { expect, test } from "bun:test";
import { CAP_CHARS, capToolResult, installOutputCap } from "./output-cap.ts";

const lines = (n: number, width = 99) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(5, "0")} ${"x".repeat(width - 6)}`).join("\n");
const text = (t: string) => [{ type: "text", text: t }];

test("an unranged read past the cap is cut after a whole line and names the offset to continue from", () => {
	const body = lines(1000); // 100K chars
	const out = capToolResult("read", { path: "/x/big.ts" }, text(body))!;
	const t = out[0].text as string;
	expect(t.length).toBeLessThan(CAP_CHARS + 400);
	const kept = t.split("\n[dotz: ")[0];
	expect(body.startsWith(kept)).toBe(true);
	expect(kept.endsWith("x")).toBe(true); // a whole line, not a cut one
	const shown = kept.split("\n").length;
	expect(t).toContain(`offset=${shown + 1}`);
	expect(t).toContain(`of ${body.length} chars`);
	// A read that started further down continues from there.
	const later = capToolResult("read", { path: "/x/big.ts", offset: 301 }, text(body))![0].text as string;
	expect(later).toContain(`offset=${301 + shown}`);
});

test("a ranged read, a small read and images are left alone", () => {
	expect(capToolResult("read", { path: "/x", offset: 1, limit: 2000 }, text(lines(1000)))).toBeUndefined();
	expect(capToolResult("read", { path: "/x" }, text(lines(50)))).toBeUndefined();
	const image = [{ type: "image", data: "a".repeat(200_000), mimeType: "image/png" }];
	expect(capToolResult("read", { path: "/x.png" }, image)).toBeUndefined();
});

test("shell output past the cap keeps its head and tail (errors, test summaries, the full-output path) and says how to see the rest", () => {
	const body = `${lines(600)}\n[Full output: /tmp/eval-1.log]`;
	for (const tool of ["eval", "bash", "bash_output"]) {
		const t = capToolResult(tool, { code: "git diff" }, text(body))![0].text as string;
		expect(t.length).toBeLessThan(CAP_CHARS + 400);
		expect(t.startsWith(lines(1))).toBe(true);
		expect(t.endsWith("[Full output: /tmp/eval-1.log]")).toBe(true);
		expect(t).toMatch(/\[dotz: \d+ chars of \d+ left out here/);
	}
	expect(capToolResult("eval", { code: "ls" }, text(lines(100)))).toBeUndefined();
});

test("grep-style results keep their first matches; other tools (task reports, edits, web pages) are not capped", () => {
	const t = capToolResult("grep", { pattern: "x" }, text(lines(1000)))![0].text as string;
	expect(t.length).toBeLessThan(CAP_CHARS + 400);
	expect(t).toContain("narrow the pattern or path");
	for (const tool of ["task", "task_output", "edit", "webfetch", "todo"]) expect(capToolResult(tool, {}, text(lines(1000)))).toBeUndefined();
});

test("the hook is installed for lane processes only and returns the capped content", () => {
	const handlers: Record<string, (e: any) => any> = {};
	const pi = { on: (name: string, fn: (e: any) => any) => (handlers[name] = fn) };
	installOutputCap(pi, {});
	expect(handlers.tool_result).toBeUndefined();
	installOutputCap(pi, { DOTZ_LANE: "alpha" });
	const r = handlers.tool_result!({ toolName: "read", input: { path: "/x" }, content: text(lines(1000)) });
	expect((r.content[0].text as string).length).toBeLessThan(CAP_CHARS + 400);
	expect(handlers.tool_result!({ toolName: "read", input: { path: "/x" }, content: text("short") })).toBeUndefined();
});
