// What hub/kakao/web.ts builds from its inputs alone: the unreplied-room scan, a reply-draft card, a room's chat payload and the lists a watch
// switch changes. Each takes what it reads as arguments; the state (caches, files, the clock) stays in createKakaoWeb.
import { kakaoUnreplied } from "../unreplied.ts";
import { owedMessage } from "./address.ts";
import { messageId } from "./contract.ts";
import { type KakaoDb, messageById, messages, ownerNames, readText, roomKinds, sentAtMs, unreadCount, watermarks } from "./db.ts";
import { draftParts } from "./draft.ts";
import { bodyText, mediaOf } from "./media.ts";
import type { Draft } from "./send.ts";
import type { KakaoConfig, Room } from "./types.ts";
import type { SendRecord } from "./web.ts";

type Msg = Awaited<ReturnType<typeof messages>>[number];
type Marks = Awaited<ReturnType<typeof watermarks>>;
const OWED_READ = 50;

export async function owedRooms(db: KakaoDb, config: KakaoConfig, sends: { chatId: string; at: number }[], dismissed: Record<string, string>, now: () => number): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const me = String(config.userId ?? "");
	const kinds = (config.watch_chats ?? []).length ? await roomKinds(db) : new Map<string, Room["kind"]>();
	for (const chatId of config.watch_chats ?? []) {
		const kind = kinds.get(chatId) ?? "other";
		const many = kind === "group" || kind === "open";
		const owed = owedMessage(await messages(db, chatId, many ? OWED_READ : 10, me), kind, { id: me, names: many ? await ownerNames(db, chatId, me) : [] });
		if (!owed) continue;
		const sentAt = sentAtMs(owed.sentAt);
		if (sends.some(s => s.chatId === chatId && s.at >= sentAt)) continue;
		if (kakaoUnreplied({ logId: owed.logId, fromMe: false, sentAt }, dismissed[chatId], now())) out.set(chatId, owed.logId);
	}
	return out;
}

export async function pendingRow(d: Draft, db: KakaoDb | undefined, ownerId: string, room: string) {
	const m = db && d.basisLogId ? await messageById(db, d.chatId, d.basisLogId, ownerId).catch(() => undefined) : undefined;
	const text = m ? readText(m).replace(/\s+/g, " ").trim() : "";
	// A KakaoTalk draft is text only, so its card always says so (첨부: 없음 · 파일을 붙일 수 없는 곳) and nothing is hidden behind a file row.
	return { code: d.code, chatId: d.chatId, room, text: d.text, parts: draftParts(d.text), ...(d.sentParts ? { sentParts: d.sentParts } : {}), ...(d.intent ? { intent: d.intent } : {}), created: d.created, attachmentsNone: true, cannotAttach: [],
		...(m && text ? { original: { who: m.fromMe ? "나" : m.sender || "상대", text: [...text].slice(0, 200).join(""), at: sentAtMs(m.sentAt) } } : {}) };
}

export function chatView(a: { chatId: string; name: string; room: Room; isWatched: boolean; list: Msg[]; names: Map<string, string>; marks: Marks; ownerId: string; now: () => number; collector: string; read: string | null; drafts: Draft[]; ask: { question: string; choices: string[] } | undefined; sends: SendRecord[]; since: number }) {
	const { chatId, name, room, isWatched, list, names, marks, ownerId, now, collector, read, drafts, ask, sends, since } = a;
	return {
		// `group`: senders are named above their messages (a group or an open chat room, like KakaoTalk). `watched`: drafts and sending are on.
		room: { chatId, name, kind: room.kind, group: room.kind === "group" || room.kind === "open", watched: isWatched },
		// The body of a photo or file message is an attachment record, not text: it goes out as a safe `media` object (no URL, no local path).
		messages: list.map(m => {
			const media = mediaOf(m, now(), names);
			return { id: messageId(m), collector, logId: m.logId, authorId: m.authorId, sender: m.sender, text: bodyText(m), type: m.type, sentAt: sentAtMs(m.sentAt), fromMe: m.fromMe, unread: unreadCount(marks, m.logId, m.authorId, ownerId), ...(media ? { media } : {}) };
		}),
		read,
		kakaoUnread: room.unread,
		drafts: drafts
			.filter(d => d.chatId === chatId && d.status === "pending")
			// `parts`: the messages the draft sends, in order (one bubble each in the card); `sentParts` of them are already in the room.
			.map(d => ({ code: d.code, text: d.text, parts: draftParts(d.text), ...(d.sentParts ? { sentParts: d.sentParts } : {}), ...(d.intent ? { intent: d.intent } : {}), basisLogId: d.basisLogId, created: d.created })),
		...(ask ? { ask } : {}),
		sends: sends
			.filter(s => s.chatId === chatId && s.at >= since && !s.retried)
			.map(({ id, text, state, reason, at, draft, collector: by }) => ({ id, text, state, ...(reason ? { reason } : {}), at, ...(draft ? { draft } : {}), ...(by ? { collector: by } : {}) })),
	};
}

// The watch and auto-draft lists after a PUT on a room; undefined when auto-draft is asked for a room that is not watched.
export function watchLists(config: KakaoConfig, chatId: string, b: { watched?: boolean; autoDraft?: boolean }): { next: string[]; nextAuto: string[] } | undefined {
	const current = config.watch_chats ?? [];
	const next = b.watched === undefined ? current : b.watched ? [...new Set([...current, chatId])] : current.filter(c => c !== chatId);
	let nextAuto = (config.auto_draft_chats ?? []).filter(c => b.watched !== false || c !== chatId);
	if (b.autoDraft === true) {
		if (!next.includes(chatId)) return undefined;
		nextAuto = [...new Set([...nextAuto, chatId])];
	} else if (b.autoDraft === false) nextAuto = nextAuto.filter(c => c !== chatId);
	return { next, nextAuto };
}

// A one-line preview of `text`, cut to `max` characters with an ellipsis.
export const clip = (text: string, max: number): string => {
	const chars = [...text];
	return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
};

// The stored person summaries with one more, the oldest dropped past 200.
export function withSummary<T>(summaries: Record<string, T>, key: string, analysis: T): Record<string, T> {
	const all = { ...summaries, [key]: analysis };
	const keys = Object.keys(all);
	if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k];
	return all;
}
