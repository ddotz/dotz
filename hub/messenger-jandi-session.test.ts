import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAME } from "./config.ts";
import { msg } from "./i18n.ts";
import { createJandiAdapter, type JandiAdapter, saveJandiConfig } from "./messenger-jandi.ts";
import type { OutMsg } from "./messenger.ts";

const SELF = { enabled: true, team_id: 11, room_id: 115, member_id: 21, bot_id: 111, keyword: "dotz", reply_prefix: "[봇]", session_secret: "jandi-session", interval_ms: 3000 };
const realFetch = globalThis.fetch;
let dir: string;
let adapter: JandiAdapter | undefined;
let posts: { path: string; body: { text?: string } }[];
let tokenStatus: number;
let hooks: string[];
let hookServer: ReturnType<typeof Bun.serve>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jandi-session-"));
	mkdirSync(join(dir, "secrets"));
	writeFileSync(join(dir, "secrets", "jandi-session"), JSON.stringify({ refresh_token: "rt-1" }), { mode: 0o600 });
	posts = [];
	hooks = [];
	tokenStatus = 200;
	hookServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => (hooks.push(await req.text()), new Response("{}")) });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.hostname !== "i1.jandi.com") return realFetch(input, init);
		if (url.pathname === "/inner-api/token") return tokenStatus === 200 ? Response.json({ access_token: "at", expires_in: 3600 }) : new Response(null, { status: tokenStatus });
		if (url.pathname.includes("/message-api/v3/")) {
			posts.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
			return Response.json({});
		}
		if (url.pathname.startsWith("/room-api/")) return Response.json({ type: "chat", companionId: SELF.bot_id, members: [SELF.member_id] });
		return Response.json({ lastLinkId: 0, records: [] });
	}) as typeof fetch;
});
afterEach(async () => {
	await adapter?.stop();
	adapter = undefined;
	globalThis.fetch = realFetch;
	hookServer.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

const config = (room: { incoming_url: string }, self: Partial<typeof SELF> | null = {}) =>
	saveJandiConfig({ enabled: true, listen: { host: "127.0.0.1", port: 0 }, allow_emails: [], rooms: [{ id: "m1", name: "메인", kind: "main", outgoing_token: "", ...room }], ...(self ? { self_chat: { ...SELF, ...self } } : {}) }, dir);
const post = (over: Partial<OutMsg> = {}): OutMsg => ({ target: "main", kind: "main", text: "안녕하세요", ...over });
async function start(alerts: string[] = []) {
	adapter = createJandiAdapter(dir);
	await adapter.start({ receive: () => {}, log: () => {}, alert: t => void alerts.push(t) });
	return adapter;
}

describe("replies through the owner's session", () => {
	test("a main room with no webhook posts as the owner, always behind the reply prefix", async () => {
		config({ incoming_url: "" });
		const a = await start();
		expect(await a.deliver(post())).toEqual({ delivered: true });
		expect(posts).toHaveLength(1);
		expect(posts[0]!.path).toBe("/message-api/v3/teams/11/rooms/115/messages");
		expect(posts[0]!.body.text).toBe("[봇] 안녕하세요");
	});

	test("without a configured prefix the post still begins with [NAME]", async () => {
		config({ incoming_url: "" }, { reply_prefix: "" });
		const a = await start();
		await a.deliver(post());
		expect(posts[0]!.body.text?.startsWith(`[${NAME}] `)).toBe(true);
	});

	test("an alert goes to the main room too, the worklog stays out", async () => {
		config({ incoming_url: "" });
		const a = await start();
		expect((await a.deliver(post({ kind: "alert", target: "alert", text: "[fail] 멈췄어요" }))).delivered).toBe(true);
		expect((await a.deliver(post({ kind: "worklog", target: "worklog", text: "기록" }))).delivered).toBe(false);
		expect(posts).toHaveLength(1);
	});

	test("a webhook, when there is one, keeps winning", async () => {
		config({ incoming_url: `http://127.0.0.1:${hookServer.port}/in` });
		const a = await start();
		expect((await a.deliver(post())).delivered).toBe(true);
		expect(posts).toEqual([]);
		expect(hooks).toHaveLength(1);
	});
});

describe("a lost session", () => {
	test("raises one plain alert, marks the loss, and the settings row says lost", async () => {
		config({ incoming_url: "" });
		tokenStatus = 401;
		const alerts: string[] = [];
		const raised = new Promise<void>(res => {
			const original = alerts.push.bind(alerts);
			alerts.push = (...t: string[]) => (res(), original(...t));
		});
		const a = await start(alerts);
		await raised;
		expect(alerts).toEqual([msg().connect.expiry.alert]);
		expect(existsSync(join(dir, "messengers", "jandi-session.json"))).toBe(true);
		expect(a.settings!().self_chat).toMatchObject({ state: "lost", label: msg().connect.expiry.lost.label, connect: msg().connect.expiry.reconnect });
	});

	test("a connected install says ok and a never-connected one says off with the connect button", async () => {
		config({ incoming_url: "" });
		expect((await start()).settings!().self_chat).toMatchObject({ state: "ok", label: msg().connect.expiry.ok.label });
		await adapter!.stop();
		config({ incoming_url: "" }, null);
		expect((await start()).settings!().self_chat).toMatchObject({ state: "off", connect: msg().connect.expiry.connect });
	});
});
