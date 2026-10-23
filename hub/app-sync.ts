// App messages across computers (docs/peer-monitoring.md): a stable message id that every computer computes the same way, and a
// deterministic merge of the lists that different computers collected. Pure: no I/O, no clock. Generic for any app (KakaoTalk first).
import { createHash } from "node:crypto";

export type StableIdInput = { app: string; room: string; appId?: string | number | null; sender: string; sentAt: number; text: string };

// A time in seconds or in milliseconds, as milliseconds. Anything above 1e11 is already milliseconds (1e11 s is year 5138).
export const toMs = (t: number): number => Math.round(t > 1e11 ? t : t * 1000);

const norm = (s: string): string => s.normalize("NFC").trim();

// `<app>:<room>:<appId>` when the app has its own id, else `<app>:<room>:h<first 16 hex of sha1(sender|sentAt ms|text)>`.
// The collecting computer is never part of the id.
export function stableMsgId({ app, room, appId, sender, sentAt, text }: StableIdInput): string {
	if (appId !== undefined && appId !== null && String(appId) !== "") return `${app}:${room}:${appId}`;
	const h = createHash("sha1").update(`${norm(sender)}|${toMs(sentAt)}|${norm(text)}`).digest("hex").slice(0, 16);
	return `${app}:${room}:h${h}`;
}

// The fields the merge reads; any other field of a message rides along unchanged.
export type SyncMsg = { id: string; collector: string; updatedAt: number; sentAt?: number; read?: boolean; status?: string };

// Dedupe by id. State converges by last writer: the higher updatedAt wins as a whole entry. On a tie the entry whose collector is
// the send-lease holder wins, else the smaller collector name, so every computer picks the same entry whatever the list order.
// Output: newest sentAt first, id as the tie-break.
export function mergeMessages<T extends SyncMsg>(lists: T[][], leaseHolder?: string): T[] {
	const best = new Map<string, T>();
	for (const m of lists.flat()) {
		const cur = best.get(m.id);
		if (!cur || wins(m, cur, leaseHolder)) best.set(m.id, m);
	}
	const at = (m: T) => (m.sentAt === undefined ? 0 : toMs(m.sentAt));
	return [...best.values()].sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function wins(a: SyncMsg, b: SyncMsg, leaseHolder?: string): boolean {
	if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
	if (leaseHolder !== undefined && a.collector !== b.collector) {
		if (a.collector === leaseHolder) return true;
		if (b.collector === leaseHolder) return false;
	}
	return a.collector < b.collector;
}
