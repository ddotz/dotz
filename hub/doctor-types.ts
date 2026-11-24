// The one finding format of the doctor (hub/doctor.ts). Every check (install health, token leaks, failure classes, prompt health)
// returns these; the doctor stores them in one result file and decides what reaches the owner's morning briefing.
// A check never sends anything itself and never calls a model.

/** Which part of the doctor found it; the morning item groups by it. */
export const DOCTOR_AREAS = ["gateway", "sessions", "logins", "watches", "disk", "update", "failures", "tokens", "prompt", "plugins"] as const;
export type DoctorArea = (typeof DOCTOR_AREAS)[number];

export type Finding = {
	/** Stable id across runs, e.g. "watch-failing:<watch name>" or "tokens:<warning class>". Repeat suppression keys on it. */
	key: string;
	area: DoctorArea;
	/** What happened, one plain sentence for the owner (already localized by the check through hub/i18n-*.ts). */
	what: string;
	todo?: string;
	short?: string;
	/** The owner-facing evidence lines (numbers, times, file names, quotes), already localized: at most EVIDENCE_LINES lines of at most EVIDENCE_CHARS characters, cut by `evidenceLines` where the finding is built. A card shows them under its title. */
	evidence: string[];
	/** Epoch ms of the first run that saw it (the doctor keeps the earliest across runs). */
	since: number;
	/** A comparable size (count, share, bytes, chars): the doctor re-reports only when this grew past the repeat step. */
	level: number;
	/** dotz already fixed it itself (cleanup, self-heal, retry): one line in the briefing, no choice. */
	fixed?: boolean;
	/** The owner may have the cause looked into: the morning line ends with the look-up mark, and replying with that line starts the look. Never a card. */
	ask?: true;
	/** What the owner must decide, when he must: one card titled `<subject> · <question>` (at most 40 characters), with `evidence` as its lines. */
	decide?: { subject: string; question: string; options: { name: string; result: string }[] };
	/** The exact edit a prompt card proposes, found by the gateway: `file` is the absolute path, `line` its 1-based line, `from` that line as it is in the file, `to` the full new line (empty: the line is deleted). */
	change?: { file: string; line: number; from: string; to: string };
};

export const EVIDENCE_LINES = 4;
export const EVIDENCE_CHARS = 120;

/** The longest card title, `<subject> · <question>`, in characters. */
export const TITLE_CHARS = 40;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const width = (s: string): number => [...s].length;
const shorten = (one: string, max: number, cutAlready = false): string => {
	const chars = [...one];
	if (chars.length <= max && !cutAlready) return one;
	if (chars.length < max) return `${one}…`;
	const head = chars.slice(0, max - 1).join(""), space = chars[max - 1] === " " ? head.length : head.lastIndexOf(" ");
	return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
};
const cut = (line: string): string => shorten(squash(line), EVIDENCE_CHARS);

/** A finding's evidence as stored: empty lines dropped, each line cut at a word boundary to EVIDENCE_CHARS, and over EVIDENCE_LINES lines the last kept line is `more(<lines left out>)`. */
export function evidenceLines(lines: string[], more: (n: number) => string): string[] {
	const kept = lines.map(cut).filter(Boolean);
	return kept.length <= EVIDENCE_LINES ? kept : [...kept.slice(0, EVIDENCE_LINES - 1), cut(more(kept.length - EVIDENCE_LINES + 1))];
}

/** A text as at most `most` evidence lines, broken at word boundaries; only what does not fit the last line is cut, at a sentence end when one is in reach, else at a word. */
export function wrapLines(text: string, most: number): string[] {
	const out: string[] = [];
	let rest = squash(text);
	while (rest && out.length < most - 1 && width(rest) > EVIDENCE_CHARS) {
		const head = [...rest].slice(0, EVIDENCE_CHARS + 1).join(""), space = head.lastIndexOf(" ");
		const at = space > 0 ? space : [...rest].slice(0, EVIDENCE_CHARS).join("").length;
		out.push(rest.slice(0, at).trimEnd());
		rest = rest.slice(at).trimStart();
	}
	if (!rest) return out;
	if (width(rest) <= EVIDENCE_CHARS) return [...out, rest];
	const head = [...rest].slice(0, EVIDENCE_CHARS).join(""), end = Math.max(...[...head.matchAll(/[.!?。](?= )/g)].map(m => m.index), -1);
	return [...out, end >= EVIDENCE_CHARS / 3 ? head.slice(0, end + 1) : shorten(rest, EVIDENCE_CHARS)];
}

/** A card subject that fits TITLE_CHARS with its question and `tag` (what tells apart two cards that would read the same): the quote in it ('…') is shortened at a word boundary first, then the subject's end. */
export function fitSubject(subject: string, question: string, tag = ""): string {
	const room = TITLE_CHARS - width(question) - 3 - width(tag), over = width(subject) - room;
	if (over <= 0) return `${subject}${tag}`;
	const open = subject.indexOf("'"), close = subject.lastIndexOf("'"), inner = subject.slice(open + 1, close);
	if (open < 0 || close <= open || width(inner) - over < 2) return `${shorten(subject, room)}${tag}`;
	return `${subject.slice(0, open + 1)}${shorten(inner.replace(/…$/, ""), width(inner) - over, inner.endsWith("…"))}${subject.slice(close)}${tag}`;
}

/** The texts the agent re-reads, by the name the owner knows them by. */
export type TextName = "mode" | "rules" | "lessons" | "feature";
const textOf = (file: string | undefined): TextName =>
	!file ? "mode" : /(^|\/)RULES\.md(:|$)/.test(file) ? "rules" : /(^|\/)LESSONS\.md(:|$)/.test(file) ? "lessons" : /(^|\/)feature\.md(:|$)/.test(file) ? "feature" : "mode";

/** The subject of a card about one line of a re-read text: the text's name (from `file`, the contract when unknown) and the start of the line without its list mark or date tag, fitted with `question` into TITLE_CHARS. */
export function lineSubject(t: { texts: Record<TextName, string>; lineSubject: (name: string, quote: string) => string }, file: string | undefined, line: string, question: string): string {
	const one = squash(line), start = one.replace(/^(?:[-*+>#]+ *|\d+[.)] +)+/, "").replace(/^\[[^\]]{1,16}\] */, "") || one;
	return fitSubject(t.lineSubject(t.texts[textOf(file)], start), question);
}

/** A check: reads files only, gets its clock and paths injected, returns findings. Throwing is caught by the doctor (one log line). */
export type DoctorCheck = (ctx: DoctorCtx) => Finding[] | Promise<Finding[]>;

/**
 * `last`: when the doctor last ran (none on the first run). `memo`: a scratch object the doctor keeps in its store between runs, for a check that
 * compares with its own last look (a log offset, a baseline); a dry run gets a copy that is never saved. `dry`: nothing may be written.
 */
export type DoctorCtx = { now: number; dataDir: string; home: string; last?: number; memo?: Record<string, unknown>; dry?: boolean };
