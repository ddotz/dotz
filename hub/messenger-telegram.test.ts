import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Incoming, Settings } from "./messenger.ts";
import { createTelegramAdapter, loadTelegramConfig, saveTelegramConfig, telegramConfigPath } from "./messenger-telegram.ts";

const TOKEN = "123456789:test-token-not-real";
const dirs: string[] = [];

const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "telegram-test-"));
	dirs.push(dir);
	return dir;
};

type Call = { method: string; body: any };
type Fake = { calls: Call[]; fetch: typeof fetch };

function telegramFetch(options: { updates?: unknown[]; rejectGetMe?: boolean; apiError?: boolean } = {}): Fake {
	const calls: Call[] = [];
	const doFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const method = String(input).split("/").pop() ?? "";
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		calls.push({ method, body });
		if (options.rejectGetMe) throw new Error(`network failed for ${TOKEN}`);
		if (options.apiError) return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
		if (method === "getMe") return Response.json({ ok: true, result: { id: 7, is_bot: true, username: "dotz_bot" } });
		if (method === "getUpdates") {
			const offset = Number(body.offset ?? -Infinity);
			return Response.json({ ok: true, result: (options.updates ?? []).filter(u => Number((u as { update_id?: number }).update_id) >= offset) });
		}
		if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 100 + calls.length, chat: { id: body.chat_id } } });
		return Response.json({ ok: false, description: "unknown method" }, { status: 404 });
	};
	return { calls, fetch: doFetch as typeof fetch };
}

const ctx = (received: Incoming[]) => ({ receive: (m: Incoming) => received.push(m), log: () => {} });

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("telegram messenger", () => {
	test("the config is written 0600 and the settings show the token only as set", () => {
		const dir = tempDir();
		const a = createTelegramAdapter(dir, { fetch: telegramFetch().fetch });
		const seen = a.saveSettings!({ enabled: true, values: { token: TOKEN, main: "123456789" }, allow: ["42", "42"] }) as Settings;
		expect(statSync(telegramConfigPath(dir)).mode & 0o777).toBe(0o600);
		expect(loadTelegramConfig(dir)).toMatchObject({ enabled: true, token: TOKEN, allow: ["42"] });
		expect(JSON.parse(readFileSync(telegramConfigPath(dir), "utf8")).token).toBe(TOKEN);
		expect(JSON.stringify(seen)).not.toContain(TOKEN);
		const token = seen.fields.find(f => f.key === "token")!;
		expect(token).toMatchObject({ type: "secret", set: true });
		expect(token).not.toHaveProperty("value");
		expect(a.configured!()).toBe(true);
	});

	test("start verifies getMe and reports ok or a scrubbed error", async () => {
		const okDir = tempDir();
		const okFake = telegramFetch();
		const a = createTelegramAdapter(okDir, { fetch: okFake.fetch, pollMs: 60_000 });
		a.saveSettings!({ enabled: true, values: { token: TOKEN, main: "123456789" }, allow: ["42"] });
		await a.start(ctx([]));
		try {
			expect(a.status.state).toBe("ok");
			expect(okFake.calls[0]!.method).toBe("getMe");
		} finally {
			a.stop();
		}

		const badDir = tempDir();
		const bad = createTelegramAdapter(badDir, { fetch: telegramFetch({ rejectGetMe: true }).fetch, pollMs: 60_000 });
		bad.saveSettings!({ enabled: true, values: { token: TOKEN, main: "123456789" }, allow: ["42"] });
		await bad.start(ctx([]));
		expect(bad.status.state).toBe("error");
		expect(bad.status.error).toContain("***");
		expect(bad.status.error).not.toContain(TOKEN);
		bad.stop();

		const apiDir = tempDir();
		const refused = createTelegramAdapter(apiDir, { fetch: telegramFetch({ apiError: true }).fetch, pollMs: 60_000 });
		refused.saveSettings!({ enabled: true, values: { token: TOKEN, main: "123456789" } });
		await refused.start(ctx([]));
		expect(refused.status.state).toBe("error");
		expect(refused.status.error).toBe("Unauthorized");
		refused.stop();
	});

	test("deliver sends to the chat of the message kind, and a project falls back to main", async () => {
		const dir = tempDir();
		saveTelegramConfig(
			{
				enabled: true,
				token: TOKEN,
				chats: [
					{ id: "111", name: "dotz", kind: "main" },
					{ id: "-222", name: "dotz-알림", kind: "alert" },
					{ id: "-333", name: "dotz-site", kind: "project", project: "ch:9" },
				],
				allow: [],
			},
			dir,
		);
		const fake = telegramFetch();
		const a = createTelegramAdapter(dir, { fetch: fake.fetch, pollMs: 60_000 });
		const alert = await a.deliver({ target: "alert", kind: "alert", text: "알림 본문" });
		expect(alert.delivered).toBe(true);
		expect(fake.calls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: "-222", text: "알림 본문" } });

		const project = await a.deliver({ target: "ch:9", kind: "project", text: "프로젝트 본문" });
		expect(project.delivered).toBe(true);
		expect(fake.calls[1]!.body.chat_id).toBe("-333");

		const other = await a.deliver({ target: "ch:404", kind: "project", text: "다른 프로젝트" });
		expect(other.delivered).toBe(true);
		expect(fake.calls[2]!.body.chat_id).toBe("111");
	});

	test("a poll takes only allow-listed authors' text messages and persists the offset", async () => {
		const dir = tempDir();
		const updates = [
			{ update_id: 10, message: { message_id: 1, text: "안녕", from: { id: 42 }, chat: { id: 111 } } },
			{ update_id: 11, message: { message_id: 2, text: "남의 말", from: { id: 43 }, chat: { id: 111 } } },
			{ update_id: 12, message: { message_id: 3, photo: [{ file_id: "x" }], from: { id: 42 }, chat: { id: 111 } } },
			{ update_id: 13, message: { message_id: 4, text: "알림방", from: { id: 42 }, chat: { id: -222 } } },
		];
		const fake = telegramFetch({ updates });
		const a = createTelegramAdapter(dir, { fetch: fake.fetch, pollMs: 60_000 });
		a.saveSettings!({ enabled: true, values: { token: TOKEN, main: "111", alert: "-222" }, allow: ["42"] });
		const received: Incoming[] = [];
		await a.start(ctx(received));
		await a.pollNow();
		a.stop();

		expect(received).toEqual([
			{ adapter: "telegram", target: "main", text: "안녕", author: "42", messageId: "1" },
			{ adapter: "telegram", target: "alert", text: "알림방", author: "42", messageId: "4" },
		]);
		expect(loadTelegramConfig(dir).cursor).toBe(14);
		const polls = fake.calls.filter(c => c.method === "getUpdates");
		expect(polls).toHaveLength(1);
		expect(polls[0]!.body).toMatchObject({ limit: 100, timeout: 0 });

		await a.start(ctx(received));
		await a.pollNow();
		a.stop();
		const second = fake.calls.filter(c => c.method === "getUpdates");
		expect(second[1]!.body).toMatchObject({ offset: 14, limit: 100, timeout: 0 });
		expect(received).toHaveLength(2);

		const settings = a.settings!() as Settings;
		expect(JSON.stringify(settings)).not.toContain(TOKEN);
	});

	test("a refused body changes nothing", () => {
		const dir = tempDir();
		const a = createTelegramAdapter(dir, { fetch: telegramFetch().fetch });
		a.saveSettings!({ enabled: true, values: { token: TOKEN, main: "111" }, allow: ["42"] });
		const before = readFileSync(telegramConfigPath(dir), "utf8");
		for (const bad of [{ values: { token: "not-a-token" } }, { values: { main: "bad id!" } }, { values: { nope: "x" } }, { allow: [1] }, { enabled: "yes" }]) {
			expect(() => a.saveSettings!(bad as never)).toThrow();
		}
		expect(readFileSync(telegramConfigPath(dir), "utf8")).toBe(before);
	});
});

describe("telegram web link", () => {
	const LINK = "https://dotz.example.com/#chat/main";
	test("a link rides as one inline URL button; a message without one has no keyboard", async () => {
		const dir = tempDir();
		saveTelegramConfig({ enabled: true, token: TOKEN, chats: [{ id: "111", name: "main", kind: "main" }], allow: [] }, dir);
		const fake = telegramFetch();
		const a = createTelegramAdapter(dir, { fetch: fake.fetch, pollMs: 60_000 });
		expect(a.ownsLink).toBe(true);
		await a.deliver({ target: "main", kind: "main", text: "끝났어요", link: LINK });
		await a.deliver({ target: "main", kind: "main", text: "링크 없음" });
		expect(fake.calls[0]!.body).toEqual({ chat_id: "111", text: "끝났어요", reply_markup: { inline_keyboard: [[{ text: "웹에서 보기", url: LINK }]] } });
		expect(fake.calls[1]!.body).toEqual({ chat_id: "111", text: "링크 없음" });
	});
});
