// Tool-result caps in lanes and their workers: an unranged read is cut at a line boundary with the offset to go on from,
// shell output keeps its head and tail with a note in the middle, small or ranged results and images stay as they are.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { CAP_CHARS, capNotices, capToolResult, installOutputCap, NOTICE_TYPE, PATCH_READ_CAP, READ_CAP } from "./output-cap.ts";

const lines = (n: number, width = 99) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(5, "0")} ${"x".repeat(width - 6)}`).join("\n");
const text = (t: string) => [{ type: "text", text: t }];
type Block = { type: string; text?: string };

test("an unranged read past the cap is cut after a whole line and names the offset to continue from", () => {
	const body = lines(1000); // 100K chars
	const out = capToolResult("read", { path: "/x/big.ts" }, text(body))!;
	const t = out[0].text as string;
	expect(t.length).toBeLessThan(READ_CAP + 400);
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

test("a read gets more room than a search result, and a patch or diff is read whole up to its own bound", () => {
	// Cut at the search cap before; whole now.
	expect(capToolResult("read", { path: "/p/x.patch" }, text(lines(300)))).toBeUndefined(); // 30K
	expect(capToolResult("read", { path: "/tmp/ptA-1.diff" }, text(lines(1000)))).toBeUndefined(); // 100K
	expect((capToolResult("read", { path: "/tmp/huge.patch" }, text(lines(3000)))![0].text as string).length).toBeLessThan(PATCH_READ_CAP + 400); // 300K
	expect(capToolResult("read", { path: "/d/a.md" }, text(lines(450)))).toBeUndefined(); // 45K
	// Still cut.
	const md = capToolResult("read", { path: "/d/a.md" }, text(lines(700)))![0].text as string; // 70K
	expect(md.length).toBeGreaterThan(CAP_CHARS);
	expect(md.length).toBeLessThan(READ_CAP + 400);
	const grep = capToolResult("grep", { pattern: "x" }, text(lines(300)))![0].text as string; // 30K
	expect(grep.length).toBeLessThan(CAP_CHARS + 400);
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

const notice = (body: string, extra: Record<string, unknown> = {}) => ({ role: "custom", customType: NOTICE_TYPE, timestamp: 1, display: true, content: `<system-reminder>Detached eval cell toolu_X (js) completed.\n${body}\nKernel state updated - variables are available to the next eval cell.</system-reminder>`, ...extra });

test("a detached eval notice past the cap keeps head and tail, saves the whole text to a file and names it", () => {
	const body = lines(800); // 80K chars
	const msgs = [{ role: "user", content: text("go") }, notice(body)];
	const out = capNotices(msgs)!;
	const t = out[1].content as string;
	expect(t.length).toBeLessThan(CAP_CHARS + 600);
	expect(t.startsWith("<system-reminder>Detached eval cell toolu_X (js) completed.\n00001 ")).toBe(true);
	expect(t.endsWith("Kernel state updated - variables are available to the next eval cell.</system-reminder>")).toBe(true);
	const file = /full output: (\S+)/.exec(t)?.[1]?.replace(/[;,)]+$/, "");
	expect(file && existsSync(file)).toBe(true);
	expect(readFileSync(file!, "utf8")).toBe(msgs[1].content as string);
	expect(out[0]).toBe(msgs[0]); // other messages are the same objects
	// The same input gives the same text on every request (the prompt cache must hold).
	expect(capNotices(msgs)![1].content).toBe(t);
});

test("the context hook sees notices as user messages with text blocks (customType is gone by then) and cuts them there; other user messages stay", () => {
	const asUser = (c: string) => ({ role: "user", timestamp: 1, content: [{ type: "text", text: c }] });
	const raw = (notice(lines(800)) as { content: string }).content;
	const out = capNotices([asUser("go"), asUser(raw)])!;
	const t = (out[1].content as Block[])[0].text as string;
	expect(t.length).toBeLessThan(CAP_CHARS + 600);
	expect(t).toMatch(/\[dotz: \d+ chars of \d+ left out here; full output: /);
	expect(t.endsWith("</system-reminder>")).toBe(true);
	expect(out[0].content).toEqual(text("go"));
	expect(capNotices([asUser(lines(800))])).toBeUndefined(); // a long user message that is not a notice
	expect(capNotices([asUser(raw.slice(0, 5000))])).toBeUndefined();
});

test("a notice with its own full-output line keeps it and needs no second file; small notices, images and other messages stay", () => {
	const own = notice(`${lines(800)}\n[Full output: /tmp/eval-9.log]`);
	const t = capNotices([own])![0].content as string;
	expect(t).toContain("[Full output: /tmp/eval-9.log]");
	expect(t).not.toContain("full output: /");
	expect(capNotices([notice(lines(100))])).toBeUndefined();
	expect(capNotices([notice(lines(800), { customType: "other" })])).toBeUndefined();
	const image = { type: "image", data: "a".repeat(200_000), mimeType: "image/png" };
	const blocks = capNotices([notice("", { content: [{ type: "text", text: lines(800) }, image] })])![0].content as any[];
	expect(blocks[0].text.length).toBeLessThan(CAP_CHARS + 600);
	expect(blocks[1]).toBe(image);
	expect(capNotices([notice("", { content: [image] })])).toBeUndefined();
});

test("a cut shell result names the file with the full output, which is not written when it is not needed", () => {
	const body = lines(600);
	const t = capToolResult("eval", { code: "bun test" }, text(body))![0].text as string;
	const file = /full output: (\S+)/.exec(t)?.[1]?.replace(/[;,)]+$/, "");
	expect(file && readFileSync(file, "utf8")).toBe(body);
	// A result that already carries OmO's [Full output: ...] line is not spilled a second time.
	const own = capToolResult("eval", { code: "x" }, text(`${body}\n[Full output: /tmp/e.log]`))![0].text as string;
	expect(own).not.toContain("full output: /");
});

test("a spill file that is reused gets a fresh mtime, so the temp sweep does not remove it under a fresh transcript", () => {
	const body = lines(601);
	const pathOf = () => /full output: (\S+)/.exec(capToolResult("eval", { code: "bun test" }, text(body))![0].text as string)?.[1]?.replace(/[;,)]+$/, "")!;
	const file = pathOf();
	const first = statSync(file).mtimeMs;
	const DAY = 86_400_000;
	utimesSync(file, new Date(first - 5 * DAY), new Date(first - 5 * DAY));
	expect(pathOf()).toBe(file);
	expect(statSync(file).mtimeMs).toBeGreaterThan(first - DAY);
});

test("the hook is installed for lane processes only and returns the capped content", () => {
	const handlers: Record<string, (e: any) => any> = {};
	const pi = { on: (name: string, fn: (e: any) => any) => (handlers[name] = fn) };
	installOutputCap(pi, {});
	expect(handlers.tool_result).toBeUndefined();
	installOutputCap(pi, { DOTZ_LANE: "alpha" });
	const r = handlers.tool_result!({ toolName: "read", input: { path: "/x" }, content: text(lines(1000)) });
	expect((r.content[0].text as string).length).toBeLessThan(READ_CAP + 400);
	expect(handlers.tool_result!({ toolName: "read", input: { path: "/x" }, content: text("short") })).toBeUndefined();
	// The context hook cuts notices in the same processes and leaves the orchestrator itself alone.
	expect(((handlers.context!({ messages: [notice(lines(800))] }) as any).messages[0].content as string).length).toBeLessThan(CAP_CHARS + 600);
	const orch: Record<string, (e: any) => any> = {};
	installOutputCap({ on: (name: string, fn: (e: any) => any) => (orch[name] = fn) }, { DOTZ_ORCHESTRATOR: "1" });
	expect(orch.context).toBeUndefined();
});
