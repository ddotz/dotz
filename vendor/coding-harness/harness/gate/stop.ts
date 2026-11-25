import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stampOf } from "../checkouts/land.ts";
import { type Placement, whereis } from "../checkouts/place.ts";
import { acceptedTextAt, recordAccepted } from "./accepted-gate.ts";
import { acceptedNotice, acceptedOf, unjudgedNotice } from "./accepted.ts";
import { gateWrittenByScript, needsBootstrap } from "./bootstrap.ts";
import { sessionFiles } from "./changed.ts";
import { stopBudgetMs, stopDeadlineMs, until } from "./deadline.ts";
import { decideStop, isLandable, unlandedDiff, unlandedFiles, unlandedWhy, waivedStop } from "./decision.ts";
import type { Outcome, Problem, RepoResult } from "./decision.ts";
import { baseTextOf, escapeInputPrint, gitShow, runAll } from "./escape-common.ts";
import { evidenceText, evidenceVerdict, featuresAt, isUnder, readFeatures } from "./evidence.ts";
import { countClasses, findingProblem } from "./findings.ts";
import { gateFilePath, matchesAny, readGateFile } from "./gate-file.ts";
import type { Check } from "./gate-file.ts";
import { cwdOf, inDotz, notify, sessionKey } from "./host.ts";
import { say } from "../notice.ts";
import type { Ctx, StopEvent, StopResult } from "./host.ts";
import { defer, dropLater, findingsText, landNow, movedText, notLandedNotice, reportSettled } from "./later.ts";
import type { Deliver } from "./later.ts";
import { notifyReport, type Show } from "./show-report.ts";
import { unchangedTree, workingTreeId } from "./index-print.ts";
import { appendRow, readPassed, recordPass } from "./log.ts";
import type { GateRow, Passed } from "./log.ts";
import { acceptProposed } from "./mistakes.ts";
import { askFindings, askWarning } from "./ask.ts";
import { leftoverFindings, leftoverWarning } from "./leftover.ts";
import { LANGUAGE_NAMES, LANGUAGE_NAMES_KO, reportFindings, reportWarning } from "./report.ts";
import { failureClass, failureState, failureText, startRun, waitFor } from "./runs.ts";
import type { CheckResult } from "./runs.ts";
import { awaitPeer, claimRun, followPeer, passes, peerClaim, releaseClaim, settleClaim } from "./shared-runs.ts";
import { cancelChecks, checkKey, endRun, forgetRepo, recentFailure, userScriptOf } from "./session.ts";
import type { ActiveRun, State } from "./session.ts";
import { baseRef, fingerprint, takeSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import { NO_STAGE_FINDINGS, mistakeStage, runStages } from "./stages.ts";
import type { StageRun, Stages } from "./stages.ts";
import { latestReply, supersede } from "./superseded.ts";
import type { Finding, TextAt } from "./types.ts";
import { isRecord, message } from "./util.ts";

const FLOOR_CONCURRENCY = 8;
const LINE_NOISE = /^\uFEFF|\r(?=\n)/g;
const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const BOOTSTRAP_SCRIPT = join(import.meta.dir, "bootstrap.ts");
const GATE_FILE = ".omp/gate.json";

interface Stop {
	deadline: number;
	hard: AbortSignal;
	limitMs: number;
	signal: AbortSignal | undefined;
}

interface Judging {
	state: State;
	repo: string;
	stop: Stop;
	passed: Record<string, Passed>;
	warnings: string[];
}

interface Prepared {
	repo: string;
	gated: boolean;
	base: Snapshot;
	now: Snapshot;
	changed: string[];
	checked: string[];
	measured: boolean;
	foreign: boolean;
}

type Preparation = { prepared: Prepared } | { repo: string; gated: boolean; error: string };

const outOfTime = (repo: string, stop: Stop) => `the stop ran out of its ${stop.limitMs / 1000} s before ${repo} was judged`;

function runningProblem(repo: string, check: Check, startedAt: number): Problem {
	const seconds = Math.round((Date.now() - startedAt) / 1000);
	return {
		kind: "running",
		repo,
		name: check.name,
		state: "running",
		text: `done-gate: check "${check.name}" is still running in ${repo} (started ${seconds}s ago, limit ${check.timeoutSec}s); one stop waits at most ${Math.round(stopBudgetMs() / 1000)}s for a check.`,
		classes: { "checks:running": 1 },
	};
}

function runOf(state: State, repo: string, check: Check, print: string, second: boolean): { active: ActiveRun; watched: boolean } {
	const key = checkKey(repo, check.name);
	const fresh = (run: ActiveRun) => run.command === check.command && (run.print === print || run.toolCalls === state.toolCalls);
	const left = state.later.get(key);
	if (left !== undefined && !fresh(left)) dropLater(state, key);
	else if (left !== undefined && left.run.settled === undefined) return { active: left, watched: true };
	else if (left !== undefined) {
		state.later.delete(key);
		state.checks.set(key, left);
	}
	const known = state.checks.get(key);
	if (known !== undefined && fresh(known)) return { active: known, watched: false };
	known?.run.cancel();
	const tree = workingTreeId(repo);
	const run = startRun(repo, check.command, check.timeoutSec, check.name);
	const active = { run, repo, check, command: check.command, print, toolCalls: state.toolCalls, second, tree };
	state.checks.set(key, active);
	claimRun(repo, check.name, { owner: state.owner, pid: process.pid, startedAt: run.startedAt, print, command: check.command, timeoutSec: check.timeoutSec });
	void run.promise.then(result => {
		if ((state.checks.get(key) ?? state.later.get(key))?.run === run) settleClaim(repo, check.name, state.owner, print, result);
	});
	return { active, watched: false };
}

function startChecks(state: State, prepared: Prepared): void {
	if (prepared.checked.length === 0 || !prepared.gated) return;
	let checks: Check[];
	try {
		checks = readGateFile(prepared.repo).checks;
	} catch {
		return;
	}
	const passed = readPassed(prepared.repo);
	for (const check of checks) {
		if (!prepared.checked.some(file => matchesAny(check.paths, file)) || state.later.has(checkKey(prepared.repo, check.name))) continue;
		const print = fingerprint(prepared.now.tree, prepared.now.dirty, check.paths);
		const known = passed[check.name];
		if (known?.fingerprint === print && known.command === check.command) continue;
		const peer = peerClaim(prepared.repo, check, print, state.owner);
		if (peer === undefined || (peer.result !== undefined && !passes(peer.result))) runOf(state, prepared.repo, check, print, false);
	}
}

async function verdict(judging: Judging, check: Check, print: string, second: boolean, done: CheckResult, before?: string): Promise<Problem | undefined> {
	const { state, repo, stop, passed, warnings } = judging;
	state.checks.delete(checkKey(repo, check.name));
	if (done.spawnError !== undefined) throw new Error(`could not start bash for check "${check.name}" in ${repo}: ${done.spawnError}`);
	if (done.timedOut || done.code !== 0) return { kind: "check", repo, name: check.name, state: failureState(done), text: failureText(repo, check, done), classes: { [`checks:${failureClass(done)}`]: 1 } };
	const after = await takeSnapshot(repo, stop.hard);
	const afterPrint = fingerprint(after.tree, after.dirty, check.paths);
	if (afterPrint !== print) {
		if (!second) return await judgeCheck(judging, check, after, true);
		warnings.push(say({ en: `done-gate: check "${check.name}" changed files under its own paths in ${repo} on two runs in a row; its second result is accepted for the tree it left behind.`, ko: `done-gate: 검사 "${check.name}"이(가) ${repo}에서 연속 두 번 실행하는 동안 자신의 경로 아래 파일을 바꿨습니다. 두 번째 결과를 그 검사가 남긴 트리 기준으로 받아들입니다.` }));
	}
	const tree = unchangedTree(repo, before);
	passed[check.name] = { fingerprint: afterPrint, command: check.command, ...(tree === undefined ? {} : { tree }) };
	recordPass(repo, check.name, passed[check.name]);
	releaseClaim(repo, check.name, state.owner);
	return undefined;
}

async function judgeCheck(judging: Judging, check: Check, now: Snapshot, second = false): Promise<Problem | undefined> {
	const { state, repo, stop, passed } = judging;
	const print = fingerprint(now.tree, now.dirty, check.paths);
	const known = passed[check.name];
	if (known?.fingerprint === print && known.command === check.command) return undefined;
	const key = checkKey(repo, check.name);
	if (!state.checks.has(key) && !state.later.has(key)) {
		const peer = await awaitPeer(repo, check, print, state.owner, { until: stop.deadline, signal: stop.signal });
		if (peer.kind === "running") {
			state.checks.set(key, { run: followPeer(repo, check, print, state.owner, peer.startedAt), repo, check, command: check.command, print, toolCalls: state.toolCalls, second });
			return runningProblem(repo, check, peer.startedAt);
		}
		if (peer.kind === "result") return await verdict(judging, check, print, second, peer.result);
	}
	const { active, watched } = runOf(state, repo, check, print, second);
	if (watched) return runningProblem(repo, check, active.run.startedAt);
	const done = active.run.settled ?? (await waitFor(active.run, stop.deadline - Date.now(), stop.signal));
	if (!done) return runningProblem(repo, check, active.run.startedAt);
	return await verdict(judging, check, active.print, active.second, done, active.tree);
}

async function baselineOf(state: State, repo: string, stop: Stop): Promise<Snapshot> {
	const baseline = state.baselines.get(repo);
	if (baseline === undefined) {
		const failure = recentFailure(state, repo);
		throw new Error(failure === undefined ? `no baseline of ${repo} was taken in this run` : `${failure}; not tried again for 10 minutes`);
	}
	if (baseline.failure !== undefined) throw new Error(baseline.failure);
	const settled = await until(baseline.result, AbortSignal.timeout(Math.max(0, stop.deadline - Date.now())));
	if (!settled) throw new Error(baseline.fail(`baseline of ${repo} was still running when the stop gave up waiting for it`));
	if (!settled.value.ok) throw new Error(settled.value.error);
	return settled.value.snapshot;
}

async function prepare(state: State, repo: string, stop: Stop, slot: Placement | undefined): Promise<Preparation> {
	const gated = existsSync(gateFilePath(repo));
	try {
		const base = await baselineOf(state, repo, stop);
		const baseline = state.baselines.get(repo);
		const { now, files } = await sessionFiles(repo, base, baseline, stop.hard);
		const measured = baseline !== undefined && !baseline.countsAll();
		const changed = measured ? files.filter(file => baseline.bashWrote.has(file)) : files;
		const unlanded = gated && slot?.path === repo ? await unlandedFiles(repo, slot.folder, stop.hard) : [];
		const checked = unlanded.length ? [...new Set([...changed, ...unlanded])] : changed;
		return { prepared: { repo, gated, base, now, changed, checked, measured, foreign: changed.length < files.length } };
	} catch (error) {
		return { repo, gated, error: stop.hard.aborted ? outOfTime(repo, stop) : message(error) };
	}
}

async function judgeGate(state: State, prepared: Prepared, stop: Stop): Promise<Pick<RepoResult, "problems" | "waived" | "warnings">> {
	const { repo, now, changed, checked } = prepared;
	const gate = readGateFile(repo);
	const judged: Pick<RepoResult, "problems" | "waived" | "warnings"> = { problems: [], waived: [], warnings: [] };
	const judging: Judging = { state, repo, stop, passed: readPassed(repo), warnings: judged.warnings };
	for (const check of checked.length ? gate.checks : []) {
		if (!checked.some(file => matchesAny(check.paths, file))) continue;
		if (stop.hard.aborted) throw new Error(outOfTime(repo, stop));
		const problem = await judgeCheck(judging, check, now);
		if (problem) {
			judged.problems.push(problem);
			if (problem.kind !== "running") break;
		}
	}
	const features = readFeatures(repo);
	const baseFeatures = gate.evidence.length && changed.length ? featuresAt(repo, baseRef(prepared.base)) : undefined;
	for (const entry of changed.length ? gate.evidence : []) {
		const matching = changed.filter(file => matchesAny(entry.paths, file) && !isUnder(entry.dir, file));
		const verdict = evidenceVerdict(repo, entry, matching, features, baseFeatures);
		if (verdict.verdict === "waived") judged.waived.push(`${entry.name}: ${verdict.waiver}`);
		else if (verdict.verdict === "missing") {
			const text = evidenceText(repo, entry, matching, verdict);
			judged.problems.push({ kind: "evidence", repo, name: entry.name, state: createHash("sha256").update(text).digest("hex"), text, classes: { "evidence:missing": 1 } });
		}
	}
	return judged;
}

interface Floor {
	findings: Finding[];
	unverified?: string;
	ungated?: string;
	errors: string[];
}

type Write = readonly [file: string, calls: number];

function uncovered(repo: string, gated: boolean, writes: readonly Write[]): Write[] {
	if (!gated) return [...writes];
	const { checks } = readGateFile(repo);
	return writes.filter(([file]) => !checks.some(check => matchesAny(check.paths, file)));
}

async function textNow(repo: string, file: string, signal: AbortSignal): Promise<string | null> {
	try {
		return await readFile(join(repo, file), { encoding: "utf8", signal });
	} catch (error) {
		if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
		throw error;
	}
}

async function movedFromBase(state: State, prepared: Prepared, writes: readonly Write[], signal: AbortSignal): Promise<Write[]> {
	const { repo } = prepared;
	const base = baseRef(prepared.base);
	const baseText = state.baselines.get(repo)?.texts.textAt;
	const moved = await runAll(writes, FLOOR_CONCURRENCY, signal, async ([file], inner) => {
		const now = await textNow(repo, file, inner);
		const before = await baseTextOf({ repo, base, files: [], baseText, signal: inner }, file);
		return now === null || before === null ? now !== before : now.replace(LINE_NOISE, "") !== before.replace(LINE_NOISE, "");
	});
	return writes.filter((_, at) => moved[at]);
}

function physical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function tempRoots(): string[] {
	const listed = process.env.DONE_GATE_TEMP_ROOTS;
	const roots = listed === undefined ? [tmpdir(), ...TEMP_ROOTS] : listed.split(":");
	return roots.filter(root => root !== "").flatMap(root => [resolve(root), physical(resolve(root))]);
}

/** Whether the gate may ask for a gate file in `repo`: its root is not inside a scratch directory (`os.tmpdir()`, /tmp, /private/tmp, /var/folders, /private/var/folders; DONE_GATE_TEMP_ROOTS, a colon-separated list, replaces them, and an empty value means none is scratch), it is not the home directory `home`, and `head`, what HEAD names, is a commit ("none" for a repo without one). */
export function eligibleForBootstrap(repo: string, head: string, home: string = homedir()): boolean {
	if (head === "none") return false;
	const places = [repo, physical(repo)];
	const homes = [resolve(home), physical(resolve(home))];
	const temporary = tempRoots();
	return !places.some(place => homes.includes(place) || temporary.some(root => isUnder(root, place)));
}

const originKey = (repo: string): string => `${repo}\0gate-not-from-script`;
const escapeFailedPrefix = (repo: string): string => `${repo}\0escape-stage-failed\0`;

function forgetEscapeFailure(state: State, repo: string): void {
	const prefix = escapeFailedPrefix(repo);
	for (const key of state.askedGate) if (key.startsWith(prefix)) state.askedGate.delete(key);
}

function shellQuote(text: string): string {
	return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

async function checkGateOrigin(prepared: Prepared, stop: Stop, floor: Floor): Promise<boolean> {
	const { repo, now } = prepared;
	try {
		if (now.head !== "none" && (await gitShow(repo, now.head, GATE_FILE, stop.hard)) !== undefined) return true;
		const written = await until(gateWrittenByScript(repo, stop.hard), stop.hard);
		if (written === undefined) throw new Error(outOfTime(repo, stop));
		return written.value;
	} catch (error) {
		floor.errors.push(stop.hard.aborted ? outOfTime(repo, stop) : message(error));
		return true;
	}
}

function flagForeignGate(state: State, floor: Floor, repo: string): void {
	if (state.askedGate.has(originKey(repo))) {
		floor.ungated = say({ en: `done-gate: ${repo} finished with a ${GATE_FILE} that is neither committed at HEAD nor the one the bootstrap script wrote.`, ko: `done-gate: ${repo}이(가) 끝날 때 ${GATE_FILE}이(가) HEAD에 커밋되어 있지 않고 부트스트랩 스크립트가 쓴 파일도 아닙니다.` });
		return;
	}
	floor.findings.push({ stage: "verify", class: "gate-not-from-script", message: `${repo}/${GATE_FILE} is not committed at HEAD and is not the file the bootstrap script wrote in this checkout, so it does not count as a gate. If the user wrote it, they can commit it. Otherwise remove it and run \`bun ${shellQuote(BOOTSTRAP_SCRIPT)} ${shellQuote(repo)}\` once, which writes the gate file; do not write or edit the gate file by hand. Then finish again.`, file: GATE_FILE });
}

/** What the stop's `verify:no-gate-file` refusal tells about `repo`: it has no gate file, and the bootstrap command that writes one. */
export function noGateFileMessage(repo: string): string {
	return `${repo} has no gate file, so nothing checks a change here when a session stops. Run \`bun ${shellQuote(BOOTSTRAP_SCRIPT)} ${shellQuote(repo)}\` once: it finds the repo's typecheck, lint and test commands, keeps the ones that pass now within 20 s, and writes .omp/gate.json and the rule kit under .omp/lint. Then finish again.`;
}

async function askForGateFile(state: State, prepared: Prepared, stop: Stop, floor: Floor): Promise<void> {
	const { repo } = prepared;
	try {
		const needed = stop.hard.aborted ? undefined : await until(needsBootstrap(repo, stop.hard), stop.hard);
		if (needed === undefined) throw new Error(outOfTime(repo, stop));
		if (!needed.value) return;
		if (state.askedGate.has(repo)) floor.ungated = say({ en: `done-gate: ${repo} still has no gate file; the next run will ask again.`, ko: `done-gate: ${repo}에는 아직 게이트 파일이 없습니다. 다음 실행에서 다시 요청합니다.` });
		else floor.findings.push({ stage: "verify", class: "no-gate-file", message: noGateFileMessage(repo) });
	} catch (error) {
		floor.errors.push(stop.hard.aborted ? outOfTime(repo, stop) : message(error));
	}
}

async function judgeFloor(state: State, prepared: Prepared, stop: Stop, floor: Floor): Promise<void> {
	const { repo, gated } = prepared;
	const candidates = state.sourceWrites.get(repo);
	if (candidates === undefined) return;
	const counts = gated && (await checkGateOrigin(prepared, stop, floor));
	const foreign = gated && !counts;
	const ranAt = state.evidenceAt ?? 0;
	const askable = !gated && eligibleForBootstrap(repo, prepared.now.head);
	if (ranAt >= Math.max(...candidates.values()) && !askable && !foreign) return;
	const open = uncovered(repo, counts, [...candidates].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	const subject = await movedFromBase(state, prepared, open, stop.hard);
	if (subject.length === 0) return;
	if (foreign) flagForeignGate(state, floor, repo);
	const [file, calls] = subject.reduce((last, write) => (write[1] > last[1] ? write : last));
	if (ranAt < calls) {
		if (state.asked.has(repo)) {
			floor.unverified = say({ en: `done-gate: ${repo} finished without anything being run after the last edit of ${file}.`, ko: `done-gate: ${repo}이(가) ${file}을(를) 마지막으로 수정한 뒤 아무것도 실행하지 않은 채 끝났습니다.` });
		} else {
			const text = `You changed ${subject.length} source file(s) in ${repo} and ran nothing after the last edit (${file}). Run the check that exercises the change (the repo's tests or typecheck, or the changed program itself) and read its output before you finish. If nothing here can run it, say in your reply what blocks it.`;
			floor.findings.push({ stage: "verify", class: "nothing-run", message: text, file });
		}
	}
	if (askable) await askForGateFile(state, prepared, stop, floor);
}

async function floorOf(state: State, prepared: Prepared, stop: Stop): Promise<Floor> {
	const floor: Floor = { findings: [], errors: [] };
	try {
		await judgeFloor(state, prepared, stop, floor);
	} catch (error) {
		floor.errors.push(stop.hard.aborted ? outOfTime(prepared.repo, stop) : message(error));
	}
	return floor;
}

function blankResult(state: State, repo: string, gated: boolean, changed: number): RepoResult {
	return { repo, changed, gated, problems: [], waived: [], warnings: [], accepted: [], unscanned: [], preexisting: [], blockedBefore: state.blocked.has(repo), stageErrors: [] };
}

async function evaluate(state: State, prepared: Prepared, stop: Stop, stageRun: Promise<StageRun>, checks: boolean): Promise<RepoResult> {
	const { repo, gated, changed } = prepared;
	const result = blankResult(state, repo, gated, changed.length);
	if (gated && checks) {
		try {
			const judged = await judgeGate(state, prepared, stop);
			result.problems.push(...judged.problems);
			result.waived = judged.waived;
			result.warnings = judged.warnings;
		} catch (error) {
			result.changed = 0;
			result.error = stop.hard.aborted ? outOfTime(repo, stop) : message(error);
		}
	}
	const found = await until(stageRun, stop.hard);
	if (found === undefined || stop.hard.aborted) {
		result.stageErrors.push(`the stages in ${repo} had not finished when the stop ran out of its ${stop.limitMs / 1000} s; what they would have found is unknown`);
		return result;
	}
	const staged = [findingProblem(repo, "escape", found.value.escape), findingProblem(repo, "rules", found.value.rules), findingProblem(repo, "defaults", found.value.defaults)].filter(problem => problem !== undefined);
	result.problems.unshift(...staged);
	result.stageErrors.push(...found.value.errors);
	result.accepted = found.value.accepted;
	result.unscanned = found.value.unscanned;
	result.preexisting = found.value.preexisting;
	return result;
}

function withMistakes(state: State, results: RepoResult[], cwd: string, session: string, stages: Stages): void {
	const found = mistakeStage(stages, session);
	const problem = findingProblem(cwd, "mistakes", found.findings);
	const home = results.find(result => result.repo === cwd);
	if (home) {
		if (problem) home.problems.push(problem);
		if (found.error !== undefined) home.stageErrors.push(found.error);
	} else if (problem || found.error !== undefined || state.blocked.has(cwd)) {
		const created = blankResult(state, cwd, false, 0);
		if (problem) created.problems.push(problem);
		if (found.error !== undefined) created.stageErrors.push(found.error);
		results.push(created);
	}
}

function withAsk(state: State, results: RepoResult[], cwd: string): void {
	const found = askFindings(state.reply);
	if (found.length === 0) return;
	let home = results.find(result => result.repo === cwd);
	if (home === undefined) {
		home = blankResult(state, cwd, false, 0);
		results.push(home);
	}
	if (state.askedAsk) {
		home.warnings.push(askWarning(found));
		return;
	}
	const problem = findingProblem(cwd, "ask", found);
	if (problem) home.problems.push(problem);
}

function withLeftover(state: State, results: RepoResult[], cwd: string): void {
	if (state.edited.size === 0 && !results.some(result => result.changed > 0)) return;
	const found = leftoverFindings(state.reply);
	if (found.length === 0) return;
	let home = results.find(result => result.repo === cwd);
	if (home === undefined) {
		home = blankResult(state, cwd, false, 0);
		results.push(home);
	}
	if (state.askedLeftover) {
		home.warnings.push(leftoverWarning(found));
		return;
	}
	const problem = findingProblem(cwd, "leftover", found);
	if (problem) home.problems.push(problem);
}

function withReport(state: State, results: RepoResult[], cwd: string, defers: boolean): void {
	const answersWait = state.waitedFor.length > 0;
	const blocked = results.some(result => result.problems.some(problem => problem.kind !== "running" || !defers));
	const waited = answersWait ? `${state.waitedFor.map(name => `"${name}"`).join(", ")} ${results.every(result => result.error === undefined) ? "passed" : "finished without a verdict (see the gate's notice)"}` : undefined;
	const user = userScriptOf(state);
	const found = reportFindings({ reply: state.reply, user, blocked, waited });
	if (found.length === 0) return;
	let home = results.find(result => result.repo === cwd);
	if (home === undefined) {
		home = blankResult(state, cwd, false, 0);
		results.push(home);
	}
	if (state.askedReport && !answersWait) {
		home.warnings.push(reportWarning(found));
		return;
	}
	const problem = findingProblem(cwd, "report", found);
	if (problem) home.problems.push(problem);
}

function withInterim(state: State, results: RepoResult[], cwd: string): void {
	const user = userScriptOf(state);
	if (state.interimWrong === 0 || user === undefined) return;
	let home = results.find(result => result.repo === cwd);
	if (home === undefined) {
		home = blankResult(state, cwd, false, 0);
		results.push(home);
	}
	home.warnings.push(say({ en: `done-gate: ${state.interimWrong} interim messages or tool-call intent labels this run were not in ${LANGUAGE_NAMES[user]}.`, ko: `done-gate: 이번 실행의 중간 메시지 또는 도구 호출 의도 설명 ${state.interimWrong}건이 ${LANGUAGE_NAMES_KO[user]}로 쓰이지 않았습니다.` }));
}

/**
 * Judges every repo of the run at a stop. Each repo the session changed goes through the anti-escape stage and, when it has
 * `.omp/lint`, the rules stage; a repo with a gate file also through its checks and evidence; after the repos, the session's
 * mistake obligations. In a repo the run reached only as a bash command's directory, the session changed only the files its bash
 * calls changed there (`Baseline.countsAll` says when every change counts instead); one where they changed none is left out, and
 * one with changes that are not the session's does not record its gate files as accepted. A repo where the session wrote source files (with an edit tool, or during a `task` call or a bash command
 * that applies a patch and changed their content) that now differ from their base text, with no gate check covering them and
 * nothing run after the last such write, is refused once per run (`verify:nothing-run`); a later stop of the run lets it through
 * with a warning and an `unverified` row. Those files in a repo with no gate file that `needsBootstrap` says should have one, when
 * `eligibleForBootstrap` allows it, are refused once per run whatever ran (`verify:no-gate-file`: run bootstrap.ts); a later
 * stop of the run lets it through with a warning and an `ungated` row. A repo whose `.omp/gate.json` is not tracked at HEAD and
 * is not byte for byte the file the script last wrote in that checkout does not count as a gate: where the floor's subject set
 * there (the source files above, whatever the gate's checks cover) is not empty, it is refused once per run whatever ran
 * (`verify:gate-not-from-script`: if the user wrote it they can commit it, otherwise remove it and run the script), then let
 * through the same way, and its checks do not count as covering the session's writes. A gate file tracked at HEAD is accepted
 * here; edits to it stay with the weakened-gate stage.
 * Markdown the terminal shows raw (`**bold**`, a `#` heading, a table) never refuses a stop; the assistant text renderer strips it from the display.
 * A reply of an interactive session (`ctx.hasUI`, outside dotz) that asks the user something in its text, a request to choose or tell, a
 * question ending or a line ending in `?`, outside fenced code (`ask:question`), is refused once per run with the order to put every
 * question and decision into one `ask` tool form with a recommended option preselected; a later stop of the run lets it through with a warning.
 * A reply of that kind from a run that edited files and lists known unfixed items (a line such as `남은 것:` or `Remaining:` with bullets under it, or a
 * bullet with such a phrase; a line naming a blocker outside the agent's reach is exempt) is refused once per run (`leftover:unfixed`) with the order to fix
 * them in this run; a later stop of the run lets it through with a warning.
 * A reply written in another script than the user's last prompt (`report:language`) is refused once per run, then let through
 * with a warning. A refusal for work asks in its own text that the reply after the fix be the final report.
 * A stop refused only to wait for running checks lets an interactive session (`ctx.hasUI`, with `deliver`) finish instead: the
 * runs are left to end after it (`defer`), the user hears how each ends, and a failure is put before the agent as a new turn.
 * Without a UI the stop is refused to wait, and the reply that answers that wait is refused for the report whenever the check
 * is in, so a note about waiting never stays the last message the user sees.
 * Everything found goes into one refusal, stage findings first. A waiver from /gate-ok lets the stop through and accepts the
 * agent's proposals to close a user's mistake without a check. The stages' signals have fired when it returns.
 * In a main checkout (slot, `whereis` of the cwd) the checks of its repo are matched against the files its unlanded commits change
 * (`unlandedFiles`) as well as the run's changed files, so every check a landing needs runs at the stop. Unless the stop was waived, a
 * stop let through there with an outcome that could land the slot (or one let through while its checks still run) first has the stages
 * judge what the landing brings: the diff from the merge base with the folder's HEAD to the slot's tree, over the unlanded files
 * (`unlandedDiff`), in a stage run of its own, since the run's stage run measures from the run's baseline, which a history-moving
 * command (cherry-pick, merge, pull) moves past the lines it brought in. The stop then lands it: with checks of the slot still running it only
 * keeps the slot's stamp as `pendingLand`, for their pass to land, and only when the stages found nothing; otherwise `landNow` lands it
 * with the slot's outcome at this stop and what the stages found, within the stop's deadline. When the folder's branch moved, or the
 * stages found something in the unlanded commits, the first such stop of the run is refused (with the rebase instruction, or with the
 * findings and the choice to fix them in the checkout or finish again to leave the commits there), counted neither as a refusal nor
 * towards the same-state streak, spends a /gate-ok waiver so the next tree is judged, and logs the slot as blocked with a `land:moved`
 * or `land:findings` finding; a later one is let through with a warning, and its row carries `land:findings` for findings. A stop's row
 * is written once its landing is done.
 */
export async function onStop(state: State, ctx: Ctx, event: StopEvent, stages: Stages, deliver?: Deliver, show?: Show): Promise<StopResult | undefined> {
	const work = new AbortController();
	try {
		return await judgeStop(state, ctx, event, stages, work.signal, deliver, show);
	} finally {
		work.abort();
	}
}

function dropVanished(state: State): string[] {
	const gone = [...new Set([...state.baselines.keys(), ...state.touched])].filter(repo => !existsSync(repo));
	for (const repo of gone) {
		forgetRepo(state, repo);
		forgetEscapeFailure(state, repo);
	}
	return gone;
}

interface Unlanded {
	findings: Finding[];
	unjudged: string[];
}

const NOTHING_UNLANDED: Unlanded = { findings: [], unjudged: [] };

type LandHold = { kind: "refused"; repo: string; finding: "land:moved" | "land:findings"; reason: string } | { kind: "noted"; repo: string; finding: "land:findings" };

async function judgeUnlanded(stages: Stages, slot: Placement, acceptedText: TextAt | undefined, signal: AbortSignal): Promise<Unlanded> {
	try {
		const diff = await unlandedDiff(slot.path, slot.folder, signal);
		if (diff === undefined || diff.files.length === 0) return NOTHING_UNLANDED;
		const run = await runStages(stages, { repo: slot.path, base: diff.base, files: diff.files, acceptedText }, signal);
		return { findings: [...run.escape, ...run.rules, ...run.defaults], unjudged: run.errors };
	} catch (error) {
		return { findings: [], unjudged: [signal.aborted ? `the stop ran out of time before the stages judged the unlanded commits of ${slot.path}` : message(error)] };
	}
}

async function landAtStop(state: State, ctx: Ctx, slot: Placement | undefined, outcome: Record<string, Outcome>, deferred: readonly Problem[], userWaived: boolean, judge: (slot: Placement) => Promise<Unlanded>, signal: AbortSignal): Promise<LandHold | undefined> {
	state.pendingLand = undefined;
	if (slot === undefined) return undefined;
	const stamp = await stampOf(slot.path, signal);
	if (stamp === undefined) {
		const why = signal.aborted ? { en: "git did not answer before the stop's deadline", ko: "종료 기한 안에 git이 응답하지 않았습니다" } : { en: "git could not read its HEAD and status", ko: "git이 HEAD와 상태를 읽지 못했습니다" };
		notify(ctx, say({ en: `done-gate: ${slot.name} was not landed on ${slot.folder} (${why.en}); the stop is allowed.`, ko: `done-gate: ${slot.name}을(를) ${slot.folder}에 반영하지 못했습니다(${why.ko}). 종료는 허용됩니다.` }), "warning");
		return undefined;
	}
	const owed = deferred.some(problem => problem.repo === slot.path);
	const unlanded = userWaived || !(owed || isLandable(outcome[slot.path])) ? NOTHING_UNLANDED : await judge(slot);
	if (owed) {
		const why = unlandedWhy(unlanded);
		if (why === undefined) state.pendingLand = { slot, stamp };
		else notify(ctx, notLandedNotice(slot, why), "warning");
		return unlanded.findings.length > 0 ? { kind: "noted", repo: slot.path, finding: "land:findings" } : undefined;
	}
	const held = await landNow(state, ctx, slot, stamp, { refused: false, outcome: outcome[slot.path], userWaived, ...unlanded }, signal);
	if (held === undefined) return undefined;
	if (!state.landRefused) {
		state.landRefused = true;
		return held.kind === "moved" ? { kind: "refused", repo: slot.path, finding: "land:moved", reason: movedText(slot, held) } : { kind: "refused", repo: slot.path, finding: "land:findings", reason: findingsText(slot, held.findings) };
	}
	if (held.kind === "findings") {
		notify(ctx, notLandedNotice(slot, held.why), "warning");
		return { kind: "noted", repo: slot.path, finding: "land:findings" };
	}
	notify(ctx, say({ en: `done-gate: ${slot.name} was not landed: ${held.branch} of ${slot.folder} still holds commits it is not based on; the stop is allowed. Run \`${held.instruction}\` in the checkout and finish again to land it.`, ko: `done-gate: ${slot.name}을(를) 반영하지 않았습니다. ${slot.folder}의 ${held.branch}에 아직 바탕이 아닌 커밋이 있습니다. 종료는 허용됩니다. 체크아웃에서 \`${held.instruction}\`을(를) 실행하고 다시 마치면 반영됩니다.` }), "warning");
	return undefined;
}

function spendWaiver(state: State, ctx: Ctx): void {
	const waiver = state.waiver;
	state.waiver = undefined;
	if (waiver === undefined) return;
	for (const mistake of acceptProposed(sessionKey(ctx))) {
		notify(ctx, say({ en: `done-gate: /gate-ok accepted the proposal to close mistake ${mistake.id} without a check; it is closed as ${mistake.status}.`, ko: `done-gate: /gate-ok로 실수 ${mistake.id}을(를) 검사 없이 닫자는 제안을 받아들였습니다. ${mistake.status} 상태로 닫혔습니다.` }), "warning");
	}
}

async function judgeStop(state: State, ctx: Ctx, event: StopEvent, stages: Stages, work: AbortSignal, deliver: Deliver | undefined, show: Show | undefined): Promise<StopResult | undefined> {
	const cwd = cwdOf(ctx);
	const limitMs = stopDeadlineMs();
	const limit = AbortSignal.timeout(limitMs);
	const stop: Stop = { deadline: Date.now() + Math.min(stopBudgetMs(), limitMs), hard: event.signal ? AbortSignal.any([limit, event.signal]) : limit, limitMs, signal: event.signal };
	const stageSignal = AbortSignal.any([work, stop.hard]);
	const row = (outcome: Record<string, Outcome>, changed: number, errors: string[], warnings: string[], extra: Partial<GateRow> = {}): GateRow => {
		const skillFiles = [...state.skillFiles].filter(ref => ref.includes("/"));
		const folder: Record<string, string> = {};
		for (const repo of Object.keys(outcome)) {
			const placed = whereis(repo)?.folder;
			if (placed !== undefined) folder[repo] = placed;
		}
		return {
			at: new Date().toISOString(),
			session: sessionKey(ctx),
			cwd,
			repos: Object.keys(outcome),
			changed,
			skills: [...state.skills],
			...(skillFiles.length ? { skillFiles } : {}),
			...(state.delegated ? { delegated: true } : {}),
			outcome,
			...(state.harness === undefined ? {} : { harness: state.harness }),
			...(Object.keys(folder).length ? { folder } : {}),
			...extra,
			...(errors.length ? { error: errors.join("; ") } : {}),
			...(warnings.length ? { warnings } : {}),
		};
	};
	try {
		if (event.signal?.aborted) {
			cancelChecks(state);
			return undefined;
		}
		const waiver = state.waiver;
		for (const repo of dropVanished(state)) notify(ctx, say({ en: `done-gate: ${repo} no longer exists, so it is left out of this run's judgment.`, ko: `done-gate: ${repo}이(가) 더 이상 없어 이번 실행의 판정에서 뺍니다.` }), "warning");
		const slot = whereis(cwd);
		const preparations = await Promise.all([...new Set([...state.baselines.keys(), ...state.touched])].map(repo => prepare(state, repo, stop, slot)));
		const started = new Map<string, Promise<StageRun>>();
		for (const preparation of preparations) {
			if ("prepared" in preparation && waiver === undefined) startChecks(state, preparation.prepared);
			if ("prepared" in preparation && preparation.prepared.changed.length > 0) {
				const { repo, base, changed } = preparation.prepared;
				const baseline = state.baselines.get(repo);
				const failedOn = `${escapeFailedPrefix(repo)}${escapeInputPrint({ repo, base: baseRef(base), files: changed, toolEdited: baseline?.toolEdited })}`;
				const skipEscape = state.askedGate.has(failedOn) ? `the escape stage in ${repo} failed on these changed files earlier in this run and was not run again; what it would have found is unknown` : undefined;
				started.set(
					repo,
					runStages(stages, { repo, base: baseRef(base), files: changed, baseText: baseline?.texts.textAt, toolEdited: baseline?.toolEdited, acceptedText: acceptedTextAt(repo), skipEscape }, stageSignal).then(run => {
						if (run.escapeFailed) {
							forgetEscapeFailure(state, repo);
							state.askedGate.add(failedOn);
						}
						return run;
					}),
				);
			}
		}
		const results: RepoResult[] = [];
		const partial = new Set<string>();
		const lacking = new Map<string, string>();
		const bare = new Map<string, string>();
		for (const preparation of preparations) {
			if ("error" in preparation) {
				if (state.touched.has(preparation.repo) && (preparation.gated || state.edited.has(preparation.repo) || state.bashed.has(preparation.repo))) results.push({ ...blankResult(state, preparation.repo, preparation.gated, 0), error: preparation.error });
				continue;
			}
			const { prepared } = preparation;
			if (prepared.checked.length === 0 && (!prepared.gated || !state.touched.has(prepared.repo) || prepared.measured)) continue;
			if (prepared.foreign) partial.add(prepared.repo);
			if (stop.hard.aborted) {
				results.push({ ...blankResult(state, prepared.repo, prepared.gated, 0), error: outOfTime(prepared.repo, stop) });
				continue;
			}
			const result = await evaluate(state, prepared, stop, started.get(prepared.repo) ?? Promise.resolve(NO_STAGE_FINDINGS), waiver === undefined);
			const floor = await floorOf(state, prepared, stop);
			result.stageErrors.push(...floor.errors);
			const verify = findingProblem(prepared.repo, "verify", floor.findings);
			if (verify) result.problems.push(verify);
			if (floor.unverified !== undefined) lacking.set(prepared.repo, floor.unverified);
			if (floor.ungated !== undefined) bare.set(prepared.repo, floor.ungated);
			results.push(result);
		}
		withMistakes(state, results, cwd, sessionKey(ctx), stages);
		if (!inDotz()) {
			if (ctx.hasUI === true) {
				withAsk(state, results, cwd);
				withLeftover(state, results, cwd);
			}
			withReport(state, results, cwd, ctx.hasUI === true && deliver !== undefined);
			withInterim(state, results, cwd);
		}
		if (event.signal?.aborted) {
			cancelChecks(state);
			return undefined;
		}
		const decision = waiver ? waivedStop(results, waiver.reason) : decideStop(results, { streak: state.streak, refusals: state.refusals, waits: state.waits });
		const running = results.flatMap(result => result.problems.filter(problem => problem.kind === "running"));
		const deferred = decision.block && decision.running && ctx.hasUI === true && deliver !== undefined ? running : [];
		const block = decision.block && deferred.length === 0;
		const outcome: Record<string, Outcome> = { ...decision.outcomes };
		for (const problem of deferred) outcome[problem.repo] = "deferred";
		for (const result of results) if (outcome[result.repo] === "no-gate" && !state.edited.has(result.repo)) delete outcome[result.repo];
		if (!block) for (const repo of state.edited) if (!Object.hasOwn(outcome, repo)) outcome[repo] = "no-gate";
		if (waiver && Object.keys(outcome).length === 0) outcome[cwd] = "user-waived";
		const errors = [
			...results.filter(r => r.error !== undefined).map(r => `${r.repo}: ${r.error}`),
			...new Set(results.flatMap(r => r.stageErrors)),
			...state.errors,
		];
		const unjudged = block ? undefined : unjudgedNotice(results, cwd);
		const unverified = block ? [] : [...lacking];
		const ungated = block ? [] : [...bare];
		const warnings = [...results.flatMap(r => r.warnings), ...unverified.map(([, warning]) => warning), ...ungated.map(([, warning]) => warning), ...(unjudged === undefined ? [] : [unjudged])];
		const findings = countClasses(results.flatMap(r => r.problems.filter(problem => !deferred.includes(problem))));
		const changed = results.reduce((sum, r) => sum + (Object.hasOwn(outcome, r.repo) ? r.changed : 0), 0);
		const accepted = block ? [] : acceptedOf(results, cwd);
		const logRow = (held?: LandHold): void => {
			const logged: Record<string, Outcome> = held?.kind === "refused" ? { ...outcome, [held.repo]: "blocked" } : outcome;
			const found = held === undefined ? findings : { ...findings, [held.finding]: 1 };
			appendRow(row(logged, changed, errors, warnings, { ...(Object.keys(found).length ? { findings: found } : {}), ...(waiver ? { waiver: waiver.reason } : {}), ...(accepted.length ? { why: accepted } : {}), ...(unverified.length ? { unverified: unverified.map(([repo]) => repo) } : {}), ...(ungated.length ? { ungated: ungated.map(([repo]) => repo) } : {}), ...(deferred.length ? { deferred: [...new Set(deferred.map(problem => problem.name))] } : {}) }));
		};
		for (const notice of [...decision.notices, ...warnings]) notify(ctx, notice, "warning");
		if (accepted.length) (show ?? notifyReport)(ctx, acceptedNotice(accepted));
		if (decision.block && block) {
			logRow();
			state.streak = decision.streak;
			state.waitedFor = decision.running ? [...new Set(running.map(problem => problem.name))] : [];
			if (decision.running) {
				state.waits += 1;
				notify(ctx, say({ en: `done-gate: waiting for check ${state.waitedFor.map(name => `"${name}"`).join(", ")} to finish; this session goes on by itself and ends with the final report once the check is in.`, ko: `done-gate: 검사 ${state.waitedFor.map(name => `"${name}"`).join(", ")}이(가) 끝나기를 기다리는 중입니다. 이 세션은 스스로 이어서 진행하고, 검사 결과가 나오면 최종 보고로 마칩니다.` }), "info");
			} else {
				state.refusals += 1;
				notify(ctx, say({ en: `done-gate: refused (${Object.keys(findings).join(", ") || "see the gate log"}); refusal ${state.refusals} of this run; the agent goes on to fix it.`, ko: `done-gate: 종료를 거절했습니다(${Object.keys(findings).join(", ") || "게이트 로그 참고"}). 이번 실행의 ${state.refusals}번째 거절이며, 에이전트가 이어서 고칩니다.` }), "warning");
			}
			for (const [repo, result] of Object.entries(decision.outcomes)) if (result === "blocked") state.blocked.add(repo);
			for (const result of results) {
				for (const problem of result.problems) {
					if (Object.hasOwn(problem.classes, "verify:nothing-run")) state.asked.add(result.repo);
					if (Object.hasOwn(problem.classes, "verify:no-gate-file")) state.askedGate.add(result.repo);
					if (problem.kind === "finding" && problem.name === "ask") state.askedAsk = true;
					if (problem.kind === "finding" && problem.name === "leftover") state.askedLeftover = true;
					if (problem.kind === "finding" && problem.name === "report") state.askedReport = true;
					if (Object.hasOwn(problem.classes, "verify:gate-not-from-script")) state.askedGate.add(originKey(result.repo));
				}
			}
			state.refusal = decision.reason;
			supersede(state, ctx, latestReply(state), Object.keys(findings));
			return { decision: "block", reason: decision.reason };
		}
		if (errors.length) notify(ctx, say({ en: `done-gate: not enforced (${errors.join("; ")}); the stop is allowed.`, ko: `done-gate: 적용하지 못했습니다(${errors.join("; ")}). 종료는 허용됩니다.` }), "warning");
		const slotAccepted = slot === undefined ? undefined : acceptedTextAt(slot.path);
		for (const result of results) if (!partial.has(result.repo) && (waiver || (result.problems.length === 0 && result.error === undefined && result.stageErrors.length === 0))) recordAccepted(result.repo);
		const held = await landAtStop(state, ctx, slot, outcome, deferred, waiver !== undefined, placed => judgeUnlanded(stages, placed, slotAccepted, stageSignal), stop.hard);
		logRow(held);
		if (held?.kind === "refused") {
			spendWaiver(state, ctx);
			state.refusal = held.reason;
			supersede(state, ctx, latestReply(state), [held.finding]);
			return { decision: "block", reason: held.reason };
		}
		spendWaiver(state, ctx);
		if (deliver !== undefined) defer(state, deferred, ctx, deliver);
		endRun(state);
		if (deliver !== undefined) reportSettled(state, ctx, deliver);
		return undefined;
	} catch (error) {
		if (event.signal?.aborted) {
			cancelChecks(state);
			return undefined;
		}
		appendRow(row({ [cwd]: "error" }, 0, [message(error)], []));
		notify(ctx, say({ en: `done-gate: not enforced (${message(error)}); the stop is allowed.`, ko: `done-gate: 적용하지 못했습니다(${message(error)}). 종료는 허용됩니다.` }), "warning");
		spendWaiver(state, ctx);
		endRun(state);
		if (deliver !== undefined) reportSettled(state, ctx, deliver);
		return undefined;
	}
}
