import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "./doctor-types.ts";
import { ENFORCED_RULES } from "./enforced-rules.ts";
import { LESSONS_MAX_BYTES } from "./prompt-budget.ts";
import { promptGrowth, promptHealth, readState, RULES_MAX_CHARS } from "./prompt-health.ts";

const root = mkdtempSync(join(tmpdir(), "prompt-health-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir = "";
let n = 0;
beforeEach(() => {
	dir = join(root, `d${n++}`);
	mkdirSync(dir, { recursive: true });
});

const DAY = 24 * 3600_000;
const t0 = Date.UTC(2026, 10, 1);
const setRules = (text: string) => writeFileSync(join(dir, "RULES.md"), text);
const run = (day: number) => promptHealth({ now: t0 + day * DAY, dataDir: dir, home: root }) as Finding[];
const keys = (found: Finding[]) => found.map(f => f.key).sort();
const sizeKeys = (found: Finding[]) => keys(found).filter(k => k.startsWith("prompt:size:"));

test("the first run only stores the baseline and reports nothing", () => {
	setRules("a".repeat(1000));
	expect(keys(run(0))).toEqual([]);
	expect(readState(dir)?.baseline.rules.chars).toBe(1000);
});

test("growth past both thresholds gives a finding with the growth as its level", () => {
	setRules("a".repeat(1000));
	run(0);
	setRules("a".repeat(7000));
	const found = run(1);
	const rules = found.find(f => f.key === "prompt:size:rules");
	expect(rules?.level).toBe(6000);
	expect(rules?.area).toBe("prompt");
	expect(rules?.evidence).toContain("1000");
	expect(rules?.evidence).toContain("7000");
	expect(rules?.evidence).toContain("2026-11-01");
	expect(promptGrowth(readState(dir)!)).toBe(true);
});

test("growth below the thresholds reports nothing", () => {
	setRules("a".repeat(1000));
	run(0);
	setRules("a".repeat(1900));
	expect(sizeKeys(run(1))).toEqual([]);
	expect(promptGrowth(readState(dir)!)).toBe(false);
});

test("a part grown by a share but not by enough characters stays quiet", () => {
	setRules("a".repeat(100));
	run(0);
	setRules("a".repeat(900));
	expect(sizeKeys(run(1))).toEqual([]);
});

test("a shrink moves the baseline down without a finding, and later growth counts from the lower baseline", () => {
	setRules("a".repeat(5000));
	run(0);
	setRules("a".repeat(1000));
	expect(sizeKeys(run(1))).toEqual([]);
	expect(readState(dir)?.baseline.rules).toEqual({ chars: 1000, at: t0 + DAY });
	setRules("a".repeat(3000));
	expect(sizeKeys(run(2))).toContain("prompt:size:rules");
});

test("a rule that code enforces is reported while a line writes it out, and not after the line is removed", () => {
	setRules("- keep replies short\n- never run launchctl kickstart on the gateway\n");
	run(0);
	const found = run(1);
	const hit = found.find(f => f.key === "prompt:enforced:gateway-restart");
	expect(hit?.decide?.options).toHaveLength(2);
	expect(keys(found).filter(k => k.startsWith("prompt:enforced:"))).toEqual(["prompt:enforced:gateway-restart"]);
	setRules("- keep replies short\n");
	expect(keys(run(2)).filter(k => k.startsWith("prompt:enforced:"))).toEqual([]);
});

test("a prompt file over its cap is reported once per file", () => {
	writeFileSync(join(dir, "LESSONS.md"), "l".repeat(LESSONS_MAX_BYTES + 1));
	setRules("r".repeat(RULES_MAX_CHARS + 5));
	const found = run(0);
	expect(keys(found).filter(k => k.startsWith("prompt:cap:"))).toEqual(["prompt:cap:LESSONS.md", "prompt:cap:RULES.md"]);
	expect(found.find(f => f.key === "prompt:cap:RULES.md")?.level).toBe(5);
	writeFileSync(join(dir, "LESSONS.md"), "l".repeat(LESSONS_MAX_BYTES));
	setRules("r".repeat(RULES_MAX_CHARS));
	expect(keys(run(1)).filter(k => k.startsWith("prompt:cap:"))).toEqual([]);
});

test("a corrupt state file starts over as a first run", () => {
	setRules("a".repeat(1000));
	writeFileSync(join(dir, "prompt-health.json"), "{not json");
	expect(keys(run(0))).toEqual([]);
	expect(readState(dir)?.baseline.rules.chars).toBe(1000);
});

const samples: Record<string, string> = {
	"limit-stop": "Stop the session when the usage limit is below 10%.",
	"expensive-model": "Use Fable only when the owner asks.",
	"gateway-restart": "Never run launchctl kickstart -k gui/501/dev.dotz.gateway.",
	"brief-done-when": "Every brief must have a Done when line.",
	"session-min-hours": "A session under 1 hour is refused.",
	"recommend-mark": "Never put a recommended mark on an option.",
	"telemetry-off": "Turn off telemetry at start.",
};

test("every enforced rule names an existing guard and matches its sample line", () => {
	const repo = join(import.meta.dir, "..");
	expect(new Set(ENFORCED_RULES.map(r => r.id)).size).toBe(ENFORCED_RULES.length);
	for (const rule of ENFORCED_RULES) {
		const [path, line] = rule.guard.split(":");
		expect(existsSync(join(repo, path))).toBe(true);
		if (line) expect(readFileSync(join(repo, path), "utf8").split("\n").length).toBeGreaterThanOrEqual(Number(line));
		expect(rule.match.test(samples[rule.id] ?? "")).toBe(true);
	}
});
