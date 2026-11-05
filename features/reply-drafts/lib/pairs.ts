// The user's real past replies, each with the message it answered (one JSON line per pair, per app). The prompt carries the closest ones
// verbatim (hub/reply-draft.ts ReplyStyle.examples) and the habits measured over all of them. Mail pairs come from the sent folder
// (tone.ts sentMail) and from edited drafts the user sent (flow.ts); the comment engine builds its own from its store; both share the shaping in hub/comments/past.ts.
import { existsSync, readFileSync } from "node:fs";
import { addressesOf, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { EXAMPLES, similarPairs, withExamples, type PastPair } from "../../../hub/comments/past.ts";
import { paths, writeAtomic } from "./settings.ts";

/** `from`: the address of the person the reply went to (absent in pairs stored before it was kept). */
export type Pair = { received: string; reply: string; at: number; from?: string };

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
			if (p && typeof p.received === "string" && typeof p.reply === "string" && typeof p.at === "number" && p.reply.trim()) out.push({ received: p.received, reply: p.reply, at: p.at, ...(typeof p.from === "string" && p.from ? { from: p.from } : {}) });
		} catch {
			unreadable++;
		}
	}
	if (unreadable) console.error(`reply draft: ${unreadable} unreadable line(s) in ${file} skipped`);
	return out;
}

// Deduped by reply + received (the newest of a repeat stays, but takes the sender from a copy that has one, so a re-read upgrades an old pair),
// the newest MAX_PAIRS kept, oldest first.
export function savePairs(app: string, pairs: Pair[]): void {
	const seen = new Map<string, Pair>();
	for (const p of [...pairs].sort((a, b) => b.at - a.at)) {
		const k = `${normText(p.reply)}\n${normText(p.received)}`;
		const before = seen.get(k);
		if (!before) seen.set(k, p);
		else if (!before.from && p.from) seen.set(k, { ...before, from: p.from });
	}
	const kept = [...seen.values()].slice(0, MAX_PAIRS);
	writeAtomic(paths.pairs(app), kept.reverse().map(p => JSON.stringify(p)).join("\n") + (kept.length ? "\n" : ""));
}

export const addPair = (app: string, pair: Pair): void => savePairs(app, [...loadPairs(app), pair]);

// Up to 2 newest replies to the same address first (`same`), then the most similar ones, EXAMPLES in all, no repeats.
export function styleWithExamples(style: ReplyStyle, app: string, text: string, from?: string): ReplyStyle {
	const pairs = loadPairs(app);
	const who = addressesOf(from)[0];
	const past: PastPair[] = pairs.map(p => ({ comment: p.received, reply: p.reply, at: p.at, thread: "", ...(who && p.from && addressesOf(p.from)[0] === who ? { same: true } : {}) }));
	const same = past.filter(p => p.same).sort((a, b) => b.at - a.at).slice(0, 2);
	const close = [...same, ...similarPairs(text, past.filter(p => !same.includes(p)), EXAMPLES)].slice(0, EXAMPLES);
	return withExamples(style, close, pairs.map(p => p.reply));
}
