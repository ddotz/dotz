// Read side of the KakaoTalk integration: key derivation and device discovery ported from kakaocli (MIT, see
// THIRD_PARTY_NOTICES.md), and typed read-only queries. The database is only ever opened read-only; bodies are read on demand.
import { Database } from "bun:sqlite";
import { createHash, pbkdf2Sync } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { KakaoConfig, KakaoPaths, Msg, Room, Runner } from "./types.ts";

// Key derivation: kakaocli KeyDerivation.swift (PBKDF2-HMAC-SHA256, 100000 iterations, 128 bytes).
const reverse = (s: string) => Array.from(s).reverse().join("");
const pbkdf2 = (password: string, salt: string) => pbkdf2Sync(password, salt, 100_000, 128, "sha256").toString("hex");

export function hashedDeviceUUID(uuid: string): string {
	const sha1 = createHash("sha1").update(uuid).digest();
	const sha256 = createHash("sha256").update(uuid).digest();
	return Buffer.concat([sha1, sha256]).toString("base64");
}

// The encrypted database's file name: 78 hex characters.
export function databaseName(userId: number, uuid: string): string {
	const password = [".", "F", String(userId), "A", "F", reverse(uuid), ".", "|"].join(".");
	return pbkdf2(password, reverse(hashedDeviceUUID(uuid))).slice(28, 28 + 78);
}

export function secureKey(userId: number, uuid: string): string {
	const parts = ["A", hashedDeviceUUID(uuid), "|", "F", uuid.slice(0, 5), "H", String(userId), "|", uuid.slice(7)];
	return pbkdf2(reverse(parts.join("F")), uuid.slice(Math.trunc(uuid.length * 0.3)));
}

const PLUTIL = "/usr/bin/plutil";
const BUNDLE = "com.kakao.KakaoTalkMac";

export const preferencesPath = (home: string) => join(home, "Library", "Preferences", `${BUNDLE}.plist`);
export const containerPath = (home: string) => join(home, "Library", "Containers", BUNDLE, "Data", "Library", "Application Support", BUNDLE);

// The container's preferences carry more than the global plist: com.kakao.KakaoTalkMac.<HEX>.plist.
export function containerPreferencesPath(home: string): string {
	const dir = join(home, "Library", "Containers", BUNDLE, "Data", "Library", "Preferences");
	const plain = join(dir, `${BUNDLE}.plist`);
	try {
		const hit = readdirSync(dir).find((f) => f.startsWith(`${BUNDLE}.`) && f.endsWith(".plist") && f !== `${BUNDLE}.plist`);
		return hit ? join(dir, hit) : plain;
	} catch {
		return plain;
	}
}

const exists = (path: string) => {
	try {
		statSync(path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
};

export async function platformUUID(runner: Runner): Promise<string> {
	const r = await runner(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
	const m = /"IOPlatformUUID" = "([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})"/.exec(r.stdout);
	if (r.code !== 0 || !m) throw new Error("could not read IOPlatformUUID from ioreg");
	return m[1] as string;
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// `plutil -convert json` refuses data and date values, so the fallback reads the xml1 form. Only the root dict's own keys
// matter to the userId strategies: scalars are decoded, nested containers become null.
export function parseXmlPlist(xml: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const tag = /<(\/?)([A-Za-z0-9]+)[^>]*?(\/?)>([^<]*)/g;
	let depth = 0;
	let key: string | undefined;
	for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
		const [, closing, name, selfClosing, text] = m as unknown as [string, string, string, string, string];
		const container = name === "dict" || name === "array";
		if (closing) {
			if (container) depth--;
			continue;
		}
		if (depth === 1) {
			if (name === "key") {
				key = unescapeXml(text);
				continue;
			}
			if (key !== undefined) {
				if (name === "integer" || name === "real") out[key] = Number(text);
				else if (name === "true") out[key] = true;
				else if (name === "false") out[key] = false;
				else if (container) out[key] = null;
				else out[key] = unescapeXml(text);
				key = undefined;
			}
		}
		if (container && !selfClosing) depth++;
	}
	return out;
}

export async function readPlist(path: string, runner: Runner): Promise<Record<string, unknown> | undefined> {
	if (!exists(path)) return undefined;
	const asJson = await runner([PLUTIL, "-convert", "json", "-o", "-", path]);
	if (asJson.code === 0) {
		try {
			const parsed = JSON.parse(asJson.stdout);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {}
	}
	const asXml = await runner([PLUTIL, "-convert", "xml1", "-o", "-", path]);
	return asXml.code === 0 ? parseXmlPlist(asXml.stdout) : undefined;
}

function commonSuffix(strings: string[]): string {
	const first = strings[0];
	if (first === undefined) return "";
	let n = 0;
	while (n < first.length && strings.every((s) => s.length > n && s[s.length - 1 - n] === first[first.length - 1 - n])) n++;
	return first.slice(first.length - n);
}

const asInt = (s: string) => (/^\d+$/.test(s) ? Number(s) : undefined);

function idFromSuffixKeys(plist: Record<string, unknown>, prefix: string): number | undefined {
	const keys = Object.keys(plist).filter((k) => k.startsWith(prefix));
	if (keys.length < 2) return undefined;
	return asInt(commonSuffix(keys.map((k) => k.slice(prefix.length))));
}

const REVISION_PREFIX = "DESIGNATEDFRIENDSREVISION:";

// The active account's SHA-512(userId) hex, from revision keys with a non-zero value (SHA-512("0") is the empty account).
export function activeAccountHash(plist: Record<string, unknown>): string | undefined {
	const empty = createHash("sha512").update("0").digest("hex");
	for (const [key, value] of Object.entries(plist)) {
		if (!key.startsWith(REVISION_PREFIX)) continue;
		const hash = key.slice(REVISION_PREFIX.length);
		if (hash !== empty && typeof value === "number" && Math.trunc(value) !== 0) return hash;
	}
	return undefined;
}

// SHA-512 pre-image search over small integers; kakaocli searches up to 1e9 for at most 10 s.
export function recoverUserIdFromSHA512(hexHash: string, opts: { maxMs?: number; max?: number } = {}): number | undefined {
	if (!/^[0-9a-f]{128}$/i.test(hexHash)) return undefined;
	const target = Buffer.from(hexHash, "hex");
	const maxMs = opts.maxMs ?? 10_000;
	const max = opts.max ?? 1_000_000_000;
	const start = Date.now();
	for (let i = 0; i < max; i++) {
		if (createHash("sha512").update(String(i)).digest().equals(target)) return i;
		if (i % 100_000 === 99_999 && Date.now() - start > maxMs) return undefined;
	}
	return undefined;
}

// The four strategies of kakaocli DeviceInfo.userId(), in order, per plist (container prefs first).
export function userIdFromPlist(plist: Record<string, unknown>, opts: { maxMs?: number } = {}): number | undefined {
	const fromTransparency = idFromSuffixKeys(plist, "FSChatWindowTransparency");
	if (fromTransparency !== undefined) return fromTransparency;
	for (const key of ["userId", "user_id", "KAKAO_USER_ID", "userID"]) {
		const v = plist[key];
		if (typeof v === "number" && Number.isInteger(v)) return v;
		if (typeof v === "string" && asInt(v) !== undefined) return asInt(v);
	}
	const hash = activeAccountHash(plist);
	const recovered = hash ? recoverUserIdFromSHA512(hash, opts) : undefined;
	if (recovered !== undefined) return recovered;
	return idFromSuffixKeys(plist, "NSWindow Frame FSChatWindowFrame_");
}

export async function findUserId(home: string, runner: Runner, opts: { maxMs?: number } = {}): Promise<number> {
	for (const path of [containerPreferencesPath(home), preferencesPath(home)]) {
		const plist = await readPlist(path, runner);
		const id = plist && userIdFromPlist(plist, opts);
		if (id !== undefined) return id;
	}
	throw new Error("could not find the KakaoTalk user id in its preferences");
}

// Scans the container for the 78-hex-character database file (with or without .db).
export function discoverDatabaseFile(container: string): string | undefined {
	let entries: string[];
	try {
		entries = readdirSync(container);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	const hit = entries.find((e) => /^[0-9a-f]{78}$/.test(e)) ?? entries.find((e) => /^[0-9a-f]{78}\.db$/.test(e));
	return hit ? join(container, hit) : undefined;
}

export type KakaoDb = { query(sql: string, params?: (string | number)[]): Promise<Record<string, unknown>[]> };

const quote = (s: string) => {
	if (s.includes("\0")) throw new Error("SQL string with a NUL character");
	return `'${s.replaceAll("'", "''")}'`;
};

// Fills `?` placeholders (outside string literals) in order. Numbers must be finite; strings are single-quote escaped.
export function inlineParams(sql: string, params: (string | number)[] = []): string {
	let out = "";
	let next = 0;
	let inString = false;
	for (const ch of sql) {
		if (ch === "'") inString = !inString;
		if (ch === "?" && !inString) {
			if (next >= params.length) throw new Error("fewer SQL params than placeholders");
			const p = params[next++] as string | number;
			if (typeof p === "number") {
				if (!Number.isFinite(p)) throw new Error("SQL param must be a finite number");
				out += String(p);
			} else out += quote(p);
		} else out += ch;
	}
	if (next !== params.length) throw new Error("more SQL params than placeholders");
	return out;
}

const sqlcipherBin = () => Bun.which("sqlcipher") ?? "/opt/homebrew/opt/sqlcipher/bin/sqlcipher";

// One sqlcipher process per query; the key travels on stdin only. KakaoTalk's cipher settings are SQLCipher 3 compatible;
// 4 is tried when 3 fails, and the winner is remembered.
export function sqlcipherDb(dbPath: string, key: string, runner: Runner, bin: string = sqlcipherBin()): KakaoDb {
	let compat = 3;
	const scrub = (text: string) => (key ? text.replaceAll(quote(key), "***").replaceAll(key, "***") : text);
	const attempt = async (sql: string, version: number): Promise<{ rows: Record<string, unknown>[] } | { error: string }> => {
		const stdin = [
			`PRAGMA cipher_default_compatibility=${version};`,
			`PRAGMA key=${quote(key)};`,
			"PRAGMA query_only=ON;",
			"PRAGMA busy_timeout=3000;",
			".mode json",
			sql.trimEnd().endsWith(";") ? sql : `${sql};`,
		].join("\n");
		const res = await runner([bin, "-readonly", dbPath], { stdin: `${stdin}\n`, timeoutMs: 20_000 });
		const failed = res.code !== 0 || /\b(Error|error)\b/.test(res.stderr) || /^(Error|Parse error|Runtime error)/m.test(res.stdout);
		if (failed) return { error: scrub(`${res.stderr}\n${res.stdout}`.trim().slice(0, 300)) || `sqlcipher exited with ${res.code}` };
		// PRAGMA busy_timeout prints its value before .mode json takes effect; the JSON array starts at a line of its own.
		const start = res.stdout.search(/^\[/m);
		if (start < 0) return { rows: [] };
		try {
			return { rows: JSON.parse(res.stdout.slice(start)) };
		} catch {
			return { error: "unexpected sqlcipher output" };
		}
	};
	return {
		async query(sql, params = []) {
			const text = inlineParams(sql, params);
			const first = await attempt(text, compat);
			if ("rows" in first) return first.rows;
			if (!/not a database/i.test(first.error)) throw new Error(first.error);
			const other = compat === 3 ? 4 : 3;
			const second = await attempt(text, other);
			if ("rows" in second) {
				compat = other;
				return second.rows;
			}
			throw new Error(first.error);
		},
	};
}

// Read-only bun:sqlite over a plain (unencrypted) file; tests and fixtures only.
export function sqliteDb(path: string): KakaoDb & { close(): void } {
	const db = new Database(path, { readonly: true });
	return {
		async query(sql, params = []) {
			return db.query(sql).all(...params) as Record<string, unknown>[];
		},
		close: () => db.close(),
	};
}

export async function deriveDb(paths: Pick<KakaoPaths, "home">, runner: Runner): Promise<{ dbPath: string; key: string; userId: number }> {
	const uuid = await platformUUID(runner);
	const userId = await findUserId(paths.home, runner);
	const key = secureKey(userId, uuid);
	const container = containerPath(paths.home);
	const derived = join(container, databaseName(userId, uuid));
	const candidates = [derived, `${derived}.db`].filter(exists);
	const found = discoverDatabaseFile(container);
	if (found && !candidates.includes(found)) candidates.push(found);
	for (const dbPath of candidates) {
		try {
			await sqlcipherDb(dbPath, key, runner).query("SELECT count(*) AS n FROM sqlite_master");
			return { dbPath, key, userId };
		} catch {}
	}
	throw new Error(candidates.length ? "the KakaoTalk database did not open with the derived key" : "no KakaoTalk database found in the container");
}

// Room type -> kind. 0 and 1 come from kakaocli (Models/Chat.swift, DatabaseReader.swift ChatType.from); 3 (drafted like
// 1) and 5 (the self chat) from kakao-dots-bridge bridge.py chats(). Anything else, 9999 (hidden) included, is "other".
export function roomKind(type: number): Room["kind"] {
	if (type === 0) return "direct";
	if (type === 1 || type === 3) return "group";
	if (type === 5) return "self";
	return "other";
}

// Text messages are type 1 (kakaocli Models/Message.swift).
export const TEXT_TYPE = 1;

// Other tooling stores sentAt in seconds (kakaocli kakaoDate); a millisecond value is accepted too.
export const sentAtMs = (sentAt: number) => (sentAt > 1e11 ? sentAt : sentAt * 1000);

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown) => Number(v ?? 0);

export async function rooms(db: KakaoDb): Promise<Room[]> {
	const rows = await db.query(
		`SELECT CAST(r.chatId AS TEXT) AS chatId, r.type AS type, r.chatName AS chatName, r.countOfNewMessage AS unread, r.lastUpdatedAt AS lastAt, r.activeMembersCount AS members,
			COALESCE(NULLIF(u.friendNickName, ''), NULLIF(u.displayName, ''), NULLIF(u.nickName, '')) AS peer,
			(SELECT COALESCE(NULLIF(mt.groupNickname, ''), NULLIF(mt.content, '')) FROM NTChatMeta mt WHERE mt.chatId = r.chatId AND mt.type = 3 LIMIT 1) AS title
		FROM NTChatRoom r LEFT JOIN NTUser u ON r.directChatMemberUserId = u.userId AND u.linkId = 0
		ORDER BY r.lastUpdatedAt DESC`,
	);
	// The room title the owner (or a member) set is chat meta type 3; KakaoTalk shows it before chatName and the 1:1 peer's name.
	return rows.map((r) => ({
		chatId: str(r.chatId),
		name: str(r.title).trim() || str(r.chatName) || str(r.peer) || "(unknown)",
		type: num(r.type),
		kind: roomKind(num(r.type)),
		unread: num(r.unread),
		lastAt: num(r.lastAt),
		...(r.members === null || r.members === undefined ? {} : { members: num(r.members) }),
	}));
}

// A display label for a group room without a name, like KakaoTalk's: the newest other authors of its last 200 messages.
// Display only: a send never uses it (kmsg finds rooms by their real name).
export async function memberLabel(db: KakaoDb, chatId: string, userId: string | number): Promise<string | undefined> {
	const rows = await db.query(
		`SELECT COALESCE(NULLIF(u.friendNickName, ''), NULLIF(u.displayName, ''), NULLIF(u.nickName, '')) AS name
		FROM (SELECT authorId, MAX(logId) AS last FROM (SELECT authorId, logId FROM NTChatMessage WHERE chatId = ? ORDER BY logId DESC LIMIT 200)
			WHERE authorId != ? GROUP BY authorId) a
		LEFT JOIN NTUser u ON a.authorId = u.userId AND u.linkId = 0 ORDER BY a.last DESC LIMIT 4`,
		[chatId, String(userId)],
	);
	const names = rows.map(r => str(r.name)).filter(Boolean);
	return names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? " 외" : "") : undefined;
}

// Chat id -> room type, without names (the watch needs kinds only).
export async function roomTypes(db: KakaoDb): Promise<Map<string, number>> {
	const rows = await db.query("SELECT CAST(chatId AS TEXT) AS chatId, type FROM NTChatRoom");
	return new Map(rows.map((r) => [str(r.chatId), num(r.type)]));
}

// Oldest first. Without `opts`: the newest `limit`. `before`: the newest `limit` older than that logId. `after`: the oldest `limit` newer than it.
export async function messages(db: KakaoDb, chatId: string, limit: number, userId: string | number, opts: { before?: string; after?: string } = {}): Promise<Msg[]> {
	const after = opts.after !== undefined;
	const bound = opts.after ?? opts.before;
	const rows = await db.query(
		`SELECT CAST(m.logId AS TEXT) AS logId, CAST(m.chatId AS TEXT) AS chatId, CAST(m.authorId AS TEXT) AS authorId,
			COALESCE(NULLIF(u.friendNickName, ''), NULLIF(u.displayName, ''), NULLIF(u.nickName, '')) AS sender,
			m.message AS text, m.type AS type, m.sentAt AS sentAt, m.attachment AS attachment, m.localFilePath AS localFilePath
		FROM NTChatMessage m LEFT JOIN NTUser u ON m.authorId = u.userId AND u.linkId = 0
		WHERE m.chatId = ?${bound === undefined ? "" : ` AND m.logId ${after ? ">" : "<"} ?`} ORDER BY m.logId ${after ? "ASC" : "DESC"} LIMIT ?`,
		[chatId, ...(bound === undefined ? [] : [bound]), Math.max(1, Math.trunc(limit))],
	);
	const me = String(userId);
	return (after ? rows : rows.reverse()).map((r) => ({
		logId: str(r.logId),
		chatId: str(r.chatId),
		authorId: str(r.authorId),
		sender: str(r.sender),
		text: str(r.text),
		type: num(r.type),
		sentAt: num(r.sentAt),
		fromMe: str(r.authorId) === me,
		...(str(r.attachment) ? { attachment: str(r.attachment) } : {}),
		...(str(r.localFilePath) ? { localFilePath: str(r.localFilePath) } : {}),
	}));
}

// One message of a room by logId (the media routes), or undefined when the room has no such message.
export async function messageById(db: KakaoDb, chatId: string, logId: string, userId: string | number): Promise<Msg | undefined> {
	const m = (await messages(db, chatId, 1, userId, { after: String(BigInt(logId) - 1n) }))[0];
	return m?.logId === logId ? m : undefined;
}

export type NewRow = { logId: string; chatId: string; authorId: string; type: number; sentAt: number };

// Metadata only, no bodies. logId is 64-bit: it stays a string end to end (compare with BigInt).
export async function newSince(db: KakaoDb, lastLogId: string, limit: number): Promise<NewRow[]> {
	const rows = await db.query(
		`SELECT CAST(logId AS TEXT) AS logId, CAST(chatId AS TEXT) AS chatId, CAST(authorId AS TEXT) AS authorId, type, sentAt
		FROM NTChatMessage WHERE logId > ? ORDER BY logId ASC LIMIT ?`,
		[lastLogId, Math.max(1, Math.trunc(limit))],
	);
	return rows.map((r) => ({ logId: str(r.logId), chatId: str(r.chatId), authorId: str(r.authorId), type: num(r.type), sentAt: num(r.sentAt) }));
}

// Metadata only: the new rows of the given rooms (watched ones), oldest first.
export async function newInChats(db: KakaoDb, lastLogId: string, chatIds: string[], limit: number): Promise<{ logId: string; chatId: string }[]> {
	if (!chatIds.length) return [];
	const rows = await db.query(
		`SELECT CAST(logId AS TEXT) AS logId, CAST(chatId AS TEXT) AS chatId FROM NTChatMessage WHERE logId > ? AND chatId IN (${chatIds.map(() => "?").join(",")}) ORDER BY logId ASC LIMIT ?`,
		[lastLogId, ...chatIds, Math.max(1, Math.trunc(limit))],
	);
	return rows.map((r) => ({ logId: str(r.logId), chatId: str(r.chatId) }));
}

export async function maxLogId(db: KakaoDb): Promise<string> {
	const rows = await db.query("SELECT CAST(MAX(logId) AS TEXT) AS maxId FROM NTChatMessage");
	return str(rows[0]?.maxId) || "0";
}

export async function ownUserId(db: KakaoDb): Promise<string | undefined> {
	const rows = await db.query("SELECT CAST(userId AS TEXT) AS userId FROM NTChatContext LIMIT 1");
	return str(rows[0]?.userId) || undefined;
}

// NTChatRoom.watermarkKeys / watermarkValues are binary plists (bplist00), each a top-level array of int64: the member user ids and,
// in the same order, each member's last-read logId. This decodes such an array from its hex form (SQL hex(column)); anything that
// is not a well-formed int array gives undefined, never a throw.
export function bplistInts(hex: string): bigint[] | undefined {
	if (!hex || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return undefined;
	const b = Buffer.from(hex, "hex");
	if (b.length < 40 || b.toString("latin1", 0, 8) !== "bplist00") return undefined;
	const byte = (at: number) => {
		if (!Number.isInteger(at) || at < 0 || at >= b.length) throw new RangeError("bplist offset out of range");
		return b[at] as number;
	};
	const uint = (at: number, n: number) => {
		let v = 0n;
		for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(byte(at + i));
		return v;
	};
	try {
		const t = b.length - 32;
		const offSize = byte(t + 6);
		const refSize = byte(t + 7);
		if (offSize < 1 || offSize > 8 || refSize < 1 || refSize > 8) return undefined;
		const top = Number(uint(t + 16, 8));
		const table = Number(uint(t + 24, 8));
		const offOf = (i: number) => Number(uint(table + i * offSize, offSize));
		const readInt = (at: number): bigint | undefined => {
			const m = byte(at);
			if (m >> 4 !== 1 || (m & 15) > 3) return undefined;
			const n = 1 << (m & 15);
			const v = uint(at + 1, n);
			return n === 8 && v >= 1n << 63n ? v - (1n << 64n) : v;
		};
		let at = offOf(top);
		const m = byte(at);
		if (m >> 4 !== 0xa) return undefined;
		let count = m & 15;
		at++;
		if (count === 15) {
			const len = readInt(at);
			if (len === undefined) return undefined;
			count = Number(len);
			at += 1 + (1 << (byte(at) & 15));
		}
		if (count < 0 || count > b.length) return undefined;
		const out: bigint[] = [];
		for (let i = 0; i < count; i++) {
			const v = readInt(offOf(Number(uint(at + i * refSize, refSize))));
			if (v === undefined) return undefined;
			out.push(v);
		}
		return out;
	} catch {
		return undefined;
	}
}

// Member user id -> the logId that member has read up to, for one room. Empty when the room has no (readable) watermarks.
export async function watermarks(db: KakaoDb, chatId: string): Promise<Map<string, bigint>> {
	const out = new Map<string, bigint>();
	let rows: Record<string, unknown>[];
	try {
		rows = await db.query("SELECT hex(watermarkKeys) AS k, hex(watermarkValues) AS v FROM NTChatRoom WHERE chatId = ?", [chatId]);
	} catch {
		return out;
	}
	const keys = bplistInts(str(rows[0]?.k));
	const values = bplistInts(str(rows[0]?.v));
	if (!keys || !values || keys.length !== values.length) return out;
	keys.forEach((k, i) => out.set(String(k), values[i] as bigint));
	return out;
}

// KakaoTalk's yellow number: the members, other than the author and the owner, whose read position is before this message. 0 = show nothing.
export function unreadCount(marks: Map<string, bigint>, logId: string, authorId: string, ownerId: string | number): number {
	let id: bigint;
	try {
		id = BigInt(logId);
	} catch {
		return 0;
	}
	const owner = String(ownerId);
	let n = 0;
	for (const [member, read] of marks) if (member !== authorId && member !== owner && read < id) n++;
	return n;
}

// One signature per room (the raw hex of its read positions) for the given rooms, in one query. A failed query gives an empty map.
export async function watermarkSignatures(db: KakaoDb, chatIds: string[]): Promise<Map<string, string>> {
	if (!chatIds.length) return new Map();
	try {
		const rows = await db.query(`SELECT CAST(chatId AS TEXT) AS chatId, hex(watermarkValues) AS v FROM NTChatRoom WHERE chatId IN (${chatIds.map(() => "?").join(",")})`, chatIds);
		return new Map(rows.map((r) => [str(r.chatId), str(r.v)]));
	} catch {
		return new Map();
	}
}

// A room counts only when the owner chose it (watch_chats). KakaoTalk has no per-room mute column in the reader sources,
// so "muted" is the owner's exclude_chats list.
export function isDraftCandidate(room: Pick<Room, "chatId" | "kind">, config: Pick<KakaoConfig, "exclude_chats" | "watch_chats">): boolean {
	return (room.kind === "direct" || room.kind === "group") && (config.watch_chats ?? []).includes(room.chatId) && !(config.exclude_chats ?? []).includes(room.chatId);
}
