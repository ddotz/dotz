import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { type CommentAdapter, commentId, type RawComment, type SourceConfig } from "./comments/contract.ts";
import { createEngine } from "./comments/engine.ts";
import { createCommentsWeb } from "./comments/web.ts";
import { integrationContext, integrationItems } from "./integrations.ts";
import { addMessage, BASE_LOG, BASE_TIME, makeFixtureDb, OWNER, ROOM } from "./kakao/fixture.ts";
import { sqliteDb } from "./kakao/db.ts";
import { kakaoPaths, type Runner } from "./kakao/types.ts";
import { createKakaoWeb } from "./kakao/web.ts";
import { mailCard, mailTarget, recordMail, setMailNoReply, setMailSuggest, unrepliedMails } from "./mail.ts";
import { kakaoUnreplied, mailUnreplied, UNREPLIED_WINDOW_MS } from "./unreplied.ts";

// 미답장: set when an item that expects a reply arrives, cleared when a reply went out for it, the owner answered himself, or he tapped 답장 안 함.
// Reading never clears it. Rules per app: comments (custom/comments), mail (mail-conversations.json), kakao (kakao/unreplied.json + the database).

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "unreplied-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the shared rules", () => {
	const mail = (extra: object = {}) => ({ key: "m1", at: new Date(NOW - 1000).toISOString(), ...extra });
	test("mail: a draft, a waiting reply or a marked mail needs a reply; sent, 답장 안 함 and old mail do not", () => {
		const none = new Set<string>();
		expect(mailUnreplied(mail({ suggest: { state: "draft" } }), none, NOW)).toBe(true);
		expect(mailUnreplied(mail({ suggest: { state: "waiting" } }), none, NOW)).toBe(true);
		expect(mailUnreplied(mail({ needsReply: true }), none, NOW)).toBe(true);
		expect(mailUnreplied(mail(), none, NOW)).toBe(false);
		expect(mailUnreplied(mail({ suggest: { state: "sent" } }), none, NOW)).toBe(false);
		expect(mailUnreplied(mail({ suggest: { state: "draft" } }), new Set(["m1"]), NOW)).toBe(false);
		expect(mailUnreplied(mail({ suggest: { state: "draft" }, noReply: true }), none, NOW)).toBe(false);
		expect(mailUnreplied(mail({ needsReply: true, at: new Date(NOW - UNREPLIED_WINDOW_MS - 1000).toISOString() }), none, NOW)).toBe(false);
	});
	test("kakao: the newest message from someone else waits; his own message after it, a waved-off logId and old messages do not", () => {
		const theirs = { logId: "20", fromMe: false, sentAt: NOW - 1000 };
		expect(kakaoUnreplied(theirs, undefined, NOW)).toBe(true);
		expect(kakaoUnreplied({ ...theirs, fromMe: true }, undefined, NOW)).toBe(false);
		expect(kakaoUnreplied(theirs, "20", NOW)).toBe(false);
		expect(kakaoUnreplied({ ...theirs, logId: "21" }, "20", NOW)).toBe(true);
		expect(kakaoUnreplied({ ...theirs, sentAt: NOW - UNREPLIED_WINDOW_MS - 1 }, undefined, NOW)).toBe(false);
		expect(kakaoUnreplied(undefined, undefined, NOW)).toBe(false);
	});
});

describe("comments", () => {
	const raw = (native: string, o: Partial<RawComment> = {}): RawComment => ({ native, thread: "p1", author: "A", text: `question ${native}?`, postTitle: "Post one", at: NOW - 1000, ...o });
	const src: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
	function setup() {
		const cdir = join(dir, "comments");
		mkdirSync(cdir, { recursive: true });
		writeFileSync(join(cdir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: src } }));
		const state = { pages: [] as RawComment[][], posted: [] as string[] };
		const adapter: CommentAdapter = {
			kind: "youtube",
			async list() {
				return { comments: state.pages.shift() ?? [], cursor: "1" };
			},
			async reply(_s, c) {
				state.posted.push(c.id);
				return { ok: true, ref: "r1" };
			},
		};
		const events: Record<string, unknown>[] = [];
		const model = async () => ({ text: `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body: "고마워요", questions: [] })}\n\`\`\``, inputTokens: 1, outputTokens: 1 });
		const engine = createEngine({ dir: cdir, now: () => NOW, collector: "mac-a", adapters: { youtube: adapter }, model, broadcast: e => events.push(e) });
		const web = createCommentsWeb({ engine, broadcast: e => events.push(e) });
		const call = async (method: string, path: string, body?: object) => {
			const url = new URL(`http://x${path}`);
			const res = await web.route(new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), url, url.pathname.split("/").filter(Boolean));
			return { status: res!.status, json: (await res!.json()) as any };
		};
		return { engine, state, events, web, call };
	}
	const c1 = commentId("youtube", "c1");

	test("a new comment from someone else is 미답장; reading the thread keeps it", async () => {
		const t = setup();
		t.state.pages = [[raw("c1"), raw("c2", { thread: "p2" })]];
		await t.engine.collect({ force: true });
		expect(t.engine.needs().youtube).toEqual({ drafts: 0, unread: 2, unreplied: 2 });
		expect((await t.call("POST", "/api/comments/thread/youtube/p1/read")).status).toBe(200);
		expect(t.engine.needs().youtube).toEqual({ drafts: 0, unread: 1, unreplied: 2 });
		const threads = (await t.call("GET", "/api/comments/threads?app=youtube")).json.threads;
		expect(threads.map((x: any) => [x.thread, x.unread, x.unreplied]).sort()).toEqual([["p1", 0, 1], ["p2", 1, 1]]);
		const view = (await t.call("GET", "/api/comments/thread/youtube/p1")).json;
		expect(view.comments.map((c: any) => [c.id, c.unreplied])).toEqual([[c1, true]]);
	});

	test("an approved send clears it, a failed send does not", async () => {
		const t = setup();
		t.state.pages = [[raw("c1")]];
		await t.engine.collect({ force: true });
		await t.engine.makeDraft(c1);
		const code = t.engine.store.drafts()[0]!.code;
		expect(t.engine.needs().youtube!.unreplied).toBe(1);
		const sent = t.engine.send(code, { by: "owner" });
		expect(sent.ok).toBe(true);
		if (sent.ok) await sent.done;
		expect(t.state.posted).toEqual([c1]);
		expect(t.engine.needs().youtube!.unreplied).toBe(0);
		expect(t.engine.unreplied(t.engine.store.comments()[0]!)).toBe(false);
	});

	test("the owner's own reply on the platform clears it; a later comment of someone else is 미답장 again", async () => {
		const t = setup();
		t.state.pages = [[raw("c1")], [raw("c1r", { parent: "c1", author: "나", mine: true, at: NOW - 500 })], [raw("c3", { at: NOW - 100 })]];
		await t.engine.collect({ force: true });
		expect(t.engine.needs().youtube!.unreplied).toBe(1);
		await t.engine.collect({ force: true });
		expect(t.engine.needs().youtube!.unreplied).toBe(0);
		await t.engine.collect({ force: true });
		expect(t.engine.needs().youtube!.unreplied).toBe(1);
	});

	test("답장 안 함 clears it, survives a reload of the store, and can be taken back", async () => {
		const t = setup();
		t.state.pages = [[raw("c1"), raw("c2")]];
		await t.engine.collect({ force: true });
		const off = await t.call("POST", `/api/comments/comment/${encodeURIComponent(c1)}/no-reply`);
		expect(off.status).toBe(200);
		expect(t.engine.needs().youtube!.unreplied).toBe(1);
		expect(t.events.some(e => e.kind === "comment" && e.thread === "p1")).toBe(true);
		const again = createEngine({ dir: join(dir, "comments"), now: () => NOW, collector: "mac-a", adapters: {}, model: async () => ({ text: "" }) });
		expect(again.needs().youtube!.unreplied).toBe(1);
		expect((await t.call("DELETE", `/api/comments/comment/${encodeURIComponent(c1)}/no-reply`)).status).toBe(200);
		expect(t.engine.needs().youtube!.unreplied).toBe(2);
		expect((await t.call("POST", "/api/comments/comment/cm:youtube:nope/no-reply")).status).toBe(404);
	});

	test("an old comment is history, not 미답장", async () => {
		const t = setup();
		t.state.pages = [[raw("old", { at: NOW - UNREPLIED_WINDOW_MS - 1000 })]];
		await t.engine.collect({ force: true });
		expect(t.engine.needs().youtube!.unreplied).toBe(0);
	});
});

describe("mail", () => {
	const key = `unrep-${Date.now().toString(36)}`;
	let n = 0;
	const add = (extra: object = {}) => {
		const k = `${key}-${++n}`;
		recordMail({ key: k, source: "zele", id: k, subject: "문의", from: "a@example.com", at: new Date(Date.now()).toISOString(), ...extra });
		return k;
	};
	const owed = (sent: string[] = []) => unrepliedMails(new Set(sent)).map(m => m.key);

	test("a mail with a reply draft is 미답장 and reading changes nothing; a plain mail is not", () => {
		const a = add({ suggest: { kind: "reply-draft", label: "답장 초안", ref: "d1", state: "draft" } });
		const b = add();
		const c = add({ needsReply: true });
		expect(owed()).toContain(a);
		expect(owed()).toContain(c);
		expect(owed()).not.toContain(b);
		expect(mailCard({ key: a, source: "zele", id: a, subject: "s", from: "f", at: "2026-10-23T00:00:00Z" }, true).unreplied).toBe(true);
		expect((mailCard({ key: b, source: "zele", id: b, subject: "s", from: "f", at: "2026-10-23T00:00:00Z" }) as Record<string, unknown>).unreplied).toBeUndefined();
	});
	test("a sent reply clears it: the reply state 'sent' or a sent draft for the mail", () => {
		const a = add({ suggest: { kind: "reply-draft", label: "답장 초안", ref: "d1", state: "draft" } });
		const b = add({ suggest: { kind: "reply-draft", label: "답장 초안", ref: "d2", state: "draft" } });
		setMailSuggest(a, { kind: "reply-draft", label: "답장 초안", ref: "d1", state: "sent" });
		expect(owed()).not.toContain(a);
		expect(owed(["x"])).toContain(b);
		expect(owed([b])).not.toContain(b);
	});
	test("답장 안 함 clears it and can be taken back; an unknown mail is refused", () => {
		const a = add({ needsReply: true });
		expect(setMailNoReply(a, true)).toBe(true);
		expect(owed()).not.toContain(a);
		expect(setMailNoReply(a, false)).toBe(true);
		expect(owed()).toContain(a);
		expect(setMailNoReply("nope-nope", true)).toBe(false);
	});
});

describe("kakao", () => {
	const DIRECT = String(ROOM.direct);
	const id = (n: number) => String(BASE_LOG + BigInt(n));
	let clock = (BASE_TIME + 100) * 1000;
	let writer: Database;
	const paths = () => kakaoPaths(dir, dir);

	function setup() {
		const p = paths();
		const dbPath = join(dir, "k.sqlite");
		writer = makeFixtureDb(dbPath);
		mkdirSync(dirname(p.config), { recursive: true });
		writeFileSync(p.config, JSON.stringify({ enabled: true, dbPath, userId: OWNER, watch_chats: [DIRECT] }));
		const events: Record<string, unknown>[] = [];
		const runner: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
		const db = sqliteDb(dbPath);
		const web = createKakaoWeb({ paths: p, runner, now: () => clock, openDb: async () => db, broadcast: e => events.push(e), collector: "mac-a" });
		const rooms = async () => {
			clock += 31_000;
			const url = new URL("http://local/api/kakao/rooms");
			const res = await web.route(new Request(url), url, ["api", "kakao", "rooms"]);
			return ((await res!.json()) as any).rooms.find((r: any) => r.chatId === DIRECT);
		};
		const call = async (method: string, path: string, body: unknown = {}) => {
			const url = new URL(`http://local${path}`);
			const res = await web.route(new Request(url, { method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), url, url.pathname.split("/").filter(Boolean));
			return res!.status;
		};
		return { web, rooms, call, events, close: () => (db.close(), writer.close()) };
	}
	beforeEach(() => {
		clock = (BASE_TIME + 100) * 1000;
	});

	test("the newest message is from someone else: 미답장; reading it keeps it", async () => {
		const t = setup();
		expect((await t.rooms()).unreplied).toBe(true);
		expect(await t.call("POST", `/api/kakao/chat/${DIRECT}/read`, { logId: id(3) })).toBe(200);
		expect((await t.rooms()).unreplied).toBe(true);
		expect(t.web.unrepliedCount()).toBe(1);
		t.close();
	});
	test("the owner's own message after it clears it (typed in KakaoTalk); a new message from them brings it back", async () => {
		const t = setup();
		expect((await t.rooms()).unreplied).toBe(true);
		addMessage(writer, { logId: BASE_LOG + 20n, chatId: ROOM.direct, authorId: OWNER, message: "답장해요", sentAt: BASE_TIME + 90 });
		expect((await t.rooms()).unreplied).toBe(false);
		addMessage(writer, { logId: BASE_LOG + 21n, chatId: ROOM.direct, authorId: 2001, message: "또 물어봐요", sentAt: BASE_TIME + 95 });
		expect((await t.rooms()).unreplied).toBe(true);
		t.close();
	});
	test("a reply sent from the web (a finished send record) clears it", async () => {
		const t = setup();
		expect((await t.rooms()).unreplied).toBe(true);
		const sends = join(dir, "kakao", "sends.json");
		mkdirSync(dirname(sends), { recursive: true });
		writeFileSync(sends, JSON.stringify([{ id: "s1", chatId: DIRECT, text: "ok", state: "sent", at: clock }]));
		expect((await t.rooms()).unreplied).toBe(false);
		t.close();
	});
	test("답장 안 함 clears the waiting message only, tells the other screens, and can be taken back", async () => {
		const t = setup();
		expect(await t.call("POST", `/api/kakao/chat/${DIRECT}/no-reply`)).toBe(200);
		expect((await t.rooms()).unreplied).toBe(false);
		expect(t.events.some(e => e.kind === "kakao_unreplied")).toBe(true);
		addMessage(writer, { logId: BASE_LOG + 22n, chatId: ROOM.direct, authorId: 2001, message: "다시요", sentAt: BASE_TIME + 96 });
		expect((await t.rooms()).unreplied).toBe(true);
		expect(await t.call("POST", `/api/kakao/chat/${DIRECT}/no-reply`)).toBe(200);
		expect((await t.rooms()).unreplied).toBe(false);
		expect(await t.call("DELETE", `/api/kakao/chat/${DIRECT}/no-reply`)).toBe(200);
		expect((await t.rooms()).unreplied).toBe(true);
		expect(await t.call("POST", `/api/kakao/chat/${String(ROOM.group)}/no-reply`)).toBe(403);
		t.close();
	});
});

describe("counts per app", () => {
	test("needs.unreplied adds the mails of the app, the comments and the app's own count; unread stays apart", () => {
		const ctx = integrationContext(dir, ["zele"]);
		const items = integrationItems(ctx, [], { "mail:a": 2 }, 100, undefined, [], NOW, { youtube: { drafts: 0, unread: 1, unreplied: 3 } }, { targets: ["mail:a", "mail:b"], apps: { kakao: 2 } });
		const by = (k: string) => items.find(i => i.key === k);
		expect(by("mail")?.needs).toMatchObject({ unread: 1, unreplied: 2 });   // one mail with 2 unread messages is one unread item
		expect(by("mail")?.unreplied).toBe(2);
		const none = integrationItems(ctx, [], {}, 100, undefined, [], NOW, {}, { targets: [], apps: {} });
		expect(none.every(i => i.needs.unreplied === 0)).toBe(true);
		expect(mailTarget("x")).toBe("mail:x");
	});
});
