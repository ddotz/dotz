// The one finding format of the doctor (hub/doctor.ts). Every check (install health, token leaks, failure classes, prompt health)
// returns these; the doctor stores them in one result file and decides what reaches the owner's morning briefing.
// A check never sends anything itself and never calls a model.

/** Which part of the doctor found it; the morning item groups by it. */
export type DoctorArea = "gateway" | "sessions" | "logins" | "watches" | "disk" | "update" | "failures" | "tokens" | "prompt";

export type Finding = {
	/** Stable id across runs, e.g. "watch-failing:<watch name>" or "tokens:<warning class>". Repeat suppression keys on it. */
	key: string;
	area: DoctorArea;
	/** What happened, one plain sentence for the owner (already localized by the check through hub/i18n-*.ts). */
	what: string;
	/** One evidence line: the number, file or log line that shows it. */
	evidence: string;
	/** Epoch ms of the first run that saw it (the doctor keeps the earliest across runs). */
	since: number;
	/** A comparable size (count, share, bytes, chars): the doctor re-reports only when this grew past the repeat step. */
	level: number;
	/** dotz already fixed it itself (cleanup, self-heal, retry): one line in the briefing, no choice. */
	fixed?: boolean;
	/** What the owner must decide, when he must; the briefing shows a choice block only then. */
	decide?: { question: string; options: { name: string; result: string }[] };
};

/** A check: reads files only, gets its clock and paths injected, returns findings. Throwing is caught by the doctor (one log line). */
export type DoctorCheck = (ctx: DoctorCtx) => Finding[] | Promise<Finding[]>;

/**
 * `last`: when the doctor last ran (none on the first run). `memo`: a scratch object the doctor keeps in its store between runs, for a check that
 * compares with its own last look (a log offset, a baseline); a dry run gets a copy that is never saved. `dry`: nothing may be written.
 */
export type DoctorCtx = { now: number; dataDir: string; home: string; last?: number; memo?: Record<string, unknown>; dry?: boolean };
