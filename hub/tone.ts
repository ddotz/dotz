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

export function parseTone(text: string): { tone?: Tone; text: string } {
	const m = MARKER.exec(text);
	return m ? { tone: TAGS[m[1]!.toLowerCase()], text: text.slice(m[0].length) } : { text };
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

// `[later]` ends a turn whose answer a background worker will bring: a sentinel for the gateway, never text for the owner.
// Where a preview must show something, it reads LATER_LINE.
export const LATER_LINE = "뒤에서 작업 중이에요";
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
