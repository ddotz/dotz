// Progress-based growth of the task token cap: checkpoints, ceiling, revival, Estimate, headroom, off switch. No sleeps: the clock, the git probe and the usage read are injected.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capReason, handoffPath, installTaskCap } from "./task-cap.ts";
import { type GitDelta, createGrowth, gitDelta, judge, parseEstimate, readGit, startingCap, stepFor, usageLeft } from "./task-cap-grow.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const M = 1_000_000;

interface Options { enabled?: boolean; step?: number; ceiling?: number; delta?: GitDelta; usage?: unknown; now?: number }

function grower(cap: number, o: Options = {}) {
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const sent: { message: any; options: any }[] = [];
	const probe = { next: o.delta ?? { commits: 1, changed: [] as string[] }, marks: 0, reads: 0 };
	const growth = createGrowth(
		cap,
		{ enabled: o.enabled ?? true, step: o.step ?? M, ceiling: o.ceiling ?? 8 * M },
		{ probe: { mark: () => void probe.marks++, delta: () => (probe.reads++, probe.next) }, now: () => o.now ?? NOW, readUsage: () => o.usage, account: () => "acct" },
	);
	installTaskCap({ on: (name, fn) => (handlers[name] ??= []).push(fn), sendMessage: (message, options) => sent.push({ message, options }) }, cap, 0, growth);
	const ctx = { abort: () => {}, compact: () => {}, sessionManager: { getSessionId: () => "sess-1" } };
	const turn = (tokens: number) => handlers.turn_end?.[0]({ message: { role: "assistant", usage: { input: 400, cacheRead: tokens - 1000, cacheWrite: 0, output: 600 } }, toolResults: [{}] }, ctx);
	const answer = () => handlers.turn_end?.[0]({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "report" }], usage: { input: 400, cacheRead: 10_000, cacheWrite: 0, output: 600 } }, toolResults: [] }, ctx);
	const call = (input: unknown = { code: `echo ${Math.random()}` }) => handlers.tool_call?.[0]({ toolName: "eval", toolCallId: "x", input }, ctx);
	const prompt = (text: string) => handlers.before_agent_start?.[0]({ prompt: text }, ctx);
	const texts = () => sent.map(s => String(s.message.content));
	return { turn, answer, call, prompt, sent, texts, probe, growth, handlers };
}

test("progress at the warning point grows the cap one step, sends no handoff steer and blocks nothing", () => {
	const w = grower(4 * M);
	w.turn(2_999_000);
	expect(w.probe.reads).toBe(0);
	w.turn(1_000);
	expect(w.probe.reads).toBe(1);
	expect(w.growth.cap()).toBe(5 * M);
	expect(w.sent).toHaveLength(1);
	expect(w.sent[0].options).toEqual({ deliverAs: "steer" });
	expect(w.texts()[0]).toContain("3M spent: cap 4M -> 5M (progress: 1 commits");
	expect(w.texts()[0]).not.toContain("handoff file");
	w.turn(M);
	expect(w.call()).toBeUndefined();
});

test("the git probe runs at checkpoints only, never per tool call", () => {
	const w = grower(4 * M);
	for (let i = 0; i < 60; i++) w.call();
	w.turn(500_000);
	expect(w.probe.reads).toBe(0);
	w.turn(2_500_000);
	expect(w.probe.reads).toBe(1);
});

test("no progress at the warning point warns once, and the cap blocks as before with the stop line", () => {
	const w = grower(4 * M, { delta: { commits: 0, changed: [] } });
	w.turn(3 * M);
	expect(w.texts()).toHaveLength(1);
	expect(w.texts()[0]).toContain("write a handoff file");
	expect(w.growth.cap()).toBe(4 * M);
	w.turn(500_000);
	expect(w.sent).toHaveLength(1);
	expect(w.call()).toBeUndefined();
	w.turn(500_000);
	const blocked = w.call();
	expect(blocked.block).toBe(true);
	expect(blocked.reason).toContain("[fail] dotz task token cap");
	expect(blocked.reason).toContain("[dotz cap] stopped at 4M of cap 4M (no progress: 0 commits, 0 files");
});

test("a window of repeated calls is spinning even when files changed", () => {
	const w = grower(4 * M, { delta: { commits: 0, changed: ["a.ts", "b.ts", "c.ts"] } });
	for (let i = 0; i < 20; i++) w.call({ code: "bun test" });
	w.turn(3 * M);
	expect(w.growth.cap()).toBe(4 * M);
	expect(w.texts()[0]).toContain("write a handoff file");
	const moving = grower(4 * M, { delta: { commits: 0, changed: ["a.ts", "b.ts", "c.ts"] } });
	for (let i = 0; i < 20; i++) moving.call();
	moving.turn(3 * M);
	expect(moving.growth.cap()).toBe(5 * M);
});

test("the ceiling ends a worker that keeps making progress: grown to it, one handoff steer, then the block", () => {
	const w = grower(4 * M, { ceiling: 6 * M });
	for (let spent = 0.5; spent < 6; spent += 0.5) {
		w.turn(500_000);
		expect(w.call()).toBeUndefined();
	}
	expect(w.growth.cap()).toBe(6 * M);
	expect(w.texts().map(t => t.includes("handoff file"))).toEqual([false, false, true]);
	w.turn(500_000);
	const blocked = w.call();
	expect(blocked.block).toBe(true);
	expect(blocked.reason).toContain("cap 6,000K");
	expect(blocked.reason).toContain("cap 4M -> 5M");
	expect(blocked.reason).toContain("cap 5M -> 6M");
});

test("a turn that jumps past the cap is judged at the call and caught up in whole steps", () => {
	const w = grower(M, { ceiling: 4 * M });
	w.turn(2 * M);
	expect(w.sent).toEqual([]);
	expect(w.call()).toBeUndefined();
	expect(w.growth.cap()).toBe(3 * M);
	const spin = grower(M, { delta: { commits: 0, changed: [] } });
	spin.turn(2 * M);
	expect(spin.call().block).toBe(true);
});

test("a follow-up after the final answer gets a fresh allowance; hidden prompts and prompts before an answer do not", () => {
	const w = grower(M, { delta: { commits: 0, changed: [] } });
	w.prompt("Do the job.\nEstimate: 15%");
	w.turn(1_100_000);
	expect(w.call().block).toBe(true);
	w.prompt("One more thing: also check the other file.");
	expect(w.call().block).toBe(true);
	w.answer();
	w.prompt("[dotz] your context (150K) was compacted");
	w.prompt("");
	expect(w.call().block).toBe(true);
	w.prompt("One more thing: also check the other file.");
	expect(w.call()).toBeUndefined();
	const before = w.sent.length;
	w.turn(800_000);
	expect(w.sent).toHaveLength(before + 1);
	expect(w.call()).toBeUndefined();
	w.turn(300_000);
	expect(w.call().block).toBe(true);
	expect(w.probe.marks).toBe(2);
});

test("Estimate: the brief's line sets the starting cap, no line keeps the default", () => {
	expect(parseEstimate("Goal.\nEstimate: 7.5%\nDone when: x")).toBe(7.5);
	expect(parseEstimate("Goal.\nEstimate: soon")).toBeUndefined();
	expect(parseEstimate(undefined)).toBeUndefined();
	const cap = (percent: number | undefined) => startingCap(percent, 12 * M, 24 * M);
	expect(cap(undefined)).toBe(12 * M);
	expect(cap(15)).toBe(12 * M);
	expect(cap(8)).toBe(6 * M);
	expect(cap(1)).toBe(4 * M);
	expect(cap(30)).toBe(24 * M);
	expect(cap(100)).toBe(24 * M);
	expect(cap(0)).toBe(12 * M);
	expect(cap(Number.NaN)).toBe(12 * M);
	expect(startingCap(30, 12 * M, 10 * M)).toBe(12 * M);
	const small = grower(12 * M);
	small.prompt("Brief.\nEstimate: 5%");
	expect(small.growth.cap()).toBe(4 * M);
	const large = grower(12 * M, { ceiling: 24 * M });
	large.prompt("Brief.\nEstimate: 30%");
	large.turn(13 * M);
	expect(large.call()).toBeUndefined();
	const none = grower(12 * M);
	none.prompt("Brief without a line.");
	expect(none.growth.cap()).toBe(12 * M);
});

const window = (id: string, usedPercent: number, resetsAt = NOW + 3_600_000) => ({ id, usedPercent, resetsAt: new Date(resetsAt).toISOString(), windowMinutes: 300 });
const usageOf = (windows: unknown[], updatedAt = NOW - 60_000) => ({ accounts: { "anthropic-subscription/acct": { windows, updatedAt } } });

test("headroom: little room in a usage window shrinks the step, an unreadable value keeps the default", () => {
	expect(stepFor(3 * M, undefined)).toBe(3 * M);
	expect(stepFor(3 * M, 60)).toBe(3 * M);
	expect(stepFor(3 * M, 20)).toBe(1_500_000);
	expect(stepFor(3 * M, 5)).toBe(M);
	expect(stepFor(500_000, 5)).toBe(500_000);
	expect(usageLeft(usageOf([window("claude:5h", 80), window("claude:7d", 10)]), "acct", NOW)).toBe(20);
	expect(usageLeft(usageOf([window("claude:5h", 80, NOW - 1)]), "acct", NOW)).toBeUndefined();
	expect(usageLeft(usageOf([window("claude:5h", 80)], NOW - 2 * 3_600_000), "acct", NOW)).toBeUndefined();
	expect(usageLeft(usageOf([window("claude:5h", 80)]), "other", NOW)).toBeUndefined();
	expect(usageLeft("garbage", "acct", NOW)).toBeUndefined();
	const tight = grower(4 * M, { step: 4 * M, ceiling: 40 * M, usage: usageOf([window("claude:5h", 80)]) });
	tight.turn(3 * M);
	expect(tight.growth.cap()).toBe(6 * M);
	const unreadable = grower(4 * M, { step: 4 * M, ceiling: 40 * M });
	unreadable.turn(3 * M);
	expect(unreadable.growth.cap()).toBe(8 * M);
	const stale = grower(4 * M, { step: 4 * M, ceiling: 40 * M, usage: usageOf([window("claude:5h", 95)], NOW - 5 * 3_600_000) });
	stale.turn(3 * M);
	expect(stale.growth.cap()).toBe(8 * M);
});

test("headroom never ends a worker: with the window nearly used up the cap still grows by the smallest step", () => {
	const w = grower(4 * M, { step: 4 * M, ceiling: 40 * M, usage: usageOf([window("claude:5h", 99)]) });
	w.turn(3 * M);
	expect(w.growth.cap()).toBe(5 * M);
	expect(w.call()).toBeUndefined();
});

test("switched off, the fixed cap behaves as before: warning at 75%, block at the cap, no probe, no extra hooks", () => {
	const w = grower(4 * M, { enabled: false });
	w.prompt("Brief.\nEstimate: 30%");
	w.turn(3 * M);
	expect(w.probe.reads + w.probe.marks).toBe(0);
	expect(w.texts()).toHaveLength(1);
	expect(w.texts()[0]).toContain("write a handoff file");
	expect(w.texts()[0]).not.toContain("[dotz cap]");
	expect(w.handlers.before_agent_start).toBeUndefined();
	w.turn(900_000);
	expect(w.call()).toBeUndefined();
	w.turn(100_000);
	const blocked = w.call();
	expect(blocked.block).toBe(true);
	expect(blocked.reason).toBe(capReason(4 * M, 4 * M, 3, handoffPath({ sessionManager: { getSessionId: () => "sess-1" } })));
	expect(w.probe.reads + w.probe.marks).toBe(0);
});

test("a cap of 0 stays no cap with growth on", () => {
	const w = grower(0);
	expect(w.handlers.tool_call).toBeUndefined();
	w.turn(50 * M);
	expect(w.sent).toEqual([]);
});

test("judge: a commit, three changed files or two finished todos move; spinning marks veto", () => {
	const base = { commits: 0, files: 0, done: 0, calls: 10, repeats: 0, idle: 0 };
	expect(judge({ ...base, commits: 1 }).progress).toBe(true);
	expect(judge({ ...base, files: 3 }).progress).toBe(true);
	expect(judge({ ...base, done: 2 }).progress).toBe(true);
	expect(judge({ ...base, files: 2, done: 1 }).progress).toBe(false);
	expect(judge({ ...base, files: 5, repeats: 6 }).progress).toBe(false);
	expect(judge({ ...base, files: 5, idle: 40 }).progress).toBe(false);
});

test("git reading: commits and changed paths between two marks; not a repository reads as nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-cap-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, timeout: 10_000, stdio: "ignore" });
	expect(readGit(dir)).toBeUndefined();
	git("init", "-q");
	writeFileSync(join(dir, "a.txt"), "a");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	const before = readGit(dir);
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "b.txt"), "b");
	writeFileSync(join(dir, "a.txt"), "changed");
	expect(gitDelta(dir, before, readGit(dir))).toEqual({ commits: 0, changed: ["a.txt", "sub/"] });
	git("add", ".");
	git("commit", "-q", "-m", "second");
	expect(gitDelta(dir, before, readGit(dir))).toEqual({ commits: 1, changed: [] });
	expect(gitDelta(dir, undefined, readGit(dir))).toBeUndefined();
});
