import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { sqliteDb } from "./db.ts";
import type { ModelReply } from "./draft.ts";
import { addMessage, BASE_LOG, BASE_TIME, makeFixtureDb, OWNER, ROOM } from "./fixture.ts";
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

function setup(config: Partial<KakaoConfig> = {}, fill?: (w: Database) => void) {
	const dbPath = join(dir, "k.sqlite");
	const fixture = makeFixtureDb(dbPath);
	fill?.(fixture);
	fixture.close();
	const full: KakaoConfig = { enabled: true, dbPath, userId: OWNER, watch_chats: [DIRECT], ...config };
	mkdirSync(dirname(paths.config), { recursive: true });
	writeFileSync(paths.config, JSON.stringify(full));
	const events: Record<string, unknown>[] = [];
	const calls: string[][] = [];
	const state = { failSend: false, changes: 0, leaseRefusal: undefined as string | undefined };
	const model = {
		calls: [] as { system: string; user: string }[],
		reply: async (): Promise<ModelReply> => ({ text: JSON.stringify({ action: "draft", body: "내일 좋아", summary: "점심 약속을 잡는 중" }), inputTokens: 1200, outputTokens: 30 }),
	};
	const runner: Runner = async argv => {
		if (argv[0] === "osascript") return { code: 0, stdout: "com.example.Editor\n", stderr: "" };
		if (argv[0] === "open") return { code: 0, stdout: "", stderr: "" };
		calls.push(argv);
		if (argv.includes("--dry-run")) return { code: 0, stdout: `Recipient: ${argv[argv.indexOf("--") + 1]}\nMessage: ${argv[argv.length - 1]}\n`, stderr: "" };
		return { code: state.failSend ? 1 : 0, stdout: "", stderr: "" };
	};
	const db = sqliteDb(dbPath);
	const web = createKakaoWeb({ paths, runner, now: () => NOW, openDb: async () => db, broadcast: e => events.push(e), onWatchChange: () => void state.changes++, kmsg: "/fake/kmsg", collector: "mac-a", lease: async () => (state.leaseRefusal ? { ok: false, reason: state.leaseRefusal } : { ok: true }), draftModel: async (system, user) => (model.calls.push({ system, user }), model.reply()) });
	const call = async (method: string, path: string, body?: unknown) => {
		const url = new URL(`http://local${path}`);
		const res = await web.route(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, url.pathname.split("/").filter(Boolean));
		return { status: res!.status, json: (await res!.json()) as any };
	};
	const draft = (over: Partial<{ chatId: string; text: string; basisLogId: string }> = {}) =>
		createDraft({ chatId: DIRECT, roomName: "Alex", text: "see you", basisLogId: id(3), ...over }, { paths, runner, now: () => NOW });
	const config$ = () => JSON.parse(readFileSync(paths.config, "utf8")) as KakaoConfig;
	return { web, call, events, calls, state, model, draft, config$, close: () => db.close() };
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
		expect(user).toContain("- hi, how are you");
		expect(user).not.toContain("hello there");

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

	test("input is capped: 30 lines, 300 characters per line, about 2K tokens (5000 characters) in total", async () => {
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
		expect([...block2].length).toBeLessThanOrEqual(5000);
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
	test("a refused lease fails a typed send and a confirmed draft with its reason, and kmsg never runs", async () => {
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
