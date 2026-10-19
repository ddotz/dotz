import { NAME } from "./config.ts";

// Message tone: a marker the model writes at the very start of line 1, or a choice block, picks the colored bar.
// Pure parsing only; Discord and web each render the result themselves (see msg-visual spec).
export type Tone = "done" | "run" | "ask" | "fail";

export const TONE_COLORS: Record<Tone, number> = { done: 0x57f287, run: 0x3b82f6, ask: 0xf0a020, fail: 0xed4245 };

const TAGS: Record<string, Tone> = { done: "done", 완료: "done", run: "run", 진행: "run", ask: "ask", 결정: "ask", fail: "fail", 실패: "fail", warn: "fail", 경고: "fail" };
const MARKER = new RegExp(`^\\[(${Object.keys(TAGS).join("|")})\\][ \\t]*`, "i");

const OPTION = /^\s*>?\s*\*\*\d+\)/;
const DECISION = /^\s*>?\s*(결정|Decision):/im;
const FENCE = /^\s*```/;
const NAME_RE = NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const META = new RegExp(`^\\s*(?:-\\s+)?(?:근거:|출처:|Evidence:|Source:|For ${NAME_RE}:|${NAME_RE} 몫:)`, "i");

// An explicit marker wins, then a choice block (ask), then the caller's default (progress: run, alert: fail).
export function parseTone(text: string, fallback?: Tone): { tone?: Tone; text: string } {
	const m = MARKER.exec(text);
	if (m) return { tone: TAGS[m[1]!.toLowerCase()], text: text.slice(m[0].length) };
	const choice = DECISION.test(text) || (text.includes("← 추천") && text.split("\n").some(l => OPTION.test(l)));
	return { tone: choice ? "ask" : fallback, text };
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

// Embed: meta lines leave the body and become the footer (markdown stripped, max 2048).
export function extractMeta(text: string): { body: string; footer: string } {
	const meta: string[] = [];
	const body = mapMeta(text, line => {
		meta.push(line.trim().replace(/^-\s+/, "").replace(/\*\*|`/g, ""));
		return undefined;
	});
	return { body, footer: meta.join("\n").slice(0, 2048) };
}

// Inside an embed the colored bar already groups a choice block, so its "> " quotes go; the recommended option becomes a badge.
export function embedChoice(text: string): string {
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
		// A quote run is stripped only when it holds an option line; other quotes stay quotes.
		let j = i;
		while (j < lines.length && lines[j]!.startsWith(">")) j++;
		const run = lines.slice(i, j);
		out.push(...(run.some(l => OPTION.test(l)) ? run.map(l => l.replace(/^>[ \t]?/, "")) : run));
		i = j;
	}
	return out.map(l => (OPTION.test(l) ? l.replace(/\s*← 추천/, "  `추천`") : l)).join("\n");
}
