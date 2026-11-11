// Progress-based growth of the task token cap (wired in by task-cap.ts; no model call anywhere in here).
// A checkpoint sits at WARN_AT of the cap and again a quarter of the base cap before every grown cap. At a checkpoint the engine asks for a
// verdict on the work since the last checkpoint: progress (a commit, changed files or finished todo items, without the
// spinning marks: mostly repeated calls, or a long run of calls without a write) grows the cap by one step, up to the ceiling,
// and the handoff steer waits (a worker that is getting somewhere is not told to wrap up; the steer is sent at the first
// checkpoint without progress, or when the ceiling leaves no room to grow). No progress is today's behaviour: warning, then the
// block at the cap, where the verdict is asked one last time. A revived worker (a follow-up after its final answer) starts a
// fresh allowance. The cap is measured per allowance, the ceiling too, so a runaway worker still ends.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadGuardConfig } from "./guard-config.ts";

export const WARN_AT = 0.75;
// Progress thresholds, picked with the 7-day replay of worker logs (see the report).
export interface Thresholds { commits: number; files: number; done: number; repeatShare: number; idle: number }
export const THRESHOLDS: Thresholds = { commits: 1, files: 3, done: 2, repeatShare: 0.5, idle: 40 };
// Checkpoints of a grown cap are never closer than this share of the base cap to the previous verdict.
const MIN_GAP = 0.1;
export const MIN_STEP = 1_000_000;
export const EST_ANCHOR_PERCENT = 15;
export const EST_FLOOR = 4_000_000;
const M = (n: number) => `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;

export interface Signals { commits: number; files: number; done: number; calls: number; repeats: number; idle: number }
export interface Verdict { progress: boolean; signal: string }
export type CapEvent =
	| { kind: "warn"; spent: number; cap: number; signal: string; ceiling: boolean }
	| { kind: "grow"; spent: number; from: number; to: number; signal: string }
	| { kind: "stop"; spent: number; cap: number; signal: string };

const share = (s: Signals) => (s.calls > 0 ? s.repeats / s.calls : 0);

export function judge(s: Signals, t: Thresholds = THRESHOLDS): Verdict {
	const signal = `${s.commits} commits, ${s.files} files, ${s.done} todo done, ${Math.round(share(s) * 100)}% repeated calls, ${s.idle} calls since the last write`;
	const moved = s.commits >= t.commits || s.files >= t.files || s.done >= t.done;
	return { progress: moved && share(s) <= t.repeatShare && s.idle < t.idle, signal };
}

const WRITE_HINT = /\bgit\s+(?:commit|add|apply|mv|rm)\b|\bsed\s+-i|>>?\s*[\w./~"'$-]|\btee\b|Bun\.write|writeFile|apply_patch|\bmkdir\b|\bmv\b|\bcp\b/;
const COMMIT_HINT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const commandOf = (input: any): string => (typeof input?.command === "string" ? input.command : typeof input?.code === "string" ? input.code : "");

// What one worker did since the last checkpoint, from its own tool calls (the git probe adds commits and changed paths at the checkpoint).
export class ProgressWindow {
	private seen = new Set<string>();
	private edited = new Set<string>();
	private commitHints = 0;
	private calls = 0;
	private repeats = 0;
	private done = 0;
	private idle = 0;

	note(name: string, input: any): void {
		const command = commandOf(input);
		const path = typeof input?.path === "string" ? input.path : "";
		const key = `${name}\0${name === "read" ? path : command || JSON.stringify(input ?? {}).slice(0, 300)}`;
		this.calls++;
		if (this.seen.has(key)) this.repeats++;
		this.seen.add(key);
		const commit = COMMIT_HINT.test(command);
		const wrote = (name === "edit" || name === "write") && path !== "";
		if (wrote) this.edited.add(path);
		const finished = name === "todo" && input?.op === "done";
		if (finished) this.done++;
		if (commit) this.commitHints++;
		if (wrote || finished || commit || WRITE_HINT.test(command)) this.idle = 0;
		else this.idle++;
	}

	snapshot(git?: GitDelta): Signals {
		const files = new Set([...this.edited, ...(git?.changed ?? [])]);
		return { commits: git ? git.commits : this.commitHints, files: files.size, done: this.done, calls: this.calls, repeats: this.repeats, idle: this.idle };
	}

	reset(): void {
		this.seen.clear();
		this.edited.clear();
		this.commitHints = this.calls = this.repeats = this.done = this.idle = 0;
	}
}

export interface GitDelta { commits: number; changed: string[] }
export interface GitState { head: string; dirty: Map<string, string> }

const runGit = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, timeout: 2000, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"] });

// Called at a checkpoint only. Not a git checkout, a timeout or any git failure is "no reading": the verdict then rests on the tool-call signals alone.
export function readGit(cwd: string): GitState | undefined {
	try {
		const dirty = new Map<string, string>();
		for (const line of runGit(cwd, ["status", "--porcelain=v1", "-z"]).split("\0")) if (line.length > 3) dirty.set(line.slice(3), line.slice(0, 2));
		return { head: runGit(cwd, ["rev-parse", "HEAD"]).trim(), dirty };
	} catch {
		// No repository, no git binary or a timeout: nothing to compare, the caller falls back to the tool-call signals.
		return undefined;
	}
}

export function gitDelta(cwd: string, before: GitState | undefined, after: GitState | undefined): GitDelta | undefined {
	if (!before || !after) return undefined;
	let commits = 0;
	if (before.head !== after.head) {
		try {
			commits = Number(runGit(cwd, ["rev-list", "--count", `${before.head}..${after.head}`]).trim()) || 1;
		} catch {
			// The old head is gone (rebase, reset): count the move as one commit.
			commits = 1;
		}
	}
	const changed = [...after.dirty].filter(([path, code]) => before.dirty.get(path) !== code).map(([path]) => path);
	return { commits, changed };
}

// The share of the allowance the work should start with: "Estimate: N%" (percent of the 5-hour window) of the brief, anchored so the
// default estimate gets the default cap, in whole millions, never under EST_FLOOR (or the default, when that is smaller) nor over the ceiling. No line: the default cap.
const ESTIMATE = /^\s*Estimate:\s*(\d+(?:\.\d+)?)\s*%?/im;
export const parseEstimate = (text: unknown): number | undefined => {
	const found = ESTIMATE.exec(typeof text === "string" ? text : "")?.[1];
	return found === undefined ? undefined : Number(found);
};
export function startingCap(estimate: number | undefined, fallback: number, ceiling: number): number {
	if (estimate === undefined || !(estimate > 0) || !Number.isFinite(estimate)) return fallback;
	const scaled = Math.round((fallback * estimate) / EST_ANCHOR_PERCENT / 1_000_000) * 1_000_000;
	return Math.min(Math.max(ceiling, fallback), Math.max(Math.min(EST_FLOOR, fallback), scaled));
}

// Share of the subscription windows still free, from OmO's last usage read (subscription-usage.json): the smallest "left" of the 5h and
// 7d windows of the account the worker runs on. Only a read younger than MAX_AGE_MS and a window that has not reset count.
const MAX_AGE_MS = 60 * 60 * 1000;
export function usageLeft(usage: any, account: string | undefined, now: number): number | undefined {
	const entry = account ? usage?.accounts?.[`anthropic-subscription/${account}`] : undefined;
	if (!entry || typeof entry.updatedAt !== "number" || now - entry.updatedAt > MAX_AGE_MS || !Array.isArray(entry.windows)) return undefined;
	const lefts = entry.windows
		.filter((w: any) => (w?.id === "claude:5h" || w?.id === "claude:7d") && typeof w.usedPercent === "number" && Date.parse(w.resetsAt) > now)
		.map((w: any) => 100 - Math.min(100, Math.max(0, w.usedPercent)));
	return lefts.length ? Math.min(...lefts) : undefined;
}

// The step shrinks when little room is left; it never grows and never goes under MIN_STEP (or under itself when that is smaller).
export function stepFor(step: number, left: number | undefined): number {
	if (left === undefined || !(left < 25)) return step;
	return Math.min(step, Math.max(MIN_STEP, Math.round(step / (left < 10 ? 4 : 2))));
}

export interface EngineOptions { base: number; grow: boolean; step: () => number; ceiling: number }

export function createCapEngine(o: EngineOptions) {
	let start = 0;
	let base = o.base;
	let cap = base;
	let armed = true;
	let warned = false;
	let stopped = false;
	let judgedAt = -1;
	const checkpoint = () => {
		const q = cap - base * (1 - WARN_AT);
		return judgedAt < 0 ? q : Math.max(q, judgedAt + base * MIN_GAP);
	};
	const decide = (rel: number, ask: () => Verdict, atCap: boolean): CapEvent | undefined => {
		const verdict = ask();
		judgedAt = rel;
		const step = o.step();
		const next = Math.min(cap + step * Math.max(1, Math.ceil((rel + 1 - cap) / step)), o.ceiling);
		if (verdict.progress && next > cap) {
			const from = cap;
			cap = next;
			armed = true;
			return { kind: "grow", spent: start + rel, from: start + from, to: start + next, signal: verdict.signal };
		}
		armed = false;
		if (atCap) {
			stopped = true;
			return { kind: "stop", spent: start + rel, cap: start + cap, signal: verdict.signal };
		}
		if (warned) return undefined;
		warned = true;
		return { kind: "warn", spent: start + rel, cap: start + cap, signal: verdict.signal, ceiling: verdict.progress };
	};
	return {
		cap: () => start + cap,
		// A tool turn ended with `spent` tokens in total.
		turn(spent: number, ask: () => Verdict): CapEvent | undefined {
			const rel = spent - start;
			if (rel >= cap || rel < checkpoint()) return undefined;
			if (!o.grow) {
				if (warned) return undefined;
				warned = true;
				return { kind: "warn", spent, cap: start + cap, signal: "", ceiling: false };
			}
			return armed ? decide(rel, ask, false) : undefined;
		},
		// A tool call came in: undefined lets it run (under the cap, or the cap just grew) or means the stop was already reported.
		atCap(spent: number, ask: () => Verdict): CapEvent | undefined {
			const rel = spent - start;
			if (rel < cap || stopped) return undefined;
			if (!o.grow) {
				stopped = true;
				return { kind: "stop", spent, cap: start + cap, signal: "" };
			}
			return decide(rel, ask, true);
		},
		isStopped: () => stopped,
		// A follow-up after the worker's final answer: a fresh allowance counted from here.
		revive(spent: number, newBase?: number): void {
			start = spent;
			if (newBase !== undefined) base = newBase;
			cap = base;
			armed = true;
			warned = false;
			stopped = false;
			judgedAt = -1;
		},
		setBase(newBase: number): void {
			base = cap = newBase;
		},
	};
}

export interface Probe { mark: () => void; delta: () => GitDelta | undefined }

// The git reading of a worker's checkout: mark() takes the baseline, delta() is what changed since the last mark and moves the baseline.
export function createGitProbe(cwd: string): Probe {
	let before: GitState | undefined;
	return {
		mark: () => void (before = readGit(cwd)),
		delta: () => {
			const after = readGit(cwd);
			const d = gitDelta(cwd, before, after);
			before = after ?? before;
			return d;
		},
	};
}

export interface GrowthConfig { enabled: boolean; step: number; ceiling: number }
export interface GrowthDeps { probe?: Probe; now?: () => number; readUsage?: () => unknown; account?: () => string | undefined; cwd?: string }

const usageFile = () => join(process.env.OMO_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".omo", "agent"), "subscription-usage.json");
const readUsageFile = (): unknown => {
	try {
		return JSON.parse(readFileSync(usageFile(), "utf8"));
	} catch {
		// No usage read on this machine: the step stays the default.
		return undefined;
	}
};

// Brief and follow-ups start with this when the harness, not the parent, wrote them (reminders, our own notes).
const HIDDEN_PROMPT = /^\s*(?:<system-reminder>|<omo-senpi|\[dotz\])/;

// One worker's growth state: the engine, the tool-call window and the lines for the parent. `base` is the configured cap.
export function createGrowth(base: number, cfg: GrowthConfig, deps: GrowthDeps = {}) {
	let probe = deps.probe;
	const win = new ProgressWindow();
	const lines: string[] = [];
	const now = deps.now ?? Date.now;
	const account = deps.account ?? (() => process.env.SENPI_CLAUDE_SDK_OAUTH_PINNED_ACCOUNT);
	const engine = createCapEngine({ base, grow: cfg.enabled, ceiling: cfg.ceiling, step: () => stepFor(cfg.step, usageLeft((deps.readUsage ?? readUsageFile)(), account(), now())) });
	const probeNow = () => (probe ??= createGitProbe(deps.cwd ?? process.cwd()));
	const ask = (): Verdict => {
		const verdict = judge(win.snapshot(probeNow().delta()));
		win.reset();
		return verdict;
	};
	const record = (e: CapEvent | undefined): CapEvent | undefined => {
		if (cfg.enabled && e?.kind === "grow") lines.push(growLine(e));
		if (cfg.enabled && e?.kind === "stop") lines.push(stopLine(e));
		return e;
	};
	let started = false;
	let answered = false;
	return {
		enabled: cfg.enabled,
		cap: () => engine.cap(),
		lines: () => [...lines],
		note: (name: string, input: unknown) => cfg.enabled && win.note(name, input),
		turn: (spent: number) => record(engine.turn(spent, ask)),
		atCap: (spent: number) => record(engine.atCap(spent, ask)),
		finished: () => void (answered = true),
		// A run is about to start with this prompt: the first one is the brief (its Estimate line sets the starting cap); a later one
		// after a final answer is a follow-up that gets a fresh allowance. Returns "revived" for the second.
		prompt(text: unknown, spent: number): "revived" | undefined {
			if (!cfg.enabled) return undefined;
			const prompt = typeof text === "string" ? text : "";
			const estimate = startingCap(parseEstimate(prompt), base, cfg.ceiling);
			if (!started) {
				started = true;
				engine.setBase(estimate);
				probeNow().mark();
				return undefined;
			}
			if (!answered || prompt.trim() === "" || HIDDEN_PROMPT.test(prompt)) return undefined;
			answered = false;
			engine.revive(spent, parseEstimate(prompt) === undefined ? undefined : estimate);
			win.reset();
			probeNow().mark();
			return "revived";
		},
	};
}

export type Growth = ReturnType<typeof createGrowth>;
export const growthFor = (base: number, g = loadGuardConfig()): Growth => createGrowth(base, { enabled: g.task_cap_grow, step: g.task_cap_step, ceiling: g.task_cap_ceiling });

export const growLine = (e: Extract<CapEvent, { kind: "grow" }>) => `[dotz cap] ${M(e.spent)} spent: cap ${M(e.from)} -> ${M(e.to)} (progress: ${e.signal})`;
export const stopLine = (e: Extract<CapEvent, { kind: "stop" }>) => `[dotz cap] stopped at ${M(e.spent)} of cap ${M(e.cap)}${e.signal ? ` (no progress: ${e.signal})` : ""}`;
