// The user's real past replies, each with the message it answered (one JSON line per pair, per app). The prompt carries the closest ones
// verbatim (hub/reply-draft.ts ReplyStyle.examples) and the habits measured over all of them. Mail pairs come from the sent folder
// (tone.ts sentMail) and from edited drafts the user sent (flow.ts); the comment engine builds its own from its store; both share the shaping in hub/comments/past.ts.
import { addressesOf, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { EXAMPLES, similarPairs, withExamples, type PastPair } from "../../../hub/comments/past.ts";
import { loadPairs, type Pair, savePairs } from "./settings.ts";

export const addPair = (app: string, pair: Pair): void => savePairs(app, [...loadPairs(app), pair]);

// Up to 2 newest replies to the same address first (`same`), then the most similar ones, EXAMPLES in all, no repeats.
// `source`: only the pairs of that mail source (absent tag = zele) and the habits measured over them; undefined = every pair.
export const styleWithExamples = (style: ReplyStyle, app: string, text: string, from?: string, source?: string): ReplyStyle =>
	styleFrom(style, loadPairs(app).filter(p => source === undefined || (p.source ?? "zele") === source), text, from);

// The same shaping over pairs already chosen (a mailbox's own: lib/box-voice.ts).
export function styleFrom(style: ReplyStyle, pairs: Pair[], text: string, from?: string): ReplyStyle {
	const who = addressesOf(from)[0];
	const past: PastPair[] = pairs.map(p => ({ comment: p.received, reply: p.reply, at: p.at, thread: "", ...(p.edited ? { edited: true as const } : {}), ...(who && p.from && addressesOf(p.from)[0] === who ? { same: true } : {}) }));
	const same = past.filter(p => p.same).sort((a, b) => b.at - a.at).slice(0, 2);
	const close = [...same, ...similarPairs(text, past.filter(p => !same.includes(p)), EXAMPLES)].slice(0, EXAMPLES);
	return withExamples(style, close, [...pairs].sort((a, b) => b.at - a.at).map(p => p.reply), text);
}
