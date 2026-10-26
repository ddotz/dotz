// The one-shot model calls of dotz (reply drafts, translations, summaries) and the provider readiness check in front of them.
//
// Every call used to spawn its own `omo -p --mode json ...` and pay the CLI's start and session setup each time (measured
// 2026-10-26: a trivial prompt on anthropic/claude-sonnet-5-5 took 6.5 s end to end, almost all of it startup). This module
// keeps that cost once: a warm `omo --mode rpc` process per model + system prompt + pinned account (a process's system
// prompt and account are fixed at launch), started lazily, answering one `prompt` frame per call and resetting its session
// afterwards so two calls never see each other's context. A process answers one call at a time: a second call of the same
// shape at the same moment gets its own process while the pool has room. The pool is capped, idle-killed, restarted after a
// crash, and a caller falls back to the one-shot spawn path when no warm process can be started or all are busy.
//
// A draft also used to sit up to 120 s on a Claude subscription whose 5-hour window was already spent (the provider is not
// ready, so the request waits and then fails). Before starting anything the selected subscription account is checked
// against what OmO itself records (auth.json accounts, credential-pool-state.json blocks, subscription-usage.json windows),
// cached for 30 s; when no account is usable the call fails at once with the reset time, or moves to another account the
// owner has logged in and that is not spent. The subscription-only rule stays: an API key is never a fallback here.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PIN_ENV } from "./account-sticky.ts";
import { withoutApiKeys } from "./apikey-policy.ts";
import { blockOf, subscriptionAccount } from "./usage-account.ts";
import { cfg, DATA_DIR, log, TZ } from "./config.ts";
import { OMO, recordStarted } from "./runtime/omo-hosts.ts";

export type Reply = { text: string; inputTokens: number; outputTokens: number; ms: number; firstTokenMs?: number };

// Tests swap `spawn` for a fake `omo`; nothing else starts a process.
export const runnerDeps = {
	spawn: (argv: string[], o: { cwd: string; env: Record<string, string | undefined> }) => Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" }),
	now: () => Date.now(),
	// A draft process that has been quiet this long is stopped; the next call starts a fresh one.
	idleMs: 10 * 60_000,
	// keyed by model + system prompt + account: mail and the three kakao prompt shapes stay warm side by side.
	maxRunners: 3,
};

// ---------------------------------------------------------------------------------------------------------------
// Provider readiness: is the subscription the selected model runs on usable now, and which account is it on?

type Json = Record<string, any>;
const readJson = (file: string): Json | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

const agentDir = () => process.env.OMO_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".omo", "agent");
const authPath = () => join(agentDir(), "auth.json");

// What the owner sees: the clock of their own timezone ("오전 1:20").
export function resetClock(ms: number, timeZone = TZ): string {
	try {
		return new Intl.DateTimeFormat("ko-KR", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms));
	} catch {
		return new Date(ms).toISOString().slice(11, 16);
	}
}

export type Health = { ok: true; account?: string } | { ok: false; reason: string };

const HEALTH_TTL_MS = 30_000;
let healthCache: { key: string; at: number; value: Health } | undefined;
export const resetHealthForTest = (): void => invalidateHealth();
export function invalidateHealth(): void {
	healthCache = undefined;
}

type Blocked = { until?: number; reason: string };

// OmO's records for one subscription account: a block (auth.json entry and/or its pool slot) or a spent usage window.
function blockedAt(account: Json, slot: Json | undefined, usage: Json | undefined, now: number): Blocked | undefined {
	const block = blockOf(account, slot, now);
	if (block) return block;
	const windows: Json[] = Array.isArray(usage?.windows) ? usage.windows : [];
	let until: number | undefined;
	for (const w of windows) {
		const used = typeof w?.usedPercent === "number" ? w.usedPercent : 0;
		if (used < 100) continue;
		const resets = typeof w?.resetsAt === "string" ? Date.parse(w.resetsAt) : Number.NaN;
		// A window whose reset already passed is over, whatever the last sample said.
		if (Number.isNaN(resets) || resets <= now) continue;
		until = until === undefined ? resets : Math.min(until, resets);
	}
	return until === undefined ? undefined : { until, reason: "limit" };
}

// Pure: the subscription account to run on now. The one OmO would use first when it is usable; otherwise another logged-in
// account that is neither blocked nor spent. Nothing usable: the earliest reset time, so the owner knows when to try again.
export function subscriptionHealth(now = Date.now(), file = authPath()): { account?: string; resetAt?: number; reason?: string } {
	const sub = readJson(file)?.["anthropic-subscription"];
	const accounts: Json[] = Array.isArray(sub?.accounts) ? sub.accounts.filter((a: Json) => typeof a?.name === "string" && typeof a?.access === "string" && a.access) : [];
	if (!accounts.length) return { reason: "구독 로그인이 없어요 · OmO에서 Claude 구독으로 로그인해 주세요" };
	const slots: Json = readJson(join(agentDir(), "credential-pool-state.json"))?.providers?.["anthropic-subscription"]?.lanes?.stored?.slots ?? {};
	const usage: Json = readJson(join(agentDir(), "subscription-usage.json"))?.accounts ?? {};
	const stateOf = (name: string) => blockedAt(accounts.find(a => a.name === name), slots[name], usage[`anthropic-subscription/${name}`], now);
	const first = subscriptionAccount(file, now);
	const rest = accounts
		.map(a => a.name as string)
		.filter(n => n !== first?.name)
		.sort((a, b) => Number(slots[b]?.lastSuccessAt ?? 0) - Number(slots[a]?.lastSuccessAt ?? 0));
	let resetAt: number | undefined;
	let authBlocked = false;
	for (const name of [...(first ? [first.name] : []), ...rest]) {
		const blocked = stateOf(name);
		if (!blocked) return { account: name };
		if (blocked.until !== undefined) resetAt = resetAt === undefined ? blocked.until : Math.min(resetAt, blocked.until);
		else authBlocked = true;
	}
	if (resetAt !== undefined) return { resetAt, reason: `구독 한도에 걸렸어요 · ${resetClock(resetAt)}에 풀려요` };
	return { reason: authBlocked ? "구독 계정을 지금 쓸 수 없어요 · OmO에서 다시 로그인해 주세요" : "구독 계정을 지금 쓸 수 없어요 · OmO에서 계정 상태를 확인해 주세요" };
}

// Is `model` (an OmO selector) runnable now? Only a Claude subscription model is gated; anything else is left to the
// runtime. Cached for 30 s so a burst of drafts reads the state files once.
export function ensureProvider(model: string, now = runnerDeps.now()): void {
	if (!model.startsWith("anthropic-subscription/")) return;
	const key = `${agentDir()}|${model}`;
	if (healthCache && healthCache.key === key && now - healthCache.at < HEALTH_TTL_MS) {
		if (healthCache.value.ok === false) throw new Error(healthCache.value.reason);
		return;
	}
	const h = subscriptionHealth(now);
	const value: Health = h.account ? { ok: true, account: h.account } : { ok: false, reason: h.reason ?? "구독 계정을 지금 쓸 수 없어요" };
	healthCache = { key, at: now, value };
	if (!value.ok) throw new Error(value.reason);
}

// The account a warm process (or one call) should pin, as the readiness check just chose it.
export function readyAccount(now = runnerDeps.now()): string | undefined {
	if (!healthCache || now - healthCache.at >= HEALTH_TTL_MS) return subscriptionHealth(now).account;
	return healthCache.value.ok ? healthCache.value.account : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The warm process.

export { PIN_ENV };

// The rpc form of outlang.ts modelArgv: same limits (no tools, skills, extensions, context files, memory, fallback), but
// long-lived and fed prompts over stdin.
export function warmArgv(system: string, model: string, thinking: string): string[] {
	return [OMO, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--omo-senpi-memory-disabled", "--no-model-fallback", "--thinking", thinking, "--model", model, "--system-prompt", system];
}

type Frame = { type?: string; id?: string; command?: string; success?: boolean; message?: Json; assistantMessageEvent?: { type?: string }; errorMessage?: string; [k: string]: unknown };
const isTextEvent = (f: Frame) => /^(text|thinking)_(start|delta)$/.test(String(f.assistantMessageEvent?.type ?? ""));
const textOf = (m: Json): string => (Array.isArray(m?.content) ? m.content.filter((b: Json) => b?.type === "text").map((b: Json) => b.text ?? "").join("") : "").trim();

class WarmRunner {
	private buf = "";
	private seq = 0;
	private pending?: { frame: (f: Frame) => boolean; fail: (e: Error) => void };
	// Calls handed to this process and not settled yet (counted when handed out, so two callers never pick the same idle process).
	private inUse = 0;
	get busy(): boolean {
		return this.inUse > 0;
	}
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	// Any prompt written to a dead process must not be trusted, so liveness is the process' own exit code, not a flag the
	// exit callback sets a tick later.
	get alive(): boolean {
		return !this.stopped && this.proc?.exitCode === null;
	}
	lastUsed = runnerDeps.now();
	private readonly proc: any;
	private readonly exited: Promise<number>;

	constructor(readonly key: string, readonly shape: string, readonly model: string, readonly system: string, private readonly thinking: string, readonly account?: string) {
		this.proc = runnerDeps.spawn(warmArgv(system, model, thinking), {
			cwd: DATA_DIR,
			env: withoutApiKeys({ ...process.env, PI_CACHE_RETENTION: "long", ...(account ? { [PIN_ENV]: account } : {}) }),
		});
		recordStarted(this.proc.pid);
		this.exited = this.proc.exited;
		void this.exited.then(code => {
			pool.delete(this);
			this.pending?.fail(new Error(`warm model process exited ${code}`));
		});
		this.read();
		this.armIdle();
	}

	private async read(): Promise<void> {
		const dec = new TextDecoder();
		try {
			for await (const chunk of this.proc.stdout) {
				this.buf += dec.decode(chunk as Uint8Array, { stream: true });
				for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
					const line = this.buf.slice(0, i).trim();
					this.buf = this.buf.slice(i + 1);
					if (!line.startsWith("{")) continue;
					let f: Frame;
					try {
						f = JSON.parse(line);
					} catch {
						continue;
					}
					if (this.pending?.frame(f)) this.pending = undefined;
				}
			}
		} catch {
			// the process went away; `exited` reports it
		}
	}

	private write(frame: Json): void {
		try {
			this.proc.stdin.write(`${JSON.stringify({ id: `d-${++this.seq}`, ...frame })}\n`);
			void this.proc.stdin.flush();
		} catch {
			// stdin closed: the process is exiting and `exited` fails the pending call
		}
	}

	private armIdle(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			if (this.busy) return this.armIdle();
			this.stop();
		}, runnerDeps.idleMs);
		this.timer.unref?.();
	}

	// The process' own exit, for a test that must know a crash happened before the next call.
	whenExited(): Promise<number> {
		return this.exited;
	}

	// A gateway that exits must leave no warm process behind, and an exit handler cannot wait for a rejection to settle.
	killNow(): void {
		this.stopped = true;
		try {
			this.proc.kill();
		} catch {}
	}

	stop(): void {
		this.stopped = true;
		pool.delete(this);
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.pending?.fail(new Error("warm model process stopped"));
		this.pending = undefined;
		try {
			this.proc.kill();
		} catch {}
	}

	// One prompt on this process, after the turn before it (prompt frames are processed in order). The session is reset
	// once the answer is in, so the next prompt starts from the system prompt alone.
	call(text: string, timeoutMs: number): Promise<Reply> {
		this.lastUsed = runnerDeps.now();
		this.armIdle();
		this.inUse++;
		const job = this.queue.then(() => this.turn(text, timeoutMs));
		const done = () => {
			this.inUse--;
			this.lastUsed = runnerDeps.now();
		};
		this.queue = job.then(done, done);
		return job;
	}
	private queue: Promise<unknown> = Promise.resolve();

	private turn(text: string, timeoutMs: number): Promise<Reply> {
		if (!this.alive) return Promise.reject(new Error("warm model process is not running"));
		const started = runnerDeps.now();
		// The clock of the caller (Date.now in the hub, the fake clock in tests) keeps one bound for both.
		return new Promise<Reply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending = undefined;
				this.stop();
				reject(new Error(`model call timed out after ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			let firstTokenMs: number | undefined;
			const settle = (fn: () => void) => {
				clearTimeout(timer);
				this.write({ type: "new_session" });
				fn();
				return true;
			};
			this.pending = {
				fail: e => {
					clearTimeout(timer);
					reject(e);
				},
				frame: f => {
					if (f.type === "message_update" && firstTokenMs === undefined && isTextEvent(f)) firstTokenMs = runnerDeps.now() - started;
					if (f.type !== "message_end" || f.message?.role !== "assistant") return false;
					const m = f.message;
					if (m.stopReason === "error") return settle(() => reject(new Error(String(m.errorMessage || "model call failed"))));
					const out = textOf(m);
					if (!out) return settle(() => reject(new Error("empty reply")));
					const u = m.usage ?? {};
					return settle(() => resolve({ text: out, inputTokens: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), outputTokens: u.output ?? 0, ms: runnerDeps.now() - started, ...(firstTokenMs !== undefined ? { firstTokenMs } : {}) }));
				},
			};
			this.write({ type: "prompt", message: text });
		});
	}
}

const pool = new Set<WarmRunner>();

process.on("exit", () => {
	for (const r of pool) r.killNow();
});

export function resetRunnersForTest(): void {
	for (const r of [...pool]) r.stop();
	pool.clear();
}

export function runnerCountForTest(): number {
	return [...pool].filter(r => r.alive).length;
}

export function lastRunnerForTest(): { whenExited: () => Promise<number> } | undefined {
	return [...pool].at(-1);
}

// The errors of a spent or refused subscription: the process stays pinned to that account, so it is stopped (the next call
// starts on the account the readiness check moves to).
const SPENT = /limit|quota|429|\brate|blocked|not_ready|구독/i;

// The least recently used idle runner is stopped to make room; a busy one is never stopped (that would fail its call).
// Returns false when every runner is busy.
function evictOne(): boolean {
	const idle = [...pool].filter(r => !r.busy).sort((a, b) => a.lastUsed - b.lastUsed);
	idle[0]?.stop();
	return idle.length > 0;
}

// One call on a warm process, started on first use and reused afterwards. Throws when no warm process can answer; the
// caller then takes the one-shot spawn path.
export async function callWarm(system: string, text: string, opts: { model: string; thinking?: string; timeoutMs: number; account?: string }): Promise<Reply> {
	const thinking = opts.thinking ?? "off";
	const shape = `${opts.model}\u0000${thinking}\u0000${system}`;
	const key = `${shape}\u0000${opts.account ?? ""}`;
	for (const r of [...pool]) if (!r.alive) pool.delete(r);
	let warm = [...pool].find(r => r.key === key && !r.busy);
	const reused = warm !== undefined;
	if (!warm) warm = start(key, shape, opts, system, thinking);
	try {
		return await warm.call(text, opts.timeoutMs);
	} catch (e) {
		const why = (e as Error).message;
		if (SPENT.test(why)) {
			warm.stop();
			throw e;
		}
		// A warm process that died between the pool check and the prompt is replaced once; the prompt is idempotent. A
		// runner that never started is left to the caller (the one-shot path), which is the faster way out.
		if (!reused || !/not running|exited/.test(why)) throw e;
		pool.delete(warm);
		return start(key, shape, opts, system, thinking).call(text, opts.timeoutMs);
	}
}

function start(key: string, shape: string, opts: { model: string; account?: string }, system: string, thinking: string): WarmRunner {
	// A process of the same shape pinned to another account is left from before the readiness check moved accounts: stopped
	// once idle, it would only hold a slot.
	for (const r of [...pool]) if (r.shape === shape && r.key !== key && !r.busy) r.stop();
	if (pool.size >= runnerDeps.maxRunners && !evictOne()) throw new Error("warm model processes are all busy");
	const warm = new WarmRunner(key, shape, opts.model, system, thinking, opts.account);
	pool.add(warm);
	return warm;
}
