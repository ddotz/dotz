// Compatibility probes of the OmO runtime (verify.ts runs them from the runtime menu): each starts a real `omo --mode rpc`
// through the adapter in a temp cwd on a cheap model (Sonnet at low effort; Haiku is never used) and checks one thing the
// hub relies on. Every process a probe starts is stopped afterwards, and with it the rpc host OmO started for it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProbeOutcome, type Probes, type ProbeStart, Run } from "./claude-probes.ts";
import type { AgentEvent, RuntimeAdapter } from "./types.ts";
import type { ProbeCtx } from "./verify.ts";

const CHEAP = "anthropic/claude-sonnet-5-5:low";
const fail = (note: string): ProbeOutcome => ({ result: "fail", note });
const ok = (note: string): ProbeOutcome => ({ result: "ok", note });
const answerOf = (events: AgentEvent[]): string => [...events].reverse().find(e => e.type === "assistant" && e.stop === "stop")?.text ?? "";
const toolCalls = (events: AgentEvent[]) => events.flatMap(e => (e.type === "activity" && e.row.type === "tool_call" ? [e.row] : []));
const toolResults = (events: AgentEvent[]) => events.flatMap(e => (e.type === "activity" && e.row.type === "tool_result" ? [e.row] : []));
const PONG = "Reply with exactly the single word PONG and nothing else.";
// OmO has no bash tool: shell commands run in `eval` cells.
const isShell = (tool?: string) => tool === "bash" || tool === "eval";
// OmO refuses to compact a tiny session; two turns over a filler text make one big enough.
const FILLER = Array.from({ length: 1500 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog near the riverbank.`).join("\n");

// A data dir of its own with one deny line, so a probe never reads or writes the owner's ~/.dotz.
function probeData(cwd: string): string {
	const dir = join(cwd, ".dotz-probe-data");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "RULES.md"), "## Blocked commands\n- deny: echo\\s+DOTZ-DENY-PROBE | probe rule, this command is refused\n");
	return dir;
}

export function makeOmoProbes(adapter: RuntimeAdapter): Probes {
	let n = 0;
	const probe = (body: (ctx: ProbeCtx, start: ProbeStart, ms: number) => Promise<ProbeOutcome>) => async (ctx: ProbeCtx): Promise<ProbeOutcome> => {
		const runs: Run[] = [];
		const start: ProbeStart = (o = {}) => {
			const run = new Run(adapter, ctx, String(++n), { model: CHEAP, env: { DOTZ_DIR: probeData(ctx.cwd), DOTZ_LANE: "probe" }, ...o });
			runs.push(run);
			return run;
		};
		try {
			return await body(ctx, start, Math.min(ctx.timeoutMs, 120_000));
		} catch (e) {
			return fail((e as Error).message);
		} finally {
			await Promise.all(runs.map(r => r.close()));
			await Promise.all(runs.map(r => r.proc.exited));
		}
	};

	return {
		turn: probe(async (_ctx, start, ms) => {
			const run = start();
			const t0 = Date.now();
			const events = await run.turn(PONG, ms);
			const kinds = events.map(e => e.type);
			if (!/PONG/i.test(answerOf(events))) return fail(`answer was not PONG: "${answerOf(events).slice(0, 80)}"`);
			for (const need of ["turn_start", "user", "assistant", "turn_end"]) if (!kinds.includes(need as AgentEvent["type"])) return fail(`no ${need} event`);
			return ok(`prompt -> turn_start, user, assistant(stop) PONG, turn_end in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		}),

		model_effort: probe(async (_ctx, start, ms) => {
			for (const level of ["low", "high"]) {
				const events = await start({ model: `anthropic/claude-sonnet-5-5:${level}` }).turn(PONG, ms);
				if (!/PONG/i.test(answerOf(events))) return fail(`--model ...:${level} did not run a normal turn`);
			}
			return { result: "adapted", note: "provider/model:thinking passes through --model; omp's `anthropic` provider is mapped to OmO's `anthropic-subscription` (OmO's `anthropic` is the per-token API key)" };
		}),

		resume: probe(async (_ctx, start, ms) => {
			const first = start();
			await first.turn("Remember this code word: TANGERINE-42. Reply with OK only.", ms);
			first.proc.refreshSession();
			const ref = await first.session(5000);
			if (!ref) return fail("no session ref after the first turn");
			await first.close();
			const answer = answerOf(await start({ resume: ref }).turn("What was the code word I told you? Reply with the word only.", ms));
			return /TANGERINE-42/i.test(answer) ? ok(`--session ${ref.split("/").pop()?.slice(0, 30)}… resumed, remembered the code word`) : fail(`resumed session did not remember: "${answer.slice(0, 80)}"`);
		}),

		handover: probe(async (_ctx, start, ms) => {
			const run = start();
			await run.turn("Reply with exactly the single word HANDOVER-CHECK and nothing else.", ms);
			run.proc.refreshSession();
			const ref = await run.session(5000);
			if (!ref) return fail("no session ref");
			for (let i = 0; i < 10; i++) {
				const text = adapter.recentExchanges(ref);
				if (text?.includes("HANDOVER-CHECK")) return ok(`recentExchanges read the saved OmO session (${text.length} chars)`);
				await Bun.sleep(500);
			}
			return fail("recentExchanges did not return the exchange");
		}),

		compaction_events: probe(async (_ctx, start, ms) => {
			const run = start();
			await run.turn(`Read this text, then reply with exactly the single word hi.\n\n${FILLER}`, ms);
			await run.turn(`Read this text too, then reply with exactly the single word again.\n\n${FILLER}`, ms);
			const from = run.events.length;
			run.proc.compact();
			const done = await run.waitFor(e => e.type === "compaction", ms, from);
			if (!done || done.type !== "compaction") return fail("no compaction event after compact()");
			if (done.state !== "done") return fail(`compaction failed: ${done.error}`);
			const after = await run.turn(PONG, ms);
			return /PONG/i.test(answerOf(after)) ? ok("compact -> compaction done; the session kept working") : fail("turn after compaction did not answer");
		}),

		usage_report: probe(async (_ctx, start, ms) => {
			const run = start();
			await run.turn(PONG, ms);
			const from = run.events.length;
			run.proc.refreshUsage();
			const hit = await run.waitFor(e => e.type === "usage" && e.tokens !== undefined && e.window !== undefined, 15_000, from);
			if (!hit || hit.type !== "usage" || !hit.tokens || !hit.window) return fail("get_session_stats was not answered with tokens and window");
			return ok(`context ${hit.tokens} / ${hit.window} tokens (get_session_stats), plus per-message usage`);
		}),

		deny_lines: probe(async (_ctx, start, ms) => {
			const run = start();
			const blocked = await run.turn("Run exactly this bash command and tell me its output: echo DOTZ-DENY-PROBE-1", ms);
			const call = toolCalls(blocked).find(c => /DOTZ-DENY-PROBE-1/.test(c.args ?? ""));
			if (!call) return fail("the model never attempted the command; nothing to block");
			const result = toolResults(blocked).find(r => r.call_id === call.call_id);
			if (!result?.is_error || !/probe rule/.test(result.text)) return fail(`the command was not blocked: ${result?.text.slice(0, 100) ?? "no result"}`);
			return ok(`dotz extension tool_call hook blocked it: "${result.text.replace(/\s+/g, " ").slice(0, 120)}"`);
		}),

		guard_extension: probe(async (_ctx, start, ms) => {
			const events = await start().turn("Call the harness_doctor tool once (no arguments) and reply with its first line only.", ms);
			const call = toolCalls(events).find(c => c.tool === "harness_doctor");
			if (!call) return fail("harness_doctor is not registered (the dotz extension's guard/harness part did not load)");
			const result = toolResults(events).find(r => r.call_id === call.call_id);
			if (!result || result.is_error) return fail(`harness_doctor failed: ${result?.text.slice(0, 120) ?? "no result"}`);
			return { result: "adapted", note: `dotz guard + harness tools load (harness_doctor: "${result.text.split("\n")[0].slice(0, 60)}"); the RULES.md deny lines and the repeat guard run; omp-only parts (worker brief/patch tracking, budget gate on task spawns) stay off because OmO has no ctx.agent or before_subagent_spawn` };
		}),

		dotz_tools: probe(async (ctx, start, ms) => {
			const events = await start().turn(`Call the dotz_verify tool with command "echo dotz-tool-ok" and cwd "${ctx.cwd}", then reply with the line of its output that contains dotz-tool-ok.`, ms);
			const call = toolCalls(events).find(c => c.tool === "dotz_verify");
			if (!call) return fail("dotz_verify is not registered");
			const result = toolResults(events).find(r => r.call_id === call.call_id);
			if (!result || result.is_error || !/receipt .* (ran|reused) exit=0/.test(result.text)) return fail(`dotz_verify did not run: ${result?.text.slice(0, 160) ?? "no result"}`);
			return ok(`dotz_* tools register with JSON Schema parameters (dotz_verify: "${result.text.split("\n")[0].slice(0, 80)}")`);
		}),

		tool_intent: probe(async (_ctx, start, ms) => {
			const events = await start().turn("Run exactly this bash command and tell me its output: echo intent-probe", ms);
			const call = toolCalls(events).find(c => isShell(c.tool));
			if (!call) return fail("no shell (bash/eval) tool_call row");
			const result = toolResults(events).find(r => r.call_id === call.call_id);
			if (!result || !/intent-probe/.test(result.text)) return fail("no tool_result row paired with the call");
			return call.intent ? ok(`tool_call ${call.tool} intent "${call.intent}", tool_result paired by id`) : { result: "adapted", note: "tool_call/tool_result rows paired by id; the row shows the command when the call carries no intent" };
		}),

		steer_abort: probe(async (_ctx, start, ms) => {
			const run = start();
			const from = run.events.length;
			run.proc.send("Run this bash command: sleep 8; echo slept. Then reply with the single word done.", "prompt");
			if (!(await run.waitFor(e => e.type === "activity" && e.row.type === "tool_call" && isShell(e.row.tool), 60_000, from))) return fail("the model never started the command");
			run.proc.send("Also: end your final answer with the word STEERED.", "steer");
			if (!(await run.waitFor(e => e.type === "assistant" && e.stop === "stop" && /STEERED/i.test(e.text), ms, from))) return fail("a message sent mid-turn was not honored");
			await Bun.sleep(1500);
			const at = run.events.length;
			run.proc.send("Run this bash command: sleep 60. Then say done.", "prompt");
			if (!(await run.waitFor(e => e.type === "activity" && e.row.type === "tool_call", 60_000, at))) return fail("the model never started the long command");
			await Bun.sleep(2000);
			run.proc.abort();
			if (!(await run.waitFor(e => e.type === "assistant" && e.stop === "aborted", 20_000, at))) return fail("abort() did not end the turn as aborted");
			await Bun.sleep(1500);
			return /PONG/i.test(answerOf(await run.turn(PONG, ms))) ? ok("steer injected mid-turn; abort -> assistant(aborted), session usable afterwards") : fail("the session did not answer after abort()");
		}),

		workers_spawn: probe(async (_ctx, start, ms) => {
			const events = await start().turn("Use the task tool to spawn ONE subagent (any cheap category) whose only job is to run the bash command `echo from-worker` and report its output. Wait for its result, then reply with the output line only.", Math.max(ms, 240_000));
			if (!toolCalls(events).some(c => c.tool === "task")) return fail("the task tool was not used");
			if (!/from-worker/.test(answerOf(events))) return fail(`the worker's result did not come back: "${answerOf(events).slice(0, 80)}"`);
			return { result: "adapted", note: "OmO task tool: the worker runs in OmO's rpc host and its result comes back into the session (no live worker frames; the rpc host is stopped when the process exits)" };
		}),

		workers_isolated_patch: async () => ({ result: "unsupported", note: "omp task isolation + orchestrator-guard patch review has no OmO equivalent wired into dotz; OmO children merge their own changes" }),
		fallback_chain: async () => ({ result: "unsupported", note: "started with --no-model-fallback: dotz's hub-driven chain is omp-only and OmO's own chain is off, so a failed model is retried/paused by the hub, never switched silently" }),
	};
}
