import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { say } from "../notice.ts";
import { folderWrites, slotCall } from "../checkouts/redirect.ts";
import { type Block, block } from "./block.ts";
import { changeItems, checkoutRoots, checkTaskInput, dropLongTtl, estimateFrom, inGitRepo, trimWaitOutput } from "./briefs.ts";
import { escalationTarget } from "../model-tiers/plan.ts";
import { anthropicLimits, BUDGET_OK_MS, budgetProblem, effortSetupOfAgent, roleSelectors, tierData } from "./budget.ts";
import { debug } from "./debug.ts";
import { deletionProblem } from "./deletion.ts";
import { evalExternalAction, externalAction } from "./eval-scan.ts";
import { evidenceWriteProblem } from "./evidence-writes.ts";
import { bashOutcome, FAILURE_HISTORY, FAILURE_NO_NEXT, type FailureRow, RUNNING_JOB_MAX_AGE_MS } from "./failures.ts";
import { type Fields, fieldsOf, type HostApi, type HostCtx, textBlocks, textOf, type ToolCallVerdict, type ToolEvent } from "./host-types.ts";
import { registerLimitWatch } from "./limit-lift.ts";
import { failureStreak, pollingProblem } from "./loops.ts";
import { machineRuleProblem } from "./machine-rules.ts";
import { appliedPatchNames, applyDirsOf, patchesApplying, patchIsApplied, patchKey, patchLanded, runsGitApply } from "./patches.ts";
import { detectCycle, REPEAT_ESCALATION_ATTEMPTS, REPEAT_HISTORY, REPEAT_MAX_SESSIONS, REPEAT_WINDOW_MS, repeatArgsDigest, repeatBlockReason, type RepeatCall, repeatResultDigest, type RepeatRow, repeatStopReason, repeatSubject, requiredLaps } from "./repeat.ts";
import { mistakeSessionKey, openMistakeProblem } from "./open-mistakes.ts";
import { capToolResult, spillToStateDir } from "./output-cap.ts";
import { deepBudgetProblem, effortAction, escalationProblem, modelProblem, patchChangedLines, reviewedPatchesIn, reviewProblem } from "./spawn-rules.ts";
import { loadState, type ProjectState, saveState, settleFinishedWorkers, settleFromText, stateSummary, briefLabel, workersOfSession } from "./state.ts";
import { familyProblem, measureFinishedWorkers, sizeNote } from "./worker-size.ts";
import { type RetryStartEvent, usageWaitAborts } from "./usage-wait.ts";
import { expandShellVars } from "./shell.ts";
import { sourcesWorkerEnv, WORKER_ENV_NOTICE, WORKER_ENV_PREFIX, workerBashInput, workerEnvFile, workerEnvPrefix, workerEnvProblem } from "./worker-env.ts";

const SLOT_REDIRECT_NOTICE = "orchestrator-guard: this session works in its own checkout of the folder. A path you named under the folder went to the checkout's copy of the file, and the folder changes only when the checkout lands. Use paths relative to the working directory, or the checkout's own paths.";

const WRAP_UP_STEER = "[orchestrator-guard] Your context was just compacted: this assignment is larger than one worker should hold. Finish only the step in progress, then return your final answer now: what is done (with changed paths), what remains, and how you verified. Do not start new steps.";
const STOP_REASON = "[orchestrator-guard] Context compacted twice: tools are disabled for this worker. Write your final answer now with partial findings: done (changed paths), remaining work, verification state.";
const SWITCH_COMPACT_MIN_TOKENS = 50_000;

const workersToldOfEnvPrefix = new Set<string>();
const envNoticesInFlight = new Set<string>();
const envNoticeKey = (ctx: HostCtx | undefined) => `${String(ctx?.sessionManager?.getSessionId?.() ?? "")}\u0000${String(ctx?.agent?.id ?? "")}`;
const externalActionReason = (kind: string) =>
	`orchestrator-guard: workers do not run external-impact commands (${kind}). Finish the rest of the task, and list the exact command under "External actions needed" in your final answer; the orchestrator decides whether to run it.`;

function contextTokens(ctx: HostCtx): number {
	const usage = fieldsOf(ctx?.getContextUsage?.());
	return Number(usage.tokens ?? usage.usedTokens ?? usage.contextTokens ?? 0) || 0;
}

type WorkerInput = { input: Fields; additionalContext?: string };

/**
 * Registers the orchestrator guard's hooks, commands and handlers on `pi`; one call is one omp session's guard, so its
 * closure state (project worker state, compaction count, reviewed patches, repeat and failure history) starts empty.
 *
 * tool_call runs the blocks of `guardToolCall` first and the repeat guard after them, so existing blocks win. Blocked
 * calls are never recorded in the repeat history (it freezes, so ignored blocks are counted instead of laps), and any
 * failure in the repeat guard allows the call: a guard bug must not veto work. Repeat stage 2 asks through ctx.ui.confirm,
 * and a dialog nobody answers within a minute counts as a deny; a person who says go on gets a fresh budget of laps
 * rather than a prompt on every call. A session without a UI, a dotz lane and the dotz orchestrator (`omp --mode rpc`,
 * where hasUI is true but nobody answers extension UI requests, so a confirm would hang the call forever) get the stop
 * block instead.
 *
 * A worker's eval cell can run shell without the bash tool (sh(), Bun.$, subprocess) and is not revised, so the
 * external-action patterns read its code. A revised worker bash call that comes back through the handler is read without
 * the env prefix, because sourcing is opaque to the parser. A message to a finished worker is refused: it would revive
 * the worker with its whole history, and it tends to redo its earlier steps.
 *
 * A `git apply` that went in (or a --3way apply whose conflicts are then resolved by hand) settles the patches it names
 * at once; the reverse check cannot recognise a patch that was edited while it was merged. Variables
 * (`P=x.patch; git apply $P`) are expanded first, and `git -C <dir> apply` counts like plain `git apply`. At a session
 * start a worker still `running` from an earlier omp process died with it: it is reported once, then settled so it does
 * not reappear as an open worker at every later session start.
 *
 * In workers the 1h cache TTL is dropped so worker prefixes use the 5-minute cache (a 1.25x write instead of 2x; workers
 * re-read within 5 minutes). External-impact commands (push, PR, publish, deploy, ssh, outbound writes) are blocked in
 * workers and handed back: the orchestrator judges and runs them (user decision 2026-10-14).
 *
 * The repeat guard fills in what each call returned, so an identical call whose output changes (a poll) is not counted
 * as a loop; that step runs before the main-session-only return, because workers are guarded too. A history idle for
 * longer than REPEAT_WINDOW_MS (or whose id was reused) starts over: a streak that old no longer describes a loop.
 * A call that is not part of the loop runs, joins the history and leaves no engaged cycle behind it; another element of
 * a blocked cycle stays blocked, because the history did not advance, so it is the same loop one step along.
 *
 * A main session whose cwd is inside an ovnfs checkout slot has the folder paths of its file tool calls moved to the
 * slot's copy (`slotCall`), with one notice per session once a redirected call succeeded; a write call that still names a
 * folder path after that is blocked with the slot path to use. Bash commands and workers are not rewritten.
 */
export function registerGuardHooks(pi: HostApi): void {
	let redirectTold = false;
	const redirectsInFlight = new Set<string>();
	let state: ProjectState | undefined;
	let budgetOkUntil = 0;
	let compactions = 0;
	const reviewedPatches = new Set<string>();
	const repeatRows = new Map<string, RepeatRow>();
	const failureRows = new Map<string, FailureRow>();
	const projectState = (ctx: HostCtx | undefined) => (state ??= loadState(String(ctx?.cwd ?? process.cwd())));
	const sessionIdOf = (ctx: HostCtx | undefined) => {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id !== "" ? id : undefined;
	};
	const repeatKey = (ctx: HostCtx | undefined) => String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.agent?.id ?? "");
	const failureRow = (ctx: HostCtx | undefined): FailureRow => {
		const key = repeatKey(ctx);
		const row = failureRows.get(key) ?? { history: [], blocked: false, told: false };
		failureRows.delete(key);
		failureRows.set(key, row);
		if (failureRows.size > REPEAT_MAX_SESSIONS) failureRows.delete(failureRows.keys().next().value as string);
		return row;
	};
	const refreshApplied = (current: ProjectState, session: string | undefined, extraDirs: string[] = [], history = false): boolean => {
		let changed = false;
		const dirs = [...new Set([...extraDirs, current.cwd])];
		const cache = new Map<string, string[]>();
		for (const [, worker] of workersOfSession(current, session)) {
			if (!worker.patch || worker.applied || !existsSync(worker.patch)) continue;
			if (patchIsApplied(dirs, worker.patch, cache) || (history && patchLanded(dirs, worker.patch))) {
				worker.applied = true;
				changed = true;
			}
		}
		return changed;
	};
	const injectState = (ctx: HostCtx | undefined, previousSession: boolean) => {
		const current = projectState(ctx);
		const settled = settleFinishedWorkers(ctx?.sessionManager?.getSessionFile?.(), current);
		const session = sessionIdOf(ctx);
		if (refreshApplied(current, session, [], true) || settled) saveState(current, sessionIdOf(ctx));
		const summary = stateSummary(current, previousSession, session);
		debug({ phase: "state-inject", previousSession, summary });
		if (summary) pi.sendMessage({ customType: "orchestrator-state", content: summary, display: true }, { deliverAs: "nextTurn" });
		if (previousSession) {
			let lost = false;
			for (const [, worker] of workersOfSession(current, session)) {
				if (worker.status === "running") lost = Boolean((worker.status = "lost"));
			}
			if (lost) saveState(current, sessionIdOf(ctx));
		}
	};

	pi.setLabel?.("Orchestrator guard");

	pi.on("session_start", (_event, ctx) => {
		if (ctx?.agent?.kind !== "main") return;
		state = undefined;
		injectState(ctx, true);
	});

	pi.on("tool_result", (event, ctx) => {
		try {
			const id = String(event?.toolCallId ?? "");
			const call = [...(repeatRows.get(repeatKey(ctx))?.calls ?? [])].reverse().find(c => (id ? c.id === id : !c.result && c.tool === event?.toolName && c.args === repeatArgsDigest(c.tool, event?.input)));
			if (call) call.result = repeatResultDigest(event?.content);
		} catch (error) {
			debug({ phase: "repeat-result-error", message: String(error) });
		}
		const noticeCall = `${envNoticeKey(ctx)}\u0000${String(event?.toolCallId ?? "")}`;
		if (envNoticesInFlight.delete(noticeCall) && !event?.isError) {
			if (workersToldOfEnvPrefix.size > 1000) workersToldOfEnvPrefix.clear();
			workersToldOfEnvPrefix.add(envNoticeKey(ctx));
		}
		if (redirectsInFlight.delete(String(event?.toolCallId ?? "")) && !event?.isError) redirectTold = true;
		if (ctx?.agent?.kind !== "main") return;
		const current = projectState(ctx);
		const text = textBlocks(event.content).join("\n");
		const toolInput = fieldsOf(event.input);
		const command = expandShellVars(textOf(toolInput.command));
		if (event.toolName === "bash" && runsGitApply(command) && (!event.isError || (/--3way/.test(command) && /with conflicts/i.test(text)))) {
			const named = appliedPatchNames(command);
			let marked = false;
			for (const [, worker] of workersOfSession(current, sessionIdOf(ctx))) {
				if (worker.patch && !worker.applied && named.includes(basename(worker.patch))) marked = worker.applied = true;
			}
			if (marked) saveState(current, sessionIdOf(ctx));
		}
		if (event?.isError) return;
		if (event.toolName === "task") {
			const progress = fieldsOf(event.details).progress;
			const fromDetails = (Array.isArray(progress) ? progress : [])
				.map(entry => fieldsOf(entry).id ?? fieldsOf(entry).agentId)
				.filter((id): id is string => typeof id === "string" && id !== "");
			const ids = fromDetails.length
				? fromDetails
				: [...new Set([...text.matchAll(/Spawned agent `([^`]+)`/g), ...text.matchAll(/^\s*- `([^`]+)` \(job `[^`]+`\)/gm)].map(m => m[1]))];
			const items = Array.isArray(toolInput.tasks) ? toolInput.tasks : [];
			const session = sessionIdOf(ctx);
			ids.forEach((id, i) => {
				if (current.settled) delete current.settled[id];
				const task = fieldsOf(items[i]).task;
				current.workers[id] ??= { brief: briefLabel(task), spawnedAt: Date.now(), status: "running", ...(session ? { session } : {}), ...(typeof task === "string" ? { items: changeItems(task) } : {}) };
			});
			debug({ phase: "state-spawn", ids });
		}
		const settledByText = settleFromText(current, text, sessionIdOf(ctx));
		const sized = measureFinishedWorkers(ctx?.sessionManager?.getSessionFile?.(), current);
		if (settledByText || sized || event.toolName === "task") saveState(current, sessionIdOf(ctx));
		if (event.toolName === "bash" && runsGitApply(command) && refreshApplied(current, sessionIdOf(ctx), applyDirsOf(command, resolve(current.cwd, textOf(toolInput.cwd))))) {
			debug({ phase: "state-applied" });
			saveState(current, sessionIdOf(ctx));
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (ctx?.agent?.kind !== "sub") return;
		try {
			const content = capToolResult(String(event?.toolName ?? ""), event?.content, event?.details, spillToStateDir);
			return content ? { content } : undefined;
		} catch (error) {
			debug({ phase: "output-cap-error", message: String(error) });
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (event?.toolName !== "bash") return;
		try {
			const row = failureRow(ctx);
			row.history = [...row.history, bashOutcome(event)].slice(-FAILURE_HISTORY);
			const streak = failureStreak(row.history, FAILURE_NO_NEXT);
			if (!streak.notice) row.blocked = row.told = false;
			else if (!row.told) {
				row.told = true;
				return { content: [...(Array.isArray(event.content) ? event.content : []), { type: "text", text: `orchestrator-guard: ${streak.notice}` }] };
			}
		} catch (error) {
			debug({ phase: "failure-streak-error", message: String(error) });
		}
	});

	pi.registerCommand("budget-ok", {
		description: "Allow worker spawns for 30 minutes despite a low Anthropic quota (orchestrator-guard budget gate).",
		handler: async (_args: unknown, ctx: HostCtx) => {
			budgetOkUntil = Date.now() + BUDGET_OK_MS;
			ctx.ui?.notify?.(say({ en: "orchestrator-guard: worker spawns allowed for 30 minutes despite low quota.", ko: "orchestrator-guard: 사용량이 부족해도 30분 동안 워커 생성을 허용합니다." }), "info");
		},
	});

	pi.registerCommand("compact-switch", {
		description: "Compact on the current model first (its cache is still warm), then switch: /compact-switch provider/model[:thinking]",
		handler: async (args: unknown, ctx: HostCtx) => {
			const selector = String(args ?? "").trim();
			const parts = selector.match(/^([^/\s]+)\/([^:\s]+)(?::(\w+))?$/);
			debug({ phase: "switch-start", selector, parsed: Boolean(parts), tokens: contextTokens(ctx), usage: ctx?.getContextUsage?.() });
			if (!parts) return ctx.ui?.notify?.(say({ en: "usage: /compact-switch provider/model[:thinking], e.g. /compact-switch anthropic/claude-opus-5-5:medium", ko: "사용법: /compact-switch provider/model[:thinking], 예: /compact-switch anthropic/claude-opus-5-5:medium" }), "warning");
			const model = ctx.modelRegistry?.find?.(parts[1], parts[2]);
			if (!model) return ctx.ui?.notify?.(say({ en: `orchestrator-guard: model ${parts[1]}/${parts[2]} not found`, ko: `orchestrator-guard: 모델 ${parts[1]}/${parts[2]}을(를) 찾지 못했습니다` }), "warning");
			const tokens = contextTokens(ctx);
			try {
				if (tokens >= SWITCH_COMPACT_MIN_TOKENS) {
					try {
						if (!ctx.compact) throw new Error("this session offers no compact(), so the model was not switched");
						await ctx.compact({ suppressContinuation: true });
					} catch (error) {
						if (!/Nothing to compact|NoOp/i.test(`${(error as Error)?.name} ${(error as Error)?.message}`)) throw error;
						debug({ phase: "switch-compact-noop" });
					}
				}
				if (!(await pi.setModel?.(model))) return ctx.ui?.notify?.(say({ en: `orchestrator-guard: could not switch to ${selector}`, ko: `orchestrator-guard: ${selector}(으)로 전환하지 못했습니다` }), "warning");
				if (parts[3]) pi.setThinkingLevel?.(parts[3]);
				debug({ phase: "switch", selector, tokensBefore: tokens, tokensAfter: contextTokens(ctx) });
				const after = Math.round(contextTokens(ctx) / 1000);
				const before = Math.round(tokens / 1000);
				ctx.ui?.notify?.(say({ en: `orchestrator-guard: switched to ${selector} (context ${before}K -> ${after}K)`, ko: `orchestrator-guard: ${selector}(으)로 전환했습니다(컨텍스트 ${before}K -> ${after}K)` }), "info");
			} catch (error) {
				debug({ phase: "switch-error", message: String(error) });
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui?.notify?.(say({ en: `orchestrator-guard: switch aborted, model unchanged (${reason})`, ko: `orchestrator-guard: 전환이 중단되어 모델은 그대로입니다(${reason})` }), "warning");
			}
		},
	});

	pi.on("session_compact", (_event, ctx) => {
		if (ctx?.agent?.kind === "main") return injectState(ctx, false);
		if (ctx?.agent?.kind !== "sub") return;
		compactions++;
		debug({ phase: "sub-compact", agent: ctx.agent.id, compactions });
		if (compactions === 1) pi.sendUserMessage(WRAP_UP_STEER, { deliverAs: "steer" });
		else if (compactions === 2) pi.sendUserMessage(STOP_REASON, { deliverAs: "steer" });
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx?.agent?.kind !== "sub" || !event?.payload) return;
		const payload = structuredClone(event.payload);
		const dropped = dropLongTtl(payload);
		debug({ phase: "sub-cache", agent: ctx.agent.id, dropped });
		return dropped ? payload : undefined;
	});

	const repeatGuard = async (event: ToolEvent, ctx: HostCtx): Promise<Block | undefined> => {
		try {
			const tool = String(event?.toolName ?? "");
			const args = repeatArgsDigest(tool, event?.input);
			if (!args) return;
			const now = Date.now();
			const key = repeatKey(ctx);
			let row = repeatRows.get(key);
			if (!row || now - row.seen > REPEAT_WINDOW_MS) row = { calls: [], blocked: 0, seen: now };
			row.seen = now;
			repeatRows.delete(key);
			repeatRows.set(key, row);
			if (repeatRows.size > REPEAT_MAX_SESSIONS) repeatRows.delete(repeatRows.keys().next().value as string);
			const cand: RepeatCall = { tool, args, result: "", id: String(event?.toolCallId ?? "") };
			const tentative = [...row.calls, cand];
			const cycle = detectCycle(tentative);
			let engaged = row.engaged;
			if (cycle && cycle[1] >= requiredLaps(cycle[0])) {
				const [period, laps] = cycle;
				const elements = tentative.slice(-period);
				const sig = elements.map(c => `${c.tool}\0${c.args}`).sort().join("\n");
				if (engaged?.sig !== sig) row.blocked = 0;
				engaged = row.engaged = { sig, elements, ran: period * laps - 1, compared: tentative.slice(-period * laps, -1).every(c => c.result) };
			} else if (!engaged?.elements.some(c => c.tool === tool && c.args === args)) {
				row.calls = tentative.slice(-REPEAT_HISTORY);
				row.engaged = undefined;
				row.blocked = 0;
				return;
			}
			if (!engaged) return;
			const ignored = row.blocked++;
			debug({ phase: "repeat-block", agent: ctx?.agent?.id, tool, ignored, ran: engaged.ran });
			if (ignored < REPEAT_ESCALATION_ATTEMPTS) return block(ctx, "repeat-block", tool, event?.input, repeatBlockReason(engaged));
			if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function" || process.env.DOTZ_LANE || process.env.DOTZ_ORCHESTRATOR === "1") return block(ctx, "repeat-stop-block", tool, event?.input, repeatStopReason(engaged, ignored));
			const allowed = await ctx.ui.confirm("Repeat guard", `${repeatSubject(engaged.elements, engaged.ran)}, and ${ignored} further attempts were blocked. Allow this call once more? Denying ends the repetition.`, { timeout: 60_000 });
			if (allowed !== true) return block(ctx, "repeat-denied-block", tool, event?.input, `orchestrator-guard repeat guard: the owner denied (or did not answer) this repeated call. ${repeatBlockReason(engaged)}`);
			row.calls = [cand];
			row.engaged = undefined;
			row.blocked = 0;
		} catch (error) {
			debug({ phase: "repeat-error", message: String(error) });
		}
	};

	const guardToolCall = async (event: ToolEvent, ctx: HostCtx): Promise<ToolCallVerdict> => {
		const tool = String(event?.toolName ?? "");
		const toolInput = fieldsOf(event?.input);
		const deny = (phase: string, reason: string) => block(ctx, phase, tool, event?.input, reason);
		if (ctx?.agent?.kind === "sub" && compactions >= 2) {
			debug({ phase: "sub-stop-block", agent: ctx.agent.id, tool });
			return deny("sub-stop-block", STOP_REASON);
		}
		const evidence = evidenceWriteProblem(tool, event?.input);
		if (evidence) {
			debug({ phase: "evidence-write-block", agent: ctx?.agent?.id, tool });
			return deny("evidence-write-block", evidence);
		}
		if (tool === "bash") {
			const machine = machineRuleProblem(expandShellVars(textOf(toolInput.command)));
			if (machine) {
				debug({ phase: "machine-rule-block", agent: ctx?.agent?.id });
				return deny("machine-rule-block", machine);
			}
			const bare = expandShellVars(textOf(toolInput.command).replace(WORKER_ENV_PREFIX, ""));
			const removal = deletionProblem(bare, resolve(String(ctx?.cwd ?? process.cwd()), textOf(toolInput.cwd)), homedir());
			if (removal) {
				debug({ phase: "deletion-block", agent: ctx?.agent?.id });
				return deny("deletion-block", removal);
			}
			const failures = failureRow(ctx);
			const repeated = failureStreak(failures.history, bare).block;
			if (repeated && !failures.blocked) {
				failures.blocked = true;
				debug({ phase: "failure-streak-block", agent: ctx?.agent?.id });
				return deny("failure-streak-block", `orchestrator-guard: ${repeated}`);
			}
		}
		if (ctx?.agent?.kind === "sub" && tool === "eval") {
			const kind = evalExternalAction(textOf(toolInput.code));
			if (kind) {
				debug({ phase: "sub-eval-block", agent: ctx.agent.id, kind });
				return deny("sub-eval-block", externalActionReason(kind));
			}
		}
		let workerInput: WorkerInput | undefined;
		if (ctx?.agent?.kind === "sub" && tool === "bash") {
			const envFile = workerEnvFile();
			const raw = textOf(toolInput.command);
			const own = workerEnvPrefix(envFile);
			const kind = externalAction(expandShellVars(raw.startsWith(own) ? raw.slice(own.length) : raw));
			if (kind) {
				debug({ phase: "sub-external-block", agent: ctx.agent.id, kind });
				return deny("sub-external-block", externalActionReason(kind));
			}
			const problem = workerEnvProblem(envFile);
			if (problem) {
				debug({ phase: "worker-env-block", agent: ctx.agent.id, envFile });
				return deny("worker-env-block", `orchestrator-guard: worker bash is blocked because ${problem} (every worker command runs after sourcing it). Finish what needs no shell and say in your final answer that bash was unavailable.`);
			}
			const revised = workerBashInput(toolInput, envFile);
			if (revised !== toolInput) {
				const worker = envNoticeKey(ctx);
				if (workersToldOfEnvPrefix.has(worker)) workerInput = { input: revised };
				else {
					if (envNoticesInFlight.size > 1000) envNoticesInFlight.clear();
					envNoticesInFlight.add(`${worker}\u0000${String(event?.toolCallId ?? "")}`);
					workerInput = { input: revised, additionalContext: WORKER_ENV_NOTICE };
				}
			}
		}
		if (ctx?.agent?.kind !== "main") return workerInput;
		const publishing = tool === "bash" ? externalAction(expandShellVars(textOf(toolInput.command).replace(WORKER_ENV_PREFIX, "")), 0, new Map(), true) : tool === "eval" ? evalExternalAction(textOf(toolInput.code), 0, undefined, undefined, true) : undefined;
		if (publishing) {
			const open = openMistakeProblem(mistakeSessionKey(ctx), publishing);
			if (open) {
				debug({ phase: "open-mistake-block", kind: publishing });
				return deny("open-mistake-block", open);
			}
		}
		let mainInput: { input: Fields } | undefined;
		if (tool === "bash" && typeof toolInput.command === "string") {
			const command = toolInput.command.replace(WORKER_ENV_PREFIX, "");
			if (sourcesWorkerEnv(command)) return deny("worker-env-leak-block", "orchestrator-guard: this command sources worker-env.sh, the env of worker shells: every git push, wrangler call and the like would fail in this session from then on. Run the command without the `. worker-env.sh` part.");
			const current = projectState(ctx);
			if (settleFinishedWorkers(ctx?.sessionManager?.getSessionFile?.(), current)) saveState(current, sessionIdOf(ctx));
			const running = workersOfSession(current, sessionIdOf(ctx)).filter(([, worker]) => worker.status === "running" && Date.now() - worker.spawnedAt < RUNNING_JOB_MAX_AGE_MS).length;
			const polling = pollingProblem(expandShellVars(command), running);
			if (polling) {
				debug({ phase: "polling-block", running });
				return deny("polling-block", `orchestrator-guard: ${polling}`);
			}
			if (command !== toolInput.command) mainInput = { input: { ...toolInput, command } };
		}
		const target = /^agent:\/\/([^/?#]+)/.exec(textOf(toolInput.path))?.[1];
		if (tool === "write" && target && target !== "all") {
			const worker = workersOfSession(projectState(ctx), sessionIdOf(ctx)).find(([id]) => id === target)?.[1];
			if (worker && worker.status !== "running") {
				debug({ phase: "finished-worker-message-block", target, status: worker.status });
				return deny("finished-worker-message-block", `orchestrator-guard: worker ${target} already ${worker.status}; a message would revive it and it may redo its earlier work. Spawn a new worker for the follow-up (task) with only the new step.`);
			}
		}
		if (tool === "task") {
			const taskCwd = String(ctx?.cwd ?? process.cwd());
			const isolate = inGitRepo(taskCwd);
			const verdict = checkTaskInput(event.input, isolate, isolate ? checkoutRoots(taskCwd) : []);
			debug({ phase: "task", verdict });
			if ("reason" in verdict) return deny("brief-block", verdict.reason);
			const sent = fieldsOf(verdict.input);
			const tiers = tierData();
			const candidates = roleSelectors();
			const notices: string[] = [];
			const taskItems: Fields[] = [];
			const sizes = projectState(ctx);
			if (measureFinishedWorkers(ctx?.sessionManager?.getSessionFile?.(), sizes)) saveState(sizes);
			const original = Array.isArray(toolInput.tasks) ? toolInput.tasks : [];
			for (const [index, raw] of (Array.isArray(sent.tasks) ? sent.tasks : []).entries()) {
				let item = fieldsOf(raw);
				const name = item.name;
				const brief = fieldsOf(original[index]).task;
				const sizeProblem = typeof name === "string" && name !== "" && typeof brief === "string" ? familyProblem(sizes, name, changeItems(brief)) : undefined;
				if (sizeProblem) return deny("worker-size-block", sizeProblem);
				const agent = typeof item.agent === "string" ? item.agent : "task";
				const effort = typeof item.effort === "string" ? item.effort : undefined;
				const asked = typeof item.model === "string" && item.model.trim() !== "" ? item.model : undefined;
				const askedSetup = effortSetupOfAgent(agent);
				const escalating = (): string | undefined => escalationProblem(name, [...Object.keys(sizes.workers), ...(sizes.finished ?? []).map(entry => entry.id), ...Object.keys(sizes.settled ?? {})]);
				if (asked !== undefined) {
					const escalate = (selector: string) => escalationTarget(tiers, selector, candidates);
					const problem = modelProblem(asked, askedSetup, escalate);
					if (problem) return deny("model-block", problem);
					const target = askedSetup.overridden || askedSetup.roleSelector === undefined ? undefined : escalate(askedSetup.roleSelector);
					if (target !== undefined && asked.trim() === target && target !== askedSetup.roleSelector) {
						const unproven = escalating();
						if (unproven) return deny("escalation-block", unproven);
					}
				}
				if (effort !== undefined) {
					const pinned = typeof item.model === "string" && /:[a-z]+$/i.test(item.model) ? item.model : undefined;
					const action = effortAction(effort, typeof item.model === "string" ? { ...askedSetup, roleSelector: pinned ?? askedSetup.roleSelector, overridden: true } : askedSetup, selector => escalationTarget(tiers, selector, candidates));
					if (action.kind === "refuse") return deny("effort-block", action.problem);
					if (action.kind === "rewrite") {
						const unproven = escalating();
						if (unproven) return deny("escalation-block", unproven);
						item = { ...item, model: action.model };
						delete item.effort;
						notices.push(say({ en: `effort "${effort}" on agent ${agent} asks for more than the role level of ${action.from}; it runs ${action.model} instead, a cheaper point than the same model one level up.`, ko: `agent ${agent}의 effort "${effort}"는 역할 기본값 ${action.from}보다 높아서, 같은 모델을 한 단계 올리는 것보다 싼 ${action.model}에서 실행하도록 바꿨습니다.` }));
					}
				}
				taskItems.push(item);
			}
			if (Date.now() >= budgetOkUntil) {
				const workers = Array.isArray(toolInput.tasks) ? toolInput.tasks.length : 1;
				const limits = await anthropicLimits();
				const est = estimateFrom(event.input);
				const problem = limits ? budgetProblem(limits, workers, est) : undefined;
				debug({ phase: "budget", workers, est, problem, haveLimits: Boolean(limits) });
				for (const item of taskItems) {
					const fable = limits ? deepBudgetProblem(limits, typeof item.agent === "string" ? item.agent : "task", typeof item.model === "string" ? item.model : undefined) : undefined;
					if (fable) return deny("fable-block", fable);
				}
				if (problem)
					return deny("budget-block", `orchestrator-guard budget gate: ${problem}. Stop and ask the user, showing the 5h and 7d remaining %: "지금 해 / 리셋 후 / 줄여서 해". 지금 해 -> they run /budget-ok (30 min); 줄여서 해 -> fewer workers or a smaller "Estimate: N%" line.`);
			}
			const named = reviewedPatchesIn(event.input);
			if (named.length) {
				const current = projectState(ctx);
				current.reviewerNamed = [...new Set([...(current.reviewerNamed ?? []), ...named])];
				saveState(current, sessionIdOf(ctx));
			}
			const additionalContext = [verdict.notice, ...notices, sizeNote(sizes)].filter(Boolean).join(" ");
			return { input: notices.length ? { ...sent, tasks: taskItems } : verdict.input, ...(additionalContext ? { additionalContext } : {}) };
		}
		const path = textOf(toolInput.path);
		if (tool === "read" && /\.patch(:|$)/.test(path)) reviewedPatches.add(patchKey(path));
		if (tool === "bash") {
			const command = expandShellVars(textOf(mainInput?.input.command ?? toolInput.command));
			const base = String(toolInput.cwd ?? ".");
			for (const shown of command.matchAll(/\b(?:cat|bat|less|head|diff)\b[^|;&]*?(\S+\.patch)/g)) reviewedPatches.add(patchKey(shown[1], base));
			const applying = patchesApplying(command);
			const unreviewed = applying.filter(patch => !reviewedPatches.has(patchKey(patch, base)));
			if (unreviewed.length) {
				debug({ phase: "apply-block", unreviewed });
				return deny("apply-block", `orchestrator-guard: review before apply. Read ${unreviewed.join(", ")} first (read tool), check it matches the brief, then apply. For large or risky patches spawn the reviewer agent.`);
			}
			const reviewerNamed = new Set(projectState(ctx).reviewerNamed ?? []);
			for (const patch of applying) {
				const file = patchKey(patch, base);
				const size = existsSync(file) ? patchChangedLines(readFileSync(file, "utf8")) : 0;
				const oversized = reviewProblem(file, size, reviewerNamed);
				if (oversized) {
					debug({ phase: "review-size-block", patch: file, size });
					return deny("review-size-block", oversized);
				}
			}
		}
		const sessionCwd = String(ctx?.cwd ?? process.cwd());
		const slotted = slotCall(sessionCwd, tool, event?.input);
		if (slotted.placement !== undefined) {
			const stray = folderWrites(slotted.placement, tool, slotted.input, sessionCwd);
			if (stray.length > 0) {
				debug({ phase: "slot-write-block", tool, paths: stray.length });
				const named = stray.map(path => (path.above === true ? `${path.named} (above the folder, so it can reach it: scope the call to the checkout, ${path.use})` : `${path.named} (use ${path.use})`));
				return deny("slot-write-block", `orchestrator-guard: this session works in its own checkout, and ${tool} names ${named.join(", ")} outside it. A write to the folder would bypass the checkout; name the checkout's path instead.`);
			}
			if (slotted.moved.length > 0) {
				debug({ phase: "slot-redirect", tool, moved: slotted.moved.length });
				const input = fieldsOf(slotted.input);
				if (redirectTold) return { input };
				if (redirectsInFlight.size > 1000) redirectsInFlight.clear();
				redirectsInFlight.add(String(event?.toolCallId ?? ""));
				return { input, additionalContext: SLOT_REDIRECT_NOTICE };
			}
		}
		return mainInput;
	};

	pi.on("tool_call", async (event, ctx) => {
		const verdict = await guardToolCall(event, ctx);
		if (verdict && "block" in verdict) return verdict;
		return (await repeatGuard(event, ctx)) ?? verdict;
	});

	pi.on("context", (event, ctx) => {
		if (ctx?.agent?.kind !== "main" || !Array.isArray(event?.messages)) return;
		const current = projectState(ctx);
		let settled = false;
		for (const message of event.messages) {
			const content = fieldsOf(message).content;
			const text = typeof content === "string" ? content : textBlocks(content).join("\n");
			if (text.includes("<task-result") && settleFromText(current, text, sessionIdOf(ctx))) settled = true;
		}
		if (settled) saveState(current, sessionIdOf(ctx));
		let trimmed = 0;
		const trim = (text: string) => {
			const next = trimWaitOutput(text);
			if (next !== text) trimmed++;
			return next;
		};
		const messages = event.messages.map((message: unknown) => {
			const fields = fieldsOf(message);
			if (typeof fields.content === "string") return { ...fields, content: trim(fields.content) };
			if (!Array.isArray(fields.content)) return message;
			return {
				...fields,
				content: fields.content.map((entry: unknown) => {
					const part = fieldsOf(entry);
					return part.type === "text" && typeof part.text === "string" ? { ...part, text: trim(part.text) } : entry;
				}),
			};
		});
		if (trimmed) debug({ phase: "context-trim", trimmed });
		return trimmed ? { messages } : undefined;
	});

	pi.on("auto_retry_start", (event: RetryStartEvent, ctx) => {
		try {
			if (!usageWaitAborts(ctx?.agent?.kind, event?.delayMs)) return;
			debug({ phase: "usage-wait-abort", delayMs: event.delayMs, errorMessage: String(event?.errorMessage ?? "").slice(0, 200) });
			setTimeout(() => {
				try {
					ctx.abort?.();
				} catch (error) {
					debug({ phase: "usage-wait-error", message: String(error) });
				}
			}, 0).unref?.();
		} catch (error) {
			debug({ phase: "usage-wait-error", message: String(error) });
		}
	});

	registerLimitWatch(pi);
}
