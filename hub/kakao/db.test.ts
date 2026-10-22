import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	containerPath,
	containerPreferencesPath,
	databaseName,
	deriveDb,
	findUserId,
	hashedDeviceUUID,
	inlineParams,
	isDraftCandidate,
	maxLogId,
	messages,
	newSince,
	ownUserId,
	parseXmlPlist,
	platformUUID,
	preferencesPath,
	recoverUserIdFromSHA512,
	roomKind,
	rooms,
	secureKey,
	sqlcipherDb,
	sqliteDb,
	userIdFromPlist,
} from "./db.ts";
import { BASE_LOG, makeFixtureDb, OWNER, ROOM } from "./fixture.ts";
import type { RunOpts, Runner, RunResult } from "./types.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kakao-db-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { argv: string[]; opts?: RunOpts };
const fakeRunner = (handler: (argv: string[], opts?: RunOpts) => Partial<RunResult>): { runner: Runner; calls: Call[] } => {
	const calls: Call[] = [];
	const runner: Runner = async (argv, opts) => {
		calls.push({ argv, opts });
		return { code: 0, stdout: "", stderr: "", ...handler(argv, opts) };
	};
	return { runner, calls };
};

// Independent re-implementation of derive() from kakao-dots-bridge src/kakao_db.py.
const UUID = "11111111-2222-3333-4444-555555555555";
const reference = (uid: number, uuid: string) => {
	const rev = (s: string) => [...s].reverse().join("");
	const hashed = Buffer.concat([createHash("sha1").update(uuid).digest(), createHash("sha256").update(uuid).digest()]).toString("base64");
	const name = pbkdf2Sync([".", "F", String(uid), "A", "F", rev(uuid), ".", "|"].join("."), rev(hashed), 100000, 128, "sha256").toString("hex").slice(28, 106);
	const parts = ["A", hashed, "|", "F", uuid.slice(0, 5), "H", String(uid), "|", uuid.slice(7)];
	const key = pbkdf2Sync(rev(parts.join("F")), uuid.slice(Math.floor(uuid.length * 0.3)), 100000, 128, "sha256").toString("hex");
	return { hashed, name, key };
};

describe("key derivation", () => {
	test("matches values computed by Python hashlib for a fixed uid and uuid", () => {
		expect(hashedDeviceUUID(UUID)).toBe("l9IvhlJXHEKslNZJNrp406vOEoJmb/bMqls8B/6qOpXTpL0sRqyemr2wnKkTNSjT3B6JUg==");
		expect(databaseName(123456789, UUID)).toBe("87a5215a35cbf196a05fd6392b3f34e8b2c9cc8d5fca5b89339fc037189d3b00857944ed77d950");
		expect(secureKey(123456789, UUID)).toBe(
			"42fe8b47e028ca878a51059b0f853521cff8fb11d383ff707a49a3dadd3df81753a3003f674d37386939684fbda648b27b46f440cdd7232d9e0b8d75280d68163231b84691aac22aa3e860ac616ff419e184fa91e818a4b4ee7f82f8c6ee259a3cb438c353db2aa4fdd1ce60f35be8dab0b0098cd2b8f8a0b0d146541a00f3f8",
		);
	});

	test("agrees with the independent node:crypto re-implementation for other inputs", () => {
		for (const [uid, uuid] of [
			[7, "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"],
			[98765432101, "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0"],
		] as const) {
			const ref = reference(uid, uuid);
			expect(hashedDeviceUUID(uuid)).toBe(ref.hashed);
			expect(databaseName(uid, uuid)).toBe(ref.name);
			expect(databaseName(uid, uuid)).toHaveLength(78);
			expect(secureKey(uid, uuid)).toBe(ref.key);
		}
	});
});

describe("device info", () => {
	const ioreg = `    | "IOPlatformUUID" = "${UUID.toUpperCase()}"\n`;

	test("platformUUID reads ioreg through the runner", async () => {
		const { runner, calls } = fakeRunner(() => ({ stdout: ioreg }));
		expect(await platformUUID(runner)).toBe(UUID.toUpperCase());
		expect(calls[0]?.argv).toEqual(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
		const none = fakeRunner(() => ({ stdout: "nothing" }));
		await expect(platformUUID(none.runner)).rejects.toThrow("IOPlatformUUID");
	});

	test("the four userId strategies", () => {
		expect(userIdFromPlist({ FSChatWindowTransparency12345: 1, FSChatWindowTransparencyX12345: 1 })).toBe(12345);
		expect(userIdFromPlist({ userId: 555 })).toBe(555);
		expect(userIdFromPlist({ KAKAO_USER_ID: "556" })).toBe(556);
		const hash = createHash("sha512").update("4242").digest("hex");
		expect(userIdFromPlist({ [`DESIGNATEDFRIENDSREVISION:${hash}`]: 3 })).toBe(4242);
		expect(userIdFromPlist({ "NSWindow Frame FSChatWindowFrame_a777": "x", "NSWindow Frame FSChatWindowFrame_b777": "y" })).toBe(777);
		expect(userIdFromPlist({ other: 1 })).toBeUndefined();
	});

	test("SHA-512 search skips the empty-account hash, zero values and honours its time cap", () => {
		const empty = createHash("sha512").update("0").digest("hex");
		const hash = createHash("sha512").update("90").digest("hex");
		expect(userIdFromPlist({ [`DESIGNATEDFRIENDSREVISION:${empty}`]: 9, [`DESIGNATEDFRIENDSREVISION:${hash}`]: 0 })).toBeUndefined();
		expect(recoverUserIdFromSHA512(hash)).toBe(90);
		expect(recoverUserIdFromSHA512(hash, { max: 50 })).toBeUndefined();
		expect(recoverUserIdFromSHA512("zz")).toBeUndefined();
	});

	test("parseXmlPlist keeps root scalars and survives data and date values", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>userId</key><integer>321</integer>
	<key>blob</key><data>AAEC</data>
	<key>when</key><date>2024-01-01T00:00:00Z</date>
	<key>nested</key><dict><key>userId</key><integer>1</integer></dict>
	<key>list</key><array><integer>5</integer></array>
	<key>flag</key><true/>
	<key>name</key><string>a &amp; b</string>
	<key>after</key><integer>9</integer>
</dict></plist>`;
		expect(parseXmlPlist(xml)).toEqual({ userId: 321, blob: "AAEC", when: "2024-01-01T00:00:00Z", nested: null, list: null, flag: true, name: "a & b", after: 9 });
	});

	test("findUserId falls back from json to xml1 and from the container plist to the global one", async () => {
		const home = join(dir, "home");
		const containerPrefs = containerPreferencesPath(home);
		mkdirSync(join(containerPrefs, ".."), { recursive: true });
		mkdirSync(join(preferencesPath(home), ".."), { recursive: true });
		writeFileSync(containerPrefs, "x");
		writeFileSync(preferencesPath(home), "x");
		const { runner, calls } = fakeRunner((argv) => {
			if (argv[2] === "json") return { code: 1, stderr: "invalid object in plist" };
			return { stdout: argv[argv.length - 1] === containerPrefs ? "<plist><dict><key>other</key><integer>1</integer></dict></plist>" : "<plist><dict><key>userId</key><integer>808</integer></dict></plist>" };
		});
		expect(await findUserId(home, runner)).toBe(808);
		expect(calls.map((c) => c.argv.slice(0, 3).join(" "))).toEqual(["/usr/bin/plutil -convert json", "/usr/bin/plutil -convert xml1", "/usr/bin/plutil -convert json", "/usr/bin/plutil -convert xml1"]);
		await expect(findUserId(join(dir, "nowhere"), runner)).rejects.toThrow("user id");
	});

	test("deriveDb finds the derived file and verifies the key through sqlcipher", async () => {
		const home = join(dir, "home");
		const uid = 4711;
		const container = containerPath(home);
		mkdirSync(container, { recursive: true });
		const name = databaseName(uid, UUID.toUpperCase());
		writeFileSync(join(container, name), "");
		mkdirSync(join(preferencesPath(home), ".."), { recursive: true });
		writeFileSync(preferencesPath(home), "x");
		const { runner, calls } = fakeRunner((argv) => {
			if (argv[0] === "/usr/sbin/ioreg") return { stdout: `"IOPlatformUUID" = "${UUID.toUpperCase()}"` };
			if (argv[0] === "/usr/bin/plutil") return { stdout: JSON.stringify({ userId: uid }) };
			return { stdout: '3000\n[{"n":1}]\n' };
		});
		const got = await deriveDb({ home }, runner);
		expect(got).toEqual({ dbPath: join(container, name), key: secureKey(uid, UUID.toUpperCase()), userId: uid });
		const sql = calls.find((c) => c.argv.includes("-readonly"));
		expect(sql?.argv.slice(1)).toEqual(["-readonly", join(container, name)]);
		expect(sql?.opts?.stdin).toContain("SELECT count(*) AS n FROM sqlite_master");
	});

	test("deriveDb discovers the database by its 78-hex name when the derived name is absent", async () => {
		const home = join(dir, "home");
		const container = containerPath(home);
		mkdirSync(container, { recursive: true });
		const found = "a".repeat(78);
		writeFileSync(join(container, found), "");
		writeFileSync(join(container, "notes.txt"), "");
		mkdirSync(join(preferencesPath(home), ".."), { recursive: true });
		writeFileSync(preferencesPath(home), "x");
		const { runner } = fakeRunner((argv) => {
			if (argv[0] === "/usr/sbin/ioreg") return { stdout: `"IOPlatformUUID" = "${UUID.toUpperCase()}"` };
			if (argv[0] === "/usr/bin/plutil") return { stdout: JSON.stringify({ userId: 1 }) };
			return { stdout: '[{"n":1}]' };
		});
		expect((await deriveDb({ home }, runner)).dbPath).toBe(join(container, found));
	});

	test("deriveDb reports a key that does not open the database without echoing the key", async () => {
		const home = join(dir, "home");
		const container = containerPath(home);
		mkdirSync(container, { recursive: true });
		writeFileSync(join(container, "b".repeat(78)), "");
		mkdirSync(join(preferencesPath(home), ".."), { recursive: true });
		writeFileSync(preferencesPath(home), "x");
		const { runner } = fakeRunner((argv) => {
			if (argv[0] === "/usr/sbin/ioreg") return { stdout: `"IOPlatformUUID" = "${UUID.toUpperCase()}"` };
			if (argv[0] === "/usr/bin/plutil") return { stdout: JSON.stringify({ userId: 1 }) };
			return { code: 1, stderr: "Error: file is not a database" };
		});
		const err = await deriveDb({ home }, runner).catch((e) => e as Error);
		expect(err.message).toContain("did not open");
		expect(err.message).not.toContain(secureKey(1, UUID.toUpperCase()));
	});
});

describe("sqlcipherDb", () => {
	const KEY = "k3y'with-quote";

	test("argv carries no key; the key and the inlined sql travel on stdin", async () => {
		const { runner, calls } = fakeRunner(() => ({ stdout: '3000\n[{"a":1}]\n' }));
		const db = sqlcipherDb("/tmp/x.db", KEY, runner, "/bin/sqlcipher");
		expect(await db.query("SELECT ? AS a, ? AS b", [1, "it's"])).toEqual([{ a: 1 }]);
		const call = calls[0];
		expect(call?.argv).toEqual(["/bin/sqlcipher", "-readonly", "/tmp/x.db"]);
		expect(call?.argv.join(" ")).not.toContain("k3y");
		expect(call?.opts?.stdin).toBe(
			["PRAGMA cipher_default_compatibility=3;", "PRAGMA key='k3y''with-quote';", "PRAGMA query_only=ON;", "PRAGMA busy_timeout=3000;", ".mode json", "SELECT 1 AS a, 'it''s' AS b;", ""].join("\n"),
		);
	});

	test("empty output is an empty result", async () => {
		const { runner } = fakeRunner(() => ({ stdout: "3000\n" }));
		expect(await sqlcipherDb("/tmp/x.db", KEY, runner, "/bin/sqlcipher").query("SELECT 1 WHERE 0")).toEqual([]);
	});

	test("errors never contain the key", async () => {
		const { runner } = fakeRunner(() => ({ code: 1, stderr: `Parse error near line 2: PRAGMA key=${"'k3y''with-quote'"} k3y'with-quote` }));
		const err = await sqlcipherDb("/tmp/x.db", KEY, runner, "/bin/sqlcipher").query("SELECT 1").catch((e) => e as Error);
		expect(err.message).toContain("Parse error");
		expect(err.message).not.toContain("k3y");
	});

	test("falls back to compatibility 4 on 'not a database' and remembers the winner", async () => {
		const { runner, calls } = fakeRunner((_argv, opts) =>
			opts?.stdin?.includes("compatibility=4") ? { stdout: '[{"ok":1}]' } : { code: 1, stderr: "Error: file is not a database" },
		);
		const db = sqlcipherDb("/tmp/x.db", KEY, runner, "/bin/sqlcipher");
		expect(await db.query("SELECT 1")).toEqual([{ ok: 1 }]);
		expect(await db.query("SELECT 1")).toEqual([{ ok: 1 }]);
		expect(calls.map((c) => /compatibility=(\d)/.exec(c.opts?.stdin ?? "")?.[1])).toEqual(["3", "4", "4"]);
	});

	test("a failure under both compatibility modes throws; other errors do not retry", async () => {
		const both = fakeRunner(() => ({ code: 1, stderr: "Error: file is not a database" }));
		await expect(sqlcipherDb("/tmp/x.db", KEY, both.runner, "/bin/sqlcipher").query("SELECT 1")).rejects.toThrow("not a database");
		expect(both.calls).toHaveLength(2);
		const other = fakeRunner(() => ({ code: 1, stderr: "Error: no such table: nope" }));
		await expect(sqlcipherDb("/tmp/x.db", KEY, other.runner, "/bin/sqlcipher").query("SELECT 1")).rejects.toThrow("no such table");
		expect(other.calls).toHaveLength(1);
	});
});

describe("inlineParams", () => {
	test("escapes strings, accepts finite numbers, ignores ? inside string literals", () => {
		expect(inlineParams("a = ? AND b = ? AND c = '?'", ["x'; DROP TABLE t; --", 42])).toBe("a = 'x''; DROP TABLE t; --' AND b = 42 AND c = '?'");
		expect(inlineParams("SELECT 1")).toBe("SELECT 1");
	});

	test("rejects non-finite numbers, NUL bytes and a wrong parameter count", () => {
		expect(() => inlineParams("?", [Number.NaN])).toThrow("finite");
		expect(() => inlineParams("?", [Number.POSITIVE_INFINITY])).toThrow("finite");
		expect(() => inlineParams("?", ["a\0b"])).toThrow("NUL");
		expect(() => inlineParams("? ?", [1])).toThrow("fewer");
		expect(() => inlineParams("?", [1, 2])).toThrow("more");
	});
});

describe("typed reads on the fixture", () => {
	const open = () => {
		const path = join(dir, "kakao.sqlite");
		makeFixtureDb(path).close();
		return sqliteDb(path);
	};

	test("rooms: names, kinds and ids as strings", async () => {
		const db = open();
		const all = await rooms(db);
		const byId = Object.fromEntries(all.map((r) => [r.chatId, r]));
		expect(byId[String(ROOM.direct)]).toMatchObject({ name: "Alex", type: 0, kind: "direct", unread: 1 });
		expect(byId[String(ROOM.group)]).toMatchObject({ name: "Study Group", kind: "group" });
		expect(byId[String(ROOM.self)]).toMatchObject({ name: "(unknown)", kind: "self" });
		expect(byId[String(ROOM.channel)]?.kind).toBe("other");
		expect(all[0]?.chatId).toBe(String(ROOM.channel));
		db.close();
	});

	test("room kinds follow the mapping and unknown types are other", () => {
		expect([0, 1, 3, 5, 9999, 7, -1].map(roomKind)).toEqual(["direct", "group", "group", "self", "other", "other", "other"]);
	});

	test("messages: oldest first, fromMe from the owner id, sender names resolved", async () => {
		const db = open();
		const list = await messages(db, String(ROOM.direct), 10, OWNER);
		expect(list.map((m) => m.text)).toEqual(["hello there", "hi, how are you", "fine, lunch tomorrow?", "photo-ref"]);
		expect(list.map((m) => m.fromMe)).toEqual([false, true, false, false]);
		expect(list[0]).toMatchObject({ sender: "Alex", authorId: "2001", type: 1, chatId: String(ROOM.direct) });
		expect(list.map((m) => m.logId)).toEqual([0n, 1n, 2n, 3n].map((n) => String(BASE_LOG + n + 1n)));
		expect((await messages(db, String(ROOM.direct), 2, String(OWNER))).map((m) => m.text)).toEqual(["fine, lunch tomorrow?", "photo-ref"]);
		db.close();
	});

	test("newSince returns metadata only, ascending, and keeps 64-bit ids exact", async () => {
		const db = open();
		const rows = await newSince(db, String(BASE_LOG + 5n), 100);
		expect(rows.map((r) => r.logId)).toEqual([String(BASE_LOG + 6n), String(BASE_LOG + 7n), String(BASE_LOG + 8n)]);
		expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["authorId", "chatId", "logId", "sentAt", "type"]);
		expect(await newSince(db, String(BASE_LOG), 2)).toHaveLength(2);
		expect(await newSince(db, String(BASE_LOG + 8n), 10)).toEqual([]);
		db.close();
	});

	test("maxLogId and ownUserId", async () => {
		const db = open();
		expect(await maxLogId(db)).toBe(String(BASE_LOG + 8n));
		expect(await ownUserId(db)).toBe(String(OWNER));
		db.close();
		const empty = join(dir, "empty.sqlite");
		makeFixtureDb(empty, { rooms: [], users: [], messages: [] }).close();
		const edb = sqliteDb(empty);
		expect(await maxLogId(edb)).toBe("0");
		edb.close();
	});

	test("isDraftCandidate: direct and group only, never excluded rooms", async () => {
		const db = open();
		const config = { enabled: true, exclude_chats: [String(ROOM.excluded)] };
		const flags = Object.fromEntries((await rooms(db)).map((r) => [r.chatId, isDraftCandidate(r, config)]));
		expect(flags).toEqual({ [ROOM.direct]: true, [ROOM.group]: true, [ROOM.self]: false, [ROOM.excluded]: false, [ROOM.channel]: false });
		expect(isDraftCandidate({ chatId: "1", kind: "group" }, { enabled: true })).toBe(true);
		db.close();
	});
});
