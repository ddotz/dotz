import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sqliteDb } from "./db.ts";
import { BASE_LOG, makeFixtureDb, OWNER, ROOM } from "./fixture.ts";
import { createDraft, listDrafts } from "./send.ts";
import { type KakaoConfig, kakaoPaths, type Runner } from "./types.ts";
import { createKakaoWeb } from "./web.ts";

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

function setup(config: Partial<KakaoConfig> = {}) {
	const dbPath = join(dir, "k.sqlite");
	makeFixtureDb(dbPath).close();
	const full: KakaoConfig = { enabled: true, dbPath, userId: OWNER, watch_chats: [DIRECT], ...config };
	mkdirSync(dirname(paths.config), { recursive: true });
	writeFileSync(paths.config, JSON.stringify(full));
	const events: Record<string, unknown>[] = [];
	const calls: string[][] = [];
	const state = { failSend: false, changes: 0 };
	const runner: Runner = async argv => {
		if (argv[0] === "osascript") return { code: 0, stdout: "com.example.Editor\n", stderr: "" };
		if (argv[0] === "open") return { code: 0, stdout: "", stderr: "" };
		calls.push(argv);
		if (argv.includes("--dry-run")) return { code: 0, stdout: `Recipient: ${argv[argv.indexOf("--") + 1]}\nMessage: ${argv[argv.length - 1]}\n`, stderr: "" };
		return { code: state.failSend ? 1 : 0, stdout: "", stderr: "" };
	};
	const db = sqliteDb(dbPath);
	const web = createKakaoWeb({ paths, runner, now: () => NOW, openDb: async () => db, broadcast: e => events.push(e), onWatchChange: () => void state.changes++, kmsg: "/fake/kmsg" });
	const call = async (method: string, path: string, body?: unknown) => {
		const url = new URL(`http://local${path}`);
		const res = await web.route(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, url.pathname.split("/").filter(Boolean));
		return { status: res!.status, json: (await res!.json()) as any };
	};
	const draft = (over: Partial<{ chatId: string; text: string; basisLogId: string }> = {}) =>
		createDraft({ chatId: DIRECT, roomName: "Alex", text: "see you", basisLogId: id(3), ...over }, { paths, runner, now: () => NOW });
	const config$ = () => JSON.parse(readFileSync(paths.config, "utf8")) as KakaoConfig;
	return { web, call, events, calls, state, draft, config$, close: () => db.close() };
}

describe("rooms", () => {
	test("lists direct and group rooms with the watched flag; toggling persists to the config and broadcasts", async () => {
		const t = setup();
		const list = await t.call("GET", "/api/kakao/rooms");
		expect(list.json.on).toBe(true);
		expect(list.json.rooms.map((r: any) => [r.chatId, r.name, r.kind, r.watched])).toEqual([
			[String(ROOM.excluded), "Quiet Group", "group", false],
			[GROUP, "Study Group", "group", false],
			[DIRECT, "Alex", "direct", true],
		]);
		expect(list.json.rooms.every((r: any) => Number.isFinite(r.lastAt) && r.lastAt > 1e11)).toBe(true);

		const on = await t.call("PUT", `/api/kakao/rooms/${GROUP}`, { watched: true });
		expect(on).toEqual({ status: 200, json: { ok: true, watched: [DIRECT, GROUP] } });
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
		expect(r.json.messages[0]).toMatchObject({ sender: "Alex", fromMe: false });
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

describe("typed send", () => {
	test("goes through the stubbed kmsg without an approval step: sending -> sent, then listed in the room's sends", async () => {
		const t = setup();
		const r = await t.call("POST", `/api/kakao/chat/${DIRECT}/send`, { text: "hello there" });
		expect(r.status).toBe(202);
		expect(r.json.state).toBe("sending");
		await t.web.idle();
		expect(t.events.map(e => [e.kind, e.id, e.state])).toEqual([["kakao_send", r.json.id, "sending"], ["kakao_send", r.json.id, "sent"]]);
		expect(t.calls).toEqual([
			["/fake/kmsg", "send", "--dry-run", "--", "Alex", "hello there"],
			["/fake/kmsg", "send", "--", "Alex", "hello there"],
		]);
		const sends = (await t.call("GET", `/api/kakao/chat/${DIRECT}`)).json.sends;
		expect(sends).toEqual([{ id: r.json.id, text: "hello there", state: "sent", at: NOW }]);
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
		expect(t.calls.at(-1)).toEqual(["/fake/kmsg", "send", "--", "Alex", "see you"]);
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
		expect(t.calls.at(-1)).toEqual(["/fake/kmsg", "send", "--", "Alex", "고친 글"]);
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
