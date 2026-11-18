import { statSync } from "node:fs";
import { dirname, extname } from "node:path";
import { ensureAccepted } from "./accepted-gate.ts";
import { BaseTexts, pruneStaleBases } from "./base-text.ts";
import { baselineBudgetMs, until } from "./deadline.ts";
import type { Streak } from "./decision.ts";
import type { Check } from "./gate-file.ts";
import { setupCommit } from "./log.ts";
import type { Script } from "./report.ts";
import type { Run } from "./runs.ts";
import { baseRef, changedFiles, committedFiles, git, takeSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import { message } from "./util.ts";

const NO_REPO_RECHECK_MS = 10_000;
const FAILED_BASELINE_RETRY_MS = 10 * 60_000;
const SOURCE_EXTENSIONS: Record<string, true> = {
	ts: true, tsx: true, js: true, jsx: true, mjs: true, cjs: true, mts: true, cts: true, py: true, go: true, rs: true, java: true, kt: true, swift: true,
	rb: true, php: true, c: true, h: true, cc: true, cpp: true, hpp: true, cs: true, sh: true, bash: true, zsh: true, sql: true, vue: true, svelte: true,
};

export type BaselineResult = { ok: true; snapshot: Snapshot } | { ok: false; error: string };

/**
 * A repo's state at first sight in a run, with the base texts of the files that were dirty then. A baseline that failed, or
 * that a handler stopped waiting for while a tool call followed (`late`), cannot say what the session changed: it may include
 * that call's changes. `failure` is set as soon as that is known, and `onFailure` hears of it once.
 */
export class Baseline {
	settled = false;
	failure: string | undefined;
	readonly result: Promise<BaselineResult>;
	readonly texts: BaseTexts;
	readonly toolEdited = new Set<string>();

	constructor(
		readonly repo: string,
		private readonly onFailure: (error: string) => void,
	) {
		this.texts = new BaseTexts(repo);
		const budget = AbortSignal.timeout(baselineBudgetMs());
		this.result = takeSnapshot(repo, budget)
			.then(async snapshot => {
				await this.texts.start(snapshot, budget);
				return snapshot;
			})
			.then(
				(snapshot): BaselineResult => {
					this.settled = true;
					return this.failure === undefined ? { ok: true, snapshot } : { ok: false, error: this.failure };
				},
				(error: unknown): BaselineResult => {
					this.settled = true;
					return { ok: false, error: this.fail(`baseline failed: ${message(error)}`) };
				},
			);
	}

	/** Records why this baseline cannot be used; the first reason stays. Returns the reason. */
	fail(error: string): string {
		if (this.failure === undefined) {
			this.failure = error;
			this.onFailure(error);
		}
		return this.failure;
	}

	/** A tool call is about to run and the snapshot is still going: it may include that call's changes. */
	late(): void {
		if (!this.settled) this.fail(`baseline of ${this.repo} was late: it finished after a tool call had begun and may include that call's changes`);
	}
}

/** A check's process, with what it took to start it: the repo and check it runs for, the tree fingerprint and the session's tool-call count at that moment, and whether it is already the second run after the check's own writes. */
export interface ActiveRun {
	run: Run;
	repo: string;
	check: Check;
	command: string;
	print: string;
	toolCalls: number;
	second: boolean;
}

/** The key a check's run has in `State.checks` and `State.later`: its repo and its name. */
export const checkKey = (repo: string, name: string): string => `${repo}\0${name}`;

/** The repo each directory belongs to (null for none) and when that was looked up, so a repo-less directory is looked at again after a while. */
export type DirRepos = Map<string, { repo: string | null; at: number }>;

/** The user's `/gate-ok`: the next stop of the session is allowed whatever it finds. */
export interface Waiver {
	reason: string;
}

/** A tool call whose result has not come yet: the session's tool-call count at the call, and its input for a result that does not carry it. */
export interface PendingCall {
	calls: number;
	input: Record<string, unknown>;
}

/**
 * What the gate keeps per session. Across runs: the repos the session has seen, the baselines that failed and when, the
 * session's tool-call count, a waiver the user granted, the checks a stop of an interactive session left running because
 * it let the session finish while they ran (`later`), and the commit the installed harness was set up from, read when the
 * session's state is made (`harness`). Per run: the baselines, the repos the run reached and edited, its
 * refusal memory, the checks still running, whether it is still going (`active`), the history-moving git commands whose
 * second snapshot is owed (`moves`), the calls that apply a patch and whose second snapshot is owed (`patches`), the tool
 * calls still to answer (`pending`), what the self-verification floor reads (the source files an edit tool wrote or a
 * patch-applying call changed, per repo with the count of each one's last write, `sourceWrites`; the last call that ran
 * something, `evidenceAt`; the repos it already `asked` about, and the repos it already asked to be given a gate file,
 * `askedGate`), the text of its last assistant message (`reply`), whether it already refused a reply for markdown
 * (`askedPlain`), for asking the user something in its text instead of the `ask` tool (`askedAsk`) and for not being a final report in the user's language (`askedReport`), the script of its last message when that was not the user's language and no tool call has told it yet (`interimLanguage`), how many such messages a tool call told it about (`interimWrong`), the checks its last refusal only
 * waited for, so the last reply answers that wait and not the user (`waitedFor`, empty otherwise), and what the next
 * `agent_start` is (`next`). Kept across runs: the language the user last asked the report in explicitly (`askedScript`), the
 * script of the user's last prompt (`userScript`), the non-latin script the user last wrote a prompt mostly in (`firmScript`, which a latin prompt does not replace), whether the session read skill://ulw (`ulwRead`), and whether it was reminded of the
 * ulw router at a source edit made without it (`nudgedUlw`).
 */
export interface State {
	baselines: Map<string, Baseline>;
	repos: Set<string>;
	failed: Map<string, { at: number; error: string }>;
	dirRepo: DirRepos;
	touched: Set<string>;
	edited: Set<string>;
	bashed: Set<string>;
	blocked: Set<string>;
	skills: Set<string>;
	checks: Map<string, ActiveRun>;
	later: Map<string, ActiveRun>;
	errors: string[];
	streak?: Streak;
	refusals: number;
	waits: number;
	toolCalls: number;
	waiver?: Waiver;
	refusal?: string;
	next?: "continue" | "fresh";
	active: boolean;
	moves: Map<string, PendingMove[]>;
	patches: Map<string, PendingPatch[]>;
	pending: Map<string, PendingCall>;
	sourceWrites: Map<string, Map<string, number>>;
	evidenceAt?: number;
	asked: Set<string>;
	askedGate: Set<string>;
	askedPlain: boolean;
	askedAsk: boolean;
	nudgedUlw: boolean;
	ulwRead: boolean;
	askedReport: boolean;
	waitedFor: string[];
	userScript?: Script;
	askedScript?: Script;
	firmScript?: Script;
	reply?: string;
	interimLanguage?: Script;
	interimWrong: number;
	harness?: string;
}

/** A repo as it was just before a history-moving git command of a bash call ran. */
export interface PendingMove {
	repo: string;
	before: Snapshot;
}

/** A repo as it was just before a call that applies a patch ran: HEAD, and the content hash of every dirty file and of every source file an edit tool wrote. */
export interface PendingPatch {
	repo: string;
	before: Snapshot;
}

/** Paths a tool call reaches: `edited` when the call writes them, `bash` when they are the directories of a bash command, which may change files in any repo it runs in. */
export interface PathGroup {
	paths: readonly string[];
	edited: boolean;
	bash?: boolean;
}

/** One repo's baseline HEAD (the empty tree for a repo without commits) and the repo-relative files the session changed since; `error` is set instead when no baseline could be taken. */
export interface SessionChange {
	repo: string;
	base: string;
	files: string[];
	error?: string;
}

export const newState = (): State => ({
	baselines: new Map(),
	repos: new Set(),
	failed: new Map(),
	dirRepo: new Map(),
	touched: new Set(),
	edited: new Set(),
	bashed: new Set(),
	blocked: new Set(),
	skills: new Set(),
	checks: new Map(),
	later: new Map(),
	errors: [],
	refusals: 0,
	waits: 0,
	toolCalls: 0,
	active: false,
	moves: new Map(),
	patches: new Map(),
	pending: new Map(),
	sourceWrites: new Map(),
	asked: new Set(),
	askedGate: new Set(),
	askedPlain: false,
	askedAsk: false,
	askedReport: false,
	nudgedUlw: false,
	interimWrong: 0,
	ulwRead: false,
	waitedFor: [],
	harness: setupCommit(),
});

/** Kills every check the session has running and forgets them. */
export function cancelChecks(state: State): void {
	for (const { run } of state.checks.values()) run.cancel();
	state.checks.clear();
}

/** The run is over: its checks are cancelled and everything it recorded is dropped, so the next run starts from first sight. The repos the session has seen and the baselines that failed stay, and so do the checks left to finish later (`later`): only `cancelLater` stops those. */
export function endRun(state: State): void {
	cancelChecks(state);
	for (const baseline of state.baselines.values()) baseline.texts.dispose();
	state.baselines.clear();
	state.moves.clear();
	state.patches.clear();
	state.touched.clear();
	state.blocked.clear();
	state.skills.clear();
	state.edited.clear();
	state.bashed.clear();
	state.pending.clear();
	state.sourceWrites.clear();
	state.evidenceAt = undefined;
	state.asked.clear();
	state.askedGate.clear();
	state.askedPlain = false;
	state.askedAsk = false;
	state.askedReport = false;
	state.waitedFor = [];
	state.reply = undefined;
	state.interimLanguage = undefined;
	state.interimWrong = 0;
	state.errors = [];
	state.streak = undefined;
	state.refusals = 0;
	state.waits = 0;
	state.refusal = undefined;
	state.active = false;
}

/** The script the user writes in: the one a prompt asked the report in, else the last prompt's, with a latin prompt (a pasted command, a short English word) not replacing the non-latin script the user last wrote mostly in. Undefined while no prompt showed it. */
export const userScriptOf = (state: State): Script | undefined => state.askedScript ?? (state.userScript === "latin" ? (state.firmScript ?? "latin") : state.userScript);

/** Whether `file` is a source file by its extension (ts, js, py, go, rs and the like; Markdown and data files are not). */
export function isSourceFile(file: string): boolean {
	return SOURCE_EXTENSIONS[extname(file).slice(1).toLowerCase()] === true;
}

/** A tool call begins: the session's tool-call count goes up by one, and a call with an id is remembered under it until `endCall`. */
export function startCall(state: State, id: string | undefined, input: Record<string, unknown>): void {
	state.toolCalls += 1;
	if (id !== undefined) state.pending.set(id, { calls: state.toolCalls, input });
}

/** A tool call has its result: forgets the call and returns what `startCall` remembered of it, if anything. */
export function endCall(state: State, id: string | undefined): PendingCall | undefined {
	if (id === undefined) return undefined;
	const call = state.pending.get(id);
	state.pending.delete(id);
	return call;
}

/** The call at tool-call count `calls` ran something that can show a change works. */
export function noteEvidence(state: State, calls: number): void {
	state.evidenceAt = Math.max(state.evidenceAt ?? calls, calls);
}

/** The call at tool-call count `calls` wrote the source file `file` of `repo`, with an edit tool or while it applied a patch; the file keeps the count of its last write. */
export function noteSourceWrite(state: State, repo: string, file: string, calls: number): void {
	const files = state.sourceWrites.get(repo) ?? new Map<string, number>();
	files.set(file, Math.max(files.get(file) ?? calls, calls));
	state.sourceWrites.set(repo, files);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The nearest directory at or above `path` that exists. */
export function existingDir(path: string): string | undefined {
	let dir = path;
	while (!isDirectory(dir)) {
		const up = dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
	return dir;
}

/** The git repo root of `dir`, remembered in `cache`; undefined for a directory outside any repo or when `signal` aborts first. */
export async function repoOfDir(cache: DirRepos, dir: string, signal: AbortSignal): Promise<string | undefined> {
	const cached = cache.get(dir);
	if (cached && (cached.repo !== null || Date.now() - cached.at < NO_REPO_RECHECK_MS)) return cached.repo ?? undefined;
	let repo: string | null;
	try {
		repo = (await git(dir, ["rev-parse", "--show-toplevel"], signal)).trim() || null;
	} catch {
		if (signal.aborted) return undefined;
		repo = null;
	}
	cache.set(dir, { repo, at: Date.now() });
	return repo ?? undefined;
}

/** Why `repo`'s baseline failed or came late within the last 10 minutes, which is how long the session does not try again; undefined when it did not. */
export function recentFailure(state: State, repo: string): string | undefined {
	const known = state.failed.get(repo);
	if (known === undefined) return undefined;
	if (Date.now() - known.at < FAILED_BASELINE_RETRY_MS) return known.error;
	state.failed.delete(repo);
	return undefined;
}

function open(state: State, repo: string): Baseline | undefined {
	const known = state.baselines.get(repo);
	if (known !== undefined) return known;
	ensureAccepted(repo);
	if (recentFailure(state, repo) !== undefined) return undefined;
	const baseline: Baseline = new Baseline(repo, error => {
		if (state.baselines.get(repo) === baseline) state.failed.set(repo, { at: Date.now(), error });
	});
	state.baselines.set(repo, baseline);
	return baseline;
}

interface Seen {
	repo: string;
	edited: boolean;
	bashed: boolean;
	touched: boolean;
}

/**
 * Records the baseline of every git repo the paths lead to, once per run, and waits for it until `deadline`; `known` are repo
 * roots to baseline as well without the run having reached them. Never throws: a tool_call handler that throws blocks the tool.
 * With `toolFollows`, a baseline still pending at the deadline is marked late. A repo whose baseline failed or came late
 * within the last 10 minutes is not baselined again.
 */
export async function track(state: State, groups: readonly PathGroup[], deadline: AbortSignal, toolFollows: boolean, known: readonly string[] = []): Promise<void> {
	try {
		const lookups = new Map<string, Promise<string | undefined>>();
		const reposOf = (paths: readonly string[]) =>
			paths.map(path => {
				const dir = existingDir(path);
				if (dir === undefined) return Promise.resolve(undefined);
				const lookup = lookups.get(dir) ?? repoOfDir(state.dirRepo, dir, deadline);
				lookups.set(dir, lookup);
				return lookup;
			});
		const found = await until(Promise.all(groups.map(async group => ({ edited: group.edited, bashed: group.bash === true, repos: await Promise.all(reposOf(group.paths)) }))), deadline);
		if (!found) {
			state.errors.push("could not look up the repos of a tool call before its deadline; changes it makes may go unseen");
			return;
		}
		const seen: Seen[] = known.map(repo => ({ repo, edited: false, bashed: false, touched: false }));
		for (const { edited, bashed, repos } of found.value) for (const repo of repos) if (repo !== undefined) seen.push({ repo, edited, bashed, touched: true });
		const pending: Baseline[] = [];
		for (const { repo, edited, bashed, touched } of seen) {
			state.repos.add(repo);
			if (touched) state.touched.add(repo);
			if (edited) state.edited.add(repo);
			if (bashed) state.bashed.add(repo);
			const baseline = open(state, repo);
			if (baseline !== undefined && !baseline.settled && baseline.failure === undefined) pending.push(baseline);
		}
		if (pending.length === 0) return;
		const finished = await until(Promise.all(pending.map(baseline => baseline.result)), deadline);
		if (!finished && toolFollows) for (const baseline of pending) baseline.late();
	} catch (error) {
		state.errors.push(message(error));
	}
}

/**
 * An agent loop that is not the continuation of a run starts one: the previous run is over however it ended, with its checks
 * cancelled and its refusal memory dropped, and the repo of `cwd` and every repo the session has seen are baselined afresh, so
 * nothing that happened before the loop is blamed on the run.
 */
export async function beginRun(state: State, cwd: string, deadline: AbortSignal): Promise<void> {
	pruneStaleBases();
	endRun(state);
	state.active = true;
	const known = [...state.repos];
	for (const repo of known) if (!isDirectory(repo)) state.repos.delete(repo);
	await track(state, [{ paths: [cwd], edited: false }], deadline, false, known.filter(repo => state.repos.has(repo)));
}

/** For each repo of the run: its baseline HEAD and the files changed since, whatever tool changed them. */
export async function changesOf(state: State, signal: AbortSignal): Promise<SessionChange[]> {
	return await Promise.all(
		[...state.baselines].map(async ([repo, baseline]): Promise<SessionChange> => {
			try {
				const base = baseline.failure === undefined ? await baseline.result : { ok: false as const, error: baseline.failure };
				if (!base.ok) return { repo, base: "", files: [], error: base.error };
				const now = await takeSnapshot(repo, signal);
				const files = changedFiles(base.snapshot, now, await committedFiles(repo, base.snapshot.head, now.head, signal));
				return { repo, base: baseRef(base.snapshot), files };
			} catch (error) {
				return { repo, base: "", files: [], error: message(error) };
			}
		}),
	);
}
