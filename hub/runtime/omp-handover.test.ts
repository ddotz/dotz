import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOVER_MAX_CHARS, handover } from "../orchestrator-parts.ts";
import { omp } from "./omp.ts";

const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;
let n = 0;
const entry = (type: string, rest: Record<string, unknown>) => line({ type, id: `e${++n}`, parentId: n > 1 ? `e${n - 1}` : null, timestamp: "2026-11-17T04:30:00.000Z", ...rest });
const user = (text: string) => entry("message", { message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
const assistant = (text: string) => entry("message", { message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 10, output: 5 }, timestamp: 2 } });
const compaction = (summary: string) => entry("compaction", { summary, shortSummary: "recap", firstKeptEntryId: "e2", tokensBefore: 42_000, details: { readFiles: ["src/a.ts"] } });

const header = line({ type: "session", version: 3, id: "01abc", timestamp: "2026-11-17T04:00:00.000Z", cwd: "/work" });
const meta = entry("model_change", { model: "anthropic/claude-opus-5-5", role: "default" }) + entry("thinking_level_change", { thinkingLevel: "medium" });

const sessionFile = (body: string): string => {
	const dir = mkdtempSync(join(tmpdir(), "omp-handover-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, header + meta + body);
	return file;
};

test("omp compacts the orchestrator in place and cannot cancel a compaction that runs", () => {
	expect(omp.caps.contextLimit).toBe("compact");
	expect(omp.caps.abortCompact).toBeUndefined();
});

test("the handover into a fresh session carries the summary of the last compaction in an omp session file, before the recent exchanges", () => {
	const quoted = user('{"type":"compaction","summary":"QUOTED, NOT AN ENTRY"}');
	const file = sessionFile(user("plan the move") + assistant("moving on Friday") + compaction("FIRST SUMMARY") + quoted + assistant("noted") + compaction("GOAL CHAIN: move on Friday, call the landlord") + user("did you call?") + assistant("yes, called"));
	expect(omp.lastCompactionSummary?.(file)).toBe("GOAL CHAIN: move on Friday, call the landlord");
	const text = handover(omp, file);
	expect(text).toContain("GOAL CHAIN: move on Friday, call the landlord");
	expect(text).not.toContain("FIRST SUMMARY");
	expect(text.indexOf("GOAL CHAIN")).toBeLessThan(text.indexOf("IN: did you call?"));
	expect(text).toContain("YOU: yes, called");
	expect(text.length).toBeLessThanOrEqual(HANDOVER_MAX_CHARS);
	rmSync(join(file, ".."), { recursive: true, force: true });
});

test("a session with no compaction entry has no summary to carry, and an unreadable one has no handover", () => {
	const file = sessionFile(user("hello") + assistant("hi"));
	expect(omp.lastCompactionSummary?.(file)).toBeUndefined();
	expect(handover(omp, file)).toContain("IN: hello");
	expect(handover(omp, join(file, "..", "missing.jsonl"))).toBe("");
	rmSync(join(file, ".."), { recursive: true, force: true });
});

test("the summary of an omp session file is stale once a real exchange follows its latest compaction entry, or when exchanges exist and none was written", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-stale-"));
	const stale = (body: string) => {
		const file = join(dir, "session.jsonl");
		writeFileSync(file, header + meta + body);
		return omp.summaryStale?.(file);
	};
	expect(stale(user("hello") + assistant("hi"))).toBe(true);
	expect(stale(user("hello") + assistant("hi") + compaction("summary"))).toBe(false);
	expect(stale(user("hello") + compaction("summary") + user("[keepalive] ping") + assistant("ok"))).toBe(false);
	expect(stale(user("hello") + compaction("summary") + user("later question") + assistant("later answer"))).toBe(true);
	expect(omp.summaryStale?.(join(dir, "missing.jsonl"))).toBe(false);
	rmSync(dir, { recursive: true, force: true });
});
