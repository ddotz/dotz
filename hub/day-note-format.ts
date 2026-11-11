// The day note's file format and where it lives, shared by the writer (day-note.ts), the recall index and the prompts.
// One file per day: <data dir>/memory/days/YYYY-MM-DD.md, a front matter (description, day, window, writer) and up to five sections of
// bullet lines "- one sentence (src: ref)". A section that has no line is left out, so a section is found by its heading, not its place.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, paths } from "./config.ts";
import { en } from "./i18n-en.ts";
import { ko } from "./i18n-ko.ts";

export const SECTION_KEYS = ["open", "done", "decided", "know", "lessons"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type Section = { key: SectionKey; lines: string[] };
export type Note = { day: string; windowStart: number; windowEnd: number; writer: string; sections: Section[] };

export const NOTE_MAX_CHARS = 6000;
export const LINE_MAX_CHARS = 200;
export const OPEN_MAX_LINES = 8;
export const LESSONS_MAX_LINES = 3;

export const daysDir = (): string => join(paths.memory, "days");
export const noteFile = (day: string, dir = daysDir()): string => join(dir, `${day}.md`);
export const dayNoteOn = (): boolean => (cfg as { day_note?: { enabled?: boolean } }).day_note?.enabled === true;

/** The calendar date in Seoul (the owner's day) of an instant. */
export const kstDay = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

/** Every language's heading for a section, so a note written under one language is read under another. */
const HEADINGS: Record<SectionKey, string[]> = Object.fromEntries(SECTION_KEYS.map(k => [k, [k, en.dayNote.headings[k], ko.dayNote.headings[k]]])) as Record<SectionKey, string[]>;

export function headingKey(heading: string): SectionKey | undefined {
	const h = heading.replace(/^#+\s*/, "").trim().toLowerCase();
	return SECTION_KEYS.find(k => HEADINGS[k].some(t => t.toLowerCase() === h));
}

export const lineSrcs = (line: string): string[] => (/\(src: ([^)]*)\)\s*$/.exec(line)?.[1] ?? "").split(/\s*[;,]\s*/).map(s => s.trim()).filter(Boolean);

export function parseNote(text: string): Note | undefined {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (!m) return undefined;
	const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(m[1]!)?.[1]?.trim() ?? "";
	const day = field("day");
	const [a, b] = field("window").split("/").map(Date.parse);
	if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
	const sections: Section[] = [];
	for (const line of text.slice(m[0].length).split("\n")) {
		if (line.startsWith("#")) {
			const key = headingKey(line);
			if (key) sections.push({ key, lines: [] });
		} else if (line.startsWith("- ") && sections.length) sections.at(-1)!.lines.push(line);
	}
	return { day, windowStart: a!, windowEnd: b!, writer: field("writer"), sections };
}

export function readNote(file: string): Note | undefined {
	try {
		return existsSync(file) ? parseNote(readFileSync(file, "utf8")) : undefined;
	} catch {
		return undefined;
	}
}

/** The note of the day before `now` (Seoul), when the feature is on and its file exists. */
export function yesterdayNote(now = Date.now(), dir = daysDir()): string | undefined {
	if (!dayNoteOn()) return undefined;
	const file = noteFile(kstDay(now - 86_400_000), dir);
	return existsSync(file) ? file : undefined;
}
