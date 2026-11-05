import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOnboarding, type OnboardDeps, type OnboardView } from "./onboarding.ts";

const SLACK = "xoxb-not-a-real-token";
const TELEGRAM = "123456789:test-token-not-real";

type BrowserCall = { action: string; arg?: Record<string, unknown> };
type BrowserResult = { ok: boolean; value?: string; waiting?: string; data?: Record<string, unknown> };

const dirs: string[] = [];
const temp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "onboard-chat-"));
	dirs.push(dir);
	return dir;
};

function browser(queue: Record<string, BrowserResult[]> = {}): { calls: BrowserCall[]; run: (action: string, arg?: Record<string, unknown>) => Promise<BrowserResult> } {
	const calls: BrowserCall[] = [];
	return {
		calls,
		async run(action, arg) {
			calls.push({ action, ...(arg ? { arg } : {}) });
			return queue[action]?.shift() ?? { ok: false };
		},
	};
}

type Visible = { id: string; name: string; is_member?: boolean; is_private?: boolean };
const VISIBLE: Visible[] = [
	{ id: "C0MAIN1234", name: "dotz" },
	{ id: "C0ALERT123", name: "dotz-알림" },
	{ id: "C0WORK1234", name: "dotz-작업" },
];

function slackFetch(channels: Visible[] = VISIBLE, denyScope = false): { calls: string[]; bodies: Record<string, string[]>; fetch: typeof fetch } {
	const calls: string[] = [];
	const bodies: Record<string, string[]> = {};
	const doFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = url.split("/api/")[1] ?? "";
		calls.push(method);
		(bodies[method] ??= []).push(String(init?.body ?? ""));
		if (method === "auth.test") return Response.json({ ok: true, user_id: "U0BOT" });
		if (method === "conversations.list") return Response.json({ ok: true, channels });
		if ((method === "conversations.join" || method === "conversations.create") && denyScope) return Response.json({ ok: false, error: "missing_scope" });
		if (method === "conversations.join") return Response.json({ ok: true });
		if (method === "conversations.create") return Response.json({ ok: true, channel: { id: `C0NEW${calls.length}`, name: new URLSearchParams(String(init?.body)).get("name") } });
		return Response.json({ ok: false, error: "unknown_method" });
	};
	return { calls, bodies, fetch: doFetch as typeof fetch };
}

function telegramFetch(updates: unknown[] = [], token = TELEGRAM): { calls: string[]; fetch: typeof fetch } {
	const calls: string[] = [];
	const doFetch = async (input: RequestInfo | URL) => {
		const method = String(input).split("/").pop() ?? "";
		calls.push(method);
		if (method === "getMe") return Response.json({ ok: true, result: { id: 7, username: "dotz_bot" } });
		if (method === "getUpdates") return Response.json({ ok: true, result: updates });
		return Response.json({ ok: false, description: `unknown ${method} for ${token}` }, { status: 404 });
	};
	return { calls, fetch: doFetch as typeof fetch };
}

function service(dir: string, b: ReturnType<typeof browser>, fetchImpl: typeof fetch): ReturnType<typeof createOnboarding> {
	const deps: OnboardDeps = { dir, fetch: fetchImpl, browser: b, exec: async () => ({ code: 0, out: "" }), restart: async () => {} };
	return createOnboarding(deps);
}

async function start(svc: ReturnType<typeof createOnboarding>, key: "slack" | "telegram"): Promise<OnboardView> {
	svc.start(key);
	await svc.idle(key);
	return svc.view(key);
}

async function cont(svc: ReturnType<typeof createOnboarding>, key: "slack" | "telegram"): Promise<OnboardView> {
	svc.continue(key);
	await svc.idle(key);
	return svc.view(key);
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("slack onboarding", () => {
	test("the first click only names the login step; continue reads the token, stores it 0600 and maps channels", async () => {
		const dir = temp();
		const b = browser({ "slack-app": [{ ok: true, data: { token: SLACK } }] });
		const net = slackFetch();
		const svc = service(dir, b, net.fetch);

		const waiting = await start(svc, "slack");
		expect(waiting.state).toBe("waiting");
		expect(waiting.step?.id).toBe("token");
		expect(waiting.owner?.label).toContain("Slack");
		expect(b.calls).toEqual([]);

		const done = await cont(svc, "slack");
		expect(done.state).toBe("done");
		expect(b.calls.map(c => c.action)).toEqual(["slack-app"]);
		expect(net.calls).toContain("auth.test");
		expect(net.calls).toContain("conversations.list");
		const secret = join(dir, "secrets", "slack-bot-token");
		expect(readFileSync(secret, "utf8").trim()).toBe(SLACK);
		expect(statSync(secret).mode & 0o777).toBe(0o600);
		const cfgFile = join(dir, "messengers", "slack.json");
		expect(statSync(cfgFile).mode & 0o777).toBe(0o600);
		const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
		expect(cfg.enabled).toBe(true);
		expect(cfg.channels.map((c: { kind: string }) => c.kind)).toEqual(["main", "alert", "worklog"]);
		expect(readFileSync(join(dir, "onboarding", "slack.json"), "utf8")).not.toContain(SLACK);
		expect(JSON.stringify(done)).not.toContain(SLACK);
	});

	test("an existing token needs no browser and no owner step", async () => {
		const dir = temp();
		const b = browser();
		const net = slackFetch();
		mkdirSync(join(dir, "messengers"), { recursive: true });
		writeFileSync(join(dir, "messengers", "slack.json"), `${JSON.stringify({ enabled: false, token: SLACK, channels: [], allow: [] })}\n`, { mode: 0o600 });
		const svc = service(dir, b, net.fetch);
		const done = await start(svc, "slack");
		expect(done.state).toBe("done");
		expect(done.owner).toBeNull();
		expect(b.calls).toEqual([]);
		expect(net.calls).toContain("conversations.list");
	});
});

describe("slack channels", () => {
	const withToken = (net: ReturnType<typeof slackFetch>) => {
		const dir = temp();
		mkdirSync(join(dir, "messengers"), { recursive: true });
		writeFileSync(join(dir, "messengers", "slack.json"), `${JSON.stringify({ enabled: false, token: SLACK, channels: [], allow: [] })}\n`, { mode: 0o600 });
		return { dir, svc: service(dir, browser(), net.fetch) };
	};
	const saved = (dir: string) => JSON.parse(readFileSync(join(dir, "messengers", "slack.json"), "utf8"));

	test("a public channel the bot is not in yet is joined, a private one is not", async () => {
		const net = slackFetch([{ id: "C0PUB11111", name: "dotz", is_member: false }, { id: "G0PRIV1111", name: "dotz-alert", is_member: false, is_private: true }]);
		const { dir, svc } = withToken(net);
		expect((await start(svc, "slack")).state).toBe("done");
		expect(net.calls.filter(c => c === "conversations.join")).toHaveLength(1);
		expect(net.bodies["conversations.join"]![0]).toContain("C0PUB11111");
		expect(saved(dir).channels.map((c: { kind: string }) => c.kind)).toEqual(["main", "alert"]);
	});

	test("with no usable channel it creates main, alert and worklog named after the bot", async () => {
		const net = slackFetch([]);
		const { dir, svc } = withToken(net);
		expect((await start(svc, "slack")).state).toBe("done");
		const channels = saved(dir).channels as { kind: string; name: string }[];
		expect(channels.map(c => c.kind)).toEqual(["main", "alert", "worklog"]);
		expect(channels.map(c => c.name.split("-").pop())).toEqual(["main", "alert", "worklog"]);
		expect(channels.every(c => /^[a-z0-9_-]+$/.test(c.name))).toBe(true);
	});

	test("an older app without the new scopes falls back to the owner step and saves no channel", async () => {
		const { dir, svc } = withToken(slackFetch([], true));
		const view = await start(svc, "slack");
		expect(view.state).toBe("waiting");
		expect(view.step?.id).toBe("channels");
		expect(saved(dir).channels).toEqual([]);
	});
});

describe("telegram onboarding", () => {
	test("token via BotFather, then one owner start step until getUpdates has the chat", async () => {
		const dir = temp();
		const b = browser({ "telegram-bot": [{ ok: true, data: { token: TELEGRAM } }] });
		const empty = telegramFetch([]);
		const svc = service(dir, b, empty.fetch);

		const waiting = await start(svc, "telegram");
		expect(waiting.state).toBe("waiting");
		expect(waiting.step?.id).toBe("token");

		const chat = await cont(svc, "telegram");
		expect(chat.state).toBe("waiting");
		expect(chat.step?.id).toBe("chat");
		expect(chat.owner?.label).toContain("시작");

		const secret = join(dir, "secrets", "telegram-bot-token");
		expect(readFileSync(secret, "utf8").trim()).toBe(TELEGRAM);
		expect(statSync(secret).mode & 0o777).toBe(0o600);
		expect(JSON.stringify(chat)).not.toContain(TELEGRAM);

		const updates = [{ update_id: 12, message: { message_id: 1, text: "안녕", from: { id: 42 }, chat: { id: 111, type: "private" } } }];
		const withChat = service(dir, b, telegramFetch(updates).fetch);
		const done = await cont(withChat, "telegram");
		expect(done.state).toBe("done");
		const cfg = JSON.parse(readFileSync(join(dir, "messengers", "telegram.json"), "utf8"));
		expect(cfg.enabled).toBe(true);
		expect(cfg.chats[0]).toMatchObject({ id: "111", kind: "main" });
		expect(cfg.allow).toEqual(["42"]);
		expect(readFileSync(join(dir, "onboarding", "telegram.json"), "utf8")).not.toContain(TELEGRAM);
	});
});
