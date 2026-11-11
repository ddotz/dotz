// The handover into a fresh session: the previous session's last compaction summary comes first, the recent exchanges fill what is left, the whole is cut at its budget.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUMMARY_MAX_CHARS } from "./compact-instructions.ts";
import { HANDOVER_MAX_CHARS, handover } from "./orchestrator-parts.ts";
import { omo } from "./runtime/omo.ts";
import { lastCompactionSummary } from "./runtime/omo-summary.ts";
import type { RuntimeAdapter } from "./runtime/types.ts";

const runtime = (exchanges: string | undefined, summary?: string): RuntimeAdapter => ({ recentExchanges: () => exchanges, lastCompactionSummary: summary === undefined ? undefined : () => summary }) as unknown as RuntimeAdapter;
const turns = (n: number) => Array.from({ length: n }, (_, i) => `${i % 2 ? "YOU" : "IN"}: turn ${String(i).padStart(3, "0")} ${"x".repeat(180)}`).join("\n\n");

test("the summary of the last compaction is read from the session file, the newest entry wins, and text that only looks like an entry is not one", () => {
	const dir = mkdtempSync(join(tmpdir(), "summary-"));
	const file = join(dir, "s.jsonl");
	const line = (o: unknown) => `${JSON.stringify(o)}\n`;
	writeFileSync(file, line({ type: "message", message: { role: "user", content: '{"type":"compaction","summary":"FAKE"}' } }) + line({ type: "compaction", summary: "first summary" }) + line({ type: "message", message: { role: "assistant", content: "ok" } }) + line({ type: "compaction", summary: "second summary" }) + line({ type: "message", message: { role: "user", content: "after" } }));
	expect(lastCompactionSummary(file)).toBe("second summary");
	expect(omo.lastCompactionSummary?.(file)).toBe("second summary");
	writeFileSync(file, line({ type: "message", message: { role: "user", content: '{"type":"compaction","summary":"FAKE"}' } }));
	expect(lastCompactionSummary(file)).toBeUndefined();
	expect(lastCompactionSummary(join(dir, "missing.jsonl"))).toBeUndefined();
	rmSync(dir, { recursive: true, force: true });
});

test("the handover carries the summary, then the recent exchanges, and a runtime without a summary reader leaves it out", () => {
	const text = handover(runtime("IN: hello\n\nYOU: hi", "THE-SUMMARY"), "/prev.jsonl");
	expect(text).toContain("THE-SUMMARY");
	expect(text.indexOf("THE-SUMMARY")).toBeLessThan(text.indexOf("IN: hello"));
	const plain = handover(runtime("IN: hello\n\nYOU: hi"), "/prev.jsonl");
	expect(plain).toContain("IN: hello");
	expect(plain).not.toContain("THE-SUMMARY");
	expect(handover(runtime(undefined, "THE-SUMMARY"), "/prev.jsonl")).toBe("");
});

test("a summary longer than the compaction cap is cut at the cap, and the whole handover is cut at its budget keeping the newest exchanges whole", () => {
	const summary = `HEAD${"s".repeat(SUMMARY_MAX_CHARS * 2)}TAIL`;
	const text = handover(runtime(turns(120), summary), "/prev.jsonl");
	expect(text.length).toBeLessThanOrEqual(HANDOVER_MAX_CHARS);
	expect(text).toContain("HEAD");
	expect(text).not.toContain("TAIL");
	expect(text.match(/s+/g)!.reduce((n, m) => Math.max(n, m.length), 0)).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
	expect(text).toContain("turn 119");
	expect(text).not.toContain("turn 000");
	const first = text.match(/(IN|YOU): turn (\d{3})/g)![0];
	expect(first.startsWith("IN: ") || first.startsWith("YOU: ")).toBe(true);
	expect(text.match(/(?:IN|YOU): turn \d{3} x{180}/g)!.length).toBe(text.match(/turn \d{3}/g)!.length);
});
