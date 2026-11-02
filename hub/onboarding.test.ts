import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscordStore } from "./discord-connection.ts";
import { createJandiStore } from "./onboarding-jandi.ts";
import { createOnboarding, type OnboardDeps, type OnboardKey, onboardingRoute, type OnboardView } from "./onboarding.ts";

const API = "https://discord.com/api/v10";
const TOKEN = "tokentokentokentoken12.abcde.SECRETSECRETSECRETSECRET1234";
const APP = "999000111222333444";
const GUILD = "123456789012345678";
const OWNER = "876543210987654321";
const BOT = "424242424242424242";
const dirs: string[] = [];

type FakeBrowser = { calls: { action: string; arg?: Record<string, unknown> }[]; run: (action: string, arg?: Record<string, unknown>) => Promise<{ ok: boolean; value?: string; waiting?: string }> };
type FakeFetch = { calls: string[]; fetch: typeof fetch };

function dataDir(options: { discord?: Record<string, unknown>; token?: string; jandi?: unknown } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "onboard-test-"));
	dirs.push(dir);
	mkdirSync(join(dir, "secrets"), { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "config.json"), `${JSON.stringify({ identity: { name: "tester" }, discord: { token_file: "", guild: "", owner_id: "", app_id: "", ...options.discord } }, null, 2)}\n`);
	if (options.token) {
		writeFileSync(join(dir, "secrets", "discord-bot-token"), `${options.token}\n`, { mode: 0o600 });
		chmodSync(join(dir, "secrets", "discord-bot-token"), 0o600);
	}
	if (options.jandi !== undefined) {
		mkdirSync(join(dir, "messengers"), { recursive: true });
		writeFileSync(join(dir, "messengers", "jandi.json"), `${JSON.stringify(options.jandi, null, 2)}\n`, { mode: 0o600 });
	}
	return dir;
}

function browser(queue: Record<string, { ok: boolean; value?: string; waiting?: string }[]> = {}): FakeBrowser {
	const calls: FakeBrowser["calls"] = [];
	return {
		calls,
		async run(action, arg) {
			calls.push({ action, ...(arg ? { arg } : {}) });
			return queue[action]?.shift() ?? { ok: false };
		},
	};
}

function discordFetch(options: { token?: string; failure?: "throw" | "401" } = {}): FakeFetch {
	const calls: string[] = [];
	const doFetch = async (input: RequestInfo | URL) => {
		const url = String(input);
		if (!url.startsWith(API)) throw new Error(`unexpected network call ${url}`);
		calls.push(url.slice(API.length));
		if (options.failure === "throw") throw new Error(`network failed for Bot ${options.token}`);
		if (options.failure === "401") return Response.json({ error: `bad ${options.token}` }, { status: 401 });
		const path = url.slice(API.length);
		if (path === "/users/@me") return Response.json({ id: BOT });
		if (path === "/users/@me/guilds") return Response.json([{ id: GUILD }]);
		if (path === `/guilds/${GUILD}/members/${BOT}`) return Response.json({ roles: ["r1"] });
		if (path === `/guilds/${GUILD}/roles`) return Response.json([{ id: "r1", permissions: "8" }]);
		if (path === `/guilds/${GUILD}`) return Response.json({ owner_id: OWNER });
		return Response.json({}, { status: 404 });
	};
	return { calls, fetch: doFetch as typeof fetch };
}

function service(dir: string, fake: FakeBrowser, network: FakeFetch, execCalls: string[][] = []) {
	let restarts = 0;
	const deps: OnboardDeps = {
		dir,
		fetch: network.fetch,
		browser: fake,
		exec: async argv => {
			execCalls.push(argv);
			return { code: 0, out: "" };
		},
		restart: async () => {
			restarts++;
		},
		discord: createDiscordStore(dir),
		jandi: createJandiStore(dir),
	};
	return { svc: createOnboarding(deps), restarts: () => restarts };
}

async function runStart(svc: ReturnType<typeof createOnboarding>, key: OnboardKey = "discord"): Promise<OnboardView> {
	svc.start(key);
	await svc.idle(key);
	return svc.view(key);
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(path));
		else out.push(path);
	}
	return out;
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("onboarding engine", () => {
	test("happy path with an existing token and config asks the owner nothing and calls no model", async () => {
		const dir = dataDir({ discord: { guild: GUILD, owner_id: OWNER, app_id: APP }, token: TOKEN });
		const fake = browser();
		const network = discordFetch();
		const execCalls: string[][] = [];
		const { svc, restarts } = service(dir, fake, network, execCalls);
		const view = await runStart(svc);
		expect(view.state).toBe("done");
		expect(view.owner).toBeNull();
		expect(view.error).toBeNull();
		expect(view.step?.id).toBe("done");
		expect(fake.calls).toEqual([]);
		expect(execCalls).toEqual([]);
		expect(restarts()).toBe(0);
		expect([...new Set(network.calls)].sort()).toEqual([`/guilds/${GUILD}/members/${BOT}`, `/guilds/${GUILD}/roles`, "/users/@me", "/users/@me/guilds"]);
		expect(JSON.stringify(view)).not.toContain(TOKEN);
	});

	test("a token read from the browser lands only in secrets/ at 0600 and never in the view or state file", async () => {
		const dir = dataDir({ discord: { guild: GUILD, owner_id: OWNER, app_id: APP } });
		const fake = browser({ "discord-token": [{ ok: true, value: TOKEN }] });
		const network = discordFetch();
		const { svc, restarts } = service(dir, fake, network);
		const waiting = await runStart(svc);
		expect(waiting.state).toBe("waiting");
		expect(waiting.step?.id).toBe("token");
		expect(waiting.owner?.label).toBe("Discord 로그인 확인");
		expect(fake.calls).toEqual([]);
		expect(existsSync(join(dir, "secrets", "discord-bot-token"))).toBe(false);
		svc.continue("discord");
		await svc.idle("discord");
		const view = svc.view("discord");
		expect(view.state).toBe("done");
		expect(restarts()).toBe(1);
		const tokenFile = join(dir, "secrets", "discord-bot-token");
		expect(readFileSync(tokenFile, "utf8").trim()).toBe(TOKEN);
		expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "secrets")).mode & 0o777).toBe(0o700);
		const stateFile = join(dir, "onboarding", "discord.json");
		expect(statSync(stateFile).mode & 0o777).toBe(0o600);
		expect(readFileSync(stateFile, "utf8")).not.toContain(TOKEN);
		expect(JSON.parse(readFileSync(stateFile, "utf8")).attempt).toBe(1);
		expect(JSON.stringify(view)).not.toContain(TOKEN);
		for (const file of walk(dir)) {
			if (file === tokenFile) continue;
			expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
		}
		const res = await onboardingRoute(new Request("http://hub/api/onboarding/discord"), new URL("http://hub/api/onboarding/discord"), svc);
		expect(res!.status).toBe(200);
		const text = await res!.text();
		expect(text).not.toContain(TOKEN);
		expect(JSON.parse(text)).toEqual(view);
		expect(svc.inventory().secrets).toContain("discord-bot-token");
		expect(JSON.stringify(svc.inventory())).not.toContain(TOKEN);
	});

	test("a failure is one actionable owner step with a scrubbed message", async () => {
		const dir = dataDir({ discord: { guild: GUILD, owner_id: OWNER, app_id: APP }, token: TOKEN });
		const fake = browser();
		const network = discordFetch({ token: TOKEN, failure: "throw" });
		const { svc } = service(dir, fake, network);
		const view = await runStart(svc);
		expect(view.state).toBe("failed");
		expect(view.step?.id).toBe("invite");
		expect(view.error).toBeTruthy();
		expect(view.error!.length).toBeLessThanOrEqual(200);
		expect(view.error).toContain("***");
		expect(view.error).not.toContain(TOKEN);
		expect(view.owner).not.toBeNull();
		expect(Object.keys(view.owner!).sort()).toEqual(["hint", "label"]);
		expect(view.owner!.label.length).toBeGreaterThan(0);
		expect(view.owner!.hint.length).toBeGreaterThan(0);
		const stateText = readFileSync(join(dir, "onboarding", "discord.json"), "utf8");
		expect(stateText).not.toContain(TOKEN);
		expect(stateText).toContain("***");
		expect(JSON.stringify(view)).not.toContain(TOKEN);
	});

	test("start waits without opening the browser, and each continue runs the token step again", async () => {
		const dir = dataDir({ discord: { guild: GUILD, owner_id: OWNER, app_id: APP } });
		const fake = browser({ "discord-token": [{ ok: true, waiting: "login" }, { ok: true, value: TOKEN }] });
		const network = discordFetch();
		const { svc, restarts } = service(dir, fake, network);
		const waiting = await runStart(svc);
		expect(waiting.state).toBe("waiting");
		expect(waiting.step?.id).toBe("token");
		expect(waiting.owner?.label).toBe("Discord 로그인 확인");
		expect(fake.calls).toEqual([]);
		expect(JSON.parse(readFileSync(join(dir, "onboarding", "discord.json"), "utf8")).index).toBe(1);
		svc.continue("discord");
		await svc.idle("discord");
		const again = svc.view("discord");
		expect(again.state).toBe("waiting");
		expect(fake.calls.map(c => c.action)).toEqual(["discord-token"]);
		expect(JSON.parse(readFileSync(join(dir, "onboarding", "discord.json"), "utf8")).attempt).toBe(1);
		svc.continue("discord");
		await svc.idle("discord");
		const done = svc.view("discord");
		expect(done.state).toBe("done");
		expect(done.owner).toBeNull();
		expect(fake.calls.map(c => c.action)).toEqual(["discord-token", "discord-token"]);
		expect(readFileSync(join(dir, "secrets", "discord-bot-token"), "utf8").trim()).toBe(TOKEN);
		expect(restarts()).toBe(1);
	});

	test("cancel records idle and a later start begins from the first step", async () => {
		const dir = dataDir({ discord: { guild: GUILD, owner_id: OWNER, app_id: APP } });
		const fake = browser({ "discord-token": [{ ok: true, waiting: "login" }] });
		const { svc } = service(dir, fake, discordFetch());
		await runStart(svc);
		const cancelled = svc.cancel("discord");
		expect(cancelled.state).toBe("idle");
		expect(cancelled.owner).toBeNull();
		expect(cancelled.step).toBeNull();
		const saved = JSON.parse(readFileSync(join(dir, "onboarding", "discord.json"), "utf8"));
		expect(saved.index).toBe(0);
		expect(saved.view.state).toBe("idle");
		expect(existsSync(join(dir, "secrets", "discord-bot-token"))).toBe(false);
	});

	test("JANDI reuses its saved rooms, enables the messenger, and writes no token to the state file", async () => {
		const dir = dataDir({
			jandi: {
				enabled: false,
				rooms: [{ id: "m1", name: "메인", kind: "main", outgoing_token: "jandi-out-token-SECRET-12345", incoming_url: "https://wh.jandi.com/in/secret" }],
			},
		});
		const fake = browser();
		const { svc, restarts } = service(dir, fake, discordFetch());
		const view = await runStart(svc, "jandi");
		expect(view.state).toBe("done");
		expect(fake.calls).toEqual([]);
		expect(restarts()).toBe(1);
		const saved = JSON.parse(readFileSync(join(dir, "messengers", "jandi.json"), "utf8"));
		expect(saved.enabled).toBe(true);
		expect(saved.rooms[0].outgoing_token).toBe("jandi-out-token-SECRET-12345");
		expect(statSync(join(dir, "messengers", "jandi.json")).mode & 0o777).toBe(0o600);
		const stateText = readFileSync(join(dir, "onboarding", "jandi.json"), "utf8");
		expect(stateText).not.toContain("jandi-out-token");
		expect(stateText).not.toContain("wh.jandi.com");
	});

	test("JANDI reads the room webhooks through the browser when none are saved", async () => {
		const dir = dataDir({ jandi: { enabled: false, rooms: [] } });
		const rooms = [{ id: "m1", name: "메인", kind: "main", outgoing_token: "jandi-browser-token-1", incoming_url: "https://wh.jandi.com/in/1" }];
		const fake = browser({ "jandi-webhooks": [{ ok: true, value: JSON.stringify(rooms) }] });
		const { svc, restarts } = service(dir, fake, discordFetch());
		const view = await runStart(svc, "jandi");
		expect(view.state).toBe("done");
		expect(fake.calls.map(c => c.action)).toEqual(["jandi-webhooks"]);
		expect(restarts()).toBe(1);
		const saved = JSON.parse(readFileSync(join(dir, "messengers", "jandi.json"), "utf8"));
		expect(saved.enabled).toBe(true);
		expect(saved.rooms[0]).toMatchObject({ id: "m1", outgoing_token: "jandi-browser-token-1", incoming_url: "https://wh.jandi.com/in/1" });
		expect(readFileSync(join(dir, "onboarding", "jandi.json"), "utf8")).not.toContain("jandi-browser-token");
	});

	test("the routes answer JSON only and refuse unknown keys and methods", async () => {
		const dir = dataDir({ discord: { guild: GUILD, owner_id: OWNER, app_id: APP }, token: TOKEN });
		const { svc } = service(dir, browser(), discordFetch());
		const call = async (method: string, path: string) => {
			const url = new URL(`http://hub${path}`);
			const res = await onboardingRoute(new Request(url, { method }), url, svc);
			return { status: res!.status, text: await res!.text() };
		};
		expect((await call("POST", "/api/onboarding/discord/start")).status).toBe(200);
		await svc.idle("discord");
		expect(JSON.parse((await call("GET", "/api/onboarding/discord")).text).state).toBe("done");
		expect((await call("GET", "/api/onboarding/nope")).status).toBe(404);
		expect((await call("GET", "/api/onboarding/discord/start")).status).toBe(405);
		for (const path of ["/api/onboarding/discord/start", "/api/onboarding/discord/continue", "/api/onboarding/discord/cancel"]) {
			expect((await call("POST", path)).text).not.toContain(TOKEN);
		}
	});
});
