import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_TOKEN } from "./config.ts";
import { createPeerChats, isOnline, linesOf, messageBody, ONLINE_MS, peerReplyPush } from "./jandi-peers.ts";
import { createSelfChat, normalizeSelfChat, type SelfChatConfig } from "./jandi-selfchat.ts";
import { loadJandiConfig, saveJandiConfig } from "./messenger-jandi.ts";
import type { Peer } from "./peers.ts";
import { makeRoute } from "./routes.ts";
import { advance } from "./runtime/test-clock.ts";
import { setSecretKey } from "./secretbox.ts";

const TEAM = 7;
const ROOM = 100;
const ME = 11;
const BOT = 22;
const OTHER = 33;
const NOW = Date.parse("2026-11-02T12:00:00Z");
const HOUR = 3600_000;

type Msg = { id: number; fromEntity: number; body: string; time?: number };
let messages: Msg[];
let roomType: string;
let failMessages: number | undefined;
let posted: Array<{ path: string; accept: string | null; auth: string | null; body: any }>;

const jandi = Bun.serve({
	port: 0,
	async fetch(req) {
		const u = new URL(req.url);
		if (u.pathname === "/inner-api/token") return Response.json({ access_token: "at-secret", expires_in: 43200 });
		if (req.headers.get("authorization") !== "bearer at-secret") return new Response(null, { status: 401 });
		if (u.pathname === `/room-api/v2/teams/${TEAM}/rooms/${ROOM}`) return Response.json({ id: ROOM, type: roomType, companionId: BOT, members: [ME, OTHER] });
		if (u.pathname === `/message-api/v2/teams/${TEAM}/rooms/${ROOM}/messages` && req.method === "GET") {
			if (failMessages) return new Response("internal", { status: failMessages });
			const records = messages.map(m => ({ id: m.id, fromEntity: m.fromEntity, time: m.time, message: { content: { body: m.body } } }));
			return Response.json({ lastLinkId: messages.at(-1)?.id ?? 0, records: records.reverse() });
		}
		if (u.pathname === `/message-api/v3/teams/${TEAM}/rooms/${ROOM}/messages` && req.method === "POST") {
			posted.push({ path: u.pathname, accept: req.headers.get("accept"), auth: req.headers.get("authorization"), body: await req.json() });
			return Response.json({ ok: true });
		}
		return new Response(null, { status: 404 });
	},
});
afterAll(() => jandi.stop(true));

const cfg: SelfChatConfig = {
	enabled: true,
	team_id: TEAM,
	room_id: ROOM,
	member_id: ME,
	bot_id: BOT,
	keyword: "dotz",
	reply_prefix: "",
	session_secret: "jandi-session",
	interval_ms: 1000,
	peers: [{ name: "work", keyword: "work", reply_prefix: "[work]" }],
};

let dir: string;
function chats(config: SelfChatConfig | null = cfg, withClient = true) {
	const client = createSelfChat(cfg, { dataDir: dir, api: `http://127.0.0.1:${jandi.port}/`, receive: () => {}, log: () => {}, onError: () => {} });
	const logs: string[] = [];
	return { logs, chat: createPeerChats({ config: () => config ?? undefined, client: () => (withClient ? client : undefined), now: () => NOW, log: m => logs.push(m) }) };
}
const get = (chat: ReturnType<typeof chats>["chat"], path: string) => chat.route(new Request(`http://x${path}`), new URL(`http://x${path}`));
const send = (chat: ReturnType<typeof chats>["chat"], text: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) => {
	const url = new URL("http://x/api/jandi-peer/work/send");
	return chat.route(new Request(url, { method: "POST", headers, body: JSON.stringify({ text }) }), url);
};
const MSGS = "/api/jandi-peer/work/messages";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jandi-peers-"));
	mkdirSync(join(dir, "secrets"));
	writeFileSync(join(dir, "secrets", "jandi-session"), JSON.stringify({ refresh_token: "rt-secret" }), { mode: 0o600 });
	setSecretKey(Buffer.alloc(32, 7));
	roomType = "chat";
	failMessages = undefined;
	posted = [];
	messages = [
		{ id: 1, fromEntity: ME, body: "dotz 내 게이트웨이 명령", time: NOW - 5 * HOUR },
		{ id: 2, fromEntity: ME, body: "work 빌드 돌려", time: NOW - 3 * HOUR },
		{ id: 3, fromEntity: OTHER, body: "[work] 빌드 시작했어요", time: NOW - 2 * HOUR },
		{ id: 4, fromEntity: OTHER, body: "work 남이 쓴 글", time: NOW - HOUR },
		{ id: 5, fromEntity: ME, body: "그냥 메모", time: NOW - HOUR },
	];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("self_chat.peers config", () => {
	const base = { enabled: true, keyword: "dotz" };
	test("keeps valid peers and drops the rest: own keyword, repeats, bad keyword or prefix, more than 8", () => {
		const peers = normalizeSelfChat({
			...base,
			peers: [
				{ name: "work", keyword: "/work", reply_prefix: " [work] " },
				{ keyword: "dotz", reply_prefix: "[x]" },
				{ keyword: "DOTZ", reply_prefix: "[x]" },
				{ keyword: "work", reply_prefix: "[또]" },
				{ keyword: "두 단어", reply_prefix: "[x]" },
				{ keyword: "a".repeat(31), reply_prefix: "[x]" },
				{ keyword: "빈접두", reply_prefix: "  " },
				{ keyword: "긴접두", reply_prefix: "x".repeat(31) },
				{ keyword: 7, reply_prefix: "[x]" },
				null,
				{ keyword: "집", reply_prefix: "[집]" },
			],
		})?.peers;
		expect(peers).toEqual([
			{ name: "work", keyword: "work", reply_prefix: "[work]" },
			{ name: "집", keyword: "집", reply_prefix: "[집]" },
		]);
		const many = Array.from({ length: 12 }, (_, i) => ({ keyword: `pc${i}`, reply_prefix: `[${i}]` }));
		expect(normalizeSelfChat({ ...base, peers: many })?.peers?.map(p => p.keyword)).toEqual(many.slice(0, 8).map(p => p.keyword));
	});

	test("a config without peers stays as before", () => {
		expect(normalizeSelfChat({ ...base, peers: [] })).not.toHaveProperty("peers");
		expect(normalizeSelfChat({ ...base })).not.toHaveProperty("peers");
	});

	test("survives save and load of jandi.json", () => {
		saveJandiConfig({ enabled: false, listen: { host: "0.0.0.0", port: 0 }, allow_emails: [], rooms: [], self_chat: cfg }, dir);
		expect(loadJandiConfig(dir).self_chat?.peers).toEqual(cfg.peers);
	});
});

describe("the conversation with one peer", () => {
	test("keeps only the owner's keyword lines and the peer's replies, oldest first", () => {
		const recs = [...messages].reverse().map(m => ({ id: m.id, fromEntity: m.fromEntity, time: m.time, message: { content: { body: m.body } } }));
		expect(linesOf(recs, ME, cfg.peers![0]!)).toEqual([
			{ id: 2, at: NOW - 3 * HOUR, me: true, text: "빌드 돌려" },
			{ id: 3, at: NOW - 2 * HOUR, me: false, text: "빌드 시작했어요" },
		]);
	});

	test("a word that only starts with the keyword or prefix is not part of it", () => {
		const recs = [
			{ id: 1, fromEntity: ME, message: { content: { body: "work아 안녕" } } },
			{ id: 2, fromEntity: OTHER, message: { content: { body: "[work]네" } } },
			{ id: 3, fromEntity: OTHER, message: { content: { body: "[work]" } } },
		];
		expect(linesOf(recs, ME, cfg.peers![0]!)).toEqual([]);
	});

	test("online means a reply within the last 24 hours", () => {
		const reply = (ago: number) => [{ id: 1, at: NOW - ago, me: false, text: "x" }];
		expect(isOnline(reply(ONLINE_MS - 1), NOW)).toBe(true);
		expect(isOnline(reply(ONLINE_MS + 1), NOW)).toBe(false);
		expect(isOnline([{ id: 1, at: NOW - HOUR, me: true, text: "x" }], NOW)).toBe(false);
		expect(isOnline([{ id: 1, at: 0, me: false, text: "x" }], NOW)).toBe(false);
	});
});

describe("a peer's new reply as a phone notification", () => {
	const peer = { name: "회사", keyword: "work", reply_prefix: "[종놈]" };
	test("titled with the peer, the reply as the body, a tap opens the peer's conversation, one per reply", () => {
		expect(peerReplyPush(peer, "빌드  끝났어요\n다음 할 일?", 41)).toEqual({ kind: "conv", title: "회사", body: "빌드 끝났어요 다음 할 일?", url: "/jandi-peer/work", tag: "jandi-peer:work:41" });
		const long = peerReplyPush(peer, "가".repeat(300), 42)!;
		expect(long.body.length).toBe(120);
		expect(long.body.endsWith("…")).toBe(true);
	});
	test("its status marker picks the gateway's own class: [ask] asks, [done]/[fail] a result, [run] stays quiet", () => {
		expect(peerReplyPush(peer, "[ask] 배포할까요?", 1)).toMatchObject({ kind: "ask", body: "배포할까요?" });
		expect(peerReplyPush(peer, "[done] 배포 끝", 2)).toMatchObject({ kind: "result", body: "배포 끝" });
		expect(peerReplyPush(peer, "[fail] 빌드 실패", 3)).toMatchObject({ kind: "result", body: "빌드 실패" });
		expect(peerReplyPush(peer, "[run] 빌드 중", 4)).toBeUndefined();
	});
	test("notify: false is kept by the config; any other value notifies (the default)", () => {
		const peers = normalizeSelfChat({ enabled: true, peers: [{ keyword: "a", reply_prefix: "[a]", notify: false }, { keyword: "b", reply_prefix: "[b]", notify: "no" }] })?.peers;
		expect(peers?.map(p => p.notify)).toEqual([false, undefined]);
	});
});

describe("the computer list", () => {
	test("appends one JANDI row per peer after the Tailscale rows, which stay as they are", async () => {
		const tailscale: Peer[] = [
			{ name: "맥북", url: "https://mac:8443", self: true, online: true },
			{ name: "맥미니", url: "https://mini:8445", self: false, online: true, unread: 2, need: 1 },
		];
		const before = JSON.stringify(tailscale);
		const list = await chats().chat.append(tailscale);
		expect(list.slice(0, 2)).toEqual(tailscale);
		expect(JSON.stringify(tailscale)).toBe(before);
		expect(list.slice(2)).toEqual([{ name: "work", url: "/jandi-peer/work", self: false, online: true, via: "jandi" }]);
	});

	test("offline when the last reply is older than 24 hours, when JANDI fails, and when the room is not the owner's bot chat", async () => {
		messages[2]!.time = NOW - 25 * HOUR;
		expect((await chats().chat.rows())[0]!.online).toBe(false);
		messages[2]!.time = NOW - HOUR;
		failMessages = 500;
		expect((await chats().chat.rows())[0]).toMatchObject({ online: false, via: "jandi" });
		failMessages = undefined;
		roomType = "topic";
		expect((await chats().chat.rows())[0]!.online).toBe(false);
	});

	test("no rows without peers, with polling off, or with the room unset", async () => {
		expect(await chats({ ...cfg, peers: undefined }).chat.rows()).toEqual([]);
		expect(await chats({ ...cfg, enabled: false }).chat.rows()).toEqual([]);
		expect(await chats({ ...cfg, room_id: 0 }).chat.rows()).toEqual([]);
		expect(await chats(null).chat.rows()).toEqual([]);
	});

	test("a slow JANDI does not hold up the list: the rows come after the short wait, from the last known messages", async () => {
		let t = NOW;
		let answer: ((v: unknown) => void) | undefined;
		const client = { checkRoom: async () => {}, post: async () => ({}), get: () => new Promise(res => { answer = res; }) };
		const chat = createPeerChats({ config: () => cfg, client: () => client as never, now: () => t, listWaitMs: 20 });
		const afterWait = async () => {
			const rows = chat.rows();
			await advance(20);   // the test clock: only the short wait passes, JANDI never answers within it
			return rows;
		};
		expect(await afterWait()).toEqual([{ name: "work", url: "/jandi-peer/work", self: false, online: false, via: "jandi" }]);   // nothing known yet
		answer!({ records: [{ id: 1, fromEntity: OTHER, time: NOW - HOUR, message: { content: { body: "[work] 끝났어요" } } }] });
		expect((await chat.rows())[0]!.online).toBe(true);   // the read that outlived the wait lands
		t += 10_000;   // past the 2 s message cache: the next read goes to JANDI, which is slow again
		expect((await afterWait())[0]!.online).toBe(true);
	});
});

describe("the chat routes", () => {
	test("messages lists the filtered conversation as JSON", async () => {
		const res = (await get(chats().chat, MSGS))!;
		expect(res.status).toBe(200);
		expect((await res.json()).map((l: { text: string }) => l.text)).toEqual(["빌드 돌려", "빌드 시작했어요"]);
	});

	test("the page is served for a configured peer, and an unknown peer or other path is not", async () => {
		const { chat } = chats();
		const page = (await get(chat, "/jandi-peer/work"))!;
		expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
		expect(await page.text()).toContain("/api/jandi-peer/work");
		expect((await get(chat, "/jandi-peer/nobody"))!.status).toBe(404);
		expect((await get(chat, "/api/jandi-peer/nobody/messages"))!.status).toBe(404);
		expect(await get(chat, "/api/peers")).toBeUndefined();
	});

	test("send posts `<keyword> <text>` as the owner to the configured room", async () => {
		const res = (await send(chats().chat, "  빌드 상태 알려줘 "))!;
		expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
		expect(posted).toHaveLength(1);
		expect(posted[0]!.path).toBe(`/message-api/v3/teams/${TEAM}/rooms/${ROOM}/messages`);
		expect(posted[0]!.auth).toBe("bearer at-secret");
		expect(posted[0]!.accept).toContain("jandi-v3");
		expect(posted[0]!.body).toEqual({ text: "work 빌드 상태 알려줘", richText: [{ type: "text_block", elements: [{ type: "text", body: "work 빌드 상태 알려줘", style: {} }] }] });
		expect(posted[0]!.body).toEqual(messageBody("work 빌드 상태 알려줘"));
	});

	test("send refuses empty or over-long text, a non-JSON body and the wrong method, and posts nothing", async () => {
		const { chat } = chats();
		expect((await send(chat, ""))!.status).toBe(400);
		expect((await send(chat, "   "))!.status).toBe(400);
		expect((await send(chat, 42))!.status).toBe(400);
		expect((await send(chat, "가".repeat(4001)))!.status).toBe(400);
		expect((await send(chat, "x", { "Content-Type": "text/plain" }))!.status).toBe(415);
		expect((await get(chat, "/api/jandi-peer/work/send"))!.status).toBe(405);
		expect(posted).toEqual([]);
		expect((await send(chat, "가".repeat(4000)))!.status).toBe(200);
	});

	test("a JANDI failure is an error, not an empty list, and carries no token", async () => {
		failMessages = 500;
		const { chat, logs } = chats();
		const res = (await get(chat, MSGS))!;
		const text = await res.text();
		expect(res.status).toBe(502);
		expect(JSON.parse(text).error).toContain("HTTP 500");
		expect(text + logs.join("\n")).not.toMatch(/at-secret|rt-secret/);
	});

	test("a room that is not the owner's bot chat is refused before anything is read or sent", async () => {
		roomType = "topic";
		const { chat } = chats();
		expect((await get(chat, MSGS))!.status).toBe(502);
		expect((await send(chat, "안녕"))!.status).toBe(502);
		expect(posted).toEqual([]);
	});

	test("without a JANDI session the routes answer an error", async () => {
		const res = (await get(chats(cfg, false).chat, MSGS))!;
		expect([res.status, typeof (await res.json()).error]).toEqual([502, "string"]);
	});
});

describe("the owner gate", () => {
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const call = (path: string, init: RequestInit = {}) => route(new Request(`http://mini.tailnet.ts.net${path}`, init));
	const paths: Array<[string, RequestInit]> = [
		["/jandi-peer/work", {}],
		[MSGS, {}],
		["/api/jandi-peer/work/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "안녕" }) }],
	];
	test("an unauthenticated request is refused on the page and both endpoints", async () => {
		for (const [path, init] of paths) expect((await call(path, init)).status).toBe(403);
	});
	test("a request with the hub token passes the gate (no peer is configured in this data dir, so 404)", async () => {
		for (const [path, init] of paths) expect((await call(path, { ...init, headers: { ...(init.headers as object), "x-dotz-token": HUB_TOKEN } })).status).toBe(404);
	});
});
