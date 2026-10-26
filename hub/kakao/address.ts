// Whether a message is addressed to the owner. In a 1:1 room every message of the other person is; in a group or open chat room the
// talk among the others is not. There a message calls the owner when it mentions him (the attachment's `mentions` list carries his user
// id, or the text has @<his name in that room>) or replies to one of his messages (type 26 with src_userId = his id). In a group room a
// question that comes right after his own last message is taken as asked of him too; an open chat room has only mentions and replies.
// One rule for 미답장 (web.ts waitingRooms) and for waking the bot (watch.ts).
import { hasWords, REPLY_TYPE } from "./db.ts";
import type { Msg, Room } from "./types.ts";

export type Owner = { id: string; names: string[] };
type Body = { type: number; text: string; attachment?: string };

const parse = (s?: string): Record<string, unknown> => {
	try {
		const v = JSON.parse(s ?? "");
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};

export function callsOwner(m: Body, owner: Owner): boolean {
	const a = parse(m.attachment);
	const mentioned = Array.isArray(a.mentions) && a.mentions.some(x => String((x as Record<string, unknown>)?.user_id ?? "") === owner.id);
	if (mentioned) return true;
	if (m.type === REPLY_TYPE && String(a.src_userId ?? "") === owner.id) return true;
	return owner.names.some(n => m.text.includes(`@${n}`));
}

const asksSomething = (text: string) => /[?？]\s*$/.test(text.trim());

// The message that waits for the owner's reply, if any: oldest first `list` (a room's newest page).
export function owedMessage(list: Msg[], kind: Room["kind"], owner: Owner): Msg | undefined {
	if (kind !== "group" && kind !== "open") {
		const newest = list.findLast(hasWords);
		return newest && !newest.fromMe ? newest : undefined;
	}
	const lastOwn = list.findLastIndex(m => m.fromMe);
	const theirs = list.slice(lastOwn + 1).filter(m => !m.fromMe && hasWords(m));
	return theirs.findLast((m, i) => callsOwner(m, owner) || (kind === "group" && lastOwn >= 0 && i === 0 && asksSomething(m.text)));
}
