import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { sqliteDb } from "./db.ts";
import { MAX_CHAT_CHARS, MAX_PAIRS, MAX_PROMPT_CHARS, type ModelReply } from "./draft.ts";
import { addMessage, BASE_LOG, BASE_TIME, bplistOfInts, makeFixtureDb, OWNER, ROOM } from "./fixture.ts";
import { createDraft, listDrafts } from "./send.ts";
import { type KakaoConfig, kakaoPaths, type Runner } from "./types.ts";
import { fakeScreen } from "./ui.fixture.ts";
import { createKakaoWeb, type WebDeps } from "./web.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const id = (n: number) => String(BASE_LOG + BigInt(n));
const DIRECT = String(ROOM.direct);
const GROUP = String(ROOM.group);

let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kakao-web-"));
	paths = kakaoPaths(dir, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(config: Partial<KakaoConfig> = {}, fill?: (w: Database) => void, extra: Partial<WebDeps> = {}) {
	const dbPath = join(dir, "k.sqlite");
	const fixture = makeFixtureDb(dbPath);
	fill?.(fixture);
	fixture.close();
	const full: KakaoConfig = { enabled: true, dbPath, userId: OWNER, watch_chats: [DIRECT], ...config };
	mkdirSync(dirname(paths.config), { recursive: true });
	writeFileSync(paths.config, JSON.stringify(full));
	const events: Record<string, unknown>[] = [];
	const state = { failSend: false, changes: 0, leaseRefusal: undefined as string | undefined };
	const fetched: { url: string; init: RequestInit | undefined }[] = [];
	const upstream = { reply: (_url: string): Response | Promise<Response> => new Response("no upstream", { status: 500 }) };
	const model = {
		calls: [] as { system: string; user: string }[],
		reply: async (): Promise<ModelReply> => ({ text: JSON.stringify({ action: "draft", body: "내일 좋아", summary: "점심 약속을 잡는 중" }), inputTokens: 1200, outputTokens: 30 }),
	};
	const screen = fakeScreen([{ id: "chat_alex", title: "Alex", window: { title: "Alex" } }], { axSend: () => (state.failSend ? { ok: false, why: "busy" } : { ok: true }) });
	const runner: Runner = screen.runner;
	const calls = screen.sends;
	const db = sqliteDb(dbPath);
	const web = createKakaoWeb({ paths, runner, now: () => NOW, openDb: async () => db, broadcast: e => events.push(e), onWatchChange: () => void state.changes++, collector: "mac-a", lease: async () => (state.leaseRefusal ? { ok: false, reason: state.leaseRefusal } : { ok: true }), draftModel: async (system, user) => (model.calls.push({ system, user }), model.reply()), fetch: (async (input: unknown, init?: RequestInit) => (fetched.push({ url: String(input), init }), upstream.reply(String(input)))) as unknown as typeof fetch, ...extra });
	const call = async (method: string, path: string, body?: unknown) => {
		const url = new URL(`http://local${path}`);
		const res = await web.route(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, url.pathname.split("/").filter(Boolean));
		return { status: res!.status, json: (await res!.json()) as any };
	};
	const raw = (method: string, path: string) => {
		const url = new URL(`http://local${path}`);
		return web.route(new Request(url, { method }), url, url.pathname.split("/").filter(Boolean)) as Promise<Response>;
	};
	const draft = (over: Partial<{ chatId: string; text: string; basisLogId: string }> = {}) =>
		createDraft({ chatId: DIRECT, roomName: "Alex", text: "see you", basisLogId: id(3), ...over }, { paths, runner, now: () => NOW });
	const config$ = () => JSON.parse(readFileSync(paths.config, "utf8")) as KakaoConfig;
	return { web, call, raw, fetched, upstream, events, calls, state, model, draft, config$, close: () => db.close() };
}

describe("rooms", () => {
	test("lists direct and group rooms with the watched flag; toggling persists to the config and broadcasts", async () => {
		const t = setup();
		const list = await t.call("GET", "/api/kakao/rooms");
		expect(list.json.on).toBe(true);
		expect(list.json.rooms.map((r: any) => [r.chatId, r.name, r.kind, r.watched, r.autoDraft])).toEqual([
			[String(ROOM.excluded), "Quiet Group", "group", false, false],
			[String(ROOM.self), "나와의 채팅", "self", false, false],
			[GROUP, "Study Group", "group", false, false],
			[DIRECT, "Alex", "direct", true, false],
		]);
		expect(list.json.rooms.some((r: any) => r.chatId === String(ROOM.channel))).toBe(false);
		expect(list.json.rooms.every((r: any) => Number.isFinite(r.lastAt) && r.lastAt > 1e11)).toBe(true);

		const on = await t.call("PUT", `/api/kakao/rooms/${GROUP}`, { watched: true });
		expect(on).toEqual({ status: 200, json: { ok: true, watched: [DIRECT, GROUP], autoDraft: [] } });
		expect(t.config$().watch_chats).toEqual([DIRECT, GROUP]);
		expect(t.config$().enabled).toBe(true);
		expect(t.events).toEqual([{ kind: "kakao_rooms" }]);
		expect(t.state.changes).toBe(1);
		expect((await t.call("GET", "/api/kakao/rooms")).json.rooms.find((r: any) => r.chatId === GROUP).watched).toBe(true);

		const off = await t.call("PUT", `/api/kakao/rooms/${DIRECT}`, { watched: false });
		expect(off.json.watched).toEqual([GROUP]);
		expect(t.config$().watch_chats).toEqual([GROUP]);
		expect((await t.call("PUT", "/api/kakao/rooms/not-a-number", { watched: true })).status).toBe(400);
		expect((await t.call("PUT", `/api/kakao/rooms/${GROUP}`, { watched: "yes" })).status).toBe(400);
		t.close();
	});

	test("a database that cannot be read gives a plain error line and no rooms", async () => {
		const t = setup();
		const url = new URL("http://local/api/kakao/rooms");
		const broken = createKakaoWeb({ paths, runner: async () => ({ code: 0, stdout: "", stderr: "" }), now: () => NOW, openDb: async () => Promise.reject(new Error("no key")), broadcast: () => {} });
		const res = await broken.route(new Request(url), url, ["api", "kakao", "rooms"]);
		const json = (await res!.json()) as any;
		expect(json.on).toBe(true);
		expect(json.rooms).toEqual([]);
		expect(typeof json.error).toBe("string");
		t.close();
	});

	test("with the integration off the list is empty and nothing else is served", async () => {
		const t = setup({ enabled: false });
		expect((await t.call("GET", "/api/kakao/rooms")).json).toEqual({ on: false, rooms: [] });
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).status).toBe(409);
		expect((await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "hi" })).status).toBe(409);
		expect((await t.call("PUT", `/api/kakao/rooms/${DIRECT}`, { watched: true })).status).toBe(409);
		expect(t.calls).toEqual([]);
		t.close();
	});
});

describe("chat", () => {
	test("a room that is not watched is refused (403) for reading, read marks and sends", async () => {
		const t = setup();
		for (const [method, path, body] of [
			["GET", `/api/kakao/chat/${GROUP}`, undefined],
			["POST", `/api/kakao/chat/${GROUP}/read`, { logId: id(5) }],
			["POST", `/api/kakao/chat/${GROUP}/send`, { text: "hi" }],
		] as const) {
			const r = await t.call(method, path, body);
			expect(r.status).toBe(403);
			expect(typeof r.json.error).toBe("string");
		}
		expect(t.calls).toEqual([]);
		expect(t.events).toEqual([]);
		t.close();
	});

	test("a watched room: messages oldest first with paging, read position moves forward only, bodies only for text", async () => {
		const t = setup();
		const r = await t.call("GET", `/api/kakao/chat/${DIRECT}`);
		expect(r.status).toBe(200);
		expect(r.json.room).toEqual({ chatId: DIRECT, name: "Alex", kind: "direct", group: false });
		expect(r.json.messages.map((m: any) => m.logId)).toEqual([id(1), id(2), id(3), id(4)]);
		expect(r.json.messages[1]).toMatchObject({ authorId: String(OWNER), fromMe: true, text: "hi, how are you", type: 1 });
		expect(r.json.messages[0]).toMatchObject({ sender: "Alex", fromMe: false, id: `k:${DIRECT}:${id(1)}`, collector: "mac-a" });
		expect(r.json.messages[3]).toMatchObject({ type: 2, text: "" });
		expect(r.json.read).toBeNull();
		expect(r.json.kakaoUnread).toBe(1);
		expect(r.json.drafts).toEqual([]);
		expect(r.json.sends).toEqual([]);
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}?limit=2`)).json.messages.map((m: any) => m.logId)).toEqual([id(3), id(4)]);
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}?before=${id(3)}`)).json.messages.map((m: any) => m.logId)).toEqual([id(1), id(2)]);
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}?after=${id(2)}`)).json.messages.map((m: any) => m.logId)).toEqual([id(3), id(4)]);
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}?after=abc`)).status).toBe(400);

		expect((await t.call("POST", `/api/kakao/chat/${DIRECT}/read`, { logId: id(3) })).json).toEqual({ ok: true });
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.read).toBe(id(3));
		await t.call("POST", `/api/kakao/chat/${DIRECT}/read`, { logId: id(2) });
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.read).toBe(id(3));
		expect((await t.call("POST", `/api/kakao/chat/${DIRECT}/read`, { logId: "x" })).status).toBe(400);
		expect(statSync(join(dir, "kakao", "reads.json")).mode & 0o777).toBe(0o600);
		t.close();
	});
});

describe("read counters", () => {
	const marks = (members: [number, number][]) => (w: Database) =>
		w.query("UPDATE NTChatRoom SET watermarkKeys = ?, watermarkValues = ? WHERE chatId = ?").run(bplistOfInts(members.map(m => m[0])), bplistOfInts(members.map(m => id(m[1]))), BigInt(ROOM.direct));
	// Alex (2001) wrote ids 1, 3, 4 and the owner id 2; Alex has read up to 1, Sam (2002) up to 3, a third member (2003) up to nothing.
	const MEMBERS: [number, number][] = [[OWNER, 4], [2001, 1], [2002, 3], [2003, 0]];

	test("each message carries unread: members other than the author and the owner who have not read it; 0 without watermarks", async () => {
		const t = setup({}, marks(MEMBERS));
		const r = await t.call("GET", `/api/kakao/chat/${DIRECT}`);
		expect(r.json.messages.map((m: any) => [m.logId, m.unread])).toEqual([[id(1), 1], [id(2), 2], [id(3), 1], [id(4), 2]]);
		t.close();
	});

	test("a room without readable watermarks shows 0 on every message", async () => {
		const plain = setup();
		expect((await plain.call("GET", `/api/kakao/chat/${DIRECT}`)).json.messages.map((m: any) => m.unread)).toEqual([0, 0, 0, 0]);
		plain.close();
	});

	test("/reads?from= answers counters only (no bodies) for messages from that logId on, and follows new read positions", async () => {
		const t = setup({}, marks(MEMBERS));
		const all = await t.call("GET", `/api/kakao/chat/${DIRECT}/reads?from=${id(1)}`);
		expect(all).toEqual({ status: 200, json: { counts: { [id(1)]: 1, [id(2)]: 2, [id(3)]: 1, [id(4)]: 2 } } });
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}/reads?from=${id(3)}`)).json).toEqual({ counts: { [id(3)]: 1, [id(4)]: 2 } });
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}/reads?from=${id(99)}`)).json).toEqual({ counts: {} });
		expect(JSON.stringify(all.json)).not.toContain("hello");
		const w = new (await import("bun:sqlite")).Database(join(dir, "k.sqlite"));
		marks([[OWNER, 4], [2001, 4], [2002, 4], [2003, 4]])(w);
		w.close();
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}/reads?from=${id(1)}`)).json.counts).toEqual({ [id(1)]: 0, [id(2)]: 0, [id(3)]: 0, [id(4)]: 0 });
		t.close();
	});

	test("/reads refuses an unwatched room (403), a missing or bad from (400), and an off integration (409)", async () => {
		const t = setup();
		expect((await t.call("GET", `/api/kakao/chat/${GROUP}/reads?from=1`)).status).toBe(403);
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}/reads`)).status).toBe(400);
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}/reads?from=abc`)).status).toBe(400);
		t.close();
	});

	test("/reads is off with the integration off (409)", async () => {
		const off = setup({ enabled: false });
		expect((await off.call("GET", `/api/kakao/chat/${DIRECT}/reads?from=1`)).status).toBe(409);
		off.close();
	});
});

describe("typed send", () => {
	test("goes through the stubbed screen without an approval step: sending -> sent, then listed in the room's sends", async () => {
		const t = setup();
		const r = await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "hello there" });
		expect(r.status).toBe(202);
		expect(r.json.state).toBe("sending");
		await t.web.idle();
		expect(t.events.map(e => [e.kind, e.id, e.state])).toEqual([["kakao_send", r.json.id, "sending"], ["kakao_send", r.json.id, "sent"]]);
		expect(t.calls).toEqual([["ax-send", "Alex", "hello there"]]);
		const sends = (await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.sends;
		expect(sends).toEqual([{ id: r.json.id, text: "hello there", state: "sent", at: NOW, collector: "mac-a" }]);
		expect(statSync(join(dir, "kakao", "sends.json")).mode & 0o777).toBe(0o600);
		expect(JSON.stringify(t.events)).not.toContain("hello there");
		expect(JSON.stringify(t.events)).not.toContain("Alex");
		t.close();
	});

	test("a failed send is recorded as failed with a reason and announced", async () => {
		const t = setup();
		t.state.failSend = true;
		const r = await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "hello there" });
		await t.web.idle();
		const last = t.events.at(-1)!;
		expect(last).toMatchObject({ kind: "kakao_send", chatId: DIRECT, id: r.json.id, state: "failed" });
		expect(typeof last.reason).toBe("string");
		const sends = (await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.sends;
		expect(sends[0]).toMatchObject({ id: r.json.id, state: "failed", reason: last.reason });
		t.close();
	});

	test("deleting a failed send removes it from the room and the store, announces it once, and never retries it", async () => {
		const t = setup();
		t.state.failSend = true;
		const r = await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "hello there" });
		await t.web.idle();
		// One failure is one event (no repeat per poll or read of the room).
		await t.call("GET", `/api/kakao/chat/${DIRECT}`);
		await t.call("GET", `/api/kakao/chat/${DIRECT}`);
		expect(t.events.filter(e => e.kind === "kakao_send" && e.state === "failed")).toHaveLength(1);
		const tries = t.calls.length;

		expect(await t.call("DELETE", `/api/kakao/chat/${DIRECT}/send/${r.json.id}`)).toEqual({ status: 200, json: { ok: true, removed: true } });
		expect(t.events.at(-1)).toEqual({ kind: "kakao_send", chatId: DIRECT, id: r.json.id, state: "deleted" });
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.sends).toEqual([]);
		expect(JSON.parse(readFileSync(join(dir, "kakao", "sends.json"), "utf8"))).toEqual([]);
		// Deleting again is a no-op, and nothing was sent again.
		expect((await t.call("DELETE", `/api/kakao/chat/${DIRECT}/send/${r.json.id}`)).json).toEqual({ ok: true, removed: false });
		await t.web.idle();
		expect(t.calls.length).toBe(tries);
		t.close();
	});

	test("watchdog: a send still sending after 60 s is failed, announced and kept as failed in the store", async () => {
		let clock = NOW;
		const timers: { fn: () => void; ms: number }[] = [];
		let release!: () => void;
		const hold = new Promise<void>(r => (release = r));
		const screen = fakeScreen([{ id: "chat_alex", title: "Alex", window: { title: "Alex" } }]);
		const runner: Runner = async (argv, o) => {
			if (argv[1] === "-l" && JSON.parse(o!.stdin!.trim()).action === "rows") await hold;
			return screen.runner(argv, o);
		};
		const t = setup({}, undefined, { runner, now: () => clock, later: (fn, ms) => void timers.push({ fn, ms }) });
		const r = await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "hello there" });
		expect(timers.map(x => x.ms)).toEqual([60_000]);
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.sends[0].state).toBe("sending");
		clock = NOW + 61_000;
		timers[0]!.fn();
		expect(t.events.at(-1)).toMatchObject({ kind: "kakao_send", id: r.json.id, state: "failed" });
		expect(typeof t.events.at(-1)!.reason).toBe("string");
		expect(JSON.parse(readFileSync(join(dir, "kakao", "sends.json"), "utf8"))[0]).toMatchObject({ id: r.json.id, state: "failed" });
		const failedEvents = t.events.filter(e => e.state === "failed").length;
		timers[0]!.fn();
		expect(t.events.filter(e => e.state === "failed")).toHaveLength(failedEvents);
		release();
		await t.web.idle();
		t.close();
	});

	test("a send older than 60 s that is still sending is listed as failed even when no timer ran", async () => {
		const t = setup();
		const file = join(dir, "kakao", "sends.json");
		const probe = await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "x" });
		await t.web.idle();
		writeFileSync(file, JSON.stringify([{ id: "Sold", chatId: DIRECT, text: "old", state: "sending", at: NOW - 61_000 }]));
		const list = (await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.sends;
		expect(list.map((s: any) => [s.id, s.state])).toEqual([["Sold", "failed"]]);
		expect(probe.status).toBe(202);
		t.close();
	});

	test("a lost send (gateway restarted) can be deleted; a sent one or another room's id cannot", async () => {
		const t = setup();
		const ok = await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "done" });
		await t.web.idle();
		const file = join(dir, "kakao", "sends.json");
		const stored = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify([...stored, { id: "Slost", chatId: DIRECT, text: "lost", state: "sending", at: NOW }, { id: "Sother", chatId: GROUP, text: "x", state: "failed", at: NOW }]));
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.sends.map((s: any) => [s.id, s.state])).toEqual([[ok.json.id, "sent"], ["Slost", "failed"]]);
		expect((await t.call("DELETE", `/api/kakao/chat/${DIRECT}/send/${ok.json.id}`)).status).toBe(409);
		expect((await t.call("DELETE", `/api/kakao/chat/${DIRECT}/send/Slost`)).json.removed).toBe(true);
		expect((await t.call("DELETE", `/api/kakao/chat/${DIRECT}/send/Sother`)).json.removed).toBe(false);
		expect(JSON.parse(readFileSync(file, "utf8")).map((s: any) => s.id)).toEqual([ok.json.id, "Sother"]);
		t.close();
	});

	test("an empty or oversize text is refused before anything runs", async () => {
		const t = setup();
		expect((await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "   " })).status).toBe(400);
		expect((await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "가".repeat(1001) })).status).toBe(400);
		await t.web.idle();
		expect(t.calls).toEqual([]);
		expect(t.events).toEqual([]);
		t.close();
	});
});

describe("drafts", () => {
	test("the click is the approval: a pending draft is sent with no inbox answer, and listed in the room until then", async () => {
		const t = setup();
		const d = await t.draft();
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.drafts).toEqual([{ code: d.code, text: "see you", basisLogId: id(3), created: d.created }]);
		const r = await t.call("POST", `/api/kakao/drafts/${d.code}/send`, {});
		expect(r.status).toBe(202);
		await t.web.idle();
		expect(t.calls.at(-1)).toEqual(["ax-send", "Alex", "see you"]);
		expect((await listDrafts({ paths, runner: async () => ({ code: 0, stdout: "", stderr: "" }) }))[0]!.status).toBe("sent");
		expect(t.events.map(e => e.kind)).toEqual(["kakao_send", "kakao_send", "kakao_draft"]);
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.drafts).toEqual([]);
		expect((await t.call("POST", `/api/kakao/drafts/${d.code}/send`, {})).status).toBe(409);
		t.close();
	});

	test("an edited text is sent instead of the draft's", async () => {
		const t = setup();
		const d = await t.draft();
		const r = await t.call("POST", `/api/kakao/drafts/${d.code}/send`, { text: "고친 글" });
		expect(r.status).toBe(202);
		await t.web.idle();
		expect(t.calls.at(-1)).toEqual(["ax-send", "Alex", "고친 글"]);
		expect((await t.call("POST", `/api/kakao/drafts/${(await t.draft()).code}/send`, { text: "  " })).status).toBe(400);
		t.close();
	});

	test("a draft that a newer incoming message made stale is refused (409) and nothing is sent", async () => {
		const t = setup();
		const d = await t.draft({ basisLogId: id(1) });
		const r = await t.call("POST", `/api/kakao/drafts/${d.code}/send`, {});
		expect(r.status).toBe(409);
		expect(typeof r.json.error).toBe("string");
		await t.web.idle();
		expect(t.calls).toEqual([]);
		expect((await listDrafts({ paths, runner: async () => ({ code: 0, stdout: "", stderr: "" }) }))[0]!.status).toBe("stale");
		expect(t.events).toEqual([{ kind: "kakao_draft", chatId: DIRECT }]);
		t.close();
	});

	test("drop marks the draft dropped and announces it; a second drop, an unknown code and an unwatched room are refused", async () => {
		const t = setup({ watch_chats: [DIRECT] });
		const d = await t.draft();
		expect((await t.call("POST", `/api/kakao/drafts/${d.code}/drop`)).json).toEqual({ ok: true });
		expect(t.events).toEqual([{ kind: "kakao_draft", chatId: DIRECT }]);
		expect((await listDrafts({ paths, runner: async () => ({ code: 0, stdout: "", stderr: "" }) }))[0]!.status).toBe("dropped");
		expect((await t.call("POST", `/api/kakao/drafts/${d.code}/drop`)).status).toBe(409);
		expect((await t.call("POST", "/api/kakao/drafts/KNOPE/drop")).status).toBe(404);
		const other = await t.draft({ chatId: GROUP });
		expect((await t.call("POST", `/api/kakao/drafts/${other.code}/drop`)).status).toBe(403);
		expect((await t.call("POST", `/api/kakao/drafts/${other.code}/send`, {})).status).toBe(403);
		expect(t.calls).toEqual([]);
		t.close();
	});
});

const chatBlock = (user: string) => /<<<CHAT\n([\s\S]*)\nCHAT>>>/.exec(user)![1]!;
const incoming = (from: number, to: number, text: (n: number) => string, author = 2001) => (w: Database) => {
	for (let n = from; n <= to; n++) addMessage(w, { logId: BASE_LOG + BigInt(n), chatId: ROOM.direct, authorId: author, message: text(n), sentAt: BASE_TIME + n * 10 });
};
const storedDrafts = () => listDrafts({ paths, runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
const DRAFT = `/api/kakao/chat/${DIRECT}/draft`;

describe("autoDraft", () => {
	test("persists in auto_draft_chats, needs watched, and goes off with watched", async () => {
		const t = setup();
		expect((await t.call("PUT", `/api/kakao/rooms/${GROUP}`, { autoDraft: true })).status).toBe(409);
		expect(t.config$().auto_draft_chats).toBeUndefined();

		const on = await t.call("PUT", `/api/kakao/rooms/${DIRECT}`, { autoDraft: true });
		expect(on).toEqual({ status: 200, json: { ok: true, watched: [DIRECT], autoDraft: [DIRECT] } });
		expect(t.config$().auto_draft_chats).toEqual([DIRECT]);
		expect(t.events).toEqual([{ kind: "kakao_rooms" }]);
		expect(t.state.changes).toBe(0);
		const rows = (await t.call("GET", "/api/kakao/rooms")).json.rooms;
		expect(rows.filter((r: any) => r.autoDraft).map((r: any) => r.chatId)).toEqual([DIRECT]);

		expect((await t.call("PUT", `/api/kakao/rooms/${DIRECT}`, { autoDraft: false })).json.autoDraft).toEqual([]);
		await t.call("PUT", `/api/kakao/rooms/${DIRECT}`, { autoDraft: true });
		const off = await t.call("PUT", `/api/kakao/rooms/${DIRECT}`, { watched: false });
		expect(off.json).toEqual({ ok: true, watched: [], autoDraft: [] });
		expect(t.config$().auto_draft_chats).toEqual([]);

		const both = await t.call("PUT", `/api/kakao/rooms/${GROUP}`, { watched: true, autoDraft: true });
		expect(both.json).toEqual({ ok: true, watched: [GROUP], autoDraft: [GROUP] });
		expect((await t.call("PUT", `/api/kakao/rooms/${GROUP}`, {})).status).toBe(400);
		expect((await t.call("PUT", `/api/kakao/rooms/${GROUP}`, { autoDraft: "yes" })).status).toBe(400);
		t.close();
	});

	test("the memo room (self) is listed and can be watched and read; channels stay out", async () => {
		const t = setup({ watch_chats: [String(ROOM.self)] });
		const rooms = (await t.call("GET", "/api/kakao/rooms")).json.rooms;
		expect(rooms.find((r: any) => r.chatId === String(ROOM.self))).toMatchObject({ kind: "self", watched: true });
		expect(rooms.some((r: any) => r.kind === "channel" || r.kind === "open")).toBe(false);
		const chat = await t.call("GET", `/api/kakao/chat/${ROOM.self}`);
		expect(chat.status).toBe(200);
		expect(chat.json.messages.map((m: any) => m.text)).toEqual(["note to self"]);
		t.close();
	});
});

describe("on-demand draft", () => {
	test("one model call builds the draft from the messages since the owner's last reply, records tokens and writes the summary", async () => {
		const t = setup();
		mkdirSync(join(dir, "kakao", "summaries"), { recursive: true });
		writeFileSync(join(dir, "kakao", "summaries", `${DIRECT}.md`), "이전 메모: 점심 이야기\n");
		const r = await t.call("POST", DRAFT);
		expect(r).toEqual({ status: 202, json: { state: "drafting" } });
		await t.web.idle();

		expect(t.model.calls).toHaveLength(1);
		const { user } = t.model.calls[0]!;
		expect(chatBlock(user)).toBe("Alex: fine, lunch tomorrow?\nAlex: (사진·파일)");
		expect(user).toContain("이전 메모: 점심 이야기");
		expect(user).toContain("상대: hello there\n나: hi, how are you");
		expect(chatBlock(user)).not.toContain("hello there");

		const [d] = await storedDrafts();
		expect(d).toMatchObject({ chatId: DIRECT, roomName: "Alex", text: "내일 좋아", basisLogId: id(3), status: "pending", tokens: { in: 1200, out: 30 } });
		expect(d!.tokens?.estimated).toBeUndefined();
		const summary = join(dir, "kakao", "summaries", `${DIRECT}.md`);
		expect(readFileSync(summary, "utf8")).toBe("점심 약속을 잡는 중\n");
		expect(statSync(summary).mode & 0o777).toBe(0o600);
		expect(t.events).toEqual([{ kind: "kakao_draft", chatId: DIRECT }]);
		expect(JSON.stringify(t.events)).not.toContain("내일 좋아");
		expect((await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.drafts.map((x: any) => x.text)).toEqual(["내일 좋아"]);
		t.close();
	});

	test("tokens are estimated from characters (marked estimated) when the model reports no usage; a long summary is cut to 600", async () => {
		const t = setup();
		const replyText = "```json\n" + JSON.stringify({ action: "draft", body: "네", summary: "가".repeat(1000) }) + "\n```";
		t.model.reply = async () => ({ text: replyText });
		await t.call("POST", DRAFT);
		await t.web.idle();
		const { system, user } = t.model.calls[0]!;
		const [d] = await storedDrafts();
		expect(d!.tokens).toEqual({ in: Math.ceil((system.length + user.length) / 2.5), out: Math.ceil(replyText.length / 2.5), estimated: true });
		expect([...readFileSync(join(dir, "kakao", "summaries", `${DIRECT}.md`), "utf8").trim()]).toHaveLength(600);
		t.close();
	});

	test("input is capped: 30 lines, 300 characters per line, 2500 characters of chat in total", async () => {
		const lines = setup({}, incoming(10, 49, n => `line-${n}`));
		await lines.call("POST", DRAFT);
		await lines.web.idle();
		const block = chatBlock(lines.model.calls[0]!.user).split("\n");
		expect(block).toHaveLength(30);
		expect(block[0]).toBe("Alex: line-20");
		expect(block.at(-1)).toBe("Alex: line-49");
		lines.close();
		rmSync(join(dir, "k.sqlite"));

		const long = setup({}, incoming(10, 12, () => "가".repeat(1000)));
		await long.call("POST", DRAFT);
		await long.web.idle();
		const cut = chatBlock(long.model.calls[0]!.user).split("\n");
		expect(cut.slice(-3).every(l => l === `Alex: ${"가".repeat(299)}…`)).toBe(true);
		long.close();
		rmSync(join(dir, "k.sqlite"));

		const total = setup({}, incoming(10, 49, () => "나".repeat(400)));
		await total.call("POST", DRAFT);
		await total.web.idle();
		const block2 = chatBlock(total.model.calls[0]!.user);
		expect([...block2].length).toBeLessThanOrEqual(MAX_CHAT_CHARS);
		expect(block2.split("\n").length).toBeLessThan(30);
		expect(block2.endsWith("나".repeat(299) + "…")).toBe(true);
		total.close();
	});

	test("a skip answer, nothing new to answer, a bad answer and a failing model make no draft and say why in plain Korean", async () => {
		const NO_REPLY = "답할 내용이 없어서 초안을 만들지 않았어요";
		const t = setup();
		t.model.reply = async () => ({ text: JSON.stringify({ action: "skip", body: "", summary: "무시되어야 함" }) });
		await t.call("POST", DRAFT);
		await t.web.idle();
		expect(t.events).toEqual([{ kind: "kakao_draft", chatId: DIRECT, error: NO_REPLY }]);
		expect(await storedDrafts()).toEqual([]);
		expect(() => statSync(join(dir, "kakao", "summaries", `${DIRECT}.md`))).toThrow();

		t.events.length = 0;
		t.model.reply = async () => ({ text: "알겠습니다" });
		await t.call("POST", DRAFT);
		await t.web.idle();
		expect(t.events).toHaveLength(1);
		expect(typeof t.events[0]!.error).toBe("string");

		t.events.length = 0;
		t.model.reply = async () => Promise.reject(new Error("exit 1"));
		await t.call("POST", DRAFT);
		await t.web.idle();
		expect(t.events).toHaveLength(1);
		expect(typeof t.events[0]!.error).toBe("string");
		expect(JSON.stringify(t.events)).not.toContain("exit 1");
		expect(await storedDrafts()).toEqual([]);
		t.close();
		rmSync(join(dir, "k.sqlite"));

		const quiet = setup({}, incoming(10, 10, () => "그럼 이만", OWNER));
		await quiet.call("POST", DRAFT);
		await quiet.web.idle();
		expect(quiet.model.calls).toEqual([]);
		expect(quiet.events).toEqual([{ kind: "kakao_draft", chatId: DIRECT, error: NO_REPLY }]);
		quiet.close();
	});

	test("an unwatched room is refused (403) and the model is never called", async () => {
		const t = setup();
		const r = await t.call("POST", `/api/kakao/chat/${GROUP}/draft`);
		expect(r.status).toBe(403);
		expect(t.model.calls).toEqual([]);
		expect(t.events).toEqual([]);
		t.close();
	});

	test("one draft at a time per room: a second request is refused (409) until the first has finished", async () => {
		const t = setup();
		let release!: (r: ModelReply) => void;
		let started!: () => void;
		const startedP = new Promise<void>(res => (started = res));
		t.model.reply = () => (started(), new Promise<ModelReply>(res => (release = res)));
		expect((await t.call("POST", DRAFT)).status).toBe(202);
		await startedP;
		const again = await t.call("POST", DRAFT);
		expect(again.status).toBe(409);
		expect(typeof again.json.error).toBe("string");
		release({ text: JSON.stringify({ action: "draft", body: "응", summary: "" }) });
		await t.web.idle();
		expect(t.model.calls).toHaveLength(1);
		expect(t.events).toEqual([{ kind: "kakao_draft", chatId: DIRECT }]);
		t.model.reply = async () => ({ text: JSON.stringify({ action: "skip", body: "", summary: "" }) });
		expect((await t.call("POST", DRAFT)).status).toBe(202);
		await t.web.idle();
		expect(t.model.calls).toHaveLength(2);
		t.close();
	});

	test("the memo room: every message counts as incoming, so the live test can draft there", async () => {
		const t = setup({ watch_chats: [String(ROOM.self)] }, w => void w.query("INSERT INTO NTChatMeta VALUES (103, 3, 'My Memo', 'My Memo')").run());
		await t.call("POST", `/api/kakao/chat/${ROOM.self}/draft`);
		await t.web.idle();
		expect(chatBlock(t.model.calls[0]!.user)).toBe("나: note to self");
		const [d] = await storedDrafts();
		expect(d).toMatchObject({ chatId: String(ROOM.self), roomName: "My Memo", basisLogId: id(6) });
		t.close();
	});
});

describe("sends go through dispatchSend", () => {
	test("a refused lease fails a typed send and a confirmed draft with its reason, and nothing is sent", async () => {
		const t = setup();
		t.state.leaseRefusal = "다른 맥이 이 대화방을 맡고 있어요";
		const typed = await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "hi" });
		const d = await t.draft();
		const confirmed = await t.call("POST", `/api/kakao/drafts/${d.code}/send`, {});
		expect([typed.status, confirmed.status]).toEqual([202, 202]);
		await t.web.idle();
		expect(t.calls).toEqual([]);
		const sends = (await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.sends;
		expect(sends.map((s: any) => [s.state, s.reason])).toEqual([["failed", t.state.leaseRefusal], ["failed", t.state.leaseRefusal]]);
		expect((await storedDrafts())[0]!.status).toBe("pending");
		t.close();
	});
});

describe("media", () => {
	const FUTURE = Math.floor(NOW / 1000) + 86_400;
	const PAST = Math.floor(NOW / 1000) - 60;
	const cdn = (p: string) => `https://talk.kakaocdn.net/${p}`;
	const att = (o: Record<string, unknown>) => JSON.stringify(o);
	const at = (n: number) => BASE_TIME + n * 10;
	const row = (n: number, type: number, attachment: string, extra: { message?: string; localFilePath?: string; chat?: number; author?: number } = {}) => ({ logId: BASE_LOG + BigInt(n), chatId: extra.chat ?? ROOM.direct, authorId: extra.author ?? 2001, message: extra.message ?? "", type, sentAt: at(n), attachment, ...(extra.localFilePath ? { localFilePath: extra.localFilePath } : {}) });
	const photo = (n: number, over: Record<string, unknown> = {}) => row(n, 2, att({ url: cdn("p/full.jpg"), thumbnailUrl: cdn("p/thumb.jpg"), thumbnailWidth: 320, thumbnailHeight: 240, w: 1600, h: 1200, expire: FUTURE, ...over }));
	const png = () => new Response("PNGBYTES", { headers: { "Content-Type": "image/png" } });

	test("each message maps to a safe media object; no raw URL, no local path and no attachment JSON reach the web", async () => {
		const real = join(dir, "내 파일 (1).pdf");
		writeFileSync(real, "pdf-bytes");
		const t = setup({}, w => {
			addMessage(w, photo(20));
			addMessage(w, row(21, 27, att({ imageUrls: [cdn("a/1.jpg"), cdn("a/2.jpg"), cdn("a/3.jpg")], thumbnailUrls: [cdn("a/t1.jpg"), cdn("a/t2.jpg"), cdn("a/t3.jpg")], thumbnailWidths: [200, 200, 200], thumbnailHeights: [300, 300, 300], expire: FUTURE })));
			addMessage(w, row(22, 3, att({ url: cdn("v/1.mp4"), w: 640, h: 360, d: 75, expire: PAST })));
			addMessage(w, row(23, 5, att({ url: cdn("s/1.m4a"), d: 8, expire: FUTURE })));
			addMessage(w, row(24, 18, att({ name: "내 파일 (1).pdf", size: 2048, url: cdn("f/1"), expire: PAST }), { localFilePath: real }));
			addMessage(w, row(25, 18, att({ name: "gone.zip", size: 10, url: cdn("f/2"), expire: PAST }), { localFilePath: join(dir, "missing.zip") }));
			addMessage(w, row(26, 20, att({ name: "x", type: "emoji", path: "p", alt: "하트" })));
			addMessage(w, row(27, 26, att({ src_message: "점심 뭐 먹을까\n" + "길".repeat(200), src_type: 1, src_userId: 2001, src_logId: 1 }), { message: "나는 국밥", author: OWNER }));
			addMessage(w, row(28, 16, att({ lat: 37.5, lng: 127.03, a: "서울 강남구", t: "회사" })));
			addMessage(w, row(29, 71, "", { message: "쇼핑 안내" }));
			addMessage(w, row(30, 0, "", { message: "Sam님이 들어왔어요" }));
			addMessage(w, row(31, 99, ""));
			addMessage(w, row(32, 12, att({ name: "x", path: "p", alt: "카카오 이모티콘" }), { message: "고마워 :)" }));
			addMessage(w, row(33, 25, att({ name: "x", path: "p", alt: "하트" }), { message: "  " }));
		});
		const r = await t.call("GET", `/api/kakao/chat/${DIRECT}`);
		const by = (n: number) => r.json.messages.find((m: any) => m.logId === id(n));
		expect(by(20)).toMatchObject({ type: 2, text: "", media: { kind: "photo", w: 320, h: 240, count: 1, expired: false } });
		expect(by(21).media).toEqual({ kind: "photo", w: 200, h: 300, count: 3, expired: false });
		expect(by(22).media).toEqual({ kind: "video", w: 640, h: 360, d: 75, expired: true });
		expect(by(23).media).toEqual({ kind: "voice", d: 8, expired: false });
		expect(by(24).media).toEqual({ kind: "file", name: "내 파일 (1).pdf", size: 2048, local: true, expired: false });
		expect(by(25).media).toEqual({ kind: "file", name: "gone.zip", size: 10, local: false, expired: true });
		expect(by(26).media).toEqual({ kind: "emoticon", alt: "(이모티콘) 하트" });
		// the text written with a sticker rides in media.text (the text field stays empty, as for every media type); blank text is none
		expect(by(32)).toMatchObject({ type: 12, text: "", media: { kind: "emoticon", alt: "(이모티콘) 카카오 이모티콘", text: "고마워 :)" } });
		expect(by(33).media).toEqual({ kind: "emoticon", alt: "(이모티콘) 하트" });
		expect(by(27)).toMatchObject({ text: "나는 국밥", media: { kind: "reply", quoteSender: "Alex" } });
		expect([...by(27).media.quote].length).toBeLessThanOrEqual(81);
		expect(by(27).media.quote.startsWith("점심 뭐 먹을까 ")).toBe(true);
		expect(by(28).media).toEqual({ kind: "location", label: "서울 강남구", lat: 37.5, lng: 127.03 });
		expect(by(29)).toMatchObject({ text: "쇼핑 안내" });
		expect(by(29).media).toBeUndefined();
		expect(by(30)).toMatchObject({ type: 0, text: "Sam님이 들어왔어요" });
		expect(by(31)).toMatchObject({ type: 99, text: "" });
		const body = JSON.stringify(r.json);
		for (const leak of ["kakaocdn", "https://", "http://", dir, "localFilePath", "attachment", "thumbnailUrl"]) expect(body).not.toContain(leak);
		t.close();
	});

	test("the media route fetches the stored URL server-side, without cookies or auth, and streams only image/video/audio back", async () => {
		const t = setup({}, w => {
			addMessage(w, photo(20));
			addMessage(w, row(21, 27, att({ imageUrls: [cdn("a/1.jpg"), cdn("a/2.jpg")], thumbnailUrls: [cdn("a/t1.jpg"), cdn("a/t2.jpg")], expire: FUTURE })));
			addMessage(w, row(22, 3, att({ url: cdn("v/1.mp4"), expire: FUTURE })));
			addMessage(w, row(23, 5, att({ url: cdn("s/1.m4a"), expire: FUTURE })));
		});
		t.upstream.reply = () => png();
		const thumb = await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(20)}?v=thumb`);
		expect(thumb.status).toBe(200);
		expect(thumb.headers.get("content-type")).toBe("image/png");
		expect(thumb.headers.get("cache-control")).toBe("private, max-age=86400");
		expect(await thumb.text()).toBe("PNGBYTES");
		expect(t.fetched[0]!.url).toBe(cdn("p/thumb.jpg"));
		const sent = t.fetched[0]!.init!;
		expect(sent.method).toBe("GET");
		expect(sent.redirect).toBe("manual");
		expect(sent.credentials).toBe("omit");
		expect(sent.headers).toEqual({});
		expect(sent.signal).toBeInstanceOf(AbortSignal);

		await (await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(20)}`)).arrayBuffer();
		expect(t.fetched[1]!.url).toBe(cdn("p/full.jpg"));
		await (await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(21)}?i=1&v=thumb`)).arrayBuffer();
		await (await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(21)}?i=1&v=full`)).arrayBuffer();
		expect(t.fetched.slice(2).map(f => f.url)).toEqual([cdn("a/t2.jpg"), cdn("a/2.jpg")]);
		t.upstream.reply = () => new Response("MOVIE", { headers: { "Content-Type": "video/mp4" } });
		expect((await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(22)}`)).headers.get("content-type")).toBe("video/mp4");
		t.upstream.reply = () => new Response("VOICE", { headers: { "Content-Type": "audio/mp4" } });
		expect(await (await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(23)}`)).text()).toBe("VOICE");

		t.upstream.reply = () => new Response("<script>alert(1)</script>", { headers: { "Content-Type": "text/html" } });
		const html = await t.call("GET", `/api/kakao/media/${DIRECT}/${id(20)}`);
		expect(html.status).toBe(502);
		t.close();
	});

	test("only https URLs on *.kakaocdn.net are fetched: other hosts, http, look-alike hosts and redirects off the host are refused", async () => {
		const bad = ["https://evil.example/x.jpg", "http://talk.kakaocdn.net/x.jpg", "https://kakaocdn.net.evil.example/x.jpg", "https://evilkakaocdn.net/x.jpg", "https://talk.kakaocdn.net@evil.example/x.jpg", "https://kakaocdn.net/x.jpg", "ftp://talk.kakaocdn.net/x.jpg", "not a url"];
		const t = setup({}, w => {
			bad.forEach((u, i) => addMessage(w, row(40 + i, 2, att({ url: u, thumbnailUrl: u, expire: FUTURE }))));
			addMessage(w, photo(60));
		});
		t.upstream.reply = () => png();
		for (let i = 0; i < bad.length; i++) {
			const r = await t.call("GET", `/api/kakao/media/${DIRECT}/${id(40 + i)}`);
			expect([r.status, bad[i]]).toEqual([502, bad[i]]);
		}
		expect(t.fetched).toEqual([]);
		t.upstream.reply = () => new Response(null, { status: 302, headers: { Location: "https://evil.example/steal.jpg" } });
		expect((await t.call("GET", `/api/kakao/media/${DIRECT}/${id(60)}`)).status).toBe(502);
		expect(t.fetched.map(f => f.url)).toEqual([cdn("p/full.jpg")]);
		t.fetched.length = 0;
		let hops = 0;
		t.upstream.reply = () => (hops++ === 0 ? new Response(null, { status: 302, headers: { Location: "https://img.kakaocdn.net/other.png" } }) : png());
		expect((await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(60)}`)).status).toBe(200);
		expect(t.fetched.map(f => f.url)).toEqual([cdn("p/full.jpg"), "https://img.kakaocdn.net/other.png"]);
		t.close();
	});

	test("an expired message or an upstream 403 / 404 answers 410; a fetch error is a plain 502", async () => {
		const t = setup({}, w => {
			addMessage(w, photo(20, { expire: PAST }));
			addMessage(w, photo(21));
		});
		t.upstream.reply = () => png();
		const old = await t.call("GET", `/api/kakao/media/${DIRECT}/${id(20)}`);
		expect(old).toEqual({ status: 410, json: { error: "기간이 지나 볼 수 없어요" } });
		expect(t.fetched).toEqual([]);
		for (const status of [403, 404]) {
			t.upstream.reply = () => new Response("no", { status });
			expect(await t.call("GET", `/api/kakao/media/${DIRECT}/${id(21)}`)).toEqual({ status: 410, json: { error: "기간이 지나 볼 수 없어요" } });
		}
		t.upstream.reply = () => Promise.reject(new Error("offline"));
		expect((await t.call("GET", `/api/kakao/media/${DIRECT}/${id(21)}`)).status).toBe(502);
		t.close();
	});

	test("the 25 MB cap: a declared size over it is refused (413), an undeclared stream that grows past it is cut off", async () => {
		const t = setup({}, w => addMessage(w, photo(20)));
		t.upstream.reply = () => new Response("x", { headers: { "Content-Type": "image/jpeg", "Content-Length": String(26 * 1024 * 1024) } });
		expect((await t.call("GET", `/api/kakao/media/${DIRECT}/${id(20)}`)).status).toBe(413);
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		t.upstream.reply = () =>
			new Response(new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 30) c.enqueue(chunk); else c.close(); } }), { headers: { "Content-Type": "image/jpeg" } });
		const res = await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(20)}`);
		expect(res.status).toBe(200);
		await expect(res.arrayBuffer()).rejects.toThrow();
		expect(sent).toBeLessThan(30);
		t.close();
	});

	test("the file route serves the downloaded file as an attachment (RFC 5987 name) and 404s when it is not on this computer", async () => {
		const real = join(dir, "dl.bin");
		writeFileSync(real, "file-bytes");
		const t = setup({}, w => {
			addMessage(w, row(20, 18, att({ name: "보고서 (최종).pdf", size: 10, url: cdn("f/1"), expire: PAST }), { localFilePath: real }));
			addMessage(w, row(21, 18, att({ name: "none.zip", url: cdn("f/2") }), { localFilePath: join(dir, "missing.zip") }));
			addMessage(w, row(22, 18, att({ name: "never.zip", url: cdn("f/3") })));
			addMessage(w, photo(23));
		});
		const ok = await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(20)}/file`);
		expect(ok.status).toBe(200);
		const cd = ok.headers.get("content-disposition")!;
		expect(cd.startsWith("attachment;")).toBe(true);
		expect(cd).toContain("filename*=UTF-8''" + encodeURIComponent("보고서 ").concat("%28%EC%B5%9C%EC%A2%85%29.pdf"));
		expect(await ok.text()).toBe("file-bytes");
		for (const n of [21, 22, 23]) expect(await t.call("GET", `/api/kakao/media/${DIRECT}/${id(n)}/file`)).toEqual({ status: 404, json: { error: "이 컴퓨터에 내려받은 파일이 없어요" } });
		expect(t.fetched).toEqual([]);
		t.close();
	});

	test("unwatched rooms (403), a message of another room or a missing one (404), bad parameters (400) and the integration off (409) are refused", async () => {
		const t = setup({ watch_chats: [DIRECT] }, w => {
			addMessage(w, photo(20));
			addMessage(w, row(21, 2, att({ url: cdn("g/1.jpg"), expire: FUTURE }), { chat: ROOM.group, author: 2002 }));
		});
		t.upstream.reply = () => png();
		expect((await t.call("GET", `/api/kakao/media/${GROUP}/${id(21)}`)).status).toBe(403);
		expect((await t.call("GET", `/api/kakao/media/${GROUP}/${id(21)}/file`)).status).toBe(403);
		expect((await t.call("GET", `/api/kakao/media/${DIRECT}/${id(21)}`)).status).toBe(404);
		expect((await t.call("GET", `/api/kakao/media/${DIRECT}/${id(99)}`)).status).toBe(404);
		expect((await t.call("GET", `/api/kakao/media/${DIRECT}/abc`)).status).toBe(400);
		expect((await t.call("GET", `/api/kakao/media/${DIRECT}/${id(20)}?i=-1`)).status).toBe(400);
		expect((await t.raw("GET", `/api/kakao/media/${DIRECT}/${id(20)}?i=5`)).status).toBe(200);
		expect(t.fetched.length).toBe(1);
		writeFileSync(paths.config, JSON.stringify({ enabled: false }));
		expect((await t.call("GET", `/api/kakao/media/${DIRECT}/${id(20)}`)).status).toBe(409);
		t.close();
	});
});

describe("owner voice in the draft prompt", () => {
	const PAIRS = 22;
	const at = (n: number) => ({ logId: BASE_LOG + BigInt(n), chatId: ROOM.direct, sentAt: BASE_TIME + n * 10 });
	// The other side writes formally, the owner writes casually; the last line is the other side's open question.
	const formalRoom = (w: Database) => {
		for (let i = 0; i < PAIRS; i++) {
			addMessage(w, { ...at(10 + i * 2), authorId: 2001, message: `${i}번 건은 확인해 주시겠습니까?` });
			addMessage(w, { ...at(11 + i * 2), authorId: OWNER, message: `${i}번 ㅇㅇ 확인함ㅋㅋ` });
		}
		addMessage(w, { ...at(100), authorId: 2001, message: "내일 점심 가능하신가요?" });
	};
	const section = (user: string) => user.slice(user.indexOf("Imitate the 나 lines:"), user.indexOf("Earlier in the room"));

	test("the prompt has the owner's pairs, the room's register stated as 반말, the learned notes, and stays inside the budget", async () => {
		const t = setup({}, formalRoom, { draftStyle: () => ({ rules: ["길이: 중앙값 9자"], corrections: [], forbidden: [], samples: [] }) });
		await t.call("POST", DRAFT);
		await t.web.idle();
		const { system, user } = t.model.calls[0]!;
		expect(/Register in THIS room: (반말|존댓말|혼용)/.exec(user)![1]).toBe("반말");
		const pairs = section(user);
		expect(pairs.match(/(^|\n)나: /g)!.length).toBe(MAX_PAIRS);
		expect(pairs).toContain("상대: 21번 건은 확인해 주시겠습니까?\n나: 21번 ㅇㅇ 확인함ㅋㅋ");
		expect(pairs).not.toContain("상대: 0번 건");
		expect(user).toContain("- 길이: 중앙값 9자");
		expect(chatBlock(user)).toBe("Alex: 내일 점심 가능하신가요?");
		expect(system.length + user.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
		t.close();
	});

	test("voice learning gets a reader of the owner's own lines only, over his recent rooms without the excluded ones", async () => {
		const seen: any[] = [];
		const learnVoice: WebDeps["learnVoice"] = async src =>
			void seen.push({ chatId: src.chatId, texts: await src.ownTexts(DIRECT, 50), counts: [...(await src.ownCounts([DIRECT, GROUP]))], rooms: await src.recentRooms() });
		const t = setup({ exclude_chats: [String(ROOM.excluded)] }, formalRoom, { learnVoice });
		await t.call("POST", DRAFT);
		await t.web.idle();
		expect(seen).toHaveLength(1);
		expect(seen[0].chatId).toBe(DIRECT);
		expect(seen[0].texts).toHaveLength(PAIRS + 1);
		expect(seen[0].texts[0]).toBe(`${PAIRS - 1}번 ㅇㅇ 확인함ㅋㅋ`);
		expect(seen[0].texts.some((x: string) => x.includes("입니까"))).toBe(false);
		expect(seen[0].counts).toEqual([[DIRECT, PAIRS + 1]]);
		expect(seen[0].rooms).toEqual([GROUP, DIRECT]);
		t.close();
	});

	test("a failing voice learner never blocks the draft", async () => {
		const t = setup({}, undefined, { learnVoice: async () => Promise.reject(new Error("boom")) });
		await t.call("POST", DRAFT);
		await t.web.idle();
		expect(t.model.calls).toHaveLength(1);
		t.close();
	});

	test("sending an edited draft reports the correction; sending it unchanged does not", async () => {
		const got: string[][] = [];
		const t = setup({}, undefined, { onCorrection: (chatId, draft, sent) => void got.push([chatId, draft, sent]) });
		const a = await t.draft();
		await t.call("POST", `/api/kakao/drafts/${a.code}/send`, { text: "see you" });
		const b = await t.draft();
		await t.call("POST", `/api/kakao/drafts/${b.code}/send`, { text: "고친 글" });
		await t.web.idle();
		expect(got).toEqual([[DIRECT, "see you", "고친 글"]]);
		t.close();
	});
});
