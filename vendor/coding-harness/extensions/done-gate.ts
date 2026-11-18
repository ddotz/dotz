import { join } from "node:path";
import { declineBootstrap, undoDeclineBootstrap } from "../harness/gate/bootstrap.ts";
import { runBoundaries } from "../harness/gate/boundaries.ts";
import type { BoundariesAction } from "../harness/gate/boundaries.ts";
import { handlerDeadline } from "../harness/gate/deadline.ts";
import { createDoneGate } from "../harness/gate/engine.ts";
import type { DoneGate } from "../harness/gate/engine.ts";
import { cwdOf, notify, sessionKey } from "../harness/gate/host.ts";
import type { Api, Ctx } from "../harness/gate/host.ts";
import { registerMistakes } from "../harness/gate/mistakes.ts";
import { runShell } from "../harness/gate/runs.ts";
import { repoOfDir } from "../harness/gate/session.ts";
import type { Stages } from "../harness/gate/stages.ts";
import { message } from "../harness/gate/util.ts";

const BOUNDARIES_DEADLINE_MS = 30_000;

async function decline(ctx: Ctx, args: string): Promise<void> {
	const undo = args === "undo";
	if (args !== "" && !undo) return notify(ctx, "done-gate: usage: /gate-decline [undo]; nothing was recorded.", "warning");
	const dir = cwdOf(ctx);
	const signal = handlerDeadline();
	const repo = await repoOfDir(new Map(), dir, signal);
	if (repo === undefined) return notify(ctx, signal.aborted ? `done-gate: the git repo of ${dir} was not found in time; nothing was recorded.` : `done-gate: ${dir} is not inside a git repo; nothing was recorded.`, "warning");
	try {
		if (undo) {
			const removed = await undoDeclineBootstrap(repo);
			return notify(ctx, removed ? `done-gate: the decline of ${repo} is removed; the gate asks for a gate file there again.` : `done-gate: ${repo} is not declined; nothing was changed.`, "info");
		}
		await declineBootstrap(repo);
	} catch (error) {
		return notify(ctx, `done-gate: the decline for ${repo} could not be ${undo ? "removed" : "recorded"}: ${message(error)}`, "warning");
	}
	notify(ctx, `done-gate: ${repo} is declined; the gate will not ask for a gate file in any checkout of this repo.`, "info");
}

async function boundaries(ctx: Ctx, args: string): Promise<void> {
	const [verb, id, ...extra] = args.split(/\s+/).filter(Boolean);
	const action: BoundariesAction | undefined = verb === undefined ? { kind: "list" } : (verb === "accept" || verb === "reject") && id !== undefined && extra.length === 0 ? { kind: verb, id } : undefined;
	if (action === undefined) return notify(ctx, "done-gate: usage: /gate-boundaries [accept <id> | reject <id>]; nothing was changed.", "warning");
	const dir = cwdOf(ctx);
	const signal = AbortSignal.timeout(BOUNDARIES_DEADLINE_MS);
	const repo = await repoOfDir(new Map(), dir, signal);
	if (repo === undefined) return notify(ctx, signal.aborted ? `done-gate: the git repo of ${dir} was not found in time; nothing was changed.` : `done-gate: ${dir} is not inside a git repo; nothing was changed.`, "warning");
	const result = await runBoundaries({ repo, action, signal });
	notify(ctx, `done-gate: ${result.message}`, result.ok ? "info" : "warning");
}

/** Registers the done gate's handlers and the /gate-ok, /gate-decline and /gate-boundaries commands on `pi` and returns the gate, whose `sessionChanges` the mistake obligations read. */
export function registerDoneGate(pi: Api, stages?: Stages): DoneGate {
	const gate = createDoneGate(stages, message => pi.sendMessage(message, { deliverAs: "aside", triggerTurn: true }));
	pi.on("before_agent_start", gate.handlers.before_agent_start);
	pi.on("agent_start", gate.handlers.agent_start);
	pi.on("agent_end", gate.handlers.agent_end);
	pi.on("assistant_message", gate.handlers.assistant_message);
	pi.on("tool_call", gate.handlers.tool_call);
	pi.on("tool_result", gate.handlers.tool_result);
	pi.on("session_stop", gate.handlers.session_stop);
	pi.on("session_switch", gate.handlers.session_switch);
	pi.on("session_branch", gate.handlers.session_branch);
	pi.on("session_shutdown", gate.handlers.session_shutdown);
	pi.registerCommand("gate-ok", {
		description: "Let the next stop of this session through whatever the done gate finds, logged as user-waived: /gate-ok [reason]",
		handler: async (args, ctx) => {
			const reason = String(args ?? "").trim() || "no reason given";
			if (!gate.waive(ctx, reason)) return notify(ctx, "done-gate: /gate-ok applies to the main session only.", "warning");
			notify(ctx, `done-gate: the next stop of this session is allowed whatever it finds (${reason}); it is logged as user-waived.`, "info");
		},
	});
	pi.registerCommand("gate-decline", {
		description: "Stop the done gate from asking for a gate file in the repo of this session's working directory, in every checkout of it: /gate-decline; /gate-decline undo takes the decline back",
		handler: (args, ctx) => decline(ctx, String(args ?? "").trim()),
	});
	pi.registerCommand("gate-boundaries", {
		description: "List the boundary rules drafted from the import graph of the repo of this session's working directory (they are drafted first when there are none, and refuse nothing until accepted): /gate-boundaries; /gate-boundaries accept <id> moves one into the rule kit and adopts it, /gate-boundaries reject <id> deletes it for good",
		handler: (args, ctx) => boundaries(ctx, String(args ?? "").trim()),
	});
	return gate;
}

/**
 * The done gate: a main session cannot finish while the lines it added carry a new comment, a suppression, a skipped test or a
 * weakened gate, while the repo's rules or declared checks fail, while required evidence is missing, or while a recorded mistake
 * has no check. A run starts with an agent loop that does not continue one (a prompt, a /mistake or advisor turn; not a steering
 * message, the continuation after a refused stop, or the wake after background jobs): it baselines the cwd repo and every repo the
 * session has seen, and any other repo a run touches is baselined at first sight. The lines a session added are measured against
 * the text each file held at the run's base point. Every edit gets the same findings back at once. Starting omp with
 * DONE_GATE_DISABLED=1 in its environment registers nothing: the switch for the user, out of reach of the session's agent.
 * A reply that cites a principle skill (principle-<kebab>) the run did not read through a skill:// URL is refused too, and so is
 * one with markdown the terminal shows raw (bold, a # heading, a table) outside fenced code, once per run. A reply in another
 * script than the user's last prompt (`report:language`), and the last reply of a run that was refused for work, whose
 * message answered the gate and not the user (`report:after-refusal`), are refused once per run too. A reply that is exactly
 * `ok`, `-` or `[later]` (the dotz protocol answers) passes both reply stages. In a dotz session (`DOTZ_RUNTIME` set and not
 * empty) the gate skips the `plain` stage, the whole `report` stage and the skill://ulw reminder; every other stage stays.
 */
export default function doneGate(pi: Api): void {
	if (process.env.DONE_GATE_DISABLED === "1") return;
	const gate = registerDoneGate(pi);
	registerMistakes(pi, {
		sessionId: sessionKey,
		changedFiles: async ctx => (await gate.sessionChanges(ctx)).flatMap(change => change.files.map(file => join(change.repo, file))),
		bases: async ctx => (await gate.sessionChanges(ctx)).flatMap(change => (change.error === undefined && change.base ? [{ repo: change.repo, base: change.base }] : [])),
		run: runShell,
	});
}
