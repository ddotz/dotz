// Tests only: a plain SQLite file with the subset of KakaoTalk's schema the reader touches. Generic fake names; production never imports this.
import { Database } from "bun:sqlite";

export type FixtureRoom = { chatId: bigint | number; type: number; chatName?: string | null; members?: number; unread?: number; lastUpdatedAt?: number; peer?: number | null };
export type FixtureUser = { userId: number; linkId?: number; friendNickName?: string | null; displayName?: string | null; nickName?: string | null };
export type FixtureMsg = { logId: bigint | number; chatId: bigint | number; authorId: number; message: string; type?: number; sentAt: number };
export type FixtureSpec = { ownerId?: number; rooms?: FixtureRoom[]; users?: FixtureUser[]; messages?: FixtureMsg[] };

export const OWNER = 1000;
export const BASE_TIME = 1_700_000_000;
// Above 2^53 so any Number round-trip of a logId shows up.
export const BASE_LOG = 9_007_199_254_740_990n;

export const ROOM = { direct: 101, group: 102, self: 103, excluded: 104, channel: 105 } as const;

const DEFAULT_ROOMS: FixtureRoom[] = [
	{ chatId: ROOM.direct, type: 0, chatName: null, members: 2, unread: 1, lastUpdatedAt: BASE_TIME + 40, peer: 2001 },
	{ chatId: ROOM.group, type: 1, chatName: "Study Group", members: 5, unread: 2, lastUpdatedAt: BASE_TIME + 50 },
	{ chatId: ROOM.self, type: 5, chatName: "", members: 1, unread: 0, lastUpdatedAt: BASE_TIME + 60 },
	{ chatId: ROOM.excluded, type: 1, chatName: "Quiet Group", members: 9, unread: 0, lastUpdatedAt: BASE_TIME + 70 },
	{ chatId: ROOM.channel, type: 7, chatName: "Shop Channel", members: 1, unread: 0, lastUpdatedAt: BASE_TIME + 80 },
];

const DEFAULT_USERS: FixtureUser[] = [
	{ userId: 2001, friendNickName: "Alex", displayName: "Alex D" },
	{ userId: 2002, friendNickName: null, displayName: null, nickName: "Sam" },
	{ userId: OWNER, displayName: "Owner" },
];

const msg = (n: number, chatId: number, authorId: number, message: string, type = 1): FixtureMsg => ({ logId: BASE_LOG + BigInt(n), chatId, authorId, message, type, sentAt: BASE_TIME + n * 10 });

const DEFAULT_MESSAGES: FixtureMsg[] = [
	msg(1, ROOM.direct, 2001, "hello there"),
	msg(2, ROOM.direct, OWNER, "hi, how are you"),
	msg(3, ROOM.direct, 2001, "fine, lunch tomorrow?"),
	msg(4, ROOM.direct, 2001, "photo-ref", 2),
	msg(5, ROOM.group, 2002, "meeting moved to noon"),
	msg(6, ROOM.self, OWNER, "note to self"),
	msg(7, ROOM.excluded, 2002, "anyone around?"),
	msg(8, ROOM.channel, 2002, "10% off today"),
];

export function makeFixtureDb(path: string, spec: FixtureSpec = {}): Database {
	const db = new Database(path, { create: true });
	db.exec(`
		CREATE TABLE NTChatRoom (chatId INTEGER PRIMARY KEY, type INTEGER, chatName TEXT, activeMembersCount INTEGER, countOfNewMessage INTEGER, lastUpdatedAt INTEGER, directChatMemberUserId INTEGER);
		CREATE TABLE NTChatMessage (logId INTEGER PRIMARY KEY, chatId INTEGER, authorId INTEGER, message TEXT, type INTEGER, sentAt INTEGER);
		CREATE TABLE NTUser (userId INTEGER, linkId INTEGER, friendNickName TEXT, displayName TEXT, nickName TEXT, PRIMARY KEY (userId, linkId));
		CREATE TABLE NTChatContext (userId INTEGER);
	`);
	db.query("INSERT INTO NTChatContext (userId) VALUES (?)").run(spec.ownerId ?? OWNER);
	for (const r of spec.rooms ?? DEFAULT_ROOMS)
		db.query("INSERT INTO NTChatRoom VALUES (?, ?, ?, ?, ?, ?, ?)").run(BigInt(r.chatId), r.type, r.chatName ?? null, r.members ?? 2, r.unread ?? 0, r.lastUpdatedAt ?? 0, r.peer ?? null);
	for (const u of spec.users ?? DEFAULT_USERS)
		db.query("INSERT INTO NTUser VALUES (?, ?, ?, ?, ?)").run(u.userId, u.linkId ?? 0, u.friendNickName ?? null, u.displayName ?? null, u.nickName ?? null);
	for (const m of spec.messages ?? DEFAULT_MESSAGES) addMessage(db, m);
	return db;
}

export function addMessage(db: Database, m: FixtureMsg): void {
	db.query("INSERT INTO NTChatMessage VALUES (?, ?, ?, ?, ?, ?)").run(BigInt(m.logId), BigInt(m.chatId), m.authorId, m.message, m.type ?? 1, m.sentAt);
}
