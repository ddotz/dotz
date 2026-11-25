import { type LandResult, landSlot, stampOf, type TreeStamp } from "../checkouts/land.ts";
import { type Placement, workOf } from "../checkouts/place.ts";
import { handlerDeadline } from "./deadline.ts";
import { CLOSING, canLand } from "./decision.ts";
import type { LandAsk, Problem } from "./decision.ts";
import { notify } from "./host.ts";
import type { Ctx, GateMessage } from "./host.ts";
import { say } from "../notice.ts";
import { unchangedTree } from "./index-print.ts";
import { recordPass } from "./log.ts";
import { failureClass, failureText } from "./runs.ts";
import { releaseClaim } from "./shared-runs.ts";
import { checkKey, forgetRepo } from "./session.ts";
import type { ActiveRun, State } from "./session.ts";
import { latestReply, supersede } from "./superseded.ts";
import { fingerprint, takeSnapshot } from "./snapshot.ts";
import type { Finding } from "./types.ts";
import { message } from "./util.ts";

const MAX_ROWS = 20;

/** A landing that found the folder's branch moved: the stop turns it into a refusal or a warning, a check's late pass into a gate turn. */
export type Moved = Extract<LandResult, { kind: "moved" }>;

/** A landing the stop turns into a refusal or a warning: the folder's branch moved, or the stages found `findings` in the slot's unlanded commits, which is `why` it did not land. */
export type Held = Moved | { readonly kind: "findings"; readonly findings: readonly Finding[]; readonly why: string };

/** How a check's result that arrives after a stop reaches the session: a message shown to the user and put before the agent, which starts a turn. */
export type Deliver = (message: GateMessage) => void;

// why(platform): omp@18.22.2 loads each extension as its own module instance, so module-level state here is not the one session-restart reads.
const shared = globalThis as { [key: symbol]: { leaving: Set<State>; running: Set<State>; judging: Set<State> } | undefined };
const KEY = Symbol.for("omp-harness.gate.pending");
const pending = (shared[KEY] ??= { leaving: new Set<State>(), running: new Set<State>(), judging: new Set<State>() });
const leaving = pending.leaving;
const replies = new WeakMap<ActiveRun, number>();

/** Marks that a run of the session started; it counts as pending gate work until it ends (`state.active` turns false). */
export function noteRun(state: State): void {
	pending.running.add(state);
}

/** Runs `judge`, a stop judgment of the session, counted as pending gate work while it lasts. */
export async function judging<T>(state: State, judge: () => Promise<T>): Promise<T> {
	pending.judging.add(state);
	try {
		return await judge();
	} finally {
		pending.judging.delete(state);
	}
}

/** What restarting this process now would cut short, over every session of it: runs whose stop is not judged yet, stop judgments in progress, and checks left to end after a run whose result is not reported yet. */
export function pendingLater(): number {
	let count = pending.judging.size;
	for (const state of pending.running) if (state.active) count += 1;
	else pending.running.delete(state);
	for (const state of leaving) {
		if (state.later.size === 0) leaving.delete(state);
		count += state.later.size;
	}
	return count;
}

/**
 * Leaves the checks `running` names, the checks a stop is about to let an interactive session finish with, to end after the run:
 * each one's process moves from `state.checks`, which `endRun` cancels, to `state.later`, the user is told it is still running,
 * and a watcher, the only owner of the run from then on, reports how it ends. A pass for the tree the check started on is
 * remembered and told to the user, and the last such pass of a slot whose stop owes a landing (`pendingLand`) lands the slot when its
 * stamp is unchanged (`landNow`); a pass for a tree edited since is told as such, and the next stop runs the check again. A
 * failure, a timeout or a kill is put before the agent through `deliver`, once, and folds the reply that ended the turn of the stop
 * that left the run, the session's latest reply at that stop. A run already left by an earlier stop keeps its watcher and that
 * reply. A stop that replaces the run for an edited tree (`dropLater`) and a session that is left (`cancelLater`) silence it, so
 * its pass lands nothing; a failure and a pass for an edited tree drop the owed landing.
 */
export function defer(state: State, running: readonly Problem[], ctx: Ctx, deliver: Deliver): void {
	for (const problem of running) {
		const key = checkKey(problem.repo, problem.name);
		const active = state.checks.get(key);
		if (active !== undefined) {
			state.checks.delete(key);
			state.later.set(key, active);
			const reply = latestReply(state);
			if (reply === undefined) replies.delete(active);
			else replies.set(active, reply);
			leaving.add(state);
			void watch(state, key, active, ctx, deliver);
		}
		if (state.later.has(key)) notify(ctx, say({ en: `done-gate: check "${problem.name}" is still running in ${problem.repo}; its result will follow.`, ko: `done-gate: 검사 "${problem.name}"이(가) ${problem.repo}에서 아직 실행 중입니다. 결과는 끝나는 대로 알려 드립니다.` }), "info");
	}
}

/** Stops the run left under `key` without a word from its watcher: a stop runs the check again for a tree edited since. */
export function dropLater(state: State, key: string): void {
	const active = state.later.get(key);
	state.later.delete(key);
	active?.run.cancel();
	if (active !== undefined) releaseClaim(active.repo, active.check.name, state.owner);
}

/** Stops every check left to end after a run, with nothing delivered for them: the session that left them is gone. */
export function cancelLater(state: State): void {
	const left = [...state.later.values()];
	state.later.clear();
	for (const { run, repo, check } of left) {
		run.cancel();
		releaseClaim(repo, check.name, state.owner);
	}
}

/** Reports every check left to end after a run that ended while a run of the session was going: a stop let the session finish without collecting it. */
export function reportSettled(state: State, ctx: Ctx, deliver: Deliver): void {
	for (const [key, active] of state.later) if (active.run.settled !== undefined) void conclude(state, key, active, ctx, deliver);
}

async function watch(state: State, key: string, active: ActiveRun, ctx: Ctx, deliver: Deliver): Promise<void> {
	await active.run.promise;
	if (!state.active) await conclude(state, key, active, ctx, deliver);
}

async function conclude(state: State, key: string, active: ActiveRun, ctx: Ctx, deliver: Deliver): Promise<void> {
	const { repo, check } = active;
	try {
		const done = await active.run.promise;
		const now = await takeSnapshot(repo, handlerDeadline());
		if (state.later.get(key) !== active) return;
		state.later.delete(key);
		const failed = done.timedOut || done.code !== 0;
		if (done.spawnError !== undefined) {
			forgetOwed(state, repo);
			notify(ctx, say({ en: `done-gate: check "${check.name}" could not be started in ${repo}: ${done.spawnError}; it was not judged.`, ko: `done-gate: 검사 "${check.name}"을(를) ${repo}에서 시작하지 못했습니다: ${done.spawnError}. 판정하지 않았습니다.` }), "warning");
		} else if (fingerprint(now.tree, now.dirty, check.paths) !== active.print) {
			forgetOwed(state, repo);
			notify(ctx, say({ en: `done-gate: check "${check.name}" ${failed ? "failed" : "passed"} in ${repo} for an earlier tree; the next stop runs it again.`, ko: `done-gate: 검사 "${check.name}"이(가) ${repo}에서 이전 트리 기준으로 ${failed ? "실패했습니다" : "통과했습니다"}. 다음 종료 때 다시 실행합니다.` }), "info");
		} else if (failed) {
			forgetOwed(state, repo);
			supersede(state, ctx, replies.get(active), [`checks:${failureClass(done)}`]);
			deliver({ customType: "done-gate", display: true, content: `${failureText(repo, check, done)}\n\n${CLOSING}` });
		} else {
			const tree = unchangedTree(repo, active.tree);
			recordPass(repo, check.name, { fingerprint: active.print, command: check.command, ...(tree === undefined ? {} : { tree }) });
			releaseClaim(repo, check.name, state.owner);
			notify(ctx, say({ en: `done-gate: check "${check.name}" passed in ${repo}.`, ko: `done-gate: 검사 "${check.name}"이(가) ${repo}에서 통과했습니다.` }), "info");
			await landOwed(state, ctx, deliver, repo);
		}
	} catch (error) {
		if (state.later.get(key) === active) state.later.delete(key);
		forgetOwed(state, repo);
		notify(ctx, say({ en: `done-gate: check "${check.name}" ended in ${repo}, but its result could not be handled (${message(error)}); the next stop judges it.`, ko: `done-gate: 검사 "${check.name}"이(가) ${repo}에서 끝났지만 결과를 처리하지 못했습니다(${message(error)}). 다음 종료 때 판정합니다.` }), "warning");
	}
}

function forgetOwed(state: State, repo: string): void {
	if (state.pendingLand?.slot.path === repo) state.pendingLand = undefined;
}

async function landOwed(state: State, ctx: Ctx, deliver: Deliver, repo: string): Promise<void> {
	const owed = state.pendingLand;
	if (owed === undefined || owed.slot.path !== repo || [...state.later.values()].some(left => left.repo === repo)) return;
	state.pendingLand = undefined;
	const deadline = handlerDeadline();
	const now = await stampOf(repo, deadline);
	if (now === undefined) {
		tellLanding(state, ctx, owed.slot, { kind: "skipped", why: deadline.aborted ? `git did not answer in ${repo} before the deadline` : `git could not read the HEAD and status of ${repo}` });
		return;
	}
	if (now.head !== owed.stamp.head || now.tracked !== owed.stamp.tracked) {
		tellLanding(state, ctx, owed.slot, { kind: "stale" });
		return;
	}
	const held = await landNow(state, ctx, owed.slot, owed.stamp, { refused: false, outcome: undefined, userWaived: false, findings: [], unjudged: [] }, deadline);
	if (held?.kind === "moved") deliver({ customType: "done-gate", display: true, content: movedText(owed.slot, held) });
}

/** What the session is told when slot `slot` cannot land because its folder's branch moved: the rebase to run in the checkout before finishing again. */
export function movedText(slot: Placement, moved: Moved): string {
	return say({
		en: `done-gate: ${moved.branch} of ${slot.folder} holds commits ${slot.name} is not based on. In the checkout run \`${moved.instruction}\`, run the checks again and finish again.`,
		ko: `done-gate: ${slot.folder}의 ${moved.branch}에 ${slot.name}의 바탕이 아닌 커밋이 있습니다. 체크아웃에서 \`${moved.instruction}\`을(를) 실행하고, 검사를 다시 돌린 뒤 다시 마치세요.`,
	});
}

/** What the session is told when the stages found `findings` in the commits slot `slot` holds and its folder lacks: fix them in the checkout with a new commit, or finish again to leave them there. */
export function findingsText(slot: Placement, findings: readonly Finding[]): string {
	const rows = findings.slice(0, MAX_ROWS).map(finding => `- ${finding.file === undefined ? "" : `${finding.file}${finding.line === undefined ? "" : `:${finding.line}`} `}[${finding.stage}:${finding.class}] ${finding.message}`);
	if (findings.length > MAX_ROWS) rows.push(`- ... and ${findings.length - MAX_ROWS} more`);
	return say({
		en: `done-gate: ${slot.name} holds commits not landed on ${slot.folder}, and the stages refuse what they bring:\n${rows.join("\n")}\n\nFix it in the checkout with a new commit and finish again, or finish again to leave the commits in the checkout.`,
		ko: `done-gate: ${slot.name}에 ${slot.folder}에 반영되지 않은 커밋이 있고, 단계 검사가 그 내용을 거절합니다:\n${rows.join("\n")}\n\n체크아웃에서 새 커밋으로 고친 뒤 다시 마치거나, 커밋을 체크아웃에 남겨 두려면 그대로 다시 마치세요.`,
	});
}

/** The warning that slot `slot` was not landed on its folder for `why`, its commits staying in the checkout. */
export function notLandedNotice(slot: Placement, why: string): string {
	return say({ en: `done-gate: ${slot.name} was not landed on ${slot.folder}: ${why}; its commits stay in the checkout.`, ko: `done-gate: ${slot.name}을(를) ${slot.folder}에 반영하지 않았습니다: ${why}. 커밋은 체크아웃에 남아 있습니다.` });
}

function tellLanding(state: State, ctx: Ctx, slot: Placement, result: LandResult): void {
	const { name, folder } = slot;
	switch (result.kind) {
		case "landed": {
			forgetRepo(state, folder);
			const commits = result.commits === 1 ? "1 commit" : `${result.commits} commits`;
			notify(ctx, say({ en: `done-gate: landed ${commits} of ${name} on ${result.branch} of ${folder} (${result.from.slice(0, 7)} -> ${result.to.slice(0, 7)}).`, ko: `done-gate: ${name}의 커밋 ${result.commits}개를 ${folder}의 ${result.branch}에 반영했습니다(${result.from.slice(0, 7)} -> ${result.to.slice(0, 7)}).` }), "info");
			tellUncommitted(ctx, name, result.uncommitted);
			return;
		}
		case "nothing":
			tellUncommitted(ctx, name, result.uncommitted);
			return;
		case "dirty-folder":
			notify(ctx, say({ en: `done-gate: ${name} was not landed: uncommitted edits in ${folder} conflict with it (${result.files.join(", ")}); the stop is allowed.`, ko: `done-gate: ${name}을(를) 반영하지 않았습니다. ${folder}의 커밋하지 않은 수정과 충돌합니다(${result.files.join(", ")}). 종료는 허용됩니다.` }), "warning");
			return;
		case "stale":
			notify(ctx, say({ en: `done-gate: ${name} was not landed: it changed after the gate judged it; the next stop judges it again.`, ko: `done-gate: ${name}을(를) 반영하지 않았습니다. 게이트가 판정한 뒤에 바뀌었습니다. 다음 종료 때 다시 판정합니다.` }), "warning");
			return;
		case "skipped":
			notify(ctx, say({ en: `done-gate: ${name} was not landed on ${folder} (${result.why}); the stop is allowed.`, ko: `done-gate: ${name}을(를) ${folder}에 반영하지 못했습니다(${result.why}). 종료는 허용됩니다.` }), "warning");
			return;
		case "moved":
			return;
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

function tellUncommitted(ctx: Ctx, name: string, paths: readonly string[]): void {
	if (paths.length === 0) return;
	const count = paths.length === 1 ? "1 path stays" : `${paths.length} paths stay`;
	notify(ctx, say({ en: `done-gate: ${count} uncommitted in ${name}: ${paths.join(", ")}`, ko: `done-gate: ${name}에 커밋하지 않은 경로 ${paths.length}개가 남아 있습니다: ${paths.join(", ")}` }), "info");
}

/**
 * Lands slot `slot` at stamp `stamp` when `canLand` lets it, with what the gate came to for it in `ask`, and tells the user how that
 * went: a slot that holds commits its folder lacks and may not land is named with the reason; after `landed` the folder is forgotten as a
 * repo of the session (`forgetRepo`). Returns, without telling, a landing the folder's moved branch or the stages' findings in the
 * unlanded commits held back, which the caller reports. Never throws.
 */
export async function landNow(state: State, ctx: Ctx, slot: Placement, stamp: TreeStamp, ask: Omit<LandAsk, "repo" | "folder">, signal: AbortSignal): Promise<Held | undefined> {
	const leave = await canLand({ ...ask, repo: slot.path, folder: slot.folder }, signal);
	if (!leave.ok) {
		if ("found" in leave) return { kind: "findings", findings: leave.found, why: leave.why };
		if (signal.aborted) tellLanding(state, ctx, slot, { kind: "skipped", why: "git did not answer before the deadline" });
		else if ((await workOf(slot)).unlanded) notify(ctx, notLandedNotice(slot, leave.why), "warning");
		return undefined;
	}
	const result = await landSlot(slot, leave.verdict, stamp, signal);
	if (result.kind === "moved") return result;
	tellLanding(state, ctx, slot, result);
	return undefined;
}
