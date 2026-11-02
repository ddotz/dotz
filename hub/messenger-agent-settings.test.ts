import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsError } from "./messenger.ts";
import { type AgentConfig, type AgentConn, type AgentTransport, agentConfigPath, createAgentAdapter, loadAgentConfig, saveAgentConfig, USER_TOKEN_NOTE } from "./messenger-agent.ts";

// The agent adapter's generic settings (설정 → 메신저): secrets are write-only, a refused body changes nothing, test() posts through the transport.
const BOT = "xoxb-bot-secret-token";
const USER = "xoxc-user-secret-token";
const COOKIE = "xoxd-cookie-secret";

const dirs: string[] = [];
const tmp = (p: string) => {
	const d = mkdtempSync(join(tmpdir(), p));
	dirs.push(d);
	return d;
};
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

class Fake implements AgentTransport {
	sent: { conn: string; chat: string; text: string }[] = [];
	polled: string[] = [];
	failChat?: string;
	listChats = async () => [];
	async poll(c: AgentConn, cursor?: string) {
		this.polled.push(c.id);
		return { messages: [], cursor: cursor ?? "c" };
	}
	async send(c: AgentConn, chat: string, text: string) {
		if (chat === this.failChat) throw new Error(`channel_not_found for token ${c.token}`);
		this.sent.push({ conn: c.id, chat, text });
		return String(this.sent.length);
	}
	react = async () => {};
}

const config = (): AgentConfig => ({
	enabled: true,
	connections: [
		{
			id: "work",
			platform: "slack",
			auth: "bot",
			token: BOT,
			allow: ["UOWNER"],
			chats: [
				{ id: "CMAIN", name: "메인", kind: "main" },
				{ id: "CPROJ", name: "결제", kind: "project", project: "ch:7" },
			],
		},
		{ id: "me", platform: "slack", auth: "user", token: USER, cookie: COOKIE, allow: ["UOWNER"], chats: [{ id: "CALERT", name: "알림", kind: "alert" }] },
	],
});

let dir: string;
let fake: Fake;
const make = () => {
	saveAgentConfig(config(), dir);
	return createAgentAdapter(dir, { transport: fake });
};
const raw = () => readFileSync(agentConfigPath(dir), "utf8");
const room = (a: ReturnType<typeof make>, id: string) => a.settings!().rooms!.items.find(r => r.id === id)!;

beforeEach(() => {
	dir = tmp("agent-settings-");
	fake = new Fake();
});

describe("GET", () => {
	test("describes every chat as a room and never carries a secret", () => {
		const s = make().settings!();
		const text = JSON.stringify(s);
		for (const secret of [BOT, USER, COOKIE]) expect(text).not.toContain(secret);
		expect(s.enabled).toBe(true);
		expect(s.allow?.items).toEqual(["UOWNER"]);
		expect(s.rooms!.items.map(r => [r.id, r.name, r.kind, r.values.connection, r.values.chat])).toEqual([
			["work:CMAIN", "메인", "main", "slack-bot", "CMAIN"],
			["work:CPROJ", "결제", "project", "slack-bot", "CPROJ"],
			["me:CALERT", "알림", "alert", "slack-user", "CALERT"],
		]);
		expect(room(make(), "work:CPROJ").project).toEqual({ target: "ch:7", name: "ch:7" });
		expect(room(make(), "work:CMAIN").set).toEqual({ bot_token: true, user_token: false, cookie: false });
		expect(room(make(), "me:CALERT").set).toEqual({ bot_token: false, user_token: true, cookie: true });
	});

	test("the user-token field is marked as the owner's own account and carries the note", () => {
		const f = make().settings!().rooms!.fields.find(x => x.key === "user_token")!;
		expect(f).toMatchObject({ type: "secret", as_user: true, hint: USER_TOKEN_NOTE });
		expect(make().settings!().rooms!.fields.filter(x => x.as_user).map(x => x.key)).toEqual(["user_token"]);
	});

	test("shows the last in/out/error of a chat from the transport", async () => {
		const a = make();
		fake.failChat = "CMAIN";
		await a.test!();
		expect(room(a, "work:CMAIN").last_error).toBeTruthy();
		expect(room(a, "work:CPROJ").last_out).toBeGreaterThan(0);
	});
});

describe("PUT", () => {
	test("omitting a secret keeps it, an empty string clears it, a value replaces it", () => {
		const a = make();
		a.saveSettings!({ rooms: [{ id: "work:CMAIN", name: "메인 2" }, { id: "work:CPROJ" }, { id: "me:CALERT", values: { cookie: "" } }] });
		let cfg = loadAgentConfig(dir);
		expect(cfg.connections.map(c => [c.id, c.token, c.cookie])).toEqual([["work", BOT, undefined], ["me", USER, undefined]]);
		expect(cfg.connections[0]!.chats.map(c => c.name)).toEqual(["메인 2", "결제"]);
		a.saveSettings!({ rooms: [{ id: "work:CMAIN", values: { bot_token: "" } }, { id: "work:CPROJ" }, { id: "me:CALERT", values: { user_token: "xoxc-new" } }] });
		cfg = loadAgentConfig(dir);
		expect(cfg.connections.map(c => [c.id, c.token])).toEqual([["work", ""], ["me", "xoxc-new"]]);
		expect(statSync(agentConfigPath(dir)).mode & 0o777).toBe(0o600);
	});

	test("the answer after a save has the set flags and still no secret", () => {
		const s = make().saveSettings!({ rooms: [{ name: "새 알림", kind: "alert", values: { connection: "telegram-bot", chat: "-100123", bot_token: "tg-secret:123" } }, { id: "work:CMAIN" }, { id: "work:CPROJ" }, { id: "me:CALERT" }] });
		expect(JSON.stringify(s)).not.toContain("tg-secret");
		const added = s.rooms!.items.find(r => r.values.chat === "-100123")!;
		expect(added).toMatchObject({ id: "telegram-bot:-100123", name: "새 알림", kind: "alert", values: { connection: "telegram-bot" }, set: { bot_token: true, user_token: false, cookie: false } });
		expect(loadAgentConfig(dir).connections.find(c => c.id === "telegram-bot")).toMatchObject({ platform: "telegram", auth: "bot", token: "tg-secret:123", allow: ["UOWNER"] });
	});

	test("enabled and the allow list apply to every connection", () => {
		const a = make();
		a.saveSettings!({ enabled: false, allow: ["U1", " U2 ", "U1"] });
		const cfg = loadAgentConfig(dir);
		expect(cfg.enabled).toBe(false);
		expect(cfg.connections.map(c => c.allow)).toEqual([["U1", "U2"], ["U1", "U2"]]);
		expect(cfg.connections.map(c => c.chats.length)).toEqual([2, 1]);
	});

	test("removing a connection's last chat removes the connection and its token", () => {
		make().saveSettings!({ rooms: [{ id: "work:CMAIN" }, { id: "work:CPROJ" }] });
		expect(loadAgentConfig(dir).connections.map(c => c.id)).toEqual(["work"]);
		expect(raw()).not.toContain(USER);
	});

	test("a refused body changes nothing", () => {
		const a = make();
		const before = raw();
		const bad: unknown[] = [
			{ rooms: [{ id: "work:CMAIN", name: "changed" }, { id: "nope:X" }] },
			{ rooms: [{ id: "work:CMAIN", name: "changed" }, { name: "x", kind: "main", values: { connection: "discord-bot", chat: "1" } }] },
			{ rooms: [{ id: "work:CMAIN", name: "changed" }, { name: "x", kind: "main", values: { connection: "slack-bot" } }] },
			{ rooms: [{ id: "work:CMAIN", name: "changed" }, { name: "x", kind: "project", values: { connection: "slack-bot", chat: "C9" } }] },
			{ rooms: [{ id: "work:CMAIN", name: "changed" }, { name: "x", kind: "main", values: { connection: "slack-bot", chat: "CMAIN" } }] },
			{ rooms: [{ id: "work:CMAIN", name: "changed" }, { name: "x", kind: "main", values: { connection: "slack-bot", chat: "C9", user_token: "xoxc-wrong" } }] },
			{ rooms: [{ id: "work:CMAIN", values: { bot_token: "one" } }, { id: "work:CPROJ", values: { bot_token: "two" } }] },
			{ rooms: [{ id: "work:CMAIN", values: { token: "x" } }] },
			{ rooms: "all" },
			{ enabled: "yes", rooms: [{ id: "work:CMAIN", name: "changed" }] },
			{ allow: [1], rooms: [{ id: "work:CMAIN", name: "changed" }] },
			{ values: { port: 1 }, rooms: [{ id: "work:CMAIN", name: "changed" }] },
		];
		for (const b of bad) {
			expect(() => a.saveSettings!(b as never)).toThrow(SettingsError);
			expect(raw()).toBe(before);
		}
	});
});

describe("availability", () => {
	test("hidden without the SDK and without any CLI, shown with an injected transport", () => {
		const path = process.env.PATH;
		process.env.PATH = tmp("agent-empty-path-");
		try {
			expect(createAgentAdapter(dir).hidden!()).toBe(true);
			expect(createAgentAdapter(dir, { transport: fake }).hidden!()).toBe(false);
		} finally {
			process.env.PATH = path;
		}
	});
});

describe("test()", () => {
	test("posts one short message per chat through the transport", async () => {
		const r = await make().test!();
		expect(fake.sent.map(s => [s.conn, s.chat])).toEqual([["work", "CMAIN"], ["work", "CPROJ"], ["me", "CALERT"]]);
		expect(new Set(fake.sent.map(s => s.text)).size).toBe(1);
		expect(fake.sent[0]!.text.length).toBeLessThan(40);
		expect(r.results).toEqual([
			{ id: "work:CMAIN", name: "메인", ok: true },
			{ id: "work:CPROJ", name: "결제", ok: true },
			{ id: "me:CALERT", name: "알림", ok: true },
		]);
	});

	test("a failing chat reports an error without the token, the others still go out", async () => {
		fake.failChat = "CPROJ";
		const r = await make().test!();
		const failed = r.results.find(x => !x.ok)!;
		expect(failed).toMatchObject({ id: "work:CPROJ", ok: false });
		expect(failed.error).toContain("channel_not_found");
		for (const secret of [BOT, USER, COOKIE]) expect(JSON.stringify(r)).not.toContain(secret);
		expect(r.results.filter(x => x.ok).length).toBe(2);
	});
});

describe("running adapter", () => {
	test("a connection added through the settings starts polling without a restart", async () => {
		const a = make();
		await a.start({ receive() {}, log() {} });
		await a.pollNow();
		expect(new Set(fake.polled)).toEqual(new Set(["work", "me"]));
		a.saveSettings!({ rooms: [{ id: "work:CMAIN" }, { id: "work:CPROJ" }, { id: "me:CALERT" }, { name: "t", kind: "main", values: { connection: "telegram-bot", chat: "42" } }] });
		fake.polled = [];
		await a.pollNow();
		expect(fake.polled).toContain("telegram-bot");
		await a.stop();
	});
});
