// The user's real past replies, each with the message it answered (one JSON line per pair, per app). The prompt carries the closest ones
// verbatim (hub/reply-draft.ts ReplyStyle.examples) and the habits measured over all of them. Mail pairs come from the sent folder
// (tone.ts sentMail) and from edited drafts the user sent (flow.ts); the comment engine builds its own from its store; both share the shaping in hub/comments/past.ts.
import { existsSync, readFileSync } from "node:fs";
import type { ReplyStyle } from "../../../hub/reply-draft.ts";
import { EXAMPLES, similarPairs, withExamples, type PastPair } from "../../../hub/comments/past.ts";
import { paths, writeAtomic } from "./settings.ts";

export type Pair = { received: string; reply: string; at: number };

export const MAX_PAIRS = 1000;

export const normText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export function loadPairs(app: string): Pair[] {
	const file = paths.pairs(app);
	if (!existsSync(file)) return [];
	const out: Pair[] = [];
	let unreadable = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const p = JSON.parse(line);
			if (p && typeof p.received === "string" && typeof p.reply === "string" && typeof p.at === "number" && p.reply.trim()) out.push({ received: p.received, reply: p.reply, at: p.at });
		} catch {
			unreadable++;
		}
	}
	if (unreadable) console.error(`reply draft: ${unreadable} unreadable line(s) in ${file} skipped`);
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

export function styleWithExamples(style: ReplyStyle, app: string, text: string): ReplyStyle {
	const pairs = loadPairs(app);
	const past: PastPair[] = pairs.map(p => ({ comment: p.received, reply: p.reply, at: p.at, thread: "" }));
	return withExamples(style, similarPairs(text, past, EXAMPLES), pairs.map(p => p.reply));
}
