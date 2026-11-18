import { feedbackDeadline, until } from "./deadline.ts";
import { formatFindings } from "./escape.ts";
import type { FormsInput } from "./forms.ts";
import { cwdOf, sessionKey } from "./host.ts";
import type { Ctx, ToolResultContext, ToolResultEvent } from "./host.ts";
import { filesByRepo } from "./repo-files.ts";
import type { DirRepos } from "./session.ts";
import type { Stages } from "./stages.ts";
import { touchedPaths } from "./tool-paths.ts";
import type { Finding, TextAt } from "./types.ts";

const NOTICE = "done-gate: the lines below were added by your last change and will be refused when you finish; fix them now.";
const MAX_CALL_FILES = 50;
const MAX_SCANNED_FILES = 200;
const MAX_REMEMBERED = 500;

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

/** What a session is told right after an edit, write or ast_edit: the escape and forms findings in the files that call changed, once per distinct finding set per file. */
export interface Feedback {
	after(event: ToolResultEvent, ctx: Ctx, baseOf: BaseOf): Promise<ToolResultContext | undefined>;
	reset(sessionId: string): void;
}

const formsRow = (finding: Finding): string => `${finding.file}:${finding.line} [${finding.class}] ${finding.message}${finding.text === undefined ? "" : `  ${finding.text}`}`;

async function formsOf(stages: Pick<Stages, "forms">, input: FormsInput & { signal: AbortSignal }): Promise<Finding[] | undefined> {
	try {
		return (await until(stages.forms(input), input.signal))?.value;
	} catch {
		return undefined;
	}
}

/** Remembers the last feedback sent per file and session, so an unchanged finding set is not repeated. */
export function createFeedback(stages: Pick<Stages, "escape" | "forms">): Feedback {
	const dirRepos: DirRepos = new Map();
	const sent = new Map<string, string>();

	const compute = async (paths: readonly string[], prefix: string, baseOf: BaseOf, signal: AbortSignal) => {
		const escapes: Finding[] = [];
		const forms: Finding[] = [];
		const remember = new Map<string, string>();
		const grouped = await until(filesByRepo(dirRepos, paths.slice(0, MAX_CALL_FILES), signal), signal);
		if (!grouped) return undefined;
		for (const [repo, called] of grouped.value) {
			const started = await until(baseOf(repo, signal), signal);
			if (!started) return undefined;
			const start = started.value;
			if (start === undefined) continue;
			const others = (start.files ?? []).filter(file => !called.includes(file));
			const files = [...called, ...others.slice(0, Math.max(0, MAX_SCANNED_FILES - called.length))];
			const formsRun = formsOf(stages, { repo, base: start.base, files, baseText: start.baseText, toolEdited: start.toolEdited, signal });
			const escaped = await until(stages.escape({ repo, base: start.base, files, baseText: start.baseText, toolEdited: start.toolEdited, acceptedText: start.acceptedText, signal }), signal);
			if (!escaped) return undefined;
			const formsFound = (await formsRun) ?? [];
			for (const file of called) {
				const hereEscape = escaped.value.findings.filter(finding => finding.file === file);
				const hereForms = formsFound.filter(finding => finding.file === file);
				const signature = hereEscape.length || hereForms.length ? `${formatFindings(hereEscape)}\0${hereForms.map(formsRow).join("\n")}` : "";
				const key = `${prefix}${repo}\0${file}`;
				if (sent.get(key) === signature) continue;
				remember.set(key, signature);
				escapes.push(...hereEscape);
				forms.push(...hereForms);
			}
		}
		return { escapes, forms, remember };
	};

	return {
		async after(event, ctx, baseOf) {
			const work = new AbortController();
			try {
				if (event.isError === true) return undefined;
				const paths = touchedPaths(event.toolName, event.input ?? {}, event.details, cwdOf(ctx));
				if (paths.length === 0) return undefined;
				const deadline = AbortSignal.any([feedbackDeadline(), work.signal]);
				const done = await compute(paths, `${sessionKey(ctx)}\0`, baseOf, deadline);
				if (!done) return undefined;
				for (const [key, signature] of done.remember) {
					sent.delete(key);
					sent.set(key, signature);
				}
				for (const key of sent.keys()) {
					if (sent.size <= MAX_REMEMBERED) break;
					sent.delete(key);
				}
				const lines = [done.escapes.length ? formatFindings(done.escapes) : "", ...done.forms.map(formsRow)].filter(part => part !== "");
				return lines.length ? { additionalContext: `${NOTICE}\n${lines.join("\n")}` } : undefined;
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
