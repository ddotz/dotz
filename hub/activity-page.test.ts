import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptPage } from "./activity.ts";

function transcriptOfSecondlyTexts(n: number): string {
	const file = join(mkdtempSync(join(tmpdir(), "dotz-page-")), "s.jsonl");
	const lines = Array.from({ length: n }, (_, i) =>
		JSON.stringify({ type: "message", timestamp: new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `m${i}` }] } }),
	);
	writeFileSync(file, lines.join("\n"));
	return file;
}

test("pages through a transcript backwards with no overlap and no gap", async () => {
	const file = transcriptOfSecondlyTexts(25);
	const seen: string[] = [];
	let page = await transcriptPage(file, 10);
	seen.unshift(...page.items.map(i => i.text));
	expect(page.more).toBe(true);
	while (page.more) {
		page = await transcriptPage(file, 10, page.items[0].ts);
		seen.unshift(...page.items.map(i => i.text));
	}
	expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
});

test("before filters strictly older items; a missing file is an empty last page", async () => {
	const file = transcriptOfSecondlyTexts(5);
	const page = await transcriptPage(file, 10, new Date(Date.UTC(2026, 9, 20, 0, 0, 3)).toISOString());
	expect(page.items.map(i => i.text)).toEqual(["m0", "m1", "m2"]);
	expect(page.more).toBe(false);
	expect(await transcriptPage(join(tmpdir(), "dotz-no-such-file.jsonl"), 10)).toEqual({ items: [], more: false });
});
