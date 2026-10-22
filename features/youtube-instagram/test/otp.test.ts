// lib/otp.ts against a temp SQLite file with the minimal Messages schema; never the real chat.db.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { decodeAttributedBody, extractCode, MessagesAccessError, probeMessages, readCodeSince, waitForCode } from "../lib/otp.ts";

let dir: string;
let db: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-otp-"));
	db = join(dir, "chat.db");
	const c = new Database(db);
	c.run("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)");
	c.run("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER)");
	c.run("INSERT INTO handle (ROWID, id) VALUES (1, '+8210000000')");
	c.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const APPLE_EPOCH = Date.UTC(2001, 0, 1);
const ns = (iso: string) => (Date.parse(iso) - APPLE_EPOCH) * 1_000_000;
const T0 = new Date("2026-10-22T03:00:00Z");

// A typedstream blob the way Messages stores attributedBody: a header, "NSString", marker bytes, '+', length, text.
function typedstream(text: string): Uint8Array {
	const body = Buffer.from(text, "utf8");
	const len = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length & 0xff, body.length >> 8]);
	return Buffer.concat([Buffer.from("streamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"), len, body, Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49])]);
}

function add(row: { text?: string | null; body?: Uint8Array | null; at: string; fromMe?: number }) {
	const c = new Database(db);
	c.run("INSERT INTO message (text, attributedBody, date, is_from_me, handle_id) VALUES (?, ?, ?, ?, 1)", [row.text ?? null, row.body ?? null, ns(row.at), row.fromMe ?? 0]);
	c.close();
}

test("extractCode: google, instagram family and generic matchers", () => {
	expect(extractCode("G-123456 is your Google verification code.", "google")).toBe("123456");
	expect(extractCode("Google 인증 코드: 654321", "google")).toBe("654321");
	expect(extractCode("Your code is 123456", "google")).toBeUndefined();
	expect(extractCode("123456 is your Instagram code. Don't share it.", "instagram")).toBe("123456");
	expect(extractCode("Facebook confirmation code 12345678", "instagram")).toBe("12345678");
	expect(extractCode("Meta: 인증 12345", "instagram")).toBeUndefined();
	expect(extractCode("[은행] 인증번호 4821을 입력하세요", "generic")).toBe("4821");
	expect(extractCode("코드 9988", "generic")).toBe("9988");
	expect(extractCode("오늘 3시에 만나요 1234", "generic")).toBeUndefined();
});

test("decodeAttributedBody reads a short and a 0x81 two-byte length, and gives up on garbage", () => {
	expect(decodeAttributedBody(typedstream("G-111222 is your Google code"))).toBe("G-111222 is your Google code");
	const long = `Instagram 코드 ${"가".repeat(100)} 445566`;
	expect(Buffer.from(long).length).toBeGreaterThan(0x7f);
	expect(decodeAttributedBody(typedstream(long))).toBe(long);
	expect(decodeAttributedBody(Buffer.from("no marker here"))).toBeUndefined();
	expect(decodeAttributedBody(Buffer.from("NSString\x01\x94"))).toBeUndefined();
	expect(decodeAttributedBody(Buffer.concat([Buffer.from("NSString\x01\x94\x84\x01+"), Buffer.from([0x81, 0xff, 0x00])]))).toBeUndefined();
});

test("readCodeSince returns the newest code after the cutoff, from text or from attributedBody alone", () => {
	add({ text: "G-000111 is your Google verification code", at: "2026-10-22T02:00:00Z" });
	expect(readCodeSince(db, "google", T0)).toBeUndefined();

	add({ text: "G-222333 is your Google verification code", at: "2026-10-22T03:01:00Z" });
	add({ body: typedstream("G-444555 is your Google verification code"), at: "2026-10-22T03:02:00Z" });
	expect(readCodeSince(db, "google", T0)).toBe("444555");

	add({ text: "G-666777 is your Google verification code", at: "2026-10-22T03:03:00Z", fromMe: 1 });
	expect(readCodeSince(db, "google", T0)).toBe("444555");

	add({ text: "123456 is your Instagram code", at: "2026-10-22T03:04:00Z" });
	expect(readCodeSince(db, "instagram", T0)).toBe("123456");
	expect(readCodeSince(db, "google", T0)).toBe("444555");
});

test("an attributedBody-only row is found when it is the only candidate", () => {
	add({ body: typedstream("Instagram 코드: 778899"), at: "2026-10-22T03:05:00Z" });
	expect(readCodeSince(db, "instagram", T0)).toBe("778899");
});

test("second-based dates from older databases still compare", () => {
	const c = new Database(db);
	c.run("INSERT INTO message (text, date, is_from_me, handle_id) VALUES (?, ?, 0, 1)", ["G-135790 is your Google code", (Date.parse("2026-10-22T03:30:00Z") - APPLE_EPOCH) / 1000]);
	c.close();
	expect(readCodeSince(db, "google", T0)).toBe("135790");
});

test("waitForCode polls with the injected sleep until the code arrives, and times out with undefined", async () => {
	const sleeps: number[] = [];
	const code = await waitForCode({
		db,
		service: "google",
		since: T0,
		timeoutMs: 30_000,
		pollMs: 1000,
		sleep: async ms => {
			sleeps.push(ms);
			if (sleeps.length === 3) add({ text: "G-314159 is your Google code", at: "2026-10-22T03:00:10Z" });
		},
	});
	expect(code).toBe("314159");
	expect(sleeps).toEqual([1000, 1000, 1000]);

	const slept: number[] = [];
	const none = await waitForCode({ db, service: "instagram", since: T0, timeoutMs: 5000, pollMs: 1000, sleep: async ms => void slept.push(ms) });
	expect(none).toBeUndefined();
	expect(slept).toHaveLength(5);
});

test("an unreadable or wrong database is a MessagesAccessError", async () => {
	expect(() => readCodeSince(join(dir, "missing.db"), "google", T0)).toThrow(MessagesAccessError);
	const bad = join(dir, "bad.db");
	writeFileSync(bad, "this is not a sqlite file at all, just text padding to look long enough");
	expect(() => readCodeSince(bad, "google", T0)).toThrow(MessagesAccessError);
	const empty = join(dir, "empty.db");
	new Database(empty).close();
	expect(() => probeMessages(empty)).toThrow(MessagesAccessError);
	await expect(waitForCode({ db: join(dir, "missing.db"), service: "google", since: T0, sleep: async () => {} })).rejects.toBeInstanceOf(MessagesAccessError);
	expect(() => probeMessages(db)).not.toThrow();
});

test("the database is opened read-only", () => {
	add({ text: "G-111111 Google", at: "2026-10-22T03:01:00Z" });
	readCodeSince(db, "google", T0);
	const c = new Database(db);
	expect((c.query("SELECT count(*) AS n FROM message").get() as { n: number }).n).toBe(1);
	c.close();
});
