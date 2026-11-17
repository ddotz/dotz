import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withoutApiKeys } from "../apikey-policy.ts";
import { parseSelector } from "../config.ts";
import { runLimited } from "../run-limited.ts";
import { type ProbeOutcome, type Probes, type ProbeStart, Run } from "./claude-probes.ts";
import { EXTENSION, ompArgv } from "./omp.ts";
import { homeDir, userRuleDirs } from "./omp-overlay.ts";
import type { AgentEvent, RuntimeAdapter, SpawnOpts } from "./types.ts";
import type { ProbeCtx } from "./verify.ts";

export type OmpProbeDeps = { argv: (o: SpawnOpts) => string[]; run: typeof runLimited };
const REAL_DEPS: OmpProbeDeps = { argv: ompArgv, run: runLimited };

const CHEAP = "anthropic/claude-sonnet-5-5:low";
const SNAPSHOT_MS = 60_000;
const PONG = "Reply with exactly the single word PONG and nothing else.";
const DOTZ_TOOLS = ["dotz_verify", "dotz_merge", "dotz_main", "dotz_recall", "dotz_escalate", "dotz_auth"];
const GUARD_TOOL = "harness_doctor";

const fail = (note: string): ProbeOutcome => ({ result: "fail", note });
const ok = (note: string): ProbeOutcome => ({ result: "ok", note });
const unknown = (note: string) => async (): Promise<ProbeOutcome> => ({ result: "unknown", note });
const answerOf = (events: AgentEvent[]): string => [...events].reverse().find(e => e.type === "assistant" && e.stop === "stop")?.text ?? "";
const toolCalls = (events: AgentEvent[]) => events.flatMap(e => (e.type === "activity" && e.row.type === "tool_call" ? [e.row] : []));
const toolResults = (events: AgentEvent[]) => events.flatMap(e => (e.type === "activity" && e.row.type === "tool_result" ? [e.row] : []));

const ownerDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homeDir(), ".omp", "agent");

function probeData(cwd: string): string {
	const dir = join(cwd, ".dotz-probe-data");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "RULES.md"), "## Blocked commands\n- deny: echo\\s+DOTZ-DENY-PROBE | probe rule, this command is refused\n");
	return dir;
}

function spawnOpts(ctx: ProbeCtx, name: string, extra: Partial<SpawnOpts> = {}): SpawnOpts {
	return {
		role: "lane",
		cwd: ctx.cwd,
		model: CHEAP,
		env: { DOTZ_DIR: probeData(ctx.cwd), DOTZ_LANE: "probe" },
		lane: { name: "probe", dir: join(ctx.cwd, `.dotz-probe-${name}`), workerModel: CHEAP, compactAt: 100_000, keepRecent: 10_000 },
		...extra,
	};
}

type Frame = {
	type?: string;
	id?: string;
	success?: boolean;
	error?: string;
	extensionPath?: string;
	data?: { systemPrompt?: string | string[]; dumpTools?: { name: string }[]; commands?: { name: string }[] };
};
type Snapshot = { argv: string[]; tools: Set<string>; prompt: string; commands: string[]; errors: string[] };

function framesOf(stdout: string): Frame[] {
	return stdout.split("\n").flatMap(line => {
		try {
			const f = JSON.parse(line);
			return f && typeof f === "object" ? [f as Frame] : [];
		} catch {
			return [];
		}
	});
}

async function snapshot(ctx: ProbeCtx, deps: OmpProbeDeps, name: string): Promise<Snapshot> {
	const opts = spawnOpts(ctx, name);
	const argv = deps.argv(opts);
	const stdin = [{ id: "state", type: "get_state" }, { id: "commands", type: "get_available_commands" }].map(f => `${JSON.stringify(f)}\n`).join("");
	const env = withoutApiKeys({ PI_CACHE_RETENTION: "long", ...process.env, ...opts.env, DOTZ_RUNTIME: "omp" });
	const limit = Math.min(ctx.timeoutMs, SNAPSHOT_MS);
	const r = await deps.run(argv, limit, { cwd: opts.cwd, env, stdin });
	if (r.timedOut) throw new Error(`omp did not answer get_state within ${Math.round(limit / 1000)}s`);
	const frames = framesOf(r.stdout);
	const state = frames.find(f => f.type === "response" && f.id === "state");
	if (!state?.success) throw new Error(`omp did not answer get_state (exit ${r.code}): ${(state?.error ?? (r.stderr || r.stdout)).trim().slice(0, 160)}`);
	const prompt = ([] as string[]).concat(state.data?.systemPrompt ?? []).join("\n");
	const tools = new Set<string>([...(state.data?.dumpTools ?? []).map(t => t.name), ...[...prompt.matchAll(/^- ([a-z][a-z0-9_]*)(?: —|:)/gm)].map(m => m[1]!)]);
	const commands = (frames.find(f => f.type === "response" && f.id === "commands")?.data?.commands ?? []).map(c => c.name);
	const errors = frames.filter(f => f.type === "extension_error").map(f => `${f.extensionPath}: ${f.error}`);
	return { argv, tools, prompt, commands, errors };
}

function marks(file: string): string[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lines = text.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n").map(l => l.trim()).filter(l => l.length >= 24 && !l.startsWith("#") && l !== "---");
	return [...new Set(lines)].sort((a, b) => b.length - a.length).slice(0, 5);
}

const namesIn = (dir: string, pick: (f: string) => string | undefined): string[] => {
	try {
		return readdirSync(dir).flatMap(f => pick(f) ?? []);
	} catch {
		return [];
	}
};

function leaks(snap: Snapshot, dir: string): string[] {
	const found: string[] = [];
	for (const f of ["RULES.md", "AGENTS.md"]) if (marks(join(dir, f)).some(m => snap.prompt.includes(m))) found.push(f);
	const ruleDirs = userRuleDirs();
	for (const ruleDir of ruleDirs) {
		const label = ruleDir === ruleDirs[0] ? "rules" : `${basename(dirname(ruleDir))}/rules`;
		for (const rule of namesIn(ruleDir, f => (/\.mdc?$/.test(f) ? f : undefined))) if (marks(join(ruleDir, rule)).some(m => snap.prompt.includes(m))) found.push(`${label}/${rule}`);
	}
	for (const skill of namesIn(join(dir, "skills"), f => (f.startsWith(".") ? undefined : f))) {
		if (snap.commands.includes(`skill:${skill}`) || new RegExp(`^- ${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m").test(snap.prompt)) found.push(`skills/${skill}`);
	}
	return found;
}

type Overlay = { retry?: { modelFallback?: boolean; fallbackChains?: Record<string, string[]> } };
const sameList = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

function ownerChainsInReach(model: string, overlayKeys: string[]): string[] {
	let chains: Record<string, unknown> | undefined;
	try {
		chains = (Bun.YAML.parse(readFileSync(join(ownerDir(), "config.yml"), "utf8")) as { retry?: { fallbackChains?: Record<string, unknown> } } | null)?.retry?.fallbackChains;
	} catch {
		return [];
	}
	return Object.keys(chains ?? {}).filter(k => !overlayKeys.includes(k) && (k === "default" || (k.endsWith("*") && model.startsWith(k.slice(0, -1)))));
}

function fallbackProbe(ctx: ProbeCtx, deps: OmpProbeDeps): ProbeOutcome {
	const hub = ["anthropic/claude-opus-5-5:low"];
	const worker = ["anthropic/claude-sonnet-5-5:medium"];
	const base = spawnOpts(ctx, "chain-a", { fallback: hub });
	const model = parseSelector(base.model).model;
	const read = (argv: string[]): Overlay => Bun.YAML.parse(readFileSync(argv.find(a => a.startsWith("--config="))!.slice("--config=".length), "utf8")) as Overlay;
	const mine = read(deps.argv({ ...base, lane: { ...base.lane!, workerFallback: worker } }));
	const chains = mine.retry?.fallbackChains ?? {};
	if (mine.retry?.modelFallback !== true) return fail("the overlay does not turn omp's model fallback on");
	if (!sameList(chains[model], hub)) return fail(`the overlay's chain of ${model} is ${JSON.stringify(chains[model])}, not the hub's ${JSON.stringify(hub)}`);
	if (!sameList(chains.task, worker)) return fail(`the overlay's task chain is ${JSON.stringify(chains.task)}, not the lane's ${JSON.stringify(worker)}`);
	const driven = read(deps.argv({ ...spawnOpts(ctx, "chain-b", { fallback: hub, hubSwitches: true }) }));
	if (!sameList(driven.retry?.fallbackChains?.[model], [])) return fail("with the hub driving the switches the overlay still carries a chain of omp's own");
	const reach = ownerChainsInReach(model, Object.keys(chains));
	if (reach.length) return fail(`the owner's retry.fallbackChains key ${reach.map(k => `"${k}"`).join(", ")} is outside the overlay and would still move a dotz process`);
	return ok(`overlay chain of ${model} = the hub's list (empty when the hub drives the switches), the task role's = the lane's, and no owner chain key reaches the process; read from the overlay and the owner's config.yml, the chain walk itself is not run`);
}

export function makeOmpProbes(adapter: RuntimeAdapter, deps: OmpProbeDeps = REAL_DEPS): Probes {
	let n = 0;
	const guarded = (body: (ctx: ProbeCtx) => Promise<ProbeOutcome> | ProbeOutcome) => async (ctx: ProbeCtx): Promise<ProbeOutcome> => {
		try {
			return await body(ctx);
		} catch (e) {
			return fail((e as Error).message);
		}
	};
	const turns = (body: (ctx: ProbeCtx, start: ProbeStart, ms: number) => Promise<ProbeOutcome>) => async (ctx: ProbeCtx): Promise<ProbeOutcome> => {
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
		}
	};
	const sessionOf = async (run: Run): Promise<string | undefined> => {
		run.proc.refreshSession();
		return run.session(5000);
	};

	return {
		turn: turns(async (_ctx, start, ms) => {
			const t0 = Date.now();
			const events = await start().turn(PONG, ms);
			if (!/PONG/i.test(answerOf(events))) return fail(`answer was not PONG: "${answerOf(events).slice(0, 80)}"`);
			const kinds = events.map(e => e.type);
			for (const need of ["turn_start", "user", "assistant", "turn_end"]) if (!kinds.includes(need as AgentEvent["type"])) return fail(`no ${need} event`);
			return ok(`prompt -> turn_start, user, assistant(stop) PONG, turn_end in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		}),

		model_effort: turns(async (_ctx, start, ms) => {
			for (const level of ["low", "high"]) {
				if (!/PONG/i.test(answerOf(await start({ model: `anthropic/claude-sonnet-5-5:${level}` }).turn(PONG, ms)))) return fail(`--model ...:${level} did not run a normal turn`);
			}
			return ok("provider/model:thinking passes through --model; a low and a high run answered normally");
		}),

		resume: turns(async (_ctx, start, ms) => {
			const first = start();
			await first.turn("Remember this code word: TANGERINE-42. Reply with OK only.", ms);
			const ref = await sessionOf(first);
			if (!ref) return fail("no session ref after the first turn");
			await first.close();
			const answer = answerOf(await start({ resume: ref }).turn("What was the code word I told you? Reply with the word only.", ms));
			return /TANGERINE-42/i.test(answer) ? ok(`--resume ${ref.split("/").pop()?.slice(0, 30)} resumed and remembered the code word`) : fail(`resumed session did not remember: "${answer.slice(0, 80)}"`);
		}),

		handover: turns(async (_ctx, start, ms) => {
			const run = start();
			await run.turn("Reply with exactly the single word HANDOVER-CHECK and nothing else.", ms);
			const ref = await sessionOf(run);
			if (!ref) return fail("no session ref");
			const text = adapter.recentExchanges(ref);
			return text?.includes("HANDOVER-CHECK") ? ok(`recentExchanges read the saved omp session (${text.length} chars)`) : fail("recentExchanges did not return the exchange");
		}),

		usage_report: turns(async (_ctx, start, ms) => {
			const run = start();
			await run.turn(PONG, ms);
			const from = run.events.length;
			run.proc.refreshUsage();
			const hit = await run.waitFor(e => e.type === "usage" && e.tokens !== undefined && e.window !== undefined, 15_000, from);
			if (!hit || hit.type !== "usage" || !hit.tokens || !hit.window) return fail("get_session_stats was not answered with tokens and window");
			return ok(`context ${hit.tokens} / ${hit.window} tokens (get_session_stats)`);
		}),

		deny_lines: turns(async (_ctx, start, ms) => {
			const blocked = await start().turn("Run exactly this bash command and tell me its output: echo DOTZ-DENY-PROBE-1", ms);
			const call = toolCalls(blocked).find(c => /DOTZ-DENY-PROBE-1/.test(c.args ?? ""));
			if (!call) return fail("the model never attempted the command; nothing to block");
			const result = toolResults(blocked).find(r => r.call_id === call.call_id);
			if (!result?.is_error || !/probe rule/.test(result.text)) return fail(`the command was not blocked: ${result?.text.slice(0, 100) ?? "no result"}`);
			return ok(`the dotz extension's tool_call hook blocked it: "${result.text.replace(/\s+/g, " ").slice(0, 120)}"`);
		}),

		guard_extension: guarded(async ctx => {
			const snap = await snapshot(ctx, deps, "guard");
			if (!snap.argv.includes(EXTENSION) || !snap.argv.includes("--no-extensions")) return fail("the probe process was not started with the dotz extension alone");
			if (snap.errors.length) return fail(`the extension reported an error: ${snap.errors[0]!.slice(0, 160)}`);
			if (!snap.tools.has(GUARD_TOOL)) return fail(`${GUARD_TOOL} is not registered (the dotz extension's guard/harness part did not load)`);
			return ok(`dotz extension loaded alone (--no-extensions --extension) in a process started by omp.ts's argv; ${GUARD_TOOL} registered, no extension error`);
		}),

		dotz_tools: guarded(async ctx => {
			const snap = await snapshot(ctx, deps, "tools");
			const missing = DOTZ_TOOLS.filter(t => !snap.tools.has(t));
			if (missing.length) return fail(`not registered: ${missing.join(", ")}`);
			return ok(`${DOTZ_TOOLS.join(", ")} registered with the lane's tool list (listed by get_state; not invoked)`);
		}),

		user_isolation: guarded(async ctx => {
			const snap = await snapshot(ctx, deps, "isolation");
			const found = leaks(snap, ownerDir());
			if (found.length) return fail(`the owner's ${found.slice(0, 6).join(", ")}${found.length > 6 ? ` and ${found.length - 6} more` : ""} reach the dotz process (${ownerDir()})`);
			return ok("none of the owner's RULES.md, AGENTS.md, rules (omp agent folder, ~/.agent, ~/.agents) or skills of the omp agent folder is in the process's prompt or command list");
		}),

		fallback_chain: guarded(ctx => fallbackProbe(ctx, deps)),

		workers_spawn: turns(async (_ctx, start, ms) => {
			const events = await start().turn("Use the task tool to spawn ONE subagent whose only job is to run the shell command `echo from-worker` and report its output. When its result is back, reply with the output line only.", Math.max(ms, 240_000));
			if (!toolCalls(events).some(c => c.tool === "task")) return fail("the task tool was not used");
			if (!/from-worker/.test(answerOf(events))) return fail(`the worker's result did not come back: "${answerOf(events).slice(0, 80)}"`);
			return ok("task tool -> a worker ran the command and its result came back into the same turn");
		}),

		tool_intent: turns(async (_ctx, start, ms) => {
			const events = await start().turn("Run exactly this bash command and tell me its output: echo intent-probe", ms);
			const call = toolCalls(events).find(c => c.tool === "bash");
			if (!call) return fail("no bash tool_call row");
			const result = toolResults(events).find(r => r.call_id === call.call_id);
			if (!result || !/intent-probe/.test(result.text)) return fail("no tool_result row paired with the call");
			return call.intent ? ok(`tool_call bash intent "${call.intent}", tool_result paired by id`) : { result: "adapted", note: "tool_call/tool_result rows paired by id; the row shows the command when the call carries no intent" };
		}),

		compaction_events: unknown("not probed on omp: a compaction needs a session over omp's compaction minimum (two long turns) and no omp probe for it exists yet"),
		steer_abort: unknown("not probed on omp: steer and abort mid-turn need a long model turn to cut into, and no omp probe for it exists yet"),
		workers_isolated_patch: unknown("not probed on omp: needs a worker that edits a git checkout and a patch review (apply:false), and no omp probe for it exists yet"),
	};
}
