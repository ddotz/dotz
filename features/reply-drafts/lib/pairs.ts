// The user's real past replies, each with the message it answered (one JSON line per pair, per app). The prompt carries the closest ones
// verbatim (hub/reply-draft.ts ReplyStyle.examples) and the habits measured over all of them. Mail pairs come from the sent folder
// (tone.ts sentMail) and from edited drafts the user sent (flow.ts); the comment engine builds its own from its store and reuses the shaping here.
import { existsSync, readFileSync } from "node:fs";
import type { ReplyStyle } from "../../../hub/reply-draft.ts";
import { similarPairs, type PastPair } from "../../../hub/comments/past.ts";
import { paths, writeAtomic } from "./settings.ts";

export type Pair = { received: string; reply: string; at: number };

export const MAX_PAIRS = 1000;
export const EXAMPLES = 8;
export const SIDE_MAX = 1500;
const MIN_HABITS = 5;

export const normText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export function loadPairs(app: string): Pair[] {
	const file = paths.pairs(app);
	if (!existsSync(file)) return [];
	const out: Pair[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		try {
			const p = JSON.parse(line);
			if (p && typeof p.received === "string" && typeof p.reply === "string" && typeof p.at === "number" && p.reply.trim()) out.push({ received: p.received, reply: p.reply, at: p.at });
		} catch {}
	}
	return out;
}

// Deduped by reply + received (the newest of a repeat stays), the newest MAX_PAIRS kept, oldest first.
export function savePairs(app: string, pairs: Pair[]): void {
	const seen = new Set<string>();
	const kept: Pair[] = [];
	for (const p of [...pairs].sort((a, b) => b.at - a.at)) {
		const k = `${normText(p.reply)}\n${normText(p.received)}`;
		if (seen.has(k)) continue;
		seen.add(k);
		kept.push(p);
		if (kept.length >= MAX_PAIRS) break;
	}
	writeAtomic(paths.pairs(app), kept.reverse().map(p => JSON.stringify(p)).join("\n") + (kept.length ? "\n" : ""));
}

export const addPair = (app: string, pair: Pair): void => savePairs(app, [...loadPairs(app), pair]);

const top = (xs: string[], n = 4): [string, number][] => {
	const count = new Map<string, number>();
	for (const x of xs) count.set(x, (count.get(x) ?? 0) + 1);
	return [...count].sort((a, b) => b[1] - a[1]).slice(0, n);
};
const shown = (xs: [string, number][]) => xs.map(([x, n]) => `${x} x${n}`).join(", ");

// Measured lines about the replies, with no message text beyond short marks; none under MIN_HABITS replies.
export function habitsOf(replies: string[]): string[] {
	const rs = replies.map(r => r.trim()).filter(Boolean);
	if (rs.length < MIN_HABITS) return [];
	const pct = (n: number) => `${Math.round((100 * n) / rs.length)}%`;
	const share = (re: RegExp) => rs.filter(r => re.test(r)).length;
	const lens = rs.map(r => [...r].length).sort((a, b) => a - b);
	const at = (q: number) => lens[Math.min(lens.length - 1, Math.floor(q * lens.length))]!;
	const out = [`Length in characters: p25 ${at(0.25)}, median ${at(0.5)}, p90 ${at(0.9)}`];
	out.push(`Most common first words: ${shown(top(rs.map(r => r.split(/\s+/)[0]!)))}`);
	const ends = rs.map(r => /[^\p{L}\p{N}\s]+$/u.exec(r)?.[0]).filter((x): x is string => !!x);
	if (ends.length) out.push(`Most common trailing marks: ${shown(top(ends))}`);
	const emoji = rs.flatMap(r => r.match(/\p{Extended_Pictographic}/gu) ?? []);
	out.push(`Replies with an emoji: ${pct(share(/\p{Extended_Pictographic}/u))}${emoji.length ? `; most used: ${shown(top(emoji))}` : ""}`);
	out.push(`Share of replies containing: ${["^^", "~", "!", "ㅠ", "ㅎ", "ㅋ"].map(m => `${m} ${pct(rs.filter(r => r.includes(m)).length)}`).join(", ")}`);
	out.push(`Share of replies ending with a period: ${pct(share(/\.$/))}`);
	return out;
}

const clip = (s: string) => s.trim().slice(0, SIDE_MAX);

// The style with the closest past pairs as examples and the habits of every reply; unchanged when nothing is close.
// Shared by the mail flow and the comment engine, which hands in its own pairs.
export function withExamples(style: ReplyStyle, close: PastPair[], replies: string[]): ReplyStyle {
	if (!close.length) return style;
	const habits = habitsOf(replies);
	return { ...style, examples: close.map(p => ({ received: clip(p.comment), reply: clip(p.reply) })), ...(habits.length ? { habits } : {}) };
}

export function styleWithExamples(style: ReplyStyle, app: string, text: string): ReplyStyle {
	const pairs = loadPairs(app);
	const past: PastPair[] = pairs.map(p => ({ comment: p.received, reply: p.reply, at: p.at, thread: "" }));
	return withExamples(style, similarPairs(text, past, EXAMPLES), pairs.map(p => p.reply));
}
