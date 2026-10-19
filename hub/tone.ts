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
