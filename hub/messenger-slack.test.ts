import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "./messenger.ts";
import { createSlackAdapter, loadSlackConfig, saveSlackConfig, slackConfigPath } from "./messenger-slack.ts";

const TOKEN = "xoxb-not-a-real-token";
const dirs: string[] = [];

const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "slack-test-"));
	dirs.push(dir);
	return dir;
};

type Call = { method: string; auth: string | null; body: URLSearchParams };
type Fake = { calls: Call[]; fetch: typeof fetch };

function slackFetch(options: { reject?: boolean; apiError?: boolean } = {}): Fake {
	const calls: Call[] = [];
	const doFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const method = String(input).split("/api/")[1] ?? "";
		const body = new URLSearchParams(String(init?.body ?? ""));
		calls.push({ method, auth: new Headers(init?.headers).get("authorization"), body });
		if (options.reject) throw new Error(`network failed for ${TOKEN}`);
		if (options.apiError) return Response.json({ ok: false, error: "invalid_auth" });
		if (method === "auth.test") return Response.json({ ok: true, user_id: "U0BOT" });
		if (method === "chat.postMessage") return Response.json({ ok: true, ts: `ts-${calls.length}`, channel: body.get("channel") });
		return Response.json({ ok: false, error: "unknown_method" });
	};
	return { calls, fetch: doFetch as typeof fetch };
}

const ctx = () => ({ receive: () => {}, log: () => {} });

function setup(dir: string, values: Record<string, string> = {}, fake: Fake = slackFetch()) {
	const a = createSlackAdapter(dir, { fetch: fake.fetch });
	a.saveSettings!({ enabled: true, values: { token: TOKEN, main: "C0MAIN1234", alert: "C0ALERT123", ...values }, allow: ["U1"] });
	return { a, fake };
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("slack messenger", () => {
	test("the config is written 0600 and the settings show the token only as set", () => {
		const dir = tempDir();
		const a = createSlackAdapter(dir, { fetch: slackFetch().fetch });
		const seen = a.saveSettings!({ enabled: true, values: { token: TOKEN, main: "C0MAIN1234" }, allow: ["U1", "U1"] }) as Settings;
		expect(statSync(slackConfigPath(dir)).mode & 0o777).toBe(0o600);
		expect(loadSlackConfig(dir)).toMatchObject({ enabled: true, token: TOKEN, allow: ["U1"] });
		expect(JSON.parse(readFileSync(slackConfigPath(dir), "utf8")).token).toBe(TOKEN);
		expect(JSON.stringify(seen)).not.toContain(TOKEN);
		const token = seen.fields.find(f => f.key === "token")!;
		expect(token).toMatchObject({ type: "secret", set: true });
		expect(token).not.toHaveProperty("value");
		expect(seen.help.join(" ")).toContain("chat:write");
		expect(seen.allow!.items).toEqual(["U1"]);
		expect(a.configured!()).toBe(true);
	});

	test("start verifies auth.test as a bearer header and reports ok or a scrubbed error", async () => {
		const okDir = tempDir();
		const ok = setup(okDir);
		await ok.a.start(ctx());
		expect(ok.a.status.state).toBe("ok");
		expect(ok.fake.calls[0]).toMatchObject({ method: "auth.test", auth: `Bearer ${TOKEN}` });
		expect(ok.fake.calls[0]!.body.toString()).not.toContain(TOKEN);

		const rejectDir = tempDir();
		setup(rejectDir);
		const rejected = createSlackAdapter(rejectDir, { fetch: slackFetch({ reject: true }).fetch });
		await rejected.start(ctx());
		expect(rejected.status.state).toBe("error");
		expect(rejected.status.error).toContain("***");
		expect(rejected.status.error).not.toContain(TOKEN);

		const apiDir = tempDir();
		setup(apiDir);
		const refused = createSlackAdapter(apiDir, { fetch: slackFetch({ apiError: true }).fetch });
		await refused.start(ctx());
		expect(refused.status).toMatchObject({ state: "error", error: "invalid_auth" });
	});

	test("deliver posts to the channel of the message kind, and a project falls back to main", async () => {
		const dir = tempDir();
		saveSlackConfig(
			{
				enabled: true,
				token: TOKEN,
				channels: [
					{ id: "C0MAIN1234", name: "dotz", kind: "main" },
					{ id: "C0ALERT123", name: "dotz-알림", kind: "alert" },
					{ id: "C0PROJ1234", name: "dotz-site", kind: "project", project: "ch:9" },
				],
				allow: [],
			},
			dir,
		);
		const fake = slackFetch();
		const a = createSlackAdapter(dir, { fetch: fake.fetch });

		const alert = await a.deliver({ target: "alert", kind: "alert", text: "알림 본문" });
		expect(alert).toEqual({ delivered: true, ids: ["ts-1"] });
		expect(fake.calls[0]).toMatchObject({ method: "chat.postMessage" });
		expect(fake.calls[0]!.body.get("channel")).toBe("C0ALERT123");
		expect(fake.calls[0]!.body.get("text")).toBe("알림 본문");

		const project = await a.deliver({ target: "ch:9", kind: "project", text: "프로젝트 본문" });
		expect(project.delivered).toBe(true);
		expect(fake.calls[1]!.body.get("channel")).toBe("C0PROJ1234");

		const other = await a.deliver({ target: "ch:404", kind: "project", text: "다른 프로젝트" });
		expect(other.delivered).toBe(true);
		expect(fake.calls[2]!.body.get("channel")).toBe("C0MAIN1234");
	});

	test("test checks auth and posts one line to main only when a main channel exists", async () => {
		const withMain = tempDir();
		const one = setup(withMain);
		const results = await one.a.test!();
		expect(results.results.map(r => [r.id, r.ok])).toEqual([
			["auth", true],
			["C0MAIN1234", true],
		]);
		expect(one.fake.calls.map(c => c.method)).toEqual(["auth.test", "chat.postMessage"]);
		expect(one.fake.calls[1]!.body.get("text")).toContain("dotz");

		const noMain = tempDir();
		const two = setup(noMain, { main: "" });
		two.a.saveSettings!({ values: { worklog: "C0WORK1234" } });
		const only = await two.a.test!();
		expect(only.results.map(r => r.id)).toEqual(["auth"]);
		expect(two.fake.calls.map(c => c.method)).toEqual(["auth.test"]);
	});

	test("a refused body changes nothing", () => {
		const dir = tempDir();
		const { a } = setup(dir);
		const before = readFileSync(slackConfigPath(dir), "utf8");
		for (const bad of [{ values: { token: "nope" } }, { values: { main: "bad id!" } }, { values: { nope: "x" } }, { allow: [1] }, { enabled: "yes" }]) {
			expect(() => a.saveSettings!(bad as never)).toThrow();
		}
		expect(readFileSync(slackConfigPath(dir), "utf8")).toBe(before);
	});
});

describe("slack web link", () => {
	test("a link is a <url|웹에서 보기> link at the end of the text; a message without one is unchanged", async () => {
		const { a, fake } = setup(tempDir());
		expect(a.ownsLink).toBe(true);
		await a.deliver({ target: "main", kind: "main", text: "끝났어요", link: "https://dotz.example.com/#chat/main" });
		await a.deliver({ target: "main", kind: "main", text: "링크 없음" });
		expect(fake.calls[0]!.body.get("text")).toBe("끝났어요\n\n<https://dotz.example.com/#chat/main|웹에서 보기>");
		expect(fake.calls[1]!.body.get("text")).toBe("링크 없음");
	});

	test("characters that would end the link early are encoded", async () => {
		const { a, fake } = setup(tempDir());
		await a.deliver({ target: "main", kind: "main", text: "x", link: "https://dotz.example.com/a|b>c d" });
		expect(fake.calls[0]!.body.get("text")).toBe("x\n\n<https://dotz.example.com/a%7Cb%3Ec%20d|웹에서 보기>");
	});
});
