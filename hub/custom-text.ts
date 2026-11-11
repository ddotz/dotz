// Pure text helpers for the custom layer's project pages: how a rule is titled and ordered, and which line sums up a lane's report.
// No config or file access, so they are called the same from custom.ts and its tests.
import { parseTone, previewSource } from "./tone.ts";

const RULE_TITLE_MAX = 25;

// Fits RULE_TITLE_MAX whole: cut at the last word that fits, no ellipsis; only one unbroken word is cut inside.
function shortTitle(s: string): string {
	if (s.length <= RULE_TITLE_MAX) return s;
	const end = s.lastIndexOf(" ", RULE_TITLE_MAX);
	return s.slice(0, end > 0 ? end : RULE_TITLE_MAX).replace(/[\s,·]+$/, "");
}

// One short phrase for a rule row. The owner's phrase wins: <DATA_DIR>/rule-titles.json maps a rule's text (as written after
// its "- ", with or without the [MM-DD] stamp) to a title, which the bot adds with the rule. Without one: the text without its
// stamp, up to the first sentence or clause end (". ", ": ", "; ", ", ", "("), then shortTitle. No model call.
export function ruleTitle(text: string, titles: Record<string, unknown> = {}): string {
	const plain = text.replace(/^\[\d{2}-\d{2}\]\s*/, "").replace(/\s+/g, " ").trim();
	const own = titles[text] ?? titles[plain];
	if (typeof own === "string" && own.trim()) return shortTitle(own.trim().replace(/\s+/g, " "));
	return shortTitle((plain.split(/[.:;,]\s|\s?\(/)[0] || plain).trim());
}

// Newest first by the [MM-DD] stamp, a stamp later in the year than today being last year's; the same day: lower in the file first.
// A rule without a stamp comes last.
export function newestRules(rules: string[], now = new Date()): string[] {
	const today = (now.getMonth() + 1) * 100 + now.getDate();
	const when = (r: string) => {
		const m = /^\[(\d{2})-(\d{2})\]/.exec(r);
		if (!m) return -Infinity;
		const day = Number(m[1]) * 100 + Number(m[2]);
		return day > today ? day - 10000 : day;
	};
	return rules.map((r, i) => ({ r, i, at: when(r) })).sort((x, y) => (x.at === y.at ? y.i - x.i : y.at - x.at)).map(x => x.r);
}

const MARK_LINE = /^\s*(?:[-*]\s*)?\**\s*\[(done|run|ask|fail|완료)\]/i;

// The line a report is summed up by: its [done]/[fail]/... line (an OmO lane may open with an "Ask: ..." handoff block),
// else its first line; the marker and markdown emphasis are stripped. `body` is what follows that line.
export function reportHead(text: string): { tone?: string; line: string; body: string } {
	const lines = previewSource(text).split("\n");
	let i = lines.findIndex(l => MARK_LINE.test(l));
	if (i < 0) i = lines.findIndex(l => l.trim());
	if (i < 0) return { line: "", body: "" };
	const raw = lines[i]!.replace(/\*\*/g, "").replace(/^\s*[-*]\s+/, "").trim();
	const t = parseTone(raw.replace(/\[완료\]/, "[done]"));
	return { ...(t.tone ? { tone: t.tone } : {}), line: t.text.trim().slice(0, 240), body: lines.slice(i + 1).join("\n").trim().slice(0, 600) };
}
