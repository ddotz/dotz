import { join } from "node:path";

export interface Finding {
	stage: "escape" | "rules" | "defaults" | "checks" | "evidence" | "mistakes" | "verify" | "cite" | "plain" | "ask" | "report";
	class: string;
	message: string;
	file?: string;
	line?: number;
	text?: string;
}

export const AST_GREP = join(import.meta.dir, "..", "node_modules", ".bin", "ast-grep");

/** What a file held at the point the session's lines are measured from: its text, `null` when it did not exist, `undefined` when unknown (the caller's fallback applies). */
export type TextAt = (file: string) => Promise<string | null | undefined>;

/** Input of the anti-escape scan. Paths are repo-relative. */
export interface EscapeInput {
	repo: string;
	/** Commit the run started from; the fallback source of a file's base text. */
	base: string;
	/** Files the session changed. */
	files: string[];
	/** Text of a file at the session's base point: the run start, or the last moment git history brought foreign lines in. Absent or `undefined` result: `git show <base>:<file>`. */
	baseText?: TextAt;
	/** Files written by the edit, write or ast_edit tools in this run. These are always scanned; a file not in the set may be skipped as generated or vendored. Absent: every file counts as tool-edited. */
	toolEdited?: ReadonlySet<string>;
	/** Last user-accepted text of a gate file (`.omp/gate.json`, `.omp/lint/**`). Absent or `undefined` result: the base text. */
	acceptedText?: TextAt;
	/** Aborting it ends the scan: child processes are killed and the call rejects. */
	signal?: AbortSignal;
}

/** Input of the project rule kit. */
export interface RulesInput {
	repo: string;
	/** Files the session changed. Given: rule occurrences are findings only in these files, and they are scanned even when an ignore file or a dot-directory hides them. Absent: the whole repo is judged. */
	files?: string[];
	/** Aborting it ends the scan: child processes are killed and the call rejects. */
	signal?: AbortSignal;
}

/** A rule occurrence in a file the session did not change, or a defect of a rule kit the session did not touch (`rule` is then the finding class, `file` the kit file): reported to the user, never a refusal. */
export interface Preexisting {
	rule: string;
	file: string;
	count: number;
}

export interface RulesScan {
	findings: Finding[];
	preexisting: Preexisting[];
}
