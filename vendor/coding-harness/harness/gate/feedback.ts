import { existsSync } from "node:fs";
import { needsBootstrap } from "./bootstrap.ts";
import { feedbackDeadline, until } from "./deadline.ts";
import { formatFindings } from "./escape.ts";
import { evidenceAsk, isUnder } from "./evidence.ts";
import { findingProblem } from "./findings.ts";
import { gateFilePath, matchesAny, readGateFile } from "./gate-file.ts";
import type { EvidenceEntry } from "./gate-file.ts";
import { cwdOf, sessionKey } from "./host.ts";
import type { Ctx, ToolResultContext, ToolResultEvent } from "./host.ts";
import { filesByRepo } from "./repo-files.ts";
import { isSourceFile } from "./session.ts";
import type { DirRepos, State } from "./session.ts";
import { hasRuleKit, mistakeStage } from "./stages.ts";
import type { Stages } from "./stages.ts";
import { eligibleForBootstrap, noGateFileMessage } from "./stop.ts";
import { touchedPaths } from "./tool-paths.ts";
import type { Finding, TextAt } from "./types.ts";

const NOTICE = "done-gate: the lines below were added by your last change and will be refused when you finish; fix them now.";
const HEADS_UP = "done-gate: heads-up, not a refusal yet:";
const MAX_CALL_FILES = 50;
const MAX_SCANNED_FILES = 200;
const MAX_REMEMBERED = 500;
const MAX_HEADS_UP_LINES = 12;

/** What a repo's diff starts from for the session at hand: the commit (its baseline for a main session, HEAD for a worker), what each file held at that point, and what the session changed in the repo, so that feedback judges the same files the stop will. */
export interface FeedbackBase {
	base: string;
	baseText?: TextAt;
	/** Repo-relative files the session changed in the repo; scanned together with the files of the call, because a comment moved between files is judged across all of them. */
	files?: readonly string[];
	/** Files written by the edit, write or ast_edit tools in this session. */
	toolEdited?: ReadonlySet<string>;
	acceptedText?: TextAt;
}

/** The base of a repo for the session at hand; undefined when there is none. */
export type BaseOf = (repo: string, signal: AbortSignal) => Promise<FeedbackBase | undefined>;

/** What a main session's tool result adds to the feedback: the run whose `told` memory holds the heads-ups, the absolute paths of the source files a patch-applying call changed, and whether the call ran something after the run's last source write (`verifies`). */
export interface RunFeedback {
	state: State;
	patched: readonly string[];
	verifies: boolean;
}

/**
 * One notice a tool result can carry. `findings`: what the escape, forms, rules and defaults stages found in one file of the call
 * (`rows` are the forms, defaults and rules findings), in main and subagent sessions. The rest are heads-ups of a main session about
 * what its stop will ask for, which change nothing the stop judges: `gate-file`, the first source write of the run in a repo the stop
 * will ask a gate file of (`due` false: the repo was looked at and needs none); `evidence`, files of the call that an evidence entry
 * of the repo's gate file covers; `mistakes`, the session's unresolved mistakes at a call that ran something after the last source write.
 */
export type Notice =
	| { kind: "findings"; repo: string; file: string; escape: Finding[]; rows: Finding[] }
	| { kind: "gate-file"; repo: string; due: boolean }
	| { kind: "evidence"; repo: string; entry: EvidenceEntry; files: string[] }
	| { kind: "mistakes"; cwd: string; findings: Finding[] };

const findingRow = (finding: Finding): string => `${finding.file}:${finding.line} [${finding.class}] ${finding.message}${finding.text === undefined ? "" : `  ${finding.text}`}`;

/**
 * Where a notice is remembered and what it is remembered as; a notice whose slot already holds its signature is not told again.
 * Findings: per session, repo and file, across runs, as the finding set, so a changed set is told again. Gate file: once per run and
 * repo. Evidence: once per run, repo and entry. Mistakes: once per run and distinct set of open mistakes.
 */
export function noticeKey(notice: Notice): { slot: string; signature: string } {
	switch (notice.kind) {
		case "findings": {
			const signature = notice.escape.length || notice.rows.length ? `${formatFindings(notice.escape)}\0${notice.rows.map(findingRow).join("\n")}` : "";
			return { slot: `findings\0${notice.repo}\0${notice.file}`, signature };
		}
		case "gate-file":
			return { slot: `gate-file\0${notice.repo}`, signature: "" };
		case "evidence":
			return { slot: `evidence\0${notice.repo}\0${notice.entry.name}`, signature: "" };
		case "mistakes":
			return { slot: `mistakes\0${notice.findings.map(finding => finding.text ?? finding.message).sort().join("\0")}`, signature: "" };
		default: {
			const _exhaustive: never = notice;
			return _exhaustive;
		}
	}
}

function headsUp(lines: readonly string[]): string {
	const all = lines.join("\n").split("\n");
	if (all.length <= MAX_HEADS_UP_LINES) return all.join("\n");
	return [...all.slice(0, MAX_HEADS_UP_LINES - 1), `... (${all.length - MAX_HEADS_UP_LINES + 1} more lines; the stop will show them all)`].join("\n");
}

function render(notices: readonly Notice[]): string | undefined {
	const findings = notices.flatMap(notice => (notice.kind === "findings" ? [notice] : []));
	const escapes = findings.flatMap(notice => notice.escape);
	const rows = findings.flatMap(notice => notice.rows.map(findingRow));
	const lines = [escapes.length ? formatFindings(escapes) : "", ...rows].filter(part => part !== "");
	const blocks = lines.length ? [`${NOTICE}\n${lines.join("\n")}`] : [];
	for (const notice of notices) {
		if (notice.kind === "gate-file" && notice.due) blocks.push(headsUp([`${HEADS_UP} when this run stops, the stop will refuse it once with verify:no-gate-file:`, noGateFileMessage(notice.repo)]));
		if (notice.kind === "evidence") {
			const named = `${HEADS_UP} ${notice.files.join(", ")} in ${notice.repo} matches evidence "${notice.entry.name}" (${notice.entry.paths.join(", ")}) of its gate file; the stop will ask for that evidence.`;
			blocks.push(headsUp([named, ...evidenceAsk(notice.entry)]));
		}
		if (notice.kind === "mistakes") {
			const open = findingProblem(notice.cwd, "mistakes", notice.findings)?.text ?? "";
			blocks.push(headsUp([`${HEADS_UP} the stop will refuse this run while these mistakes are open; resolve them before your final report.`, open]));
		}
	}
	return blocks.length ? blocks.join("\n\n") : undefined;
}

async function settled<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	try {
		return (await until(work(), signal))?.value;
	} catch {
		return undefined;
	}
}

async function gateFileNotice(state: State, repo: string, called: readonly string[], signal: AbortSignal): Promise<Notice | undefined> {
	if (!called.some(isSourceFile) || state.told.has(noticeKey({ kind: "gate-file", repo, due: false }).slot)) return undefined;
	if (state.askedGate.has(repo) || existsSync(gateFilePath(repo))) return undefined;
	const baseline = state.baselines.get(repo);
	if (baseline === undefined || baseline.failure !== undefined) return undefined;
	const start = await until(baseline.result, signal);
	if (!start?.value.ok) return undefined;
	if (!eligibleForBootstrap(repo, start.value.snapshot.head)) return { kind: "gate-file", repo, due: false };
	const needed = await settled(() => needsBootstrap(repo, signal), signal);
	return needed === undefined ? undefined : { kind: "gate-file", repo, due: needed };
}

function evidenceNotices(repo: string, called: readonly string[]): Notice[] {
	if (!existsSync(gateFilePath(repo))) return [];
	return readGateFile(repo).evidence.flatMap((entry): Notice[] => {
		const files = called.filter(file => matchesAny(entry.paths, file) && !isUnder(entry.dir, file));
		return files.length ? [{ kind: "evidence", repo, entry, files }] : [];
	});
}

async function headsUpsOf(state: State, repo: string, called: readonly string[], signal: AbortSignal): Promise<Notice[]> {
	const gateFile = await settled(() => gateFileNotice(state, repo, called, signal), signal);
	const evidence = await settled(async () => evidenceNotices(repo, called), signal);
	return [...(gateFile === undefined ? [] : [gateFile]), ...(evidence ?? [])];
}

/** What a session is told on a tool result: for the files an edit, write, ast_edit or patch-applying call changed, the escape, forms, rules and defaults findings, once per distinct finding set per file; in a main session, the heads-ups of `Notice`, once per run and slot. */
export interface Feedback {
	after(event: ToolResultEvent, ctx: Ctx, baseOf: BaseOf, run?: RunFeedback): Promise<ToolResultContext | undefined>;
	reset(sessionId: string): void;
}

/** Remembers the last finding set told per file and session, so an unchanged set is not repeated; heads-ups are remembered in the run's `State.told`. */
export function createFeedback(stages: Stages): Feedback {
	const dirRepos: DirRepos = new Map();
	const sent = new Map<string, string>();

	const findingsOf = async (repo: string, called: readonly string[], baseOf: BaseOf, signal: AbortSignal): Promise<Notice[] | undefined> => {
		const started = await until(baseOf(repo, signal), signal);
		if (!started) return undefined;
		const start = started.value;
		if (start === undefined) return [];
		const others = (start.files ?? []).filter(file => !called.includes(file));
		const files = [...called, ...others.slice(0, Math.max(0, MAX_SCANNED_FILES - called.length))];
		const scanned = { repo, base: start.base, files, baseText: start.baseText, toolEdited: start.toolEdited, signal };
		const formsRun = settled(() => stages.forms(scanned), signal);
		const rulesRun = hasRuleKit(repo) ? settled(() => stages.rules({ repo, files, signal }), signal) : undefined;
		const escaped = await until(stages.escape({ ...scanned, acceptedText: start.acceptedText }), signal);
		if (!escaped) return undefined;
		const rows = [...((await formsRun) ?? []), ...((await rulesRun)?.findings ?? [])];
		return called.map(file => ({ kind: "findings", repo, file, escape: escaped.value.findings.filter(finding => finding.file === file), rows: rows.filter(finding => finding.file === file) }));
	};

	const compute = async (paths: readonly string[], baseOf: BaseOf, signal: AbortSignal, run: RunFeedback | undefined): Promise<Notice[] | undefined> => {
		if (paths.length === 0) return [];
		const grouped = await until(filesByRepo(dirRepos, paths.slice(0, MAX_CALL_FILES), signal), signal);
		if (!grouped) return undefined;
		const notices: Notice[] = [];
		for (const [repo, called] of grouped.value) {
			const heads = run === undefined ? Promise.resolve([]) : headsUpsOf(run.state, repo, called, signal);
			const found = await findingsOf(repo, called, baseOf, signal);
			if (found === undefined) return undefined;
			notices.push(...found, ...(await heads));
		}
		return notices;
	};

	return {
		async after(event, ctx, baseOf, run) {
			const work = new AbortController();
			try {
				const touched = event.isError === true ? [] : touchedPaths(event.toolName, event.input ?? {}, event.details, cwdOf(ctx));
				const paths = [...new Set([...touched, ...(run?.patched ?? [])])];
				const deadline = AbortSignal.any([feedbackDeadline(), work.signal]);
				const notices = await compute(paths, baseOf, deadline, run);
				if (!notices) return undefined;
				if (run?.verifies === true) {
					const open = mistakeStage(stages, sessionKey(ctx)).findings;
					if (open.length) notices.push({ kind: "mistakes", cwd: cwdOf(ctx), findings: open });
				}
				const prefix = `${sessionKey(ctx)}\0`;
				const memory = (notice: Notice): Map<string, string> | undefined => (notice.kind === "findings" ? undefined : run?.state.told);
				const fresh = notices.filter(notice => {
					const { slot, signature } = noticeKey(notice);
					const told = memory(notice);
					return (told === undefined ? sent.get(`${prefix}${slot}`) : told.get(slot)) !== signature;
				});
				for (const notice of fresh) {
					const { slot, signature } = noticeKey(notice);
					const told = memory(notice);
					if (told !== undefined) told.set(slot, signature);
					else {
						sent.delete(`${prefix}${slot}`);
						sent.set(`${prefix}${slot}`, signature);
					}
				}
				for (const key of sent.keys()) {
					if (sent.size <= MAX_REMEMBERED) break;
					sent.delete(key);
				}
				const text = render(fresh);
				return text === undefined ? undefined : { additionalContext: text };
			} catch {
				return undefined;
			} finally {
				work.abort();
			}
		},
		reset(sessionId) {
			const prefix = `${sessionId}\0`;
			for (const key of [...sent.keys()]) if (key.startsWith(prefix)) sent.delete(key);
			if (sent.size === 0) dirRepos.clear();
		},
	};
}
