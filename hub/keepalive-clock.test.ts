// The keepalive's idle clock after a restart continues from the session's last answer: bookkeeping lines written at
// startup (and the file's mtime) do not count, so a cache that already expired is not pinged and re-written in full.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastAnswerAt } from "./orchestrator.ts";

const line = (o: unknown) => JSON.stringify(o);

test("lastAnswerAt is the last assistant message, not the startup bookkeeping written after it", () => {
	const file = join(mkdtempSync(join(tmpdir(), "ka-")), "s.jsonl");
	writeFileSync(
		file,
		[
			line({ type: "message", timestamp: "2026-10-19T22:50:00.000Z", message: { role: "user", content: "q" } }),
			line({ type: "message", timestamp: "2026-10-19T22:55:46.000Z", message: { role: "assistant", content: [{ type: "text", text: "a" }] } }),
			line({ type: "custom", customType: "senpi.hooks.stop-state", data: { role: "assistant" }, timestamp: "2026-10-19T22:55:46.100Z" }),
			line({ type: "custom", customType: "pi-rules.scan", data: { reason: "startup" }, timestamp: "2026-10-20T00:08:10.000Z" }),
			"",
		].join("\n"),
	);
	expect(lastAnswerAt(file)).toBe(Date.parse("2026-10-19T22:55:46.000Z"));
});

test("lastAnswerAt is undefined for a missing file or a session without an answer", () => {
	const dir = mkdtempSync(join(tmpdir(), "ka-"));
	expect(lastAnswerAt(join(dir, "none.jsonl"))).toBeUndefined();
	writeFileSync(join(dir, "q.jsonl"), `${line({ type: "message", timestamp: "2026-10-19T22:50:00.000Z", message: { role: "user", content: "q" } })}\n`);
	expect(lastAnswerAt(join(dir, "q.jsonl"))).toBeUndefined();
});
