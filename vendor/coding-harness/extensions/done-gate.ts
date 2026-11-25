import { join } from "node:path";
import { declineBootstrap, undoDeclineBootstrap } from "../harness/gate/bootstrap.ts";
import { runBoundaries } from "../harness/gate/boundaries.ts";
import type { BoundariesAction } from "../harness/gate/boundaries.ts";
import { handlerDeadline } from "../harness/gate/deadline.ts";
import { createDoneGate } from "../harness/gate/engine.ts";
import type { DoneGate } from "../harness/gate/engine.ts";
import { cwdOf, notify, sessionKey } from "../harness/gate/host.ts";
import { say } from "../harness/notice.ts";
import { showReport } from "../harness/gate/show-report.ts";
import { renderReply } from "../harness/gate/superseded.ts";
import type { Api, Ctx } from "../harness/gate/host.ts";
import { registerMistakes } from "../harness/gate/mistakes.ts";
import { runShell } from "../harness/gate/runs.ts";
import { repoOfDir } from "../harness/gate/session.ts";
import type { Stages } from "../harness/gate/stages.ts";
import { message } from "../harness/gate/util.ts";

const BOUNDARIES_DEADLINE_MS = 30_000;

async function decline(ctx: Ctx, args: string): Promise<void> {
	const undo = args === "undo";
	if (args !== "" && !undo) return notify(ctx, say({ en: "done-gate: usage: /gate-decline [undo]; nothing was recorded.", ko: "done-gate: 사용법: /gate-decline [undo]. 아무것도 기록하지 않았습니다." }), "warning");
	const dir = cwdOf(ctx);
	const signal = handlerDeadline();
	const repo = await repoOfDir(new Map(), dir, signal);
	if (repo === undefined) return notify(ctx, signal.aborted ? say({ en: `done-gate: the git repo of ${dir} was not found in time; nothing was recorded.`, ko: `done-gate: ${dir}의 git 저장소를 제때 찾지 못했습니다. 아무것도 기록하지 않았습니다.` }) : say({ en: `done-gate: ${dir} is not inside a git repo; nothing was recorded.`, ko: `done-gate: ${dir}은(는) git 저장소 안에 있지 않습니다. 아무것도 기록하지 않았습니다.` }), "warning");
	try {
		if (undo) {
			const removed = await undoDeclineBootstrap(repo);
			return notify(ctx, removed ? say({ en: `done-gate: the decline of ${repo} is removed; the gate asks for a gate file there again.`, ko: `done-gate: ${repo}의 거부 설정을 해제했습니다. 게이트가 다시 게이트 파일을 요청합니다.` }) : say({ en: `done-gate: ${repo} is not declined; nothing was changed.`, ko: `done-gate: ${repo}은(는) 거부 상태가 아닙니다. 바뀐 것은 없습니다.` }), "info");
		}
		await declineBootstrap(repo);
	} catch (error) {
		return notify(ctx, say({ en: `done-gate: the decline for ${repo} could not be ${undo ? "removed" : "recorded"}: ${message(error)}`, ko: `done-gate: ${repo}의 거부 설정을 ${undo ? "해제" : "기록"}하지 못했습니다: ${message(error)}` }), "warning");
	}
	notify(ctx, say({ en: `done-gate: ${repo} is declined; the gate will not ask for a gate file in any checkout of this repo.`, ko: `done-gate: ${repo}을(를) 거부했습니다. 게이트는 이 저장소의 어떤 체크아웃에서도 게이트 파일을 요청하지 않습니다.` }), "info");
}

async function boundaries(pi: Api, ctx: Ctx, args: string): Promise<void> {
	const [verb, id, ...extra] = args.split(/\s+/).filter(Boolean);
	const action: BoundariesAction | undefined = verb === undefined ? { kind: "list" } : (verb === "accept" || verb === "reject") && id !== undefined && extra.length === 0 ? { kind: verb, id } : undefined;
	if (action === undefined) return notify(ctx, say({ en: "done-gate: usage: /gate-boundaries [accept <id> | reject <id>]; nothing was changed.", ko: "done-gate: 사용법: /gate-boundaries [accept <id> | reject <id>]. 바뀐 것은 없습니다." }), "warning");
	const dir = cwdOf(ctx);
	const signal = AbortSignal.timeout(BOUNDARIES_DEADLINE_MS);
	const repo = await repoOfDir(new Map(), dir, signal);
	if (repo === undefined) return notify(ctx, signal.aborted ? say({ en: `done-gate: the git repo of ${dir} was not found in time; nothing was changed.`, ko: `done-gate: ${dir}의 git 저장소를 제때 찾지 못했습니다. 바뀐 것은 없습니다.` }) : say({ en: `done-gate: ${dir} is not inside a git repo; nothing was changed.`, ko: `done-gate: ${dir}은(는) git 저장소 안에 있지 않습니다. 바뀐 것은 없습니다.` }), "warning");
	const result = await runBoundaries({ repo, action, signal });
	showReport(pi, ctx, { title: "gate-boundaries", markdown: result.message, level: result.ok ? "info" : "warning" });
}

/** Registers the done gate's handlers, the assistant text renderer that folds a reply the gate sent back into one row, and the /gate-ok, /gate-decline, /gate-boundaries and /gate-show commands on `pi`, and returns the gate, whose `sessionChanges` the mistake obligations read. */
export function registerDoneGate(pi: Api, stages?: Stages): DoneGate {
	const gate = createDoneGate(
		stages,
		message => pi.sendMessage(message, { deliverAs: "aside", triggerTurn: true }),
		(ctx, report) => showReport(pi, ctx, report),
	);
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
			if (!gate.waive(ctx, reason)) return notify(ctx, say({ en: "done-gate: /gate-ok applies to the main session only.", ko: "done-gate: /gate-ok는 메인 세션에서만 쓸 수 있습니다." }), "warning");
			notify(ctx, say({ en: `done-gate: the next stop of this session is allowed whatever it finds (${reason}); it is logged as user-waived.`, ko: `done-gate: 이 세션의 다음 종료는 무엇이 발견되든 허용됩니다(${reason}). 사용자 면제로 기록됩니다.` }), "info");
		},
	});
	pi.registerCommand("gate-decline", {
		description: "Stop the done gate from asking for a gate file in the repo of this session's working directory, in every checkout of it: /gate-decline; /gate-decline undo takes the decline back",
		handler: (args, ctx) => decline(ctx, String(args ?? "").trim()),
	});
	pi.registerCommand("gate-boundaries", {
		description: "List the boundary rules drafted from the import graph of the repo of this session's working directory (they are drafted first when there are none, and refuse nothing until accepted): /gate-boundaries; /gate-boundaries accept <id> moves one into the rule kit and adopts it, /gate-boundaries reject <id> deletes it for good",
		handler: (args, ctx) => boundaries(pi, ctx, String(args ?? "").trim()),
	});
	pi.registerCommand("gate-show", {
		description: "Show the replies the done gate sent back in full again, or fold them back into one row each: /gate-show",
		handler: async (_args, ctx) => gate.toggleSuperseded(ctx),
	});
	pi.registerAssistantTextRenderer?.(renderReply);
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
 * Markdown the terminal shows raw (bold, a # heading, a table) never refuses a stop: the assistant text renderer draws a finished
 * reply without it outside fenced code. A reply in another
 * script than the user's last prompt (`report:language`), and the last reply of a run that was refused for work, whose
 * message answered the gate and not the user (`report:after-refusal`), are refused once per run. A reply that is exactly
 * `ok`, `-` or `[later]` (the dotz protocol answers) passes the reply stages. In a dotz session (`DOTZ_RUNTIME` set and not
 * empty) the gate skips the whole `report` stage, the markdown stripping and the skill://ulw reminder; every other stage stays.
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
