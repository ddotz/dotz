import { NAME } from "./config.ts";

// Message tone: an explicit marker the model writes at the very start of line 1 ([done] [run] [wait] [ask] [fail] and their
// Korean/alias forms) becomes one leading status emoji. No marker, no emoji; nothing is inferred from the content.
// Pure parsing only; Discord and web each render the result themselves.
export type Tone = "done" | "run" | "wait" | "ask" | "fail";

// [run] and [wait] say where a session stands right now, so they go stale: progress, never a result (no bell, no push, no orchestrator turn).
export const parkedTone = (tone: Tone | undefined): boolean => tone === "run" || tone === "wait";

export const TONE_EMOJI: Record<Tone, string> = { done: "✅", run: "⏳", wait: "⏸️", ask: "❓", fail: "❌" };

const TAGS: Record<string, Tone> = { done: "done", 완료: "done", run: "run", 진행: "run", wait: "wait", 대기: "wait", ask: "ask", 결정: "ask", fail: "fail", 실패: "fail", warn: "fail", 경고: "fail" };
const MARKER = new RegExp(`^\\[(${Object.keys(TAGS).join("|")})\\][ \\t]*`, "i");

const OPTION = /^\s*>?\s*\*\*\d+\)/;
const FENCE = /^\s*```/;
const NAME_RE = NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const META = new RegExp(`^\\s*(?:-\\s+)?(?:근거:|출처:|Evidence:|Source:|For ${NAME_RE}:|${NAME_RE} 몫:)`, "i");

// Machine markers never reach the owner as text (owner 2026-10-23: no `[...]` tag in anything shown). Parsers read the tag first;
// every display path then runs the text through stripMarkers. Only these shapes, only at line start (optionally behind a list
// dash, `**` or a `**name**: ` lead), outside ``` fences, are dropped; other brackets are content: `[1]`, `[x]`, `[text](url)`,
// `[name] ...` that is not one of these shapes, anything mid-line, code.
//   status      [run] [wait] [done] [ask] [fail] [warn] [blocked] [partial] [later] [ok] [error] and Korean forms
//   gateway     [lane <word>] ([lane error]/[lane exited]/[lane stuck]) [dotz gateway|inbox|reflect|lane <name>|...] [dotz]
//               [orchestrator-guard] [gateway check] [web:<target>] [지금 도는 것] [now running] [handover] [keepalive] [system] [attachment] [owner via <x>]
//   tool        [ok | 12ms] [error | 3s] ; routine [routine:<id>:<hash>] ; clock [10-23]
//   [file] lines are attachments (hub/discord-files.ts takes them first); a left-over one is dropped with its path.
// A control word also acts as one in three more places (owner 2026-11-05: "`[later]` 연도(2026)와..." reached him as a code chip), bare, in a code span or bold:
// opening the message before a space (not before a word that names it: "`[later]` 표시를 고쳤어요", "`[later]`로 끝나요"), alone on a line, and closing the
// message after a finished sentence. Anywhere else it is being talked about: mid-sentence, a list item, a span with a particle, a fence.
// A lone `-` closing a message is the no-op sentinel left under a note.
const STATUS_WORDS = "run|wait|done|ask|fail|warn|blocked|partial|later|ok|error|err|완료|진행|대기|결정|실패|경고|차단|부분|나중|오류";
const MARKER_BODY = `(?:${STATUS_WORDS}|attachment|system|handover|keepalive|orchestrator-guard|gateway check|web:[a-z-]+|지금 도는 것|now running|dotz(?: [a-z][\\w:-]*(?: [^\\]\\n]{1,40})?)?|lane [a-z가-힣][^\\]\\n]{0,30}|owner via [^\\]\\n]{1,30}|(?:ok|error|err|fail)[ ]*\\|[^\\]\\n]{1,24}|routine:[^\\]\\n]{1,60}|\\d{2}-\\d{2})`;
const LINE_LEAD = "[ \\t]*(?:[-*][ \\t]+)?(?:진행 중:[ \\t]*)?(?:\\*\\*[^*\\n]{1,60}\\*\\*:?[ \\t]+)?";
const MARKER_LEAD = new RegExp(`^(${LINE_LEAD})(\\*\\*)?\\[${MARKER_BODY}\\](\\*\\*)?[ \\t]*`, "i");
const FILE_MARK = /^[ \t]*\[file\][ \t]/i;
const LONE_DASH = /\n[ \t]*-\s*$/;
const NAMES_IT = "(?:마커|표시|표식|문구|제어어|단어|토큰|글자|신호|처리|누출|같은|marker|sentinel|token|word)";
const edges = (word: string, skip = "") => ({
	open: new RegExp(`^([ \\t]*${skip})(\`|\\*\\*)?\\[${word}\\]\\2(?:[ \\t]+(?!${NAMES_IT})|[ \\t]*$)`, "i"),
	alone: new RegExp(`^[ \\t]*(\`|\\*\\*)?\\[${word}\\]\\1[ \\t]*$`, "i"),
	close: new RegExp(`(?<=[.!?…요다])[ \\t]+(\`|\\*\\*)?\\[${word}\\]\\1[ \\t]*$`, "i"),
});
const CONTROL = edges("(?:run|wait|done|ask|fail|later|keepalive)");
// A tone marker may stand before `[later]` (it is the message's tone, stripLater keeps it).
const LATER_EDGES = edges("later", `(?:\\[(?:${STATUS_WORDS})\\][ \\t]*)*`);

// The lines outside fences with `lead` markers and control words at the edges gone. `tail`: the last line with text.
function stripWords(text: string, w: typeof CONTROL, full: boolean): string {
	let fence = false, opened = false, tail = -1;
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (FENCE.test(line) || fence) {
			if (FENCE.test(line)) fence = !fence;
			out.push(line);
			if (line.trim()) tail = -1;
			continue;
		}
		if (full && FILE_MARK.test(line)) continue;
		let l = line;
		if (full) for (let m = MARKER_LEAD.exec(l); m; m = MARKER_LEAD.exec(l)) l = m[1]! + l.slice(m[0].length);
		if (!opened && l.trim()) {
			opened = true;
			const m = w.open.exec(l);
			if (m) l = m[1]! + l.slice(m[0].length);
		}
		if (w.alone.test(l)) l = "";
		if (l.trim()) tail = out.length;
		out.push(l);
	}
	if (tail < 0) return out.join("\n");
	if (full && out[tail]!.trim() === "-" && out.slice(0, tail).some(l => l.trim())) out[tail] = "";
	else out[tail] = out[tail]!.replace(w.close, "");
	return out.join("\n");
}
export const stripMarkers = (text: string): string => (text.includes("[") || LONE_DASH.test(text) ? stripWords(text, CONTROL, true) : text);

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
export function stripHandoff(raw: string): string {
	const text = stripProjectInfo(raw);
	const m = /^\s*Ask:[^\n]*(?:\n(?!\s*\n)[^\n]*)*/.exec(text);
	if (!m || !/\bFor you:/.test(m[0])) return text;
	const rest = text.slice(m[0].length).replace(/^\s+/, "");
	if (rest) return rest;
	return /\bFor you:\s*([\s\S]*?)(?:\s+Now:[\s\S]*)?$/.exec(m[0])?.[1]?.trim() || text;
}

// A project turn's <project-info> block (hub/projectinfo.ts) is for the gateway, never text for the owner. An unclosed block runs to the end.
export const PROJECT_INFO_BLOCK = /\s*<project-info>([\s\S]*?)(?:<\/project-info>|$)/g;
export const stripProjectInfo = (text: string): string => (text.includes("<project-info>") ? text.replace(PROJECT_INFO_BLOCK, "").trimEnd() : text);

// True when a reply still carries the harness handoff labels (even when the leading block was stripped or never led).
export const leaksHandoff = (text: string): boolean => /\bFor you:[\s\S]*\bNow:[\s\S]*\bNext:/.test(text);

// `[later]` ends a turn whose answer a background worker will bring: a sentinel for the gateway, never text for the owner.
// Where a preview must show something, it reads LATER_LINE.
export const LATER_LINE = "백그라운드 작업 중";
export const isLater = (text: string): boolean => /^\s*(`|\*\*)?\[later\]\1\s*$/i.test(text);
/** `text` without `[later]` where it acts as the control word (stripWords); everything else stays, the tone marker too. */
export const stripLater = (text: string): string => (/\[later\]/i.test(text) ? stripWords(text, LATER_EDGES, false).trimEnd() : text);
/** A final text read by meaning: `later` when the word acts as control, whatever stands around it; `text` is what the owner may still read of it. */
export function laterParts(text: string): { later: boolean; text: string } {
	const t = text.trim(), prose = stripLater(t).trim();
	return prose === t ? { later: false, text: t } : { later: true, text: isSilent(prose) ? "" : prose };
}

// `-` is the no-op sentinel: a turn with nothing to say answers it alone and the gateway posts nothing. A model sometimes wraps
// it in a short meta note ("Already posted. -", or the note then "-" on its own line); that is still a no-op. Only a short
// single-paragraph note counts: one with a status marker, a [file] line, a list, a quote or a numbered choice, or one that asks something, is a real answer.
const SILENT_NOTE_MAX = 160;
const NOT_A_NOTE = /^[ \t]*(?:[-*>][ \t]|\*\*\d+\)|\d+[.)][ \t]|\[file\][ \t])/i;
export function isSilent(text: string): boolean {
	const t = text.trim();
	if (t === "-") return true;
	const m = /^([\s\S]*\S)\s+-$/.exec(t);
	const note = m?.[1]?.trim();
	if (!note || note.length > SILENT_NOTE_MAX || /[?？]$/.test(note) || /\n[ \t]*\n/.test(note)) return false;
	return note.split("\n").every(l => !NOT_A_NOTE.test(l) && !MARKER_LEAD.test(l) && !MARKER.test(l.trim()));
}

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
