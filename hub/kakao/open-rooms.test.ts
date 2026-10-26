// Open chat rooms (NTChatRoom.linkId != 0, named by NTOpenLink.linkName) in KakaoTalk monitoring, behind the 오픈채팅방 보기 setting
// (config open_chats, default on), and readable labels + a short hint for rooms without a name. A fixture database, fake screen and
// fake model only: nothing reaches KakaoTalk.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fieldsOf, readSettings } from "../app-settings.ts";
import { parseDraftApproval } from "../draft-approval.ts";
import { type Ctx, type Reader, run } from "./cli.ts";
import { isDraftCandidate, type KakaoDb, messages, rooms, sqliteDb } from "./db.ts";
import { BASE_LOG, BASE_TIME, type FixtureMsg, type FixtureRoom, makeFixtureDb, OWNER } from "./fixture.ts";
import { createDraft, draftBlock, forgetWarm, sendDraft } from "./send.ts";
import { type KakaoConfig, kakaoPaths } from "./types.ts";
import { fakeScreen } from "./ui.fixture.ts";
import { runWatch } from "./watch.ts";
import { createKakaoWeb } from "./web.ts";

const OPEN = 106;
const OPEN_NAME = "보컬 스터디 오픈채팅";
const UNNAMED = Array.from({ length: 12 }, (_, i) => 200 + i);
const QUIET = 300;
const LONELY = 301;
const NOW = (BASE_TIME + 1000) * 1000;
const log = (n: number) => BASE_LOG + BigInt(n);

const roomsSpec: FixtureRoom[] = [
	{ chatId: 101, type: 0, chatName: null, members: 2, peer: 2001, lastUpdatedAt: BASE_TIME + 40 },
	{ chatId: OPEN, type: 2, chatName: "", members: 30, linkId: 77, unread: 3, lastUpdatedAt: BASE_TIME + 900 },
	...UNNAMED.map((chatId, i) => ({ chatId, type: 1, chatName: null, members: 6, lastUpdatedAt: BASE_TIME + 100 + i })),
	{ chatId: QUIET, type: 1, chatName: null, members: 4, lastUpdatedAt: BASE_TIME + 20 },
	{ chatId: LONELY, type: 0, chatName: null, members: 2, peer: null, lastUpdatedAt: BASE_TIME + 10 },
];
const users = [
	{ userId: 2001, friendNickName: "Alex" },
	{ userId: 2002, nickName: "Sam" },
	{ userId: 3001, linkId: 77, nickName: "익명의 라이언" },
	{ userId: OWNER, displayName: "Owner" },
];
const msgs: FixtureMsg[] = [
	{ logId: log(1), chatId: 101, authorId: 2001, message: "hello there", sentAt: BASE_TIME + 10 },
	...UNNAMED.flatMap((chatId, i) => [
		{ logId: log(10 + i * 2), chatId, authorId: 2001, message: `회의 ${i}번 안건`, sentAt: BASE_TIME + 100 + i },
		{ logId: log(11 + i * 2), chatId, authorId: 2002, message: `${i}번 방 마지막 말이 아주 길어서 목록에서는 잘려 보여야 하는 문장입니다`, sentAt: BASE_TIME + 101 + i },
	]),
	{ logId: log(90), chatId: OPEN, authorId: 3001, message: "오늘 발성 연습 몇 시에 해요?", sentAt: BASE_TIME + 900 },
];

let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
let dbPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kk-open-"));
	paths = kakaoPaths(join(dir, "data"), join(dir, "home"));
	dbPath = join(dir, "k.sqlite");
	makeFixtureDb(dbPath, { rooms: roomsSpec, users, messages: msgs, openLinks: [{ linkId: 77, linkName: OPEN_NAME }] }).close();
	forgetWarm();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeConfig = (over: Partial<KakaoConfig> = {}): KakaoConfig => {
	const c: KakaoConfig = { enabled: true, dbPath, userId: OWNER, watch_chats: [String(OPEN)], auto_draft_chats: [String(OPEN)], ...over };
	mkdirSync(dirname(paths.config), { recursive: true });
	writeFileSync(paths.config, JSON.stringify(c));
	return c;
};

function web() {
	const db = sqliteDb(dbPath);
	const screen = fakeScreen([{ id: "chat_open", title: OPEN_NAME, window: { title: OPEN_NAME } }]);
	const w = createKakaoWeb({ paths, runner: screen.runner, now: () => NOW, openDb: async () => db, broadcast: () => {}, collector: "mac-a" });
	const call = async (method: string, path: string, body?: unknown) => {
		const url = new URL(`http://local${path}`);
		const res = await w.route(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, url.pathname.split("/").filter(Boolean));
		return { status: res!.status, json: (await res!.json()) as any };
	};
	return { call, close: () => db.close() };
}

describe("open chat rooms", () => {
	test("the database reader knows an open room by its link: kind open, the link's name, its members by their open profile", async () => {
		const db = sqliteDb(dbPath);
		const open = (await rooms(db)).find(r => r.chatId === String(OPEN))!;
		expect(open).toMatchObject({ kind: "open", name: OPEN_NAME, members: 30 });
		expect((await messages(db, String(OPEN), 10, OWNER)).map(m => m.sender)).toEqual(["익명의 라이언"]);
		db.close();
	});

	test("an older database without links still lists its rooms (no open room there)", async () => {
		const old = join(dir, "old.sqlite");
		makeFixtureDb(old, { noLinks: true }).close();
		const db = sqliteDb(old);
		expect((await rooms(db)).map(r => r.kind)).toEqual(["other", "group", "self", "group", "direct"]);
		db.close();
	});

	test("on (the default): listed in 모니터링 with its name, watched, readable and drafted like a normal room", async () => {
		writeConfig();
		const t = web();
		const list = (await t.call("GET", "/api/kakao/rooms")).json.rooms;
		expect(list.find((r: any) => r.chatId === String(OPEN))).toMatchObject({ kind: "open", name: OPEN_NAME, watched: true, autoDraft: true, unread: 3, hint: "오늘 발성 연습 몇 시에 해요?" });
		const chat = await t.call("GET", `/api/kakao/chat/${OPEN}`);
		expect(chat.status).toBe(200);
		expect(chat.json.messages.map((m: any) => [m.sender, m.text])).toEqual([["익명의 라이언", "오늘 발성 연습 몇 시에 해요?"]]);
		expect(isDraftCandidate({ chatId: String(OPEN), kind: "open" }, { watch_chats: [String(OPEN)] })).toBe(true);
		t.close();
	});

	test("off: not listed, not readable, never a draft candidate", async () => {
		writeConfig({ open_chats: false });
		const t = web();
		const list = (await t.call("GET", "/api/kakao/rooms")).json.rooms;
		expect(list.some((r: any) => r.chatId === String(OPEN))).toBe(false);
		expect(list.some((r: any) => r.kind === "open")).toBe(false);
		expect((await t.call("GET", `/api/kakao/chat/${OPEN}`)).status).not.toBe(200);
		expect(isDraftCandidate({ chatId: String(OPEN), kind: "open" }, { watch_chats: [String(OPEN)], open_chats: false })).toBe(false);
		t.close();
	});

	test("a new message in a watched open room wakes the bot when on, and not when off", async () => {
		const w = makeFixtureDb(join(dir, "w.sqlite"), { rooms: roomsSpec, users, messages: msgs, openLinks: [{ linkId: 77, linkName: OPEN_NAME }] });
		const db: KakaoDb = { query: async (sql, params = []) => w.query(sql).all(...(params as never[])) as Record<string, unknown>[] };
		const sig = join(dir, "sig");
		writeFileSync(sig, "a");
		const wake = async (config: KakaoConfig, n: number) => {
			const stateDir = join(dir, `state-${n}`);
			const clock = (BASE_TIME + 950 + n) * 1000;
			await runWatch({ db, config, stateDir, now: () => clock, dbFiles: [sig] });
			w.query("INSERT INTO NTChatMessage VALUES (?, ?, ?, ?, 1, ?, NULL, NULL)").run(log(100 + n), OPEN, 3001, "몇 시에 해요?", BASE_TIME + 940 + n);
			writeFileSync(sig, `a${n}`);
			return (await runWatch({ db, config, stateDir, now: () => clock, dbFiles: [sig] })).lines;
		};
		const base: KakaoConfig = { enabled: true, userId: OWNER, watch_chats: [String(OPEN)], auto_draft_chats: [String(OPEN)], settle_seconds: 0 };
		expect((await wake(base, 1)).join("\n")).toContain(`kakao chat=${OPEN} new=1`);
		expect(await wake({ ...base, open_chats: false }, 2)).toEqual([]);
		w.close();
	});

	test("end to end through the CLI: draft -> 1) 보내기 -> one Accessibility send into the open room", async () => {
		const config = writeConfig();
		const db = sqliteDb(dbPath);
		const reader: Reader = { rooms: () => rooms(db), messages: (c, l) => messages(db, c, l, OWNER), draftable: r => isDraftCandidate(r, config) };
		const screen = fakeScreen([{ id: "chat_open", title: OPEN_NAME, window: { title: OPEN_NAME } }]);
		const out: string[] = [];
		const deps = { paths, runner: screen.runner };
		const unused = async () => {
			throw new Error("unexpected call");
		};
		const ctx = { paths, runner: screen.runner, out: (l: string) => void out.push(l), stdin: async () => "7시에 해요", reader: async () => reader, hub: { post: async () => ({ status: 200, json: {} }), get: unused, patch: unused, del: unused }, drafts: async () => ({ create: (i: Parameters<typeof createDraft>[0]) => createDraft(i, deps), block: draftBlock, send: (code: string, extra: object) => sendDraft(code, { ...deps, ...(extra as { latestIncoming: (c: string) => Promise<string | undefined> }) }) }), now: () => 0 } as unknown as Ctx;
		expect(await run(["draft", "--chat", String(OPEN)], ctx)).toBe(0);
		const card = parseDraftApproval(out[0]!)!;
		expect(card).toMatchObject({ toLabel: "대화방", to: OPEN_NAME, body: "7시에 해요" });
		appendFileSync(paths.inbox, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: "1) 보내기", picks: [{ q: `카톡 답장 보낼까요? (${card.ref})`, n: 1, label: "보내기" }] })}\n`);
		expect(await run(["send", "--draft", card.ref!], ctx)).toBe(0);
		expect(screen.sends).toEqual([["ax-send", OPEN_NAME, "7시에 해요"]]);
		db.close();
	});

	test("the KakaoTalk app settings have 오픈채팅방 보기, on by default, stored as open_chats", () => {
		const f = fieldsOf("kakao").find(x => x.key === "open_chats");
		expect(f).toMatchObject({ label: "오픈채팅방 보기", type: "bool", store: "custom/kakao/config.json", path: "open_chats", def: true });
		expect(readSettings(join(dir, "data"), "kakao").find(v => v.key === "open_chats")?.value).toBe(true);
	});
});

describe("rooms without a name", () => {
	test("every room in the list has a readable label (members, 외 N명, kind) and a hint; none says unknown", async () => {
		writeConfig();
		const t = web();
		const list: any[] = (await t.call("GET", "/api/kakao/rooms")).json.rooms;
		for (const r of list) {
			expect(r.name).not.toBe("(unknown)");
			expect(r.name).not.toBe("이름 없는 방");
			expect(typeof r.hint === "string" && r.hint.length > 0).toBe(true);
		}
		const by = Object.fromEntries(list.map(r => [r.chatId, r]));
		for (const id of UNNAMED) expect(by[String(id)].name).toBe("Sam, Alex 외 3명");
		expect(by[String(UNNAMED[0])].hint).toBe("0번 방 마지막 말이 아주 길어서 목록에서는 잘려 보여야…");
		expect(by[String(QUIET)]).toMatchObject({ name: "단체 대화방 4명", hint: "4명" });
		expect(by[String(LONELY)]).toMatchObject({ name: "1:1 대화방", hint: "2명" });
		expect(by["101"]).toMatchObject({ name: "Alex", hint: "hello there" });
		t.close();
	});
});
