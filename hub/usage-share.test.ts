// The usage screen's "what used it" rows come from the nightly audit's record, cut at 10% of the day's spend.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUseShare, sharesOf } from "./usage-share.ts";

const AT = Date.UTC(2026, 10, 12, 19, 30);
const use = (kind: "orchestrator" | "lane" | "worker" | "other", name: string, models: Record<string, number>, tokens = 1000) => ({ kind, name, models, cost: Object.values(models).reduce((a, b) => a + b, 0), tokens });

test("rows at or over 10% of the cost, biggest first, each named by its costliest model; the rest is summed", () => {
	const s = sharesOf([use("orchestrator", "", { "claude-fable-5-2": 50, "claude-opus-5-5": 10 }), use("lane", "site-fix", { "claude-opus-5-5": 30 }), use("worker", "w1", { "claude-sonnet-5-5": 9 }), use("other", "x", { "claude-sonnet-5-5": 1 })], AT, 24);
	expect(s.rows.map(r => [r.kind, r.name, r.model, r.pct])).toEqual([["orchestrator", "", "claude-fable-5-2", 60], ["lane", "site-fix", "claude-opus-5-5", 30]]);
	expect(s.models.map(m => [m.model, m.pct])).toEqual([["claude-fable-5-2", 50], ["claude-opus-5-5", 40], ["claude-sonnet-5-5", 10]]);
	expect(s.rest).toEqual({ sessions: 2, pct: 10 });
	expect(s.cost).toBe(100);
});

test("a day that cost nothing is cut by tokens, and an empty day has no rows", () => {
	const s = sharesOf([use("lane", "a", { m: 0 }, 900), use("lane", "b", { m: 0 }, 100)], AT, 24);
	expect(s.rows.map(r => [r.name, r.pct])).toEqual([["a", 90], ["b", 10]]);
	expect(sharesOf([], AT, 24)).toMatchObject({ rows: [], models: [], rest: { sessions: 0, pct: 100 } });
});

test("the screen reads the newest day's record, again only after the file changed; no file or no record is undefined", () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-share-"));
	const file = join(dir, "token-audit.json");
	expect(readUseShare(file)).toBeUndefined();
	const day = (cost: number) => ({ date: "2026-11-12", cost, use: sharesOf([use("lane", "a", { m: cost })], AT, 24) });
	writeFileSync(file, JSON.stringify({ days: [{ date: "2026-11-11" }, day(5)] }));
	expect(readUseShare(file)?.cost).toBe(5);
	writeFileSync(file, JSON.stringify({ days: [day(5), day(70)] }));
	expect(readUseShare(file)?.cost).toBe(70);
	writeFileSync(file, JSON.stringify({ days: [{ date: "2026-11-12" }] }));
	expect(readUseShare(file)).toBeUndefined();
});
