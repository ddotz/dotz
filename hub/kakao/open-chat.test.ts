import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type KakaoDb, sqliteDb } from "./db.ts";
import { addMessage, BASE_LOG, BASE_TIME, type FixtureMsg, makeFixtureDb, OWNER } from "./fixture.ts";
import { kakaoPaths, type KakaoConfig, type Runner } from "./types.ts";
import { runWatch } from "./watch.ts";
import { createKakaoWeb } from "./web.ts";

// Open chat rooms (and group rooms) as KakaoTalk shows them: the open profile nickname of each sender, emoticons as images, the author of a
// replied-to message; and 미답장 / bot wake-ups only for what is addressed to the owner there. Synthetic rows only.
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kakao-open-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LINK = 77;
const R = { direct: 101, group: 102, open: 106 } as const;
const PEER = 2001, MEMBER = 2003;
const at = (n: number) => BASE_TIME + n * 10;
const m = (n: number, chatId: number, authorId: number, message: string, type = 1, attachment?: object): FixtureMsg => ({ logId: BASE_LOG + BigInt(n), chatId, authorId, message, type, sentAt: at(n), ...(attachment ? { attachment: JSON.stringify(attachment) } : {}) });
const id = (n: number) => String(BASE_LOG + BigInt(n));

function setup(messages: FixtureMsg[], watch: number[] = [R.direct, R.group, R.open]) {
	const p = kakaoPaths(dir, dir);
	const dbPath = join(dir, "k.sqlite");
	const writer = makeFixtureDb(dbPath, {
		rooms: [
			{ chatId: R.direct, type: 0, members: 2, peer: PEER, lastUpdatedAt: at(1) },
			{ chatId: R.group, type: 1, chatName: "Study Group", members: 5, lastUpdatedAt: at(2) },
			{ chatId: R.open, type: 1, chatName: "", members: 40, lastUpdatedAt: at(3), linkId: LINK },
		],
		users: [
			{ userId: PEER, friendNickName: "Alex" },
			{ userId: PEER, linkId: LINK, nickName: "OpenAlex" },
			{ userId: MEMBER, linkId: LINK, nickName: "Washer" },
			{ userId: OWNER, nickName: "Owner" },
			{ userId: OWNER, linkId: LINK, nickName: "OwnerOpen" },
		],
		openLinks: [{ linkId: LINK, linkName: "Open Room" }],
		messages,
	});
	mkdirSync(dirname(p.config), { recursive: true });
	const config: KakaoConfig = { enabled: true, dbPath, userId: OWNER, watch_chats: watch.map(String), auto_draft_chats: watch.map(String) };
	writeFileSync(p.config, JSON.stringify(config));
	const events: Record<string, unknown>[] = [];
	const fetched: string[] = [];
	const runner: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
	const db = sqliteDb(dbPath);
	let clock = (BASE_TIME + 1000) * 1000;
	const fakeFetch = (async (url: string) => {
		fetched.push(String(url));
		return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } });
	}) as unknown as typeof fetch;
	const web = createKakaoWeb({ paths: p, runner, now: () => clock, openDb: async () => db, broadcast: e => events.push(e), collector: "mac-a", fetch: fakeFetch });
	const call = async (method: string, path: string, body?: unknown) => {
		const url = new URL(`http://local${path}`);
		const res = await web.route(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, url.pathname.split("/").filter(Boolean));
		return { status: res!.status, json: res!.headers.get("content-type")?.includes("json") ? ((await res!.json()) as any) : undefined };
	};
	const rooms = async () => {
		clock += 31_000;
		return ((await call("GET", "/api/kakao/rooms")).json.rooms as any[]).reduce((o, r) => ({ ...o, [r.chatId]: r }), {} as Record<string, any>);
	};
	return { web, call, rooms, events, fetched, writer, config, close: () => (db.close(), writer.close()) };
}

describe("open chat room view", () => {
	test("senders are named like KakaoTalk: the room is shown with names and each one is his open profile nickname, not the friend name", async () => {
		const t = setup([m(1, R.open, PEER, "hi all"), m(2, R.open, MEMBER, "car wash today"), m(3, R.open, OWNER, "thanks")]);
		const r = await t.call("GET", `/api/kakao/chat/${R.open}`);
		expect(r.status).toBe(200);
		expect(r.json.room.group).toBe(true);
		expect(r.json.messages.map((x: any) => [x.sender, x.fromMe])).toEqual([["OpenAlex", false], ["Washer", false], ["OwnerOpen", true]]);
		t.close();
	});

	test("an emoticon carries its name once and its image comes from the stored item path (item.kakaocdn.net)", async () => {
		const t = setup([m(1, R.open, MEMBER, "", 20, { name: "(emoticon)", path: "4412207.emot_001.webp", alt: "카카오 이모티콘", type: "animated-emoticon/digital-item" }), m(2, R.open, MEMBER, "", 12, { alt: "카카오 이모티콘" })]);
		const r = await t.call("GET", `/api/kakao/chat/${R.open}`);
		expect(r.json.messages[0].media).toEqual({ kind: "emoticon", alt: "카카오 이모티콘", image: true });
		expect(r.json.messages[1].media).toEqual({ kind: "emoticon", alt: "카카오 이모티콘" });
		const img = await t.call("GET", `/api/kakao/media/${R.open}/${id(1)}?i=0&v=full`);
		expect(img.status).toBe(200);
		expect(t.fetched).toEqual(["https://item.kakaocdn.net/dw/4412207.emot_001.webp"]);
		expect((await t.call("GET", `/api/kakao/media/${R.open}/${id(2)}?i=0&v=full`)).status).toBe(404);
		t.close();
	});

	test("a reply names the author of the original even when that message is not on the page", async () => {
		const t = setup([m(1, R.open, MEMBER, "who has a ladder?"), m(2, R.open, PEER, "me, later", 26, { src_logId: Number(id(1)), src_userId: MEMBER, src_message: "who has a ladder?", src_type: 1 })]);
		const r = await t.call("GET", `/api/kakao/chat/${R.open}?limit=1`);
		expect(r.json.messages[0].media).toEqual({ kind: "reply", quote: "who has a ladder?", quoteSender: "Washer" });
		t.close();
	});
});

describe("미답장 only for what is addressed to the owner in a group or open room", () => {
	test("1:1: the other person's last message waits; group and open chatter does not", async () => {
		const t = setup([m(1, R.direct, PEER, "lunch?"), m(2, R.group, PEER, "meeting moved to noon"), m(3, R.open, MEMBER, "anyone selling a bike")]);
		const rooms = await t.rooms();
		expect([rooms[R.direct].unreplied, rooms[R.group].unreplied, rooms[R.open].unreplied]).toEqual([true, false, false]);
		expect(t.web.unrepliedCount()).toBe(1);
		t.close();
	});

	test("a mention of the owner (metadata or @nickname), a reply to his message, or a question right after his message waits", async () => {
		const t = setup([
			m(1, R.group, PEER, "Owner can you check?", 1, { mentions: [{ user_id: OWNER, at: [1], len: 5 }] }),
			m(2, R.open, OWNER, "I can bring chairs"),
			m(3, R.open, PEER, "great", 26, { src_logId: Number(id(2)), src_userId: OWNER, src_message: "I can bring chairs", src_type: 1 }),
		]);
		let rooms = await t.rooms();
		expect([rooms[R.group].unreplied, rooms[R.open].unreplied]).toEqual([true, true]);
		addMessage(t.writer, m(4, R.open, OWNER, "ok"));
		addMessage(t.writer, m(5, R.open, MEMBER, "hey @OwnerOpen are you coming"));
		addMessage(t.writer, m(6, R.group, OWNER, "done"));
		addMessage(t.writer, m(7, R.group, PEER, "which file did you mean?"));
		rooms = await t.rooms();
		expect([rooms[R.group].unreplied, rooms[R.open].unreplied]).toEqual([true, true]);
		// chatter after the addressed message keeps it waiting; the owner's answer clears it
		addMessage(t.writer, m(8, R.open, PEER, "random chatter"));
		addMessage(t.writer, m(9, R.group, OWNER, "the second one"));
		rooms = await t.rooms();
		expect([rooms[R.group].unreplied, rooms[R.open].unreplied]).toEqual([false, true]);
		// an open room gets no "question after his message" rule: only mentions and replies count there
		addMessage(t.writer, m(10, R.open, OWNER, "here"));
		addMessage(t.writer, m(11, R.open, MEMBER, "what time?"));
		rooms = await t.rooms();
		expect(rooms[R.open].unreplied).toBe(false);
		t.close();
	});

	test("taking a waiting room off the watch list clears its badge and the count at once", async () => {
		const t = setup([m(1, R.direct, PEER, "lunch?")]);
		expect((await t.rooms())[R.direct].unreplied).toBe(true);
		expect(t.web.unrepliedCount()).toBe(1);
		expect((await t.call("PUT", `/api/kakao/rooms/${R.direct}`, { watched: false })).status).toBe(200);
		expect(t.web.unrepliedCount()).toBe(0);
		expect(t.events.some(e => e.kind === "kakao_unreplied")).toBe(true);
		expect((await t.call("GET", "/api/kakao/rooms")).json.rooms.find((r: any) => r.chatId === String(R.direct)).unreplied).toBe(false);
		t.close();
	});
});

describe("a room that is not watched opens read-only", () => {
	test("its messages are readable with watched false; send, draft and 답장 안 함 stay refused", async () => {
		const t = setup([m(1, R.open, MEMBER, "hello"), m(2, R.open, MEMBER, "", 20, { path: "4412207.emot_001.webp", alt: "카카오 이모티콘" })], [R.direct]);
		const r = await t.call("GET", `/api/kakao/chat/${R.open}`);
		expect(r.status).toBe(200);
		expect(r.json.room.watched).toBe(false);
		expect(r.json.messages.map((x: any) => x.sender)).toEqual(["Washer", "Washer"]);
		expect(r.json.drafts).toEqual([]);
		expect((await t.call("GET", `/api/kakao/media/${R.open}/${id(2)}?i=0&v=full`)).status).toBe(200);
		for (const [method, path] of [["POST", "send"], ["POST", "draft"], ["POST", "no-reply"]] as const) expect((await t.call(method, `/api/kakao/chat/${R.open}/${path}`, { text: "x" })).status).toBe(403);
		expect((await t.call("GET", `/api/kakao/chat/${R.direct}`)).json.room.watched).toBe(true);
		t.close();
	});

	test("a room opens with its newest 50 messages", async () => {
		const t = setup(Array.from({ length: 120 }, (_, i) => m(i + 1, R.group, PEER, `line ${i}`)));
		const list = (await t.call("GET", `/api/kakao/chat/${R.group}`)).json.messages;
		expect(list).toHaveLength(50);
		expect(list.at(-1).logId).toBe(id(120));
		t.close();
	});

	test("168 rooms x 5,000 messages: each open stays under 100 ms of server time and the room list is read once", async () => {
		const p = kakaoPaths(dir, dir);
		const dbPath = join(dir, "big.sqlite");
		const ROOMS = 168, PER = 5000;
		const w = makeFixtureDb(dbPath, { rooms: Array.from({ length: ROOMS }, (_, i) => ({ chatId: 5000 + i, type: i % 3 === 0 ? 0 : 1, chatName: i % 3 === 0 ? null : `Room ${i}`, members: 6, peer: i % 3 === 0 ? PEER : null, lastUpdatedAt: at(i), ...(i % 5 === 0 ? { linkId: LINK } : {}) })), users: [{ userId: PEER, friendNickName: "Alex" }, { userId: MEMBER, linkId: LINK, nickName: "Washer" }], openLinks: [{ linkId: LINK, linkName: "Open Room" }], messages: [] });
		w.exec("CREATE INDEX IF NOT EXISTS msg_chat ON NTChatMessage (chatId, logId)");
		const ins = w.query("INSERT INTO NTChatMessage VALUES (?, ?, ?, ?, 1, ?, NULL, NULL)");
		w.transaction(() => {
			let n = 0n;
			for (let k = 0; k < PER; k++) for (let i = 0; i < ROOMS; i++) ins.run(BASE_LOG + n++, 5000 + i, k % 2 ? PEER : MEMBER, `message ${k}`, BASE_TIME + Number(n));
		})();
		mkdirSync(dirname(p.config), { recursive: true });
		writeFileSync(p.config, JSON.stringify({ enabled: true, dbPath, userId: OWNER, watch_chats: ["5000"] }));
		const db = sqliteDb(dbPath);
		let roomReads = 0;
		const counted: KakaoDb = { query: (sql, params) => ((roomReads += /FROM NTChatRoom r\b/.test(sql) && /ORDER BY r\.lastUpdatedAt/.test(sql) && !/WHERE r\.chatId/.test(sql) ? 1 : 0), db.query(sql, params)) };
		const web = createKakaoWeb({ paths: p, runner: async () => ({ code: 0, stdout: "", stderr: "" }), now: () => (BASE_TIME + 1000) * 1000, openDb: async () => counted, broadcast: () => {}, collector: "mac-a" });
		const open = async (chatId: number) => {
			const url = new URL(`http://local/api/kakao/chat/${chatId}`);
			const t0 = performance.now();
			const res = await web.route(new Request(url), url, url.pathname.split("/").filter(Boolean));
			const ms = performance.now() - t0;
			expect(res!.status).toBe(200);
			expect(((await res!.json()) as any).messages).toHaveLength(50);
			return ms;
		};
		const times = [];
		for (const chatId of [5000, 5001, 5005, 5100, 5167, 5003]) times.push(await open(chatId));
		times.sort((a, b) => a - b);
		expect(times[Math.floor(times.length / 2)]!).toBeLessThan(100);
		expect(times.at(-1)!).toBeLessThan(250);
		expect(roomReads).toBeLessThanOrEqual(1);
		db.close();
		w.close();
	});
});

describe("watch wakes the bot for an open room only when the owner is called", () => {
	const run = async (messages: FixtureMsg[]) => {
		for (const f of ["k.sqlite", "state"]) rmSync(join(dir, f), { recursive: true, force: true });
		const t = setup([m(0, R.direct, OWNER, "baseline")]);
		const db: KakaoDb = { query: async (sql, params = []) => t.writer.query(sql).all(...params) as Record<string, unknown>[] };
		const stateDir = join(dir, "state");
		const now = () => (BASE_TIME + 200) * 1000;
		await runWatch({ db, config: t.config, stateDir, now });
		for (const x of messages) addMessage(t.writer, x);
		const out = await runWatch({ db, config: { ...t.config, settle_seconds: 0 }, stateDir, now });
		t.close();
		return out.lines;
	};
	test("open chatter wakes nothing; a mention, an @nickname or a reply to the owner does; a group room is unchanged", async () => {
		expect(await run([m(1, R.open, MEMBER, "anyone selling a bike"), m(2, R.group, PEER, "meeting moved")])).toEqual([expect.stringContaining(`chat=${R.group} `)]);
		expect(await run([m(3, R.open, MEMBER, "Owner?", 1, { mentions: [{ user_id: OWNER, at: [1], len: 5 }] })])).toEqual([expect.stringContaining(`chat=${R.open} new=1 from=${id(3)}`)]);
		expect(await run([m(4, R.open, MEMBER, "@OwnerOpen hello")])).toEqual([expect.stringContaining(`chat=${R.open} `)]);
		expect(await run([m(5, R.open, MEMBER, "yes", 26, { src_logId: 1, src_userId: OWNER, src_message: "x", src_type: 1 })])).toEqual([expect.stringContaining(`chat=${R.open} `)]);
	});
});
