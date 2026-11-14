import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_TOKEN } from "./config.ts";
import { msg } from "./i18n.ts";
import { setViewing } from "./notices-bell.ts";
import { shouldNotify } from "./push.ts";
import { createPeerChats, isOnline, linesOf, messageBody, ONLINE_MS, peerReplyPush, STATUS_FILE } from "./jandi-peers.ts";
import { SNAPSHOT_MARK, type Snapshot } from "./relay-snapshot.ts";
import { createSelfChat, normalizeSelfChat, type SelfChatConfig } from "./jandi-selfchat.ts";
import { get, register, RelayError, unregister } from "./messenger.ts";
import { loadJandiConfig, saveJandiConfig } from "./messenger-jandi.ts";
import { relayRoute, relayRows } from "./relay-route.ts";
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
let statusMessages: Msg[];
let statusMembers: number[];
const STATUS_ROOM = 200;
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
		if (u.pathname === `/room-api/v2/teams/${TEAM}/rooms/${STATUS_ROOM}`) return Response.json({ id: STATUS_ROOM, type: "privateGroup", members: statusMembers });
		if (u.pathname === `/message-api/v2/teams/${TEAM}/rooms/${STATUS_ROOM}/messages` && req.method === "GET")
			return Response.json({ records: statusMessages.map(m => ({ id: m.id, fromEntity: m.fromEntity, time: m.time, message: { content: { body: m.body } } })).reverse() });
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
	return { logs, chat: createPeerChats({ config: () => config ?? undefined, client: () => (withClient ? client : undefined), now: () => NOW, log: m => logs.push(m), dataDir: dir }) };
}
const ROW = { name: "work", url: "/#chat/relay:jandi:work", self: false, online: true, via: "jandi", key: "work", note: msg().relay.note };
// The relay endpoints as the web app calls them, through the messenger registry like hub/routes.ts does.
const call = (chat: ReturnType<typeof chats>["chat"], path: string, init?: RequestInit) => {
	register({ id: "jandi", relay: chat } as never);
	const url = new URL(`http://x${path}`);
	return relayRoute(new Request(url, init), url);
};
const send = (chat: ReturnType<typeof chats>["chat"], text: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
	call(chat, "/api/relay/jandi/work/send", { method: "POST", headers, body: JSON.stringify({ text }) });
const MSGS = "/api/relay/jandi/work/messages";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jandi-peers-"));
	mkdirSync(join(dir, "secrets"));
	writeFileSync(join(dir, "secrets", "jandi-session"), JSON.stringify({ refresh_token: "rt-secret" }), { mode: 0o600 });
	setSecretKey(Buffer.alloc(32, 7));
	roomType = "chat";
	failMessages = undefined;
	posted = [];
	statusMessages = [];
	statusMembers = [ME];
	messages = [
		{ id: 1, fromEntity: ME, body: "dotz 내 게이트웨이 명령", time: NOW - 5 * HOUR },
		{ id: 2, fromEntity: ME, body: "work 빌드 돌려", time: NOW - 3 * HOUR },
		{ id: 3, fromEntity: OTHER, body: "[work] 빌드 시작했어요", time: NOW - 2 * HOUR },
		{ id: 4, fromEntity: OTHER, body: "work 남이 쓴 글", time: NOW - HOUR },
		{ id: 5, fromEntity: ME, body: "그냥 메모", time: NOW - HOUR },
	];
});
// All test files share one process: the real adapter goes back in the registry.
const realJandi = get("jandi");
afterEach(() => {
	unregister("jandi");
	if (realJandi) register(realJandi);
	rmSync(dir, { recursive: true, force: true });
});

describe("self_chat.peers config", () => {
	test("a reply prefix that is this gateway's own or another peer's is dropped: its answers must not read as that computer's", () => {
		const peers = [{ keyword: "a", reply_prefix: "[home]" }, { keyword: "b", reply_prefix: "[b]" }, { keyword: "c", reply_prefix: "[b]" }];
		expect(normalizeSelfChat({ keyword: "dotz", reply_prefix: "[home]", peers })!.peers!.map(p => p.keyword)).toEqual(["b"]);
	});
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
			{ id: 1, fromEntity: ME, message: { content: { body: "work들 안녕" } } },
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

describe("the computer list", () => {
	test("one relay row per peer, whose address is its chat view in the app with the key percent-encoded", async () => {
		expect(await chats().chat.rows()).toEqual([ROW]);
		const rows = await chats({ ...cfg, peers: [{ name: "집", keyword: "집", reply_prefix: "[집]" }] }).chat.rows();
		expect(rows).toEqual([{ ...ROW, name: "집", url: "/#chat/relay:jandi:%EC%A7%91", key: "집", online: false }]);
	});

	test("the registered adapter's rows are what /api/peers appends after the Tailscale rows", async () => {
		register({ id: "jandi", relay: chats().chat } as never);
		expect(await relayRows()).toEqual([ROW]);
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
		expect(await afterWait()).toEqual([{ ...ROW, online: false }]);   // nothing known yet
		answer!({ records: [{ id: 1, fromEntity: OTHER, time: NOW - HOUR, message: { content: { body: "[work] 끝났어요" } } }] });
		expect((await chat.rows())[0]!.online).toBe(true);   // the read that outlived the wait lands
		t += 10_000;   // past the 2 s message cache: the next read goes to JANDI, which is slow again
		expect((await afterWait())[0]!.online).toBe(true);
	});
});

describe("the relay: lines and send", () => {
	test("lines are the filtered conversation", async () => {
		expect((await chats().chat.lines("work")).map(l => l.text)).toEqual(["빌드 돌려", "빌드 시작했어요"]);
	});

	test("send posts `<keyword> <text>` as the owner to the configured room", async () => {
		await chats().chat.send("work", "빌드 상태 알려줘");
		expect(posted).toHaveLength(1);
		expect(posted[0]!.path).toBe(`/message-api/v3/teams/${TEAM}/rooms/${ROOM}/messages`);
		expect(posted[0]!.auth).toBe("bearer at-secret");
		expect(posted[0]!.accept).toContain("jandi-v3");
		expect(posted[0]!.body).toEqual({ text: "work 빌드 상태 알려줘", richText: [{ type: "text_block", elements: [{ type: "text", body: "work 빌드 상태 알려줘", style: {} }] }] });
		expect(posted[0]!.body).toEqual(messageBody("work 빌드 상태 알려줘"));
	});

	test("a peer that is not configured is a 404, a JANDI failure a 502 with no token in it", async () => {
		const { chat, logs } = chats();
		const nobody = await chat.lines("nobody").catch((e: unknown) => e);
		expect([nobody instanceof RelayError, (nobody as RelayError).status]).toEqual([true, 404]);
		failMessages = 500;
		const failed = await chat.lines("work").catch((e: unknown) => e);
		expect([failed instanceof RelayError, (failed as RelayError).status]).toEqual([true, 502]);
		expect((failed as RelayError).message).toContain("HTTP 500");
		expect(`${(failed as RelayError).message}${logs.join("\n")}`).not.toMatch(/at-secret|rt-secret/);
	});

	test("a room that is not the owner's bot chat is refused before anything is read or sent", async () => {
		roomType = "topic";
		const { chat } = chats();
		expect(((await chat.lines("work").catch((e: unknown) => e)) as RelayError).status).toBe(502);
		expect(((await chat.send("work", "안녕").catch((e: unknown) => e)) as RelayError).status).toBe(502);
		expect(posted).toEqual([]);
	});

	test("without a JANDI session the chat answers an error", async () => {
		const failed = (await chats(cfg, false).chat.lines("work").catch((e: unknown) => e)) as RelayError;
		expect([failed.status, typeof failed.message]).toEqual([502, "string"]);
	});
});

describe("the relay endpoints", () => {
	test("messages lists the filtered conversation as JSON, and an unknown peer or adapter is a 404", async () => {
		const { chat } = chats();
		const res = (await call(chat, MSGS))!;
		expect(res.status).toBe(200);
		expect((await res.json()).map((l: { text: string }) => l.text)).toEqual(["빌드 돌려", "빌드 시작했어요"]);
		expect((await call(chat, "/api/relay/jandi/nobody/messages"))!.status).toBe(404);
		expect((await call(chat, "/api/relay/nope/work/messages"))!.status).toBe(404);
		expect(await call(chat, "/api/peers")).toBeUndefined();
	});

	test("a JANDI failure is a 502 with the reason, not an empty list, and carries no token", async () => {
		failMessages = 500;
		const { chat, logs } = chats();
		const res = (await call(chat, MSGS))!;
		const text = await res.text();
		expect(res.status).toBe(502);
		expect(JSON.parse(text).error).toContain("HTTP 500");
		expect(text + logs.join("\n")).not.toMatch(/at-secret|rt-secret/);
	});

	test("send trims the text and posts it as `<keyword> <text>`", async () => {
		const res = (await send(chats().chat, "  빌드 상태 알려줘 "))!;
		expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
		expect(posted.map(p => p.body.text)).toEqual(["work 빌드 상태 알려줘"]);
	});

	test("send refuses a non-JSON body (415), a huge body (413), empty or over-long text (400) and the wrong method (405), and posts nothing", async () => {
		const { chat } = chats();
		expect((await send(chat, "x", { "Content-Type": "text/plain" }))!.status).toBe(415);
		expect((await send(chat, "x".repeat(64 * 1024 + 1)))!.status).toBe(413);
		expect((await send(chat, ""))!.status).toBe(400);
		expect((await send(chat, "   "))!.status).toBe(400);
		expect((await send(chat, 42))!.status).toBe(400);
		expect((await send(chat, "가".repeat(4001)))!.status).toBe(400);
		expect((await call(chat, "/api/relay/jandi/work/send"))!.status).toBe(405);
		expect((await call(chat, MSGS, { method: "POST" }))!.status).toBe(405);
		expect(posted).toEqual([]);
		expect((await send(chat, "가".repeat(4000)))!.status).toBe(200);
	});

	test("the old chat page's address leads to the app's chat view, the key percent-encoded", async () => {
		const { chat } = chats();
		for (const [path, to] of [["/jandi-peer/work", "/#chat/relay:jandi:work"], ["/jandi-peer/%EC%A7%91/", "/#chat/relay:jandi:%EC%A7%91"], ["/jandi-peer/a%2Fb", "/#chat/relay:jandi:a%2Fb"]] as const) {
			const res = (await call(chat, path))!;
			expect([res.status, res.headers.get("location")]).toEqual([302, to]);
		}
		expect((await call(chat, "/jandi-peer/%E0%A4%A"))!.status).toBe(404);
		expect((await call(chat, "/jandi-peer/work", { method: "POST" }))!.status).toBe(405);
	});

	test("a room that is not the owner's bot chat is a 502 on both endpoints and posts nothing", async () => {
		roomType = "topic";
		const { chat } = chats();
		expect((await call(chat, MSGS))!.status).toBe(502);
		expect((await send(chat, "안녕"))!.status).toBe(502);
		expect(posted).toEqual([]);
	});
});

describe("a peer's new reply as a notification", () => {
	const peer = cfg.peers![0]!;
	test("a credential-shaped word never reaches the payload, and the rest carries no room or member id", () => {
		const m = peerReplyPush(peer, "키는 sk-abcdefghijklmnopqrstuvwxyz 예요", 9)!;
		expect(JSON.stringify(m)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
		expect(Object.keys(m).sort()).toEqual(["body", "kind", "tag", "title", "url"]);
		expect(JSON.stringify(m)).not.toContain(String(cfg.room_id));
	});
	test("nothing goes out while that computer's chat is on a screen, and it notifies again once the page is gone", () => {
		expect(peerReplyPush(peer, "[fail]", 10)).toMatchObject({ kind: "result", body: "❌" });
		const m = peerReplyPush(peer, "빌드 끝났어요", 11)!;
		expect(setViewing("tab-relay", `relay:jandi:${peer.keyword}`).ok).toBe(true);
		expect(shouldNotify(m, 1_000, undefined, () => true)).toBe(false);
		setViewing("tab-relay", "");
		expect(shouldNotify(m, 1_000, undefined, () => true)).toBe(true);
		expect(shouldNotify(m, 2_000, undefined, () => true)).toBe(false);   // the same post twice is one notification
	});
	test("a class switched off in the app's settings stays quiet", () => {
		expect(shouldNotify(peerReplyPush(peer, "빌드 끝났어요", 12)!, 1_000, () => false, () => false)).toBe(false);
	});
	test("the class follows the status marker: [ask] asks, [done] and [fail] are results, no marker is a message, [run] is silent", () => {
		const kind = (text: string) => peerReplyPush(peer, text, 1)?.kind;
		expect([kind("[ask] 배포할까요?"), kind("[done] 끝났어요"), kind("[fail] 실패했어요"), kind("빌드 시작했어요"), kind("[run] 도는 중")]).toEqual(["ask", "result", "result", "conv", undefined]);
		expect(peerReplyPush(peer, "[ask]", 1)).toBeUndefined();
	});

	test("it is titled with the computer, opens its chat view, and carries one tag per reply", () => {
		expect(peerReplyPush(peer, "빌드   끝났어요\n잘 됐어요", 7)).toEqual({ kind: "conv", title: "work", body: "빌드 끝났어요 잘 됐어요", url: "/#chat/relay:jandi:work", tag: "relay:jandi:work:7" });
		expect(peerReplyPush(peer, "빌드 끝났어요", 8)!.tag).not.toBe(peerReplyPush(peer, "빌드 끝났어요", 7)!.tag);
		expect(peerReplyPush({ ...peer, keyword: "집" }, "안녕", 1)!.url).toBe("/#chat/relay:jandi:%EC%A7%91");
	});

	test("the body is cut at 120 characters", () => {
		const body = peerReplyPush(peer, "가".repeat(200), 1)!.body;
		expect([body.length, body.endsWith("…")]).toEqual([120, true]);
		expect(peerReplyPush(peer, "가".repeat(120), 1)!.body).toBe("가".repeat(120));
	});
});

describe("status snapshots", () => {
	const snap = (at: number, name: string): Snapshot => ({ v: 1, at, projects: [{ key: `dir:~/${name}`, name, note: "메모" }], sessions: [], monitors: [], todos: { open: 0, items: [] }, notices: [] });
	const line = (id: number, prefix: string, s: Snapshot | string, time = NOW - HOUR): Msg => ({ id, fromEntity: OTHER, body: `${prefix} ${SNAPSHOT_MARK} ${typeof s === "string" ? s : JSON.stringify(s)}`, time });
	const STATUS = "/api/relay/jandi/work/status";
	const file = () => join(dir, "messengers", STATUS_FILE);

	test("snapshot lines never show as chat lines, malformed ones included", async () => {
		messages.push(line(6, "[work]", snap(1, "a")), line(7, "[work]", "{broken"));
		expect((await chats().chat.lines("work")).map(l => l.id)).toEqual([2, 3]);
		expect(linesOf(messages.map(m => ({ id: m.id, fromEntity: m.fromEntity, time: m.time, message: { content: { body: m.body } } })), ME, cfg.peers![0]!).map(l => l.id)).toEqual([2, 3]);
	});

	test("status is the newest decodable snapshot of that peer with its line's time; a newer malformed line and another peer's prefix do not count", async () => {
		messages.push(
			line(6, "[work]", snap(100, "old"), NOW - 3 * HOUR),
			line(7, "[work]", snap(200, "new"), NOW - 2 * HOUR),
			line(8, "[work]", "{broken", NOW - HOUR),
			line(9, "[other]", snap(300, "alien"), NOW - HOUR),
		);
		const { chat } = chats();
		expect(await chat.status("work")).toEqual({ snapshot: snap(200, "new"), received_at: NOW - 2 * HOUR });
		expect((await chat.rows())[0]!.status_at).toBe(NOW - 2 * HOUR);
	});

	test("with a status room the snapshot is read there, not from the self chat; a status room someone else is in is not read", async () => {
		const withRoom = { ...cfg, status_room_id: STATUS_ROOM };
		statusMessages = [{ ...line(50, "[work]", snap(7, "quiet")), fromEntity: ME }];
		expect(await chats(withRoom).chat.status("work")).toEqual({ snapshot: snap(7, "quiet"), received_at: NOW - HOUR });
		expect((await chats(withRoom).chat.lines("work")).map(l => l.id)).toEqual([2, 3]);
		rmSync(join(dir, "messengers"), { recursive: true, force: true });
		statusMembers = [ME, OTHER];
		const { chat, logs } = chats(withRoom);
		expect(await chat.status("work")).toEqual({ snapshot: null });
		expect(logs.join("\n")).toContain(`${STATUS_ROOM}`);
	});

	test("no snapshot yet: null, and the row has no status_at", async () => {
		const { chat } = chats();
		expect(await chat.status("work")).toEqual({ snapshot: null });
		expect(await chat.rows()).toEqual([ROW]);
	});

	test("the last snapshot outlives the room's messages and a restart; a newer line replaces it; JANDI out of reach still serves it", async () => {
		messages.push(line(6, "[work]", snap(1, "first"), NOW - 2 * HOUR));
		expect((await chats().chat.status("work")).snapshot).toEqual(snap(1, "first"));
		messages = messages.filter(m => !m.body.includes(SNAPSHOT_MARK));   // scrolled out of the last 100
		expect(await chats().chat.status("work")).toEqual({ snapshot: snap(1, "first"), received_at: NOW - 2 * HOUR });
		expect((await chats().chat.rows())[0]!.status_at).toBe(NOW - 2 * HOUR);
		messages.push(line(10, "[work]", snap(2, "second"), NOW - HOUR));
		expect((await chats().chat.status("work")).snapshot).toEqual(snap(2, "second"));
		failMessages = 500;
		expect((await chats().chat.status("work")).snapshot).toEqual(snap(2, "second"));
	});

	test("JANDI out of reach with nothing saved is an error, not an empty status", async () => {
		failMessages = 500;
		await expect(chats().chat.status("work")).rejects.toBeInstanceOf(RelayError);
	});

	test("a saved snapshot of a peer that is removed from the config is not served, and one under another reply prefix is not the new computer's", async () => {
		messages.push(line(6, "[work]", snap(1, "a")));
		await chats().chat.status("work");
		expect(Object.keys(JSON.parse(readFileSync(file(), "utf8")))).toEqual(["work"]);
		messages = [];
		await expect(chats({ ...cfg, peers: [{ name: "x", keyword: "x", reply_prefix: "[x]" }] }).chat.status("work")).rejects.toBeInstanceOf(RelayError);
		const renamed = { ...cfg, peers: [{ name: "work", keyword: "work", reply_prefix: "[pc2]" }] };
		expect(await chats(renamed).chat.status("work")).toEqual({ snapshot: null });
	});

	test("GET /status answers the snapshot JSON; other methods 405, an unknown peer or an adapter without status 404", async () => {
		messages.push(line(6, "[work]", snap(5, "a"), NOW - HOUR));
		const { chat } = chats();
		const ok = await call(chat, STATUS);
		expect(ok!.status).toBe(200);
		expect(await ok!.json()).toEqual({ snapshot: snap(5, "a"), received_at: NOW - HOUR });
		expect((await call(chat, STATUS, { method: "POST" }))!.status).toBe(405);
		expect((await call(chat, "/api/relay/jandi/nobody/status"))!.status).toBe(404);
		expect((await call(chat, "/api/relay/nope/work/status"))!.status).toBe(404);
		const { status: _s, ...noStatus } = chat;
		expect((await call(noStatus as never, STATUS))!.status).toBe(404);
	});
});

describe("the owner gate", () => {
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const call = (path: string, init: RequestInit = {}) => route(new Request(`http://mini.tailnet.ts.net${path}`, init));
	const paths: Array<[string, RequestInit, number]> = [
		["/jandi-peer/work", {}, 302],
		[MSGS, {}, 404],
		["/api/relay/jandi/work/status", {}, 404],
		["/api/relay/jandi/work/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "안녕" }) }, 404],
	];
	test("an unauthenticated request is refused on the old page and both endpoints", async () => {
		for (const [path, init] of paths) expect((await call(path, init)).status).toBe(403);
	});
	test("a request with the hub token passes the gate (the page leads on, and no peer is configured in this data dir, so the endpoints answer 404)", async () => {
		for (const [path, init, status] of paths) expect((await call(path, { ...init, headers: { ...(init.headers as object), "x-dotz-token": HUB_TOKEN } })).status).toBe(status);
	});
});
