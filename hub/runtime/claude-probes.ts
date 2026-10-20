// Compatibility probes of the Claude Code runtime (see verify.ts for how the runtime menu runs them): each one starts a
// real `claude` process through the adapter in a temp cwd on a cheap model and checks one thing the hub relies on.
// A probe that cannot run here answers `unsupported`/`disabled` with the reason instead of a guess.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentProcess, RuntimeAdapter } from "./types.ts";
import type { CheckResult, ProbeCtx } from "./verify.ts";

export type ProbeOutcome = { result: CheckResult; note: string };
export type Probes = Record<string, (ctx: ProbeCtx) => Promise<ProbeOutcome>>;
export type ProbeStart = (o?: { model?: string; resume?: string; env?: Record<string, string>; fallback?: string[] }) => Run;

const fail = (note: string): ProbeOutcome => ({ result: "fail", note });
const ok = (note: string): ProbeOutcome => ({ result: "ok", note });

// Real probe processes cost a paid session each (2026-10-20: 197 throwaway sessions, $11.4, most from probe scripts run
// by hand and repeated runtime checks). They start only inside a check the owner asked for (verifyRuntime with real) or
// a deliberate end-to-end run (DOTZ_E2E=1); anything else gets an error before a process exists.
let realDepth = 0;
export const realProbesAllowed = (): boolean => realDepth > 0 || process.env.DOTZ_E2E === "1";
export async function withRealProbes<T>(fn: () => Promise<T>): Promise<T> {
	realDepth++;
	try {
		return await fn();
	} finally {
		realDepth--;
	}
}

// One probe process with everything it emitted, so a probe can wait for an event after the moment it sent something.
export class Run {
	readonly events: AgentEvent[] = [];
	readonly proc: AgentProcess;
	private waiters: { pred: (e: AgentEvent) => boolean; from: number; resolve: (e: AgentEvent | undefined) => void }[] = [];
	private closed = false;
	constructor(adapter: RuntimeAdapter, ctx: ProbeCtx, id: string, o: { model: string; resume?: string; env?: Record<string, string>; fallback?: string[] }) {
		if (!realProbesAllowed()) throw new Error("real runtime probes start only in a requested runtime check (POST /api/runtimes/<id>/verify {real:true}) or with DOTZ_E2E=1");
		this.proc = adapter.start({
			role: "lane",
			cwd: ctx.cwd,
			model: o.model,
			resume: o.resume,
			fallback: o.fallback,
			env: o.env ?? {},
			lane: { name: "probe", dir: join(ctx.cwd, `.dotz-probe-${id}`), workerModel: o.model, compactAt: 100_000, keepRecent: 10_000 },
		});
		void (async () => {
			for await (const ev of this.proc.events) {
				this.events.push(ev);
				this.waiters = this.waiters.filter(w => {
					const hit = this.events.slice(w.from).find(w.pred);
					if (hit) w.resolve(hit);
					return !hit;
				});
			}
			this.closed = true;
			for (const w of this.waiters) w.resolve(undefined);
			this.waiters = [];
		})();
	}
	waitFor(pred: (e: AgentEvent) => boolean, ms: number, from = 0): Promise<AgentEvent | undefined> {
		const hit = this.events.slice(from).find(pred);
		if (hit || this.closed) return Promise.resolve(hit);
		const { promise, resolve } = Promise.withResolvers<AgentEvent | undefined>();
		const timer = setTimeout(() => resolve(undefined), ms);
		this.waiters.push({ pred, from, resolve: e => (clearTimeout(timer), resolve(e)) });
		return promise;
	}
	// Sends a prompt and returns what the turn emitted; throws when the turn does not end in time.
	async turn(text: string, ms: number): Promise<AgentEvent[]> {
		const from = this.events.length;
		this.proc.send(text, "prompt");
		if (!(await this.waitFor(e => e.type === "turn_end", ms, from))) throw new Error(`no turn_end within ${Math.round(ms / 1000)}s for "${text.slice(0, 40)}"`);
		return this.events.slice(from);
	}
	async session(ms: number): Promise<string | undefined> {
		const ev = await this.waitFor(e => e.type === "session", ms);
		return ev?.type === "session" ? ev.ref : undefined;
	}
	async close(): Promise<void> {
		this.proc.kill();
		const gone = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
		if (!gone) this.proc.kill(true);
	}
}

const answerOf = (events: AgentEvent[]): string => [...events].reverse().find(e => e.type === "assistant" && e.stop === "stop")?.text ?? "";
const toolResults = (events: AgentEvent[]) => events.flatMap(e => (e.type === "activity" && e.row.type === "tool_result" ? [e.row] : []));
const toolCalls = (events: AgentEvent[]) => events.flatMap(e => (e.type === "activity" && e.row.type === "tool_call" ? [e.row] : []));

export function makeProbes(adapter: RuntimeAdapter): Probes {
	let n = 0;
	// Runs a probe body with a factory for tracked processes; every process is stopped afterwards, whatever happened.
	const probe = (body: (ctx: ProbeCtx, start: ProbeStart, ms: number) => Promise<ProbeOutcome>) => async (ctx: ProbeCtx): Promise<ProbeOutcome> => {
		const runs: Run[] = [];
		// A cheap model unless the caller already chose one; each wait is bounded by the caller's timeout.
		const cheap = /haiku/i.test(ctx.model) ? ctx.model : "haiku";
		const start: ProbeStart = (o = {}) => {
			const run = new Run(adapter, ctx, String(++n), { model: cheap, ...o });
			runs.push(run);
			return run;
		};
		try {
			return await body(ctx, start, Math.min(ctx.timeoutMs, 90_000));
		} catch (e) {
			return fail((e as Error).message);
		} finally {
			await Promise.all(runs.map(r => r.close()));
		}
	};

	return {
		turn: probe(async (ctx, start, ms) => {
			const run = start();
			const t0 = Date.now();
			const events = await run.turn("Reply with exactly the single word PONG and nothing else.", ms);
			const kinds = events.map(e => e.type);
			const answer = answerOf(events);
			if (!/PONG/i.test(answer)) return fail(`answer was not PONG: "${answer.slice(0, 80)}"`);
			for (const need of ["turn_start", "user", "assistant", "turn_end"]) if (!kinds.includes(need as AgentEvent["type"])) return fail(`no ${need} event`);
			if (kinds.indexOf("turn_start") > kinds.indexOf("turn_end")) return fail("turn_end before turn_start");
			ctx.log(`turn answered in ${Date.now() - t0}ms`);
			return ok(`prompt -> turn_start, user, assistant(stop) "${answer.slice(0, 20)}", turn_end in ${((Date.now() - t0) / 1000).toFixed(1)}s${kinds.includes("session") ? ", session ref" : ""}`);
		}),

		model_effort: probe(async (_ctx, start, ms) => {
			const levels = ["low", "max"];
			const results = await Promise.all(
				levels.map(async level => {
					const run = start({ model: `haiku:${level}` });
					const events = await run.turn("Reply with exactly the single word PONG and nothing else.", ms);
					const err = events.find(e => e.type === "assistant" && e.stop === "error");
					return { level, answer: answerOf(events), err: err?.type === "assistant" && err.stop === "error" ? err.error.text : undefined };
				}),
			);
			const bad = results.find(r => r.err || !/PONG/i.test(r.answer));
			if (bad) return fail(`--effort ${bad.level} did not run a normal turn: ${bad.err ?? bad.answer.slice(0, 80)}`);
			return { result: "adapted", note: `model id (provider prefix stripped) and thinking -> --effort (${levels.join(" and ")} ran normal turns; medium/high/xhigh pass through); off/minimal run as low, auto keeps the CLI default` };
		}),

		resume: probe(async (_ctx, start, ms) => {
			const first = start();
			await first.turn("Remember this code word: TANGERINE-42. Reply with OK only.", ms);
			const ref = await first.session(2000);
			if (!ref) return fail("no session ref after the first turn");
			await first.close();
			const second = start({ resume: ref });
			const events = await second.turn("What was the code word I told you? Reply with the word only.", ms);
			const answer = answerOf(events);
			return /TANGERINE-42/i.test(answer) ? ok(`resumed session ${ref.slice(0, 8)}…, remembered the code word`) : fail(`resumed session did not remember: "${answer.slice(0, 80)}"`);
		}),

		handover: probe(async (_ctx, start, ms) => {
			const run = start();
			await run.turn("Reply with exactly the single word HANDOVER-CHECK and nothing else.", ms);
			const ref = await run.session(2000);
			if (!ref) return fail("no session ref");
			// The CLI writes the session file a moment after the turn ends.
			for (let i = 0; i < 10; i++) {
				const text = adapter.recentExchanges(ref);
				if (text?.includes("HANDOVER-CHECK")) return ok(`recentExchanges read the saved session (${text.length} chars: IN/YOU lines)`);
				await Bun.sleep(500);
			}
			return fail(`recentExchanges(${ref.slice(0, 8)}…) did not return the exchange`);
		}),

		compaction_events: probe(async (_ctx, start, ms) => {
			const run = start();
			await run.turn("Reply with exactly the single word hi.", ms);
			const from = run.events.length;
			run.proc.compact();
			const done = await run.waitFor(e => e.type === "compaction", ms, from);
			if (!done || done.type !== "compaction") return fail("no compaction event after compact()");
			if (done.state !== "done") return fail(`compaction failed: ${done.error}`);
			await Bun.sleep(300);
			if (run.events.slice(from).some(e => e.type === "turn_start")) return fail("a requested compaction was reported as a turn");
			const after = await run.turn("Reply with exactly the single word PONG and nothing else.", ms);
			return /PONG/i.test(answerOf(after)) ? ok(`/compact -> compaction done${done.tokensBefore ? ` (was ${done.tokensBefore} tokens)` : ""}; the session kept working`) : fail("turn after compaction did not answer");
		}),

		usage_report: probe(async (ctx, start, ms) => {
			const run = start();
			await run.turn("Reply with exactly the single word PONG and nothing else.", ms);
			const from = run.events.length;
			run.proc.refreshUsage();
			const hit = await run.waitFor(e => e.type === "usage" && e.tokens !== undefined && e.window !== undefined, 15_000, from);
			if (!hit || hit.type !== "usage") return fail("refreshUsage() was not answered with tokens and window");
			if (!hit.tokens || !hit.window) return fail(`implausible numbers: ${hit.tokens}/${hit.window}`);
			ctx.log(`usage ${hit.tokens}/${hit.window}`);
			return ok(`context ${hit.tokens} / ${hit.window} tokens (get_context_usage), plus per-message usage`);
		}),

		deny_lines: probe(async (ctx, start, ms) => {
			const dataDir = join(ctx.cwd, ".dotz-probe-data");
			mkdirSync(dataDir, { recursive: true });
			writeFileSync(join(dataDir, "RULES.md"), "## Blocked commands\n- deny: echo\\s+DOTZ-DENY-PROBE | probe rule, this command is refused\n");
			const run = start({ env: { DOTZ_DIR: dataDir } });
			const blocked = await run.turn("Run exactly this bash command and tell me its output: echo DOTZ-DENY-PROBE-1", ms);
			const call = toolCalls(blocked).find(c => /DOTZ-DENY-PROBE-1/.test(c.args ?? ""));
			if (!call) return fail("the model never attempted the command; nothing to block");
			const result = toolResults(blocked).find(r => r.call_id === call.call_id);
			if (!result?.is_error || !/probe rule/.test(result.text)) return fail(`the command was not blocked: ${result?.text.slice(0, 100) ?? "no result"}`);
			const allowed = await run.turn("Run exactly this bash command and tell me its output: echo allowed-ok", ms);
			const fine = toolResults(allowed).find(r => /allowed-ok/.test(r.text) && !r.is_error);
			if (!fine) return fail("a command no rule matches did not run either");
			return ok(`blocked: "${result.text.replace(/\s+/g, " ").slice(-110)}"; a non-matching command ran`);
		}),

		tool_intent: probe(async (_ctx, start, ms) => {
			const run = start();
			const events = await run.turn("Run exactly this bash command with the Bash tool and tell me its output: echo intent-probe", ms);
			const call = toolCalls(events).find(c => c.tool === "Bash");
			if (!call) return fail("no Bash tool_call row");
			if (!call.intent) return fail("the tool_call row has no intent");
			const result = toolResults(events).find(r => r.call_id === call.call_id);
			if (!result || !/intent-probe/.test(result.text)) return fail("no tool_result row paired with the call");
			return ok(`tool_call Bash intent "${call.intent}" (Bash description), tool_result paired by id`);
		}),

		steer_abort: probe(async (_ctx, start, ms) => {
			const run = start();
			const from = run.events.length;
			run.proc.send("Run this bash command with the Bash tool: sleep 10; echo slept. Then reply with the single word done.", "prompt");
			if (!(await run.waitFor(e => e.type === "activity" && e.row.type === "tool_call", 30_000, from))) return fail("the model never started the command");
			run.proc.send("Also: end your final answer with the word STEERED.", "steer");
			if (!(await run.waitFor(e => e.type === "turn_end", ms, from))) return fail("steered turn did not end");
			const steered = /STEERED/i.test(answerOf(run.events.slice(from)));
			const at = run.events.length;
			run.proc.send("Run this bash command with the Bash tool: sleep 60. Then say done.", "prompt");
			if (!(await run.waitFor(e => e.type === "activity" && e.row.type === "tool_call", 30_000, at))) return fail("the model never started the long command");
			await Bun.sleep(2000);
			run.proc.abort();
			const aborted = await run.waitFor(e => e.type === "assistant" && e.stop === "aborted", 15_000, at);
			if (!aborted) return fail(`abort() did not end the turn as aborted${steered ? "" : "; steer was not honored either"}`);
			await run.waitFor(e => e.type === "turn_end", 5000, at);
			const after = await run.turn("Reply with exactly the single word PONG and nothing else.", ms);
			if (!/PONG/i.test(answerOf(after))) return fail("the session did not answer after abort()");
			if (!steered) return fail("a message sent mid-turn was not injected into the running turn");
			return ok("steer: mid-turn message injected at the next tool boundary; abort(): control_request interrupt -> assistant(aborted), session usable afterwards");
		}),

		workers_spawn: probe(async (_ctx, start, ms) => {
			const run = start();
			const events = await run.turn("Use the Agent tool to spawn one subagent that runs the bash command `echo from-worker` and reports the output. Then reply with the single word done.", Math.max(ms, 60_000));
			const updates = events.flatMap(e => (e.type === "subagent" ? [e.update] : []));
			if (!updates.length) return fail("no task worker was reported (the Agent tool was not used)");
			const last = updates.at(-1)!;
			return { result: "adapted", note: `built-in Agent tool: worker reported live (${updates.length} updates, last "${last.status}"); the worker model is picked by the model per call (lanes.worker_model cannot be pinned); no orchestrator-guard brief rules, no worker fallback chain` };
		}),

		workers_isolated_patch: async () => ({ result: "unsupported", note: "isolated worker worktrees that return a reviewable .patch (omp task isolation + orchestrator-guard merge summary) have no equivalent; Claude Code workers edit the working tree directly" }),
		guard_extension: async () => ({ result: "unsupported", note: "orchestrator-guard is an omp extension (brief limits, quota gate, external-action stops); Claude Code cannot load it. Only the RULES.md Bash deny lines are enforced here (see deny_lines)" }),
		dotz_tools: async () => ({ result: "unsupported", note: "dotz_send / dotz_lane / dotz_schedule / dotz_auth are tools of the omp dotz extension; this adapter registers no replacement (it would need an MCP server)" }),

		fallback_chain: probe(async (_ctx, start, ms) => {
			const run = start({ model: "bogus-model-x", fallback: ["haiku"] });
			const events = await run.turn("Reply with exactly the single word PONG and nothing else.", ms);
			const switched = events.find(e => e.type === "fallback");
			if (!switched || switched.type !== "fallback") return fail("an unavailable primary model did not fall back to the next model");
			if (!/PONG/i.test(answerOf(events))) return fail("the fallback model did not answer");
			return { result: "adapted", note: `--fallback-model: ${switched.from} -> ${switched.to} (${switched.reason ?? "unavailable"}) reported as a fallback event; the CLI only falls back on an unavailable/overloaded model, rate limits and quota stops are left to the hub's retry policy` };
		}),
	};
}
