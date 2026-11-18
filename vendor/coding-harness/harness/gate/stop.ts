import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acceptedTextAt, recordAccepted } from "./accepted-gate.ts";
import { acceptedNotice, acceptedOf, unjudgedNotice } from "./accepted.ts";
import { gateWrittenByScript, needsBootstrap } from "./bootstrap.ts";
import { sessionFiles } from "./changed.ts";
import { citationFindings } from "./citations.ts";
import { stopBudgetMs, stopDeadlineMs, until } from "./deadline.ts";
import { decideStop, waivedStop } from "./decision.ts";
import type { Outcome, Problem, RepoResult } from "./decision.ts";
import { baseTextOf, gitShow, runAll } from "./escape-common.ts";
import { evidenceText, evidenceVerdict, featuresAt, isUnder, readFeatures } from "./evidence.ts";
import { countClasses, findingProblem } from "./findings.ts";
import { gateFilePath, matchesAny, readGateFile } from "./gate-file.ts";
import type { Check } from "./gate-file.ts";
import { cwdOf, inDotz, notify, sessionKey } from "./host.ts";
import type { Ctx, StopEvent, StopResult } from "./host.ts";
import { defer, dropLater, reportSettled } from "./later.ts";
import type { Deliver } from "./later.ts";
import { appendRow, readPassed, writePassed } from "./log.ts";
import type { GateRow, Passed } from "./log.ts";
import { acceptProposed } from "./mistakes.ts";
import { askFindings, askWarning } from "./ask.ts";
import { plainTextFindings, plainTextWarning } from "./plaintext.ts";
import { LANGUAGE_NAMES, reportFindings, reportWarning } from "./report.ts";
import { failureClass, failureState, failureText, startRun, waitFor } from "./runs.ts";
import { cancelChecks, checkKey, endRun, recentFailure, userScriptOf } from "./session.ts";
import type { ActiveRun, State } from "./session.ts";
import { baseRef, fingerprint, takeSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import { NO_STAGE_FINDINGS, mistakeStage, runStages } from "./stages.ts";
import type { StageRun, Stages } from "./stages.ts";
import type { Finding } from "./types.ts";
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
}

type Preparation = { prepared: Prepared } | { repo: string; gated: boolean; error: string };

const outOfTime = (repo: string, stop: Stop) => `the stop ran out of its ${stop.limitMs / 1000} s before ${repo} was judged`;

function runningProblem(repo: string, check: Check, active: ActiveRun): Problem {
	const seconds = Math.round((Date.now() - active.run.startedAt) / 1000);
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
	const active = { run: startRun(repo, check.command, check.timeoutSec), repo, check, command: check.command, print, toolCalls: state.toolCalls, second };
	state.checks.set(key, active);
	return { active, watched: false };
}

function startChecks(state: State, prepared: Prepared): void {
	if (prepared.changed.length === 0 || !prepared.gated) return;
	let checks: Check[];
	try {
		checks = readGateFile(prepared.repo).checks;
	} catch {
		return;
	}
	const passed = readPassed(prepared.repo);
	for (const check of checks) {
		if (!prepared.changed.some(file => matchesAny(check.paths, file)) || state.later.has(checkKey(prepared.repo, check.name))) continue;
		const print = fingerprint(prepared.now.tree, prepared.now.dirty, check.paths);
		const known = passed[check.name];
		if (known?.fingerprint !== print || known.command !== check.command) runOf(state, prepared.repo, check, print, false);
	}
}

async function judgeCheck(judging: Judging, check: Check, now: Snapshot, second = false): Promise<Problem | undefined> {
	const { state, repo, stop, passed, warnings } = judging;
	const print = fingerprint(now.tree, now.dirty, check.paths);
	const known = passed[check.name];
	if (known?.fingerprint === print && known.command === check.command) return undefined;
	const key = checkKey(repo, check.name);
	const { active, watched } = runOf(state, repo, check, print, second);
	if (watched) return runningProblem(repo, check, active);
	const done = active.run.settled ?? (await waitFor(active.run, stop.deadline - Date.now(), stop.signal));
	if (!done) return runningProblem(repo, check, active);
	state.checks.delete(key);
	if (done.spawnError !== undefined) throw new Error(`could not start bash for check "${check.name}" in ${repo}: ${done.spawnError}`);
	if (done.timedOut || done.code !== 0) return { kind: "check", repo, name: check.name, state: failureState(done), text: failureText(repo, check, done), classes: { [`checks:${failureClass(done)}`]: 1 } };
	const after = await takeSnapshot(repo, stop.hard);
	const afterPrint = fingerprint(after.tree, after.dirty, check.paths);
	if (afterPrint !== active.print) {
		if (!active.second) return await judgeCheck(judging, check, after, true);
		warnings.push(`done-gate: check "${check.name}" changed files under its own paths in ${repo} on two runs in a row; its second result is accepted for the tree it left behind.`);
	}
	passed[check.name] = { fingerprint: afterPrint, command: check.command };
	writePassed(repo, { ...readPassed(repo), [check.name]: passed[check.name] });
	return undefined;
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

async function prepare(state: State, repo: string, stop: Stop): Promise<Preparation> {
	const gated = existsSync(gateFilePath(repo));
	try {
		const base = await baselineOf(state, repo, stop);
		const { now, files: changed } = await sessionFiles(repo, base, state.baselines.get(repo), stop.hard);
		return { prepared: { repo, gated, base, now, changed } };
	} catch (error) {
		return { repo, gated, error: stop.hard.aborted ? outOfTime(repo, stop) : message(error) };
	}
}

async function judgeGate(state: State, prepared: Prepared, stop: Stop): Promise<Pick<RepoResult, "problems" | "waived" | "warnings">> {
	const { repo, now, changed } = prepared;
	const gate = readGateFile(repo);
	const judged: Pick<RepoResult, "problems" | "waived" | "warnings"> = { problems: [], waived: [], warnings: [] };
	const judging: Judging = { state, repo, stop, passed: readPassed(repo), warnings: judged.warnings };
	for (const check of changed.length ? gate.checks : []) {
		if (!changed.some(file => matchesAny(check.paths, file))) continue;
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
		floor.ungated = `done-gate: ${repo} finished with a ${GATE_FILE} that is neither committed at HEAD nor the one the bootstrap script wrote.`;
		return;
	}
	floor.findings.push({ stage: "verify", class: "gate-not-from-script", message: `${repo}/${GATE_FILE} is not committed at HEAD and is not the file the bootstrap script wrote in this checkout, so it does not count as a gate. If the user wrote it, they can commit it. Otherwise remove it and run \`bun ${shellQuote(BOOTSTRAP_SCRIPT)} ${shellQuote(repo)}\` once, which writes the gate file; do not write or edit the gate file by hand. Then finish again.`, file: GATE_FILE });
}

async function askForGateFile(state: State, prepared: Prepared, stop: Stop, floor: Floor): Promise<void> {
	const { repo } = prepared;
	try {
		const needed = stop.hard.aborted ? undefined : await until(needsBootstrap(repo, stop.hard), stop.hard);
		if (needed === undefined) throw new Error(outOfTime(repo, stop));
		if (!needed.value) return;
		if (state.askedGate.has(repo)) floor.ungated = `done-gate: ${repo} still has no gate file; the next run will ask again.`;
		else floor.findings.push({ stage: "verify", class: "no-gate-file", message: `${repo} has no gate file, so nothing checks a change here when a session stops. Run \`bun ${shellQuote(BOOTSTRAP_SCRIPT)} ${shellQuote(repo)}\` once: it finds the repo's typecheck, lint and test commands, keeps the ones that pass now within 20 s, and writes .omp/gate.json and the rule kit under .omp/lint. Then finish again.` });
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
			floor.unverified = `done-gate: ${repo} finished without anything being run after the last edit of ${file}.`;
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

function withCitations(state: State, results: RepoResult[], cwd: string): void {
	const problem = findingProblem(cwd, "cite", citationFindings(state.reply, state.skills));
	if (problem === undefined) return;
	const home = results.find(result => result.repo === cwd);
	if (home) home.problems.push(problem);
	else results.push({ ...blankResult(state, cwd, false, 0), problems: [problem] });
}

function withPlainText(state: State, results: RepoResult[], cwd: string): void {
	const found = plainTextFindings(state.reply);
	if (found.length === 0) return;
	let home = results.find(result => result.repo === cwd);
	if (home === undefined) {
		home = blankResult(state, cwd, false, 0);
		results.push(home);
	}
	if (state.askedPlain) {
		home.warnings.push(plainTextWarning(found));
		return;
	}
	const problem = findingProblem(cwd, "plain", found);
	if (problem) home.problems.push(problem);
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
	home.warnings.push(`done-gate: ${state.interimWrong} interim messages or tool-call intent labels this run were not in ${LANGUAGE_NAMES[user]}.`);
}

/**
 * Judges every repo of the run at a stop. Each repo the session changed goes through the anti-escape stage and, when it has
 * `.omp/lint`, the rules stage; a repo with a gate file also through its checks and evidence; after the repos, the session's
 * mistake obligations. A repo where the session wrote source files (with an edit tool, or during a `task` call or a bash command
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
 * The last reply of the session is judged for citations too: one that names a `principle-<kebab>` id whose skill the run did not
 * read through a `skill://` URL is refused (`cite:unread-principle`), under the same waiver and streak rules as the stages' findings.
 * So is one with markdown the terminal shows raw: `**bold**`, a `#` heading or a table outside fenced code (`plain:bold`,
 * `plain:heading`, `plain:table`). That is refused once per run; a later stop of the run lets it through with a warning.
 * A reply of an interactive session (`ctx.hasUI`, outside dotz) that asks the user something in its text, a request to choose or tell, a
 * question ending or a line ending in `?`, outside fenced code (`ask:question`), is refused once per run with the order to put every
 * question and decision into one `ask` tool form with a recommended option preselected; a later stop of the run lets it through with a warning.
 * A reply written in another script than the user's last prompt (`report:language`) is refused once per run, then let through
 * with a warning. A refusal for work asks in its own text that the reply after the fix be the final report.
 * A stop refused only to wait for running checks lets an interactive session (`ctx.hasUI`, with `deliver`) finish instead: the
 * runs are left to end after it (`defer`), the user hears how each ends, and a failure is put before the agent as a new turn.
 * Without a UI the stop is refused to wait, and the reply that answers that wait is refused for the report whenever the check
 * is in, so a note about waiting never stays the last message the user sees.
 * Everything found goes into one refusal, stage findings first. A waiver from /gate-ok lets the stop through and accepts the
 * agent's proposals to close a user's mistake without a check. The stages' signals have fired when it returns.
 */
export async function onStop(state: State, ctx: Ctx, event: StopEvent, stages: Stages, deliver?: Deliver): Promise<StopResult | undefined> {
	const work = new AbortController();
	try {
		return await judgeStop(state, ctx, event, stages, work.signal, deliver);
	} finally {
		work.abort();
	}
}

function spendWaiver(state: State, ctx: Ctx): void {
	const waiver = state.waiver;
	state.waiver = undefined;
	if (waiver === undefined) return;
	for (const mistake of acceptProposed(sessionKey(ctx))) {
		notify(ctx, `done-gate: /gate-ok accepted the proposal to close mistake ${mistake.id} without a check; it is closed as ${mistake.status}.`, "warning");
	}
}

async function judgeStop(state: State, ctx: Ctx, event: StopEvent, stages: Stages, work: AbortSignal, deliver: Deliver | undefined): Promise<StopResult | undefined> {
	const cwd = cwdOf(ctx);
	const limitMs = stopDeadlineMs();
	const limit = AbortSignal.timeout(limitMs);
	const stop: Stop = { deadline: Date.now() + Math.min(stopBudgetMs(), limitMs), hard: event.signal ? AbortSignal.any([limit, event.signal]) : limit, limitMs, signal: event.signal };
	const stageSignal = AbortSignal.any([work, stop.hard]);
	const row = (outcome: Record<string, Outcome>, changed: number, errors: string[], warnings: string[], extra: Partial<GateRow> = {}): GateRow => ({
		at: new Date().toISOString(),
		session: sessionKey(ctx),
		cwd,
		repos: Object.keys(outcome),
		changed,
		skills: [...state.skills],
		outcome,
		...(state.harness === undefined ? {} : { harness: state.harness }),
		...extra,
		...(errors.length ? { error: errors.join("; ") } : {}),
		...(warnings.length ? { warnings } : {}),
	});
	try {
		if (event.signal?.aborted) {
			cancelChecks(state);
			return undefined;
		}
		const waiver = state.waiver;
		const preparations = await Promise.all([...new Set([...state.baselines.keys(), ...state.touched])].map(repo => prepare(state, repo, stop)));
		const started = new Map<string, Promise<StageRun>>();
		for (const preparation of preparations) {
			if ("prepared" in preparation && waiver === undefined) startChecks(state, preparation.prepared);
			if ("prepared" in preparation && preparation.prepared.changed.length > 0) {
				const { repo, base, changed } = preparation.prepared;
				const baseline = state.baselines.get(repo);
				started.set(repo, runStages(stages, { repo, base: baseRef(base), files: changed, baseText: baseline?.texts.textAt, toolEdited: baseline?.toolEdited, acceptedText: acceptedTextAt(repo) }, stageSignal));
			}
		}
		const results: RepoResult[] = [];
		const lacking = new Map<string, string>();
		const bare = new Map<string, string>();
		for (const preparation of preparations) {
			if ("error" in preparation) {
				if (state.touched.has(preparation.repo) && (preparation.gated || state.edited.has(preparation.repo) || state.bashed.has(preparation.repo))) results.push({ ...blankResult(state, preparation.repo, preparation.gated, 0), error: preparation.error });
				continue;
			}
			const { prepared } = preparation;
			if (prepared.changed.length === 0 && (!prepared.gated || !state.touched.has(prepared.repo))) continue;
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
		withCitations(state, results, cwd);
		if (!inDotz()) {
			withPlainText(state, results, cwd);
			if (ctx.hasUI === true) withAsk(state, results, cwd);
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
		appendRow(row(outcome, changed, errors, warnings, { ...(Object.keys(findings).length ? { findings } : {}), ...(waiver ? { waiver: waiver.reason } : {}), ...(accepted.length ? { why: accepted } : {}), ...(unverified.length ? { unverified: unverified.map(([repo]) => repo) } : {}), ...(ungated.length ? { ungated: ungated.map(([repo]) => repo) } : {}), ...(deferred.length ? { deferred: [...new Set(deferred.map(problem => problem.name))] } : {}) }));
		for (const notice of [...decision.notices, ...warnings]) notify(ctx, notice, "warning");
		if (accepted.length) notify(ctx, acceptedNotice(accepted), "warning");
		if (decision.block && block) {
			state.streak = decision.streak;
			state.waitedFor = decision.running ? [...new Set(running.map(problem => problem.name))] : [];
			if (decision.running) {
				state.waits += 1;
				notify(ctx, `done-gate: waiting for check ${state.waitedFor.map(name => `"${name}"`).join(", ")} to finish; this session goes on by itself and ends with the final report once the check is in.`, "info");
			} else {
				state.refusals += 1;
				notify(ctx, `done-gate: refused (${Object.keys(findings).join(", ") || "see the gate log"}); refusal ${state.refusals} of this run; the agent goes on to fix it.`, "warning");
			}
			for (const [repo, result] of Object.entries(decision.outcomes)) if (result === "blocked") state.blocked.add(repo);
			for (const result of results) {
				for (const problem of result.problems) {
					if (Object.hasOwn(problem.classes, "verify:nothing-run")) state.asked.add(result.repo);
					if (Object.hasOwn(problem.classes, "verify:no-gate-file")) state.askedGate.add(result.repo);
					if (problem.kind === "finding" && problem.name === "plain") state.askedPlain = true;
					if (problem.kind === "finding" && problem.name === "ask") state.askedAsk = true;
					if (problem.kind === "finding" && problem.name === "report") state.askedReport = true;
					if (Object.hasOwn(problem.classes, "verify:gate-not-from-script")) state.askedGate.add(originKey(result.repo));
				}
			}
			state.refusal = decision.reason;
			return { decision: "block", reason: decision.reason };
		}
		if (errors.length) notify(ctx, `done-gate: not enforced (${errors.join("; ")}); the stop is allowed.`, "warning");
		for (const result of results) if (waiver || (result.problems.length === 0 && result.error === undefined && result.stageErrors.length === 0)) recordAccepted(result.repo);
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
		notify(ctx, `done-gate: not enforced (${message(error)}); the stop is allowed.`, "warning");
		spendWaiver(state, ctx);
		endRun(state);
		if (deliver !== undefined) reportSettled(state, ctx, deliver);
		return undefined;
	}
}
