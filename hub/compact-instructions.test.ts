import { expect, test } from "bun:test";
import { basename } from "node:path";
import { ARCHIVE_FILES, compactInstructions, SUMMARY_MAX_CHARS } from "./compact-instructions.ts";
import { DEFAULTS, paths } from "./config.ts";

test("the summary instruction states a size target that is a small part of the compaction point, and stays short itself", () => {
	const text = compactInstructions();
	expect(text).toContain(String(SUMMARY_MAX_CHARS));
	// Measured 2026-11-11: Korean-heavy summaries run about 2.9 characters per token; the target stays under a tenth of the default point.
	expect(SUMMARY_MAX_CHARS / 2.5).toBeLessThan(DEFAULTS.rotate_tokens / 10);
	// It rides along with every compaction request.
	expect(text.length).toBeLessThan(2000);
});

test("the instruction points at the record files the gateway writes", () => {
	const text = compactInstructions();
	for (const file of ARCHIVE_FILES) expect(text).toContain(file);
	expect(ARCHIVE_FILES).toContain(basename(paths.inbox));
	expect(ARCHIVE_FILES).toContain(basename(paths.outbox));
});
