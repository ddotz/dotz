import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchSummarizer } from "./watchsummary.ts";

const setup = (reply: string, today = () => "2026-10-23") => {
	const calls: string[] = [];
	const summarize = createWatchSummarizer({
		call: async (_system, text) => (calls.push(text), { text: reply, inputTokens: 100, outputTokens: 12 }),
		file: join(mkdtempSync(join(tmpdir(), "wsum-")), "cache.json"),
		today,
	});
	return { calls, summarize };
};

test("one model call per distinct output; the same output again is read from the cache", async () => {
	const { calls, summarize } = setup("새 항목이 하나 늘었어요");
	expect(await summarize("zzqx 1049 wrd\u0007 raw blob 1")).toBe("새 항목이 하나 늘었어요");
	expect(await summarize("zzqx 1049 wrd\u0007 raw blob 1")).toBe("새 항목이 하나 늘었어요");
	expect(calls).toHaveLength(1);
});

test("a reply that is not a Korean sentence, or an output too short to mean anything, costs nothing more and shows nothing", async () => {
	const { calls, summarize } = setup("?");
	expect(await summarize("zzqx 1049 wrd raw blob 2")).toBeUndefined();
	expect(await summarize("ok")).toBeUndefined();
	expect(calls).toHaveLength(1);
});

test("calls stop at the daily cap and start again the next day", async () => {
	let day = "2026-10-23";
	const { calls, summarize } = setup("확인이 필요한 변화가 있어요", () => day);
	for (let i = 0; i < 40; i++) await summarize("blob number " + i + " zzqx");
	expect(calls).toHaveLength(30);
	day = "2026-10-24";
	await summarize("blob number 99 zzqx");
	expect(calls).toHaveLength(31);
});
