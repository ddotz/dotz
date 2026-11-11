import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsError } from "./messenger.ts";
import { desiredRooms } from "./messenger-rooms.ts";
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
	channels: { id: string; name: string }[] = [];
	created: string[] = [];
	canCreate = false;
	sent: { conn: string; chat: string; text: string }[] = [];
	polled: string[] = [];
	failChat?: string;
	listChats = async () => this.channels;
	createChat?: AgentTransport["createChat"];
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
const makeCreating = () => {
	fake.createChat = async (_c, name) => {
		fake.created.push(name);
		return { id: `N${fake.created.length}`, name };
	};
};

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

const PROJECTS = [{ target: "ch:7", name: "결제" }, { target: "ch:8", name: "정산" }];
const chatsOf = (id: string) => loadAgentConfig(dir).connections.find(c => c.id === id)!.chats.map(c => [c.kind, c.project ?? "", c.id]);
const slackOnly = (over: Partial<AgentConfig> = {}): AgentConfig => ({ enabled: true, connections: [{ id: "slack-bot", platform: "slack", auth: "bot", token: BOT, allow: ["UOWNER"], chats: [] }], ...over });

describe("rooms from the web structure", () => {
	test("switching it on creates the missing channels for main, alert, worklog and every project when the transport can", async () => {
		makeCreating();
		saveAgentConfig(slackOnly(), dir);
		const a = createAgentAdapter(dir, { transport: fake });
		await a.syncRooms!(desiredRooms(PROJECTS));
		expect(fake.created).toEqual(["dotz", "dotz-알림", "dotz-작업내역", "dotz-결제", "dotz-정산"]);
		expect(chatsOf("slack-bot")).toEqual([["main", "", "N1"], ["alert", "", "N2"], ["worklog", "", "N3"], ["project", "ch:7", "N4"], ["project", "ch:8", "N5"]]);
		expect(a.enabled()).toBe(true);
		expect(a.settings!().rooms!.hint).toBeUndefined();
		await a.syncRooms!(desiredRooms(PROJECTS));
		expect(fake.created).toHaveLength(5);
	});

	test("without channel creation it maps channels of the same name and keeps the owner's chats", async () => {
		fake.channels = [{ id: "CD", name: "dotz" }, { id: "CP", name: "dotz-결제" }, { id: "COTHER", name: "random" }];
		saveAgentConfig(slackOnly({ connections: [{ ...slackOnly().connections[0]!, chats: [{ id: "CMINE", name: "내 알림", kind: "alert" }] }] }), dir);
		const a = createAgentAdapter(dir, { transport: fake });
		await a.syncRooms!(desiredRooms(PROJECTS));
		expect(chatsOf("slack-bot")).toEqual([["alert", "", "CMINE"], ["main", "", "CD"], ["project", "ch:7", "CP"]]);
		expect(fake.created).toEqual([]);
	});

	test("removing a project drops its mapped chat and leaves the channel alone; a new project is mapped", async () => {
		makeCreating();
		saveAgentConfig(slackOnly(), dir);
		const a = createAgentAdapter(dir, { transport: fake });
		await a.syncRooms!(desiredRooms(PROJECTS));
		await a.syncRooms!(desiredRooms([PROJECTS[1]!, { target: "ch:9", name: "신규" }]));
		expect(chatsOf("slack-bot").filter(c => c[0] === "project")).toEqual([["project", "ch:8", "N5"], ["project", "ch:9", "N6"]]);
		expect(fake.created.at(-1)).toBe("dotz-신규");
	});

	test("it does nothing while switched off, and a transport error leaves the rest mapped", async () => {
		saveAgentConfig(slackOnly({ enabled: false }), dir);
		makeCreating();
		const off = createAgentAdapter(dir, { transport: fake });
		await off.syncRooms!(desiredRooms(PROJECTS));
		expect(fake.created).toEqual([]);
		saveAgentConfig(slackOnly(), dir);
		fake.createChat = async (_c, name) => {
			if (name === "dotz-알림") throw new Error(`name_taken ${BOT}`);
			return { id: `X-${name}`, name };
		};
		const a = createAgentAdapter(dir, { transport: fake });
		await a.syncRooms!(desiredRooms(PROJECTS.slice(0, 1)));
		expect(chatsOf("slack-bot")).toEqual([["main", "", "X-dotz"], ["worklog", "", "X-dotz-작업내역"], ["project", "ch:7", "X-dotz-결제"]]);
	});

	test("the one thing left is a line in the rooms payload: the token, then Telegram's chat id", () => {
		const none = createAgentAdapter(tmp("agent-empty-"), { transport: fake });
		expect(none.settings!().rooms!.hint).toContain("봇 토큰");
		saveAgentConfig(slackOnly(), dir);
		expect(createAgentAdapter(dir, { transport: fake }).settings!().rooms!.hint).toContain("dotz 채널");
		saveAgentConfig({ enabled: true, connections: [{ id: "telegram-bot", platform: "telegram", auth: "bot", token: "123:abc", allow: [], chats: [] }] }, dir);
		const tg = createAgentAdapter(dir, { transport: fake });
		expect(tg.settings!().rooms!.hint).toContain("Telegram 채팅 ID");
		tg.saveSettings!({ values: { telegram_chat: "-1001" } });
		expect(chatsOf("telegram-bot")).toEqual([["main", "", "-1001"]]);
		expect(tg.settings!().rooms!.hint).toBeUndefined();
		expect(tg.settings!().fields.find(f => f.key === "telegram_chat")?.value).toBe("-1001");
	});

	test("tokens come in as top-level values: omitted keeps, \"\" clears, and no secret is ever returned", () => {
		const a = createAgentAdapter(dir, { transport: fake });
		a.saveSettings!({ enabled: true, allow: ["UOWNER"], values: { slack_bot_token: BOT, slack_user_token: USER, slack_cookie: COOKIE } });
		const cfg = loadAgentConfig(dir);
		expect(cfg.connections.map(c => [c.id, c.token, c.cookie ?? "", c.allow])).toEqual([["slack-bot", BOT, "", ["UOWNER"]], ["slack-user", USER, COOKIE, ["UOWNER"]]]);
		expect(a.settings!().fields.filter(f => f.type === "secret").map(f => [f.key, f.set])).toEqual([["slack_bot_token", true], ["slack_user_token", true], ["slack_cookie", true], ["telegram_bot_token", false]]);
		for (const secret of [BOT, USER, COOKIE]) expect(JSON.stringify(a.settings!())).not.toContain(secret);
		a.saveSettings!({ values: { slack_cookie: "" } });
		expect(loadAgentConfig(dir).connections.find(c => c.id === "slack-user")).toMatchObject({ token: USER });
		expect(loadAgentConfig(dir).connections.find(c => c.id === "slack-user")!.cookie).toBeUndefined();
		a.saveSettings!({ values: { slack_user_token: "" } });
		expect(loadAgentConfig(dir).connections.map(c => c.id)).toEqual(["slack-bot"]);
		expect(() => a.saveSettings!({ values: { port: 1 } })).toThrow(SettingsError);
		expect(() => a.saveSettings!({ values: { slack_bot_token: 5 } })).toThrow(SettingsError);
	});

	test("an old config file keeps loading and its chats stay after a sync", async () => {
		saveAgentConfig(config(), dir);
		const a = createAgentAdapter(dir, { transport: fake });
		await a.syncRooms!(desiredRooms([{ target: "ch:7", name: "결제" }]));
		expect(chatsOf("work")).toEqual([["main", "", "CMAIN"], ["project", "ch:7", "CPROJ"]]);
		expect(chatsOf("me")).toEqual([["alert", "", "CALERT"]]);
		expect(loadAgentConfig(dir).connections.map(c => [c.id, c.token])).toEqual([["work", BOT], ["me", USER]]);
	});
});
