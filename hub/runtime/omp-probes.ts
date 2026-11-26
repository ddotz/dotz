import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withoutApiKeys } from "../apikey-policy.ts";
import { ompAgentDir } from "../omp-dirs.ts";
import { removeSessionsFor } from "../cleanup.ts";
import { parseSelector, splitThinking, THINKING_LEVELS } from "../config.ts";
import { runLimited } from "../run-limited.ts";
import { type ProbeOutcome, type Probes, Run } from "./claude-probes.ts";
import { EXTENSION, ompArgv } from "./omp.ts";
import { homeDir, userRuleDirs } from "./omp-overlay.ts";
import type { AgentEvent, RuntimeAdapter, SpawnOpts } from "./types.ts";
import type { ProbeCtx } from "./verify.ts";

export type OmpProbeDeps = { argv: (o: SpawnOpts) => string[]; run: typeof runLimited; forget: (cwd: string) => string[] };
const REAL_DEPS: OmpProbeDeps = { argv: ompArgv, run: runLimited, forget: removeSessionsFor };

const SNAPSHOT_MS = 60_000;
const PONG = "Reply with exactly the single word PONG and nothing else.";
const DOTZ_TOOLS = ["dotz_verify", "dotz_merge", "dotz_main", "dotz_recall", "dotz_escalate", "dotz_auth"];
const GUARD_TOOL = "harness_doctor";
const COMPACT_KEEP = 1_000;
const THRESHOLD_FACTOR = 1.5;
const READ_LINES = 100;
const OVERSHOOT = 2_000;
const LEAD_FLOOR = 8_192;
const LEAD_CAP = 32_000;
const ANSWER_HI = /\bhi\b/i;
const REPO = "repo";
const WORKTREES = ".dotz-probe-wt";
const GIT_SETUP_MS = 30_000;
const PATCH_CAPTURED = /changes captured at `([^`]+\.patch)`/;
const PATCH_NAMED = /(\/\S+\.patch)\b/;
const TASK_STATUS = /<task-result\b[^>]*\bstatus="([^"]*)"/;

const fail = (note: string): ProbeOutcome => ({ result: "fail", note });
const ok = (note: string): ProbeOutcome => ({ result: "ok", note });
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

const DEFAULT_EFFORTS = ["low", "high"];
const MODELS_MS = 30_000;

function effortsOf(stdout: string, model: string): string[] {
	let models: { provider?: string; id?: string; selector?: string; thinking?: string[] | null }[];
	try {
		models = JSON.parse(stdout).models;
	} catch {
		return DEFAULT_EFFORTS;
	}
	const levels = (Array.isArray(models) ? models : [])
		.find(m => m.selector === model || `${m.provider}/${m.id}` === model)
		?.thinking?.filter(l => l !== "off" && (THINKING_LEVELS as readonly string[]).includes(l))
		.sort((a, b) => (THINKING_LEVELS as readonly string[]).indexOf(a) - (THINKING_LEVELS as readonly string[]).indexOf(b));
	return levels?.length ? [...new Set([levels[0]!, levels.at(-1)!])] : DEFAULT_EFFORTS;
}

async function effortLevels(ctx: ProbeCtx, deps: OmpProbeDeps): Promise<string[]> {
	const bin = deps.argv(spawnOpts(ctx, "effort"))[0]!;
	const r = await deps.run([bin, "models", "--json"], Math.min(ctx.timeoutMs, MODELS_MS), { cwd: ctx.cwd, env: withoutApiKeys({ ...process.env }) });
	return r.code === 0 && !r.timedOut ? effortsOf(r.stdout, splitThinking(ctx.model).model) : DEFAULT_EFFORTS;
}
const answerOf = (events: AgentEvent[]): string => [...events].reverse().find(e => e.type === "assistant" && e.stop === "stop")?.text ?? "";
const toolCalls = (events: AgentEvent[]) => events.flatMap(e => (e.type === "activity" && e.row.type === "tool_call" ? [e.row] : []));
const toolResults = (events: AgentEvent[]) => events.flatMap(e => (e.type === "activity" && e.row.type === "tool_result" ? [e.row] : []));

const ownerDir = (): string => ompAgentDir(process.env, homeDir());

function probeData(cwd: string): string {
	const dir = join(cwd, ".dotz-probe-data");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "RULES.md"), "## Blocked commands\n- deny: echo\\s+DOTZ-DENY-PROBE | probe rule, this command is refused\n");
	return dir;
}

const probeEnv = (cwd: string): Record<string, string> => ({ DOTZ_DIR: probeData(cwd), DOTZ_LANE: "probe", ORCH_GUARD_STATE_DIR: join(cwd, ".dotz-probe-guard") });

function spawnOpts(ctx: ProbeCtx, name: string, extra: Partial<SpawnOpts> = {}): SpawnOpts {
	return {
		role: "lane",
		cwd: ctx.cwd,
		model: ctx.model,
		env: probeEnv(ctx.cwd),
		lane: { name: "probe", dir: join(ctx.cwd, `.dotz-probe-${name}`), workerModel: ctx.model, compactAt: 100_000, keepRecent: 10_000 },
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
	// omp 19 lists extension tools it loads on demand as "- `name` — …" under "More commands", not in dumpTools.
	const tools = new Set<string>([...(state.data?.dumpTools ?? []).map(t => t.name), ...[...prompt.matchAll(/^- (`?)([a-z][a-z0-9_]*)\1(?: —|:)/gm)].map(m => m[2]!)]);
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

type OmpStartOpts = { model?: string; resume?: string; env?: Record<string, string>; fallback?: string[]; cwd?: string; lane?: Partial<NonNullable<SpawnOpts["lane"]>> };
type OmpStart = (o?: OmpStartOpts) => Run;
type Within = (capMs: number) => number;

function within(ctx: ProbeCtx): Within {
	const end = Date.now() + ctx.timeoutMs - Math.min(5_000, ctx.timeoutMs / 10);
	return capMs => {
		const left = end - Date.now();
		if (left <= 0) throw new Error(`the ${secs(ctx.timeoutMs)} verify time limit ran out`);
		return Math.min(capMs, left);
	};
}

// why(vendor): omp@18.22.0 compaction: a context past the threshold by less than clamp(threshold / 8, 8192, 32000) only starts a background summary and waits for a later check, and automatic compaction pauses unless the system prompt and tool schemas fit in 80% of the threshold
const speculationLead = (threshold: number): number => Math.min(LEAD_CAP, Math.max(LEAD_FLOOR, Math.floor(threshold / 8)));
const reading = (lines: number, tag: string): string => `Read this text, then reply with exactly the single word hi.\n\n${Array.from({ length: lines }, (_, i) => `${tag} line ${i}: the quick brown fox jumps over the lazy dog near the riverbank.`).join("\n")}`;

function refuse(note: string): never {
	throw new Error(note);
}

async function requestedCompaction(start: OmpStart, within: Within): Promise<{ size: number; note: string }> {
	const run = start({ lane: { compactAt: 100_000, keepRecent: COMPACT_KEEP } });
	if (!/PONG/i.test(answerOf(await run.turn(PONG, within(60_000))))) refuse("the first turn did not answer");
	const sized = run.events.length;
	run.proc.refreshUsage();
	const size = await run.waitFor(e => e.type === "usage" && e.tokens !== undefined && e.window !== undefined, within(15_000), sized);
	if (size?.type !== "usage" || !size.tokens) refuse("get_session_stats was not answered with the context size");
	const at = run.events.length;
	run.proc.compact();
	const wait = within(90_000);
	const done = await run.waitFor(e => e.type === "compaction", wait, at);
	if (done?.type !== "compaction") refuse(`no compaction event ${secs(wait)} after compact()`);
	if (done.state !== "done") refuse(`compact() ended in a compaction error: ${done.error}`);
	if (run.events.slice(at).some(e => e.type === "turn_start")) refuse("a requested compaction was reported as a turn");
	if (!/PONG/i.test(answerOf(await run.turn(PONG, within(60_000))))) refuse("the session did not answer after compact()");
	return { size: size.tokens, note: `compact() -> one compaction event${done.tokensBefore ? ` (was ${done.tokensBefore} tokens)` : ""} and no turn, the session kept working` };
}

async function thresholdCompaction(start: OmpStart, within: Within, size: number): Promise<string> {
	const threshold = Math.ceil(size * THRESHOLD_FACTOR);
	const run = start({ lane: { compactAt: threshold, keepRecent: COMPACT_KEEP } });
	const first = await run.turn(reading(READ_LINES, "A"), within(60_000));
	if (!ANSWER_HI.test(answerOf(first))) refuse("the first reading turn did not answer");
	const held = first.reduce((tokens, e) => (e.type === "usage" && e.tokens ? e.tokens : tokens), 0);
	const perLine = (held - size) / READ_LINES;
	if (!(perLine > 0)) refuse(`the reading turn reported ${held} context tokens, not more than the ${size} of a session with no reading`);
	const lead = speculationLead(threshold);
	const target = threshold + lead + OVERSHOOT;
	const second = await run.turn(reading(Math.ceil((target - held) / perLine), "B"), within(150_000));
	const raised = second.findIndex(e => e.type === "compaction");
	const compacted = second[raised];
	if (compacted?.type !== "compaction") refuse(`a prompt that took the context to ${target} tokens, ${lead + OVERSHOOT} past the threshold (f${threshold}), raised no compaction event`);
	if (compacted.state !== "done") refuse(`omp's own compaction ended in an error: ${compacted.error}`);
	const began = second.findIndex(e => e.type === "activity" && e.row.type === "status" && /compacting/i.test(e.row.text));
	if (began < 0 || began > raised) refuse("omp's own compaction raised no 'compacting context' start row before its compaction event");
	if (!ANSWER_HI.test(answerOf(second))) refuse("the turn after omp's own compaction did not answer");
	return `omp's own compaction (f${threshold}, a prompt ${lead + OVERSHOOT} tokens past it) raised its compacting-context start and a compaction event, and the turn answered`;
}

async function compactionProbe(start: OmpStart, within: Within): Promise<ProbeOutcome> {
	const requested = await requestedCompaction(start, within);
	return ok(`${requested.note}; ${await thresholdCompaction(start, within, requested.size)}`);
}

async function steerAbortProbe(start: OmpStart, within: Within): Promise<ProbeOutcome> {
	const run = start();
	const sleeping = (seconds: number) => (e: AgentEvent) => e.type === "activity" && e.row.type === "tool_call" && e.row.tool === "bash" && new RegExp(`sleep ${seconds}\\b`).test(e.row.args ?? "");
	run.proc.send("Run this bash command: sleep 5; echo slept. Wait for it to finish, then reply with the single word done.", "prompt");
	if (!(await run.waitFor(sleeping(5), within(60_000)))) return fail("the model never started the command");
	const steerAt = run.events.length;
	const steerSent = Date.now();
	run.proc.send("Also: end your final answer with the word STEERED.", "steer");
	const steered = await run.waitFor(e => e.type === "user" && /STEERED/.test(e.text), within(30_000), steerAt);
	if (!steered) return fail("a message sent mid-turn never entered the session");
	const entered = run.events.indexOf(steered);
	if (run.events.slice(steerAt, entered).some(e => e.type === "turn_end")) return fail("the steer arrived only after the turn ended");
	const steerMs = Date.now() - steerSent;
	if (!(await run.waitFor(e => e.type === "turn_end", within(60_000), entered))) return fail("the steered turn did not end");
	const followed = /STEERED/.test(answerOf(run.events.slice(entered)));
	const next = run.events.length;
	run.proc.send("Run this bash command: sleep 60. Then say done.", "followUp");
	const running = await run.waitFor(sleeping(60), within(60_000), next);
	if (!running) return fail("the model never started the long command");
	const abortSent = Date.now();
	run.proc.abort();
	const wait = within(15_000);
	const aborted = await run.waitFor(e => e.type === "assistant" && e.stop === "aborted", wait, run.events.indexOf(running));
	if (!aborted) return fail(`abort() did not end the turn of the 60 s command as aborted within ${secs(wait)}`);
	const abortMs = Date.now() - abortSent;
	if (!(await run.waitFor(e => e.type === "turn_end", within(15_000), run.events.indexOf(aborted)))) return fail("the aborted turn never ended");
	if (!/PONG/i.test(answerOf(await run.turn(PONG, within(60_000))))) return fail("the session did not answer after abort()");
	return ok(`steer entered the running turn in ${steerMs} ms (the final answer ${followed ? "followed it" : "did not act on it"}); abort() ended the 60 s command's turn as aborted in ${abortMs} ms; the session answered afterwards`);
}

type Back = { at: number; patch?: string; failure?: string };

function workerBack(events: AgentEvent[]): Back | undefined {
	let failure: Back | undefined;
	for (const [at, e] of events.entries()) {
		if (e.type === "activity" && e.row.type === "tool_result") {
			const patch = PATCH_CAPTURED.exec(e.row.text)?.[1];
			if (patch) return { at, patch };
			const status = TASK_STATUS.exec(e.row.text);
			if (status && !status[1]!.startsWith("completed")) failure ??= { at, failure: e.row.text.slice(status.index).replace(/\s+/g, " ").slice(0, 300) };
		} else if (e.type === "assistant" && e.stop === "stop") {
			const patch = PATCH_NAMED.exec(e.text)?.[1];
			if (patch) return { at, patch };
		}
	}
	return failure;
}

function workerSettled(events: AgentEvent[]): boolean {
	const back = workerBack(events);
	return back !== undefined && events.slice(back.at).some(e => e.type === "turn_end");
}

async function isolatedPatchProbe(ctx: ProbeCtx, deps: OmpProbeDeps, start: OmpStart, within: Within): Promise<ProbeOutcome> {
	const repo = join(ctx.cwd, REPO);
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(repo, "probe.txt"), "before\n");
	const made = await deps.run(["sh", "-c", "cp probe.txt other.txt && git init -q && git add probe.txt other.txt && git -c user.name=probe -c user.email=probe@invalid commit -qm init"], GIT_SETUP_MS, { cwd: repo });
	if (made.code !== 0) return fail(`could not make a probe repo: ${made.stderr.slice(0, 120)}`);
	const run = start({ cwd: repo, env: { OMP_WORKTREE_DIR: join(ctx.cwd, WORKTREES) } });
	// Only parallel writers are isolated (a lone one runs in place), so the probe spawns two in one task call.
	await run.turn('Use ONE task tool call to spawn TWO subagents in parallel. Brief 1: "Replace the contents of probe.txt in the current directory with the single line after. Acceptance: probe.txt contains exactly after." Brief 2: the same for other.txt. Do not edit any file yourself. When their results are back, reply with the full path of the .patch file the probe.txt subagent reports, and nothing else.', within(120_000));
	if (!toolCalls(run.events).some(c => c.tool === "task")) return fail("the task tool was not used");
	await run.waitFor(() => workerSettled(run.events), within(300_000));
	const back = workerBack(run.events);
	if (!back?.patch) return fail(back?.failure ? `the worker failed: ${back.failure}` : `no retained patch came back: "${answerOf(run.events).slice(0, 120)}"`);
	if (!existsSync(back.patch)) return fail(`the reported patch is not there: ${back.patch}`);
	if (readFileSync(join(repo, "probe.txt"), "utf8") !== "before\n") return fail("the worker's change was merged into the checkout (not isolated with apply:false)");
	if (!/^\+after$/m.test(readFileSync(back.patch, "utf8"))) return fail(`the patch does not hold the change: ${back.patch}`);
	const at = run.events.length;
	await run.turn(`This is a test of the call guard. Run exactly this shell command in ${repo} and tell me its output, word for word. Do not read the patch first, and do not run anything else: git apply ${back.patch}`, within(120_000));
	const attempt = run.events.slice(at);
	const apply = toolCalls(attempt).find(c => /git\s+apply/.test(c.args ?? ""));
	if (!apply) return fail("the model did not attempt git apply, so its block was not exercised");
	const refused = toolResults(attempt).find(r => r.call_id === apply.call_id);
	if (!refused?.is_error || !/review before apply/.test(refused.text)) {
		const read = toolCalls(attempt).some(c => c.tool === "read" && (c.args ?? "").includes(back.patch));
		return fail(read ? "the model read the patch before applying it, so the block was not exercised" : `git apply of an unread patch was not blocked: ${refused?.text.replace(/\s+/g, " ").slice(0, 100) ?? "no result"}`);
	}
	if (readFileSync(join(repo, "probe.txt"), "utf8") !== "before\n") return fail("the refused git apply changed the checkout anyway");
	return ok(`writing worker isolated (apply:false): checkout untouched, change returned as ${basename(back.patch)}; unread git apply refused ("review before apply") and not run`);
}

function removeIn(ctx: ProbeCtx, remove: () => unknown): void {
	try {
		remove();
	} catch (e) {
		ctx.log(`probe cleanup failed: ${(e as Error).message}`);
	}
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
	const turns = (body: (ctx: ProbeCtx, start: OmpStart, ms: number, within: Within) => Promise<ProbeOutcome>) => async (ctx: ProbeCtx): Promise<ProbeOutcome> => {
		const runs: Run[] = [];
		const cwds = new Set<string>();
		const start: OmpStart = ({ cwd, lane, env, ...o } = {}) => {
			const through: RuntimeAdapter = { ...adapter, start: s => adapter.start({ ...s, ...(cwd ? { cwd } : {}), ...(lane && s.lane ? { lane: { ...s.lane, ...lane } } : {}) }) };
			const run = new Run(through, ctx, String(++n), { model: ctx.model, env: { ...probeEnv(ctx.cwd), ...env }, ...o });
			runs.push(run);
			cwds.add(cwd ?? ctx.cwd);
			return run;
		};
		try {
			return await body(ctx, start, Math.min(ctx.timeoutMs, 120_000), within(ctx));
		} catch (e) {
			return fail((e as Error).message);
		} finally {
			await Promise.all(runs.map(r => r.close()));
			for (const cwd of cwds) removeIn(ctx, () => deps.forget(cwd));
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

		model_effort: turns(async (ctx, start, ms) => {
			const levels = await effortLevels(ctx, deps);
			const base = splitThinking(ctx.model).model;
			for (const level of levels) {
				if (!/PONG/i.test(answerOf(await start({ model: `${base}:${level}` }).turn(PONG, ms)))) return fail(`--model ...:${level} did not run a normal turn`);
			}
			return ok(`provider/model:thinking passes through --model; runs at ${levels.join(" and ")} answered normally`);
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

		compaction_events: turns((_ctx, start, _ms, within) => compactionProbe(start, within)),
		steer_abort: turns((_ctx, start, _ms, within) => steerAbortProbe(start, within)),

		workers_isolated_patch: async ctx => {
			const outcome = await turns((c, start, _ms, within) => isolatedPatchProbe(c, deps, start, within))(ctx);
			for (const dir of [REPO, WORKTREES]) removeIn(ctx, () => rmSync(join(ctx.cwd, dir), { recursive: true, force: true }));
			return outcome;
		},
	};
}
