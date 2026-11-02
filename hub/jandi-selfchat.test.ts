import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandOf, createSelfChat, normalizeSelfChat, type SelfChatConfig } from "./jandi-selfchat.ts";
import { readSecretFile, setSecretKey } from "./secretbox.ts";

const TEAM = 7;
const ROOM = 100;
const ME = 11;
const BOT = 22;
const WEBHOOK_BOT = 33;

type Msg = { id: number; fromEntity: number; body: string };
let room: { type: string; companionId: number; members: number[] };
let messages: Msg[];
let calls: string[];
let expireOnce: boolean;
let rotate: string | undefined;

const jandi = Bun.serve({
	port: 0,
	async fetch(req) {
		const u = new URL(req.url);
		calls.push(u.pathname + u.search);
		if (u.pathname === "/inner-api/token") {
			const b = (await req.json()) as { refresh_token?: string };
			if (b.refresh_token !== "rt-1" && b.refresh_token !== "rt-2") return Response.json({ code: 40000 }, { status: 400 });
			return Response.json({ access_token: "at", refresh_token: rotate ?? b.refresh_token, expires_in: 43200 });
		}
		if (req.headers.get("authorization") !== "bearer at") return new Response(null, { status: 401 });
		if (expireOnce) {
			expireOnce = false;
			return new Response(null, { status: 401 });
		}
		if (u.pathname === `/room-api/v2/teams/${TEAM}/rooms/${ROOM}`) return Response.json({ id: ROOM, ...room });
		if (u.pathname === `/message-api/v2/teams/${TEAM}/rooms/${ROOM}/messages`) {
			const after = Number(u.searchParams.get("linkId") ?? 0);
			const list = u.searchParams.get("type") === "new" ? messages.filter(m => m.id > after) : messages.slice(-1);
			const records = list.map(m => ({ id: m.id, fromEntity: m.fromEntity, message: { content: { body: m.body } } }));
			return Response.json({ lastLinkId: messages.at(-1)?.id ?? 0, records: records.reverse() });
		}
		return new Response(null, { status: 404 });
	},
});
afterAll(() => jandi.stop(true));

let dir: string;
const cfg: SelfChatConfig = { enabled: true, team_id: TEAM, room_id: ROOM, member_id: ME, bot_id: BOT, keyword: "dotz", session_secret: "jandi-session", interval_ms: 1000 };
function make(received: string[], errors: (string | undefined)[] = []) {
	return createSelfChat(cfg, { dataDir: dir, api: `http://127.0.0.1:${jandi.port}/`, receive: t => received.push(t), log: () => {}, onError: e => errors.push(e) });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jandi-selfchat-"));
	mkdirSync(join(dir, "secrets"));
	mkdirSync(join(dir, "messengers"));
	writeFileSync(join(dir, "secrets", "jandi-session"), JSON.stringify({ refresh_token: "rt-1" }), { mode: 0o600 });
	setSecretKey(Buffer.alloc(32, 7));
	room = { type: "chat", companionId: BOT, members: [WEBHOOK_BOT, ME] };
	messages = [{ id: 1, fromEntity: ME, body: "dotz 예전 명령" }];
	calls = [];
	expireOnce = false;
	rotate = undefined;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("commandOf takes `dotz <text>` and `/dotz <text>` only, case-insensitively", () => {
	expect(commandOf("dotz 오늘 일정", "dotz")).toBe("오늘 일정");
	expect(commandOf("  /DOTZ  win Get-Date ", "dotz")).toBe("win Get-Date");
	expect(commandOf("dotz", "dotz")).toBeUndefined();
	expect(commandOf("dotzz 안녕", "dotz")).toBeUndefined();
	expect(commandOf("메모: dotz 안녕", "dotz")).toBeUndefined();
	expect(normalizeSelfChat({ keyword: "/땅콩", enabled: true })?.keyword).toBe("땅콩");
});

test("a room that is not the member's chat with the JANDI bot is refused before any message is read", async () => {
	room = { type: "topic", companionId: 0, members: [ME] };
	const got: string[] = [];
	await expect(make(got).tick()).rejects.toThrow("not this member's chat with the JANDI bot");
	expect(calls.some(c => c.includes("/messages"))).toBe(false);
	expect(got).toEqual([]);
});

test("starts after the newest message, hands on only the owner's keyword messages in order, and never twice across a restart", async () => {
	const got: string[] = [];
	const sc = make(got);
	await sc.tick();
	expect(got).toEqual([]); // history before the start is not replayed
	messages.push(
		{ id: 2, fromEntity: ME, body: "dotz 안녕" },
		{ id: 3, fromEntity: WEBHOOK_BOT, body: "dotz 웹훅이 올린 글" },
		{ id: 4, fromEntity: ME, body: "그냥 메모" },
		{ id: 5, fromEntity: ME, body: "/dotz win Get-Date" },
	);
	await sc.tick();
	expect(got).toEqual(["안녕", "win Get-Date"]);
	await sc.tick();
	expect(got).toEqual(["안녕", "win Get-Date"]);

	messages.push({ id: 6, fromEntity: ME, body: "dotz 재시작 뒤" });
	const again: string[] = [];
	await make(again).tick();
	expect(again).toEqual(["재시작 뒤"]);
});

test("an expired access token is refreshed once, and a rotated refresh token is stored sealed", async () => {
	rotate = "rt-2";
	const got: string[] = [];
	const sc = make(got);
	await sc.tick();
	expect(JSON.parse(readSecretFile(join(dir, "secrets", "jandi-session"))).refresh_token).toBe("rt-2");
	expireOnce = true;
	messages.push({ id: 2, fromEntity: ME, body: "dotz 다시" });
	await sc.tick();
	expect(got).toEqual(["다시"]);
	expect(calls.filter(c => c === "/inner-api/token").length).toBe(2);
});

test("a missing session secret is reported, not guessed around", async () => {
	rmSync(join(dir, "secrets", "jandi-session"));
	await expect(make([]).tick()).rejects.toThrow("no JANDI session");
	expect(calls).toEqual([]);
});
