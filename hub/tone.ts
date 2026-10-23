import { NAME } from "./config.ts";

// Message tone: an explicit marker the model writes at the very start of line 1 ([done] [run] [ask] [fail] and their
// Korean/alias forms) becomes one leading status emoji. No marker, no emoji; nothing is inferred from the content.
// Pure parsing only; Discord and web each render the result themselves.
export type Tone = "done" | "run" | "ask" | "fail";

export const TONE_EMOJI: Record<Tone, string> = { done: "✅", run: "⏳", ask: "❓", fail: "❌" };

const TAGS: Record<string, Tone> = { done: "done", 완료: "done", run: "run", 진행: "run", ask: "ask", 결정: "ask", fail: "fail", 실패: "fail", warn: "fail", 경고: "fail" };
const MARKER = new RegExp(`^\\[(${Object.keys(TAGS).join("|")})\\][ \\t]*`, "i");

const OPTION = /^\s*>?\s*\*\*\d+\)/;
const FENCE = /^\s*```/;
const NAME_RE = NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const META = new RegExp(`^\\s*(?:-\\s+)?(?:근거:|출처:|Evidence:|Source:|For ${NAME_RE}:|${NAME_RE} 몫:)`, "i");

// Machine markers never reach the owner as text (owner 2026-10-23: no `[...]` tag in anything shown). Parsers read the tag first;
// every display path then runs the text through stripMarkers. Only these shapes, only at line start (optionally behind a list
// dash, `**` or a `**name**: ` lead), outside ``` fences, are dropped; other brackets are content: `[1]`, `[x]`, `[text](url)`,
// `[name] ...` that is not one of these shapes, anything mid-line, code.
//   status      [run] [done] [ask] [fail] [warn] [blocked] [partial] [later] [ok] [error] and Korean forms
//   gateway     [lane <word>] ([lane error]/[lane exited]/[lane stuck]) [dotz gateway|inbox|reflect|lane <name>|...] [dotz]
//               [orchestrator-guard] [지금 도는 것] [now running] [handover] [keepalive] [system] [attachment] [owner via <x>]
//   tool        [ok | 12ms] [error | 3s] ; routine [routine:<id>:<hash>] ; clock [10-23]
//   [file] lines are attachments (hub/discord-files.ts takes them first); a left-over one is dropped with its path.
const STATUS_WORDS = "run|done|ask|fail|warn|blocked|partial|later|ok|error|err|완료|진행|결정|실패|경고|차단|부분|나중|오류";
const MARKER_BODY = `(?:${STATUS_WORDS}|attachment|system|handover|keepalive|orchestrator-guard|지금 도는 것|now running|dotz(?: [a-z][\\w:-]*(?: [^\\]\\n]{1,40})?)?|lane [a-z가-힣][^\\]\\n]{0,30}|owner via [^\\]\\n]{1,30}|(?:ok|error|err|fail)[ ]*\\|[^\\]\\n]{1,24}|routine:[^\\]\\n]{1,60}|\\d{2}-\\d{2})`;
const LINE_LEAD = "[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*[^*\\n]{1,60}\\*\\*:?[ \\t]+)?";
const MARKER_LEAD = new RegExp(`^(${LINE_LEAD})(\\*\\*)?\\[${MARKER_BODY}\\](\\*\\*)?[ \\t]*`, "i");
const FILE_MARK = /^[ \t]*\[file\][ \t]/i;
export function stripMarkers(text: string): string {
	if (!text.includes("[")) return text;
	let fence = false;
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (FENCE.test(line)) {
			fence = !fence;
			out.push(line);
			continue;
		}
		if (fence) {
			out.push(line);
			continue;
		}
		if (FILE_MARK.test(line)) continue;
		let l = line;
		for (let m = MARKER_LEAD.exec(l); m; m = MARKER_LEAD.exec(l)) l = m[1]! + l.slice(m[0].length);
		out.push(l);
	}
	return out.join("\n");
}

// The leading status marker apart from the rest: `head` is the raw marker text, `rest` still carries the other markers.
export function splitTone(text: string): { tone?: Tone; head: string; rest: string } {
	const m = MARKER.exec(text);
	return m ? { tone: TAGS[m[1]!.toLowerCase()], head: m[0], rest: text.slice(m[0].length) } : { head: "", rest: text };
}

// `text` is what may be shown: the status marker and every other machine marker are gone.
export function parseTone(text: string): { tone?: Tone; text: string } {
	const { tone, rest } = splitTone(text);
	return tone ? { tone, text: stripMarkers(rest) } : { text: stripMarkers(rest) };
}

// OmO's harness opens a final answer with a handoff block ("Ask: ... - wanted: ... For you: ... Now: ... Next: ..."): agent
// bookkeeping, not owner text. Shown messages drop that leading paragraph; a message that was only the block keeps its
// "For you" part. Claim and report parsing read the raw text.
export function stripHandoff(text: string): string {
	const m = /^\s*Ask:[^\n]*(?:\n(?!\s*\n)[^\n]*)*/.exec(text);
	if (!m || !/\bFor you:/.test(m[0])) return text;
	const rest = text.slice(m[0].length).replace(/^\s+/, "");
	if (rest) return rest;
	return /\bFor you:\s*([\s\S]*?)(?:\s+Now:[\s\S]*)?$/.exec(m[0])?.[1]?.trim() || text;
}

// True when a reply still carries the harness handoff labels (even when the leading block was stripped or never led).
export const leaksHandoff = (text: string): boolean => /\bFor you:[\s\S]*\bNow:[\s\S]*\bNext:/.test(text);

// `[later]` ends a turn whose answer a background worker will bring: a sentinel for the gateway, never text for the owner.
// Where a preview must show something, it reads LATER_LINE.
export const LATER_LINE = "백그라운드 작업 중";
export const isLater = (text: string): boolean => /^\s*\[later\]\s*$/i.test(text);

// A one-line preview's source text: the handoff block and an "Ask: " label are dropped, a lone `[later]` becomes LATER_LINE.
export function previewSource(raw: string): string {
	const text = stripHandoff(raw).replace(/^\s*Ask:[ \t]*/i, "");
	return isLater(text) ? LATER_LINE : text;
}

// Rewrites (or drops, on undefined) meta lines outside ``` fences, in place.
function mapMeta(text: string, fn: (line: string) => string | undefined): string {
	let fence = false;
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const isFence = FENCE.test(line);
		if (isFence) fence = !fence;
		const r = fence || isFence || !META.test(line) ? line : fn(line);
		if (r !== undefined) out.push(r);
	}
	return out.join("\n");
}

// Plain message: a meta line becomes Discord subtext in place ("- " list dash dropped, it would show after "-# ").
export const metaToSubtext = (text: string) => mapMeta(text, line => `-# ${line.trim().replace(/^-\s+/, "")}`);

// A choice block (a run of ">" lines holding an option line) loses its "> " prefixes outside ``` fences; other quotes stay quotes.
export function plainChoice(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let fence = false;
	for (let i = 0; i < lines.length; ) {
		const isFence = FENCE.test(lines[i]!);
		if (isFence) fence = !fence;
		if (fence || isFence || !lines[i]!.startsWith(">")) {
			out.push(lines[i++]!);
			continue;
		}
		let j = i;
		while (j < lines.length && lines[j]!.startsWith(">")) j++;
		const run = lines.slice(i, j);
		out.push(...(run.some(l => OPTION.test(l)) ? run.map(l => l.replace(/^>[ \t]?/, "")) : run));
		i = j;
	}
	return out.join("\n");
}
