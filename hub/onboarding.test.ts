import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscordStore } from "./discord-connection.ts";
import { createJandiStore } from "./onboarding-jandi.ts";
import { HUB_TOKEN } from "./config.ts";
import { introOf, issueToken, markDone, markTerminalDone, SETUP_COOKIE } from "../firstrun/first-run.ts";
import { makeRoute } from "./routes.ts";
import { createSetupGate, type SetupDeps } from "../firstrun/setup-gate.ts";
import { readFirstRun } from "../firstrun/first-run.ts";
import { draftLang } from "../firstrun/setup-state.ts";
import { setCatalogProvider } from "./web-i18n.ts";
import { createGenerator } from "./web-i18n-gen.ts";
import { bundle, indexPage, setAppLang, webSources } from "./webapp.ts";
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

	test("JANDI reuses its saved webhook rooms, enables the messenger, and writes no token to the state file", async () => {
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

describe("first-run setup gate", () => {
	const HOUR = 3600_000;
	const open = (extra: Partial<SetupDeps> = {}) => {
		const dir = mkdtempSync(join(tmpdir(), "setup-gate-"));
		dirs.push(dir);
		const logs: string[] = [];
		const gate = createSetupGate({ dir, home: dir, pkg: join(import.meta.dir, ".."), localHeaders: () => ({}), restart: () => {}, providers: async () => undefined, log: l => logs.push(l), scan: async () => ({}), terms: () => undefined, ...extra });
		const call = async (path: string, init: RequestInit & { cookie?: string; host?: string } = {}) => {
			const { cookie, host = "127.0.0.1:7420", ...rest } = init;
			const req = new Request(`http://${host}${path}`, { ...rest, headers: { ...(cookie ? { cookie: `${SETUP_COOKIE}=${cookie}` } : {}), ...(rest.headers as Record<string, string> | undefined) } });
			return (await gate.route(req, new URL(req.url), "127.0.0.1")) ?? new Response("passed on", { status: 599 });
		};
		const login = async (): Promise<string> => {
			const r = await call(`/setup?token=${issueToken(dir)}`);
			return /dotz_setup=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")![1]!;
		};
		return { dir, logs, call, login };
	};
	const json = (body: unknown, cookie: string, method = "POST") => ({ method, cookie, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

	test("the token is used once: 303 with an HttpOnly cookie, then 404", async () => {
		const { dir, call } = open();
		const token = issueToken(dir);
		const first = await call(`/setup?token=${token}`);
		expect(first.status).toBe(303);
		expect(first.headers.get("set-cookie")).toMatch(/^dotz_setup=.+HttpOnly; SameSite=Strict/);
		expect((await call(`/setup?token=${token}`)).status).toBe(404);
	});

	test("an expired token is 404 and a request without the cookie learns nothing", async () => {
		const { dir, call, login } = open();
		expect((await call(`/setup?token=${issueToken(dir, Date.now() - 25 * HOUR)}`)).status).toBe(404);
		const cookie = await login();
		expect((await call("/setup")).status).toBe(404);
		expect((await call("/api/setup/state")).status).toBe(404);
		expect((await call("/api/setup/state", { cookie })).status).toBe(200);
	});

	test("proxy headers, a foreign Host and a foreign Origin are 404 even with a valid cookie", async () => {
		const { call, login } = open();
		const cookie = await login();
		for (const init of [{ headers: { "x-forwarded-for": "1.2.3.4" } }, { headers: { "tailscale-user-login": "me@example.com" } }, { host: "evil.example:7420" }, { headers: { origin: "https://evil.example" } }])
			expect((await call("/api/setup/state", { cookie, ...init })).status).toBe(404);
	});

	test("after markDone every setup route is 404", async () => {
		const { dir, call, login } = open();
		const cookie = await login();
		markDone(dir);
		for (const path of ["/setup", "/setup.js", "/api/setup/state"]) expect((await call(path, { cookie })).status).toBe(404);
	});

	test("a draft resumes in a new gate and drops fields it does not know", async () => {
		const { dir, call, login } = open();
		const cookie = await login();
		expect((await call("/api/setup/draft", json({ step: "identity", values: { name: "Dotty", evil: "x" } }, cookie, "PUT"))).status).toBe(200);
		const again = createSetupGate({ dir, home: dir, pkg: dir, localHeaders: () => ({}), restart: () => {}, providers: async () => undefined, log: () => {}, scan: async () => ({}) });
		const req = new Request("http://127.0.0.1:7420/api/setup/state", { headers: { cookie: `${SETUP_COOKIE}=${cookie}` } });
		const state = (await (await again.route(req, new URL(req.url), "127.0.0.1"))!.json()) as { step: string; draft: Record<string, unknown> };
		expect(state.step).toBe("identity");
		expect(state.draft).toEqual({ name: "Dotty" });
	});

	test("a secret lands in secrets/ only: not in first-run.json, the log or the state body", async () => {
		const { dir, logs, call, login } = open({ jobs: { tailscale: async io => (io.line(TOKEN), { ok: true, detail: TOKEN }) } });
		const cookie = await login();
		const saved = await call("/api/setup/secret", json({ name: "discord-bot-token", value: TOKEN }, cookie));
		expect(saved.status).toBe(200);
		expect(await saved.text()).not.toContain(TOKEN);
		expect((await call("/api/setup/run/tailscale", json({}, cookie))).status).toBe(202);
		let state = "";
		// the job runs on microtasks: poll the state body (bounded) until its row is done
		for (let n = 0; n < 200 && !state.includes('"state":"done"'); n++) state = await (await call("/api/setup/state", { cookie })).text();
		expect(state).toContain('"state":"done"');
		expect(readFileSync(join(dir, "secrets", "discord-bot-token"), "utf8")).toContain(TOKEN);
		expect(statSync(join(dir, "secrets", "discord-bot-token")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(dir, "onboarding", "first-run.json"), "utf8")).not.toContain(TOKEN);
		expect(logs.join("\n")).not.toContain(TOKEN);
		expect(state).not.toContain(TOKEN);
	});

	test("an unknown job, an unknown terminal id and a body carrying argv are refused", async () => {
		const { call, login } = open();
		const cookie = await login();
		expect((await call("/api/setup/run/nope", json({}, cookie))).status).toBe(404);
		expect((await call("/api/setup/term/bash", json({}, cookie))).status).toBe(404);
		expect((await call("/api/setup/term/aside-login", json({ argv: ["sh", "-c", "id"] }, cookie))).status).toBe(400);
	});

	test("the state answers from the last scan and ?fresh=1 scans again", async () => {
		let scans = 0;
		const { call, login } = open({ scan: async () => ({ n: ++scans }) });
		const cookie = await login();
		const scanOf = async (path: string) => ((await (await call(path, { cookie })).json()) as { scan: { n: number } }).scan.n;
		expect(await scanOf("/api/setup/state")).toBe(1);
		expect(await scanOf("/api/setup/state")).toBe(1);
		expect(await scanOf("/api/setup/state?fresh=1")).toBe(2);
		expect(await scanOf("/api/setup/state")).toBe(2);
		expect(scans).toBe(2);
	});

	test("a language with no shipped list: the status line goes waiting, preparing, ready, and the first app page after the onboarding is in that language", async () => {
		type Sent = { k: string; en: unknown };
		let connected = false;
		let modelCalls = 0;
		const call = async (_system: string, text: string) => {
			modelCalls++;
			const items = JSON.parse(text) as Sent[];
			return { text: JSON.stringify(items.map(i => (typeof i.en === "string" ? `pt: ${i.en}` : Object.fromEntries(Object.entries(i.en as object).map(([c, t]) => [c, `pt: ${t}`]))))) };
		};
		const cache = mkdtempSync(join(tmpdir(), "web-i18n-cache-"));
		dirs.push(cache);
		let gateDir = "";
		const make = (lang: () => string) => {
			const g = createGenerator({ call, dir: cache, ko: () => webSources().ko, en: () => webSources().en, lang, connected: () => connected, onLanguage: setAppLang, schedule: () => () => {} });
			g.install();
			return g;
		};
		const gen = make(() => draftLang(readFirstRun(gateDir)?.draft ?? {}));
		let signedIn = false;
		const gate = open({ i18n: gen, scan: async () => ({ harnesses: [{ login_ready: signedIn }] }), jobs: { permissions: async () => ({ ok: true }) } });
		gateDir = gate.dir;
		try {
			const cookie = await gate.login();
			const stateOf = async () => ((await (await gate.call("/api/setup/state", { cookie })).json()) as { web?: { state: string } }).web?.state;
			expect((await gate.call("/api/setup/draft", json({ step: "identity", values: { lang: "pt", name: "Dotty" } }, cookie, "PUT"))).status).toBe(200);
			expect(await stateOf()).toBe("waiting");
			expect(modelCalls).toBe(0);

			// The work program gets signed in; the next scan of the wizard sees it and nothing else is pressed.
			const seen: string[] = [];
			const ready = new Promise<void>(done => gen.subscribe(s => { seen.push(s.state); if (s.state === "ready") done(); }));
			connected = true;
			signedIn = true;
			expect((await gate.call("/api/setup/state?fresh=1", { cookie })).status).toBe(200);
			await ready;
			expect(seen[0]).toBe("preparing");
			expect(seen.at(-1)).toBe("ready");
			expect(await stateOf()).toBe("ready");

			expect((await gate.call("/api/setup/run/permissions", json({}, cookie))).status).toBe(202);
			expect((await gate.call("/api/setup/apply", json({}, cookie))).status).toBe(200);
			const before = modelCalls;

			const restarted = make(() => "pt");
			await restarted.signal("start");
			expect(modelCalls).toBe(before);
			const html = await (await indexPage(new Request("http://localhost/"))).text();
			expect(html).toContain('<html lang="pt">');
			expect(bundle("js").text).toContain('const I18N_LANG = "pt"');
		} finally {
			setCatalogProvider(undefined);
			setAppLang("ko");
		}
	});
});

describe("/api/intro", () => {
	const data = process.env.DOTZ_DIR!;
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const ask = async (method: string, intro?: string, token = HUB_TOKEN) => {
		const headers: Record<string, string> = { "content-type": "application/json", ...(token ? { "x-dotz-token": token } : {}) };
		const r = await route(new Request("http://127.0.0.1:7420/api/intro", { method, headers, ...(intro ? { body: JSON.stringify({ intro }) } : {}) }));
		return { status: r.status, text: await r.text() };
	};
	const intro = async (method = "GET", value?: string) => (JSON.parse((await ask(method, value)).text) as { intro: string }).intro;
	afterEach(() => rmSync(join(data, "onboarding"), { recursive: true, force: true }));

	test("pending after the web onboarding is done, seen once the tour ran, and it stays seen", async () => {
		issueToken(data);
		markDone(data);
		expect(await intro()).toBe("pending");
		expect(await intro("POST", "seen")).toBe("seen");
		expect(await intro()).toBe("seen");
		expect(JSON.parse(readFileSync(join(data, "onboarding", "first-run.json"), "utf8")).status).toBe("done");
	});

	test("an install that never went through the web onboarding is never pending", async () => {
		expect(await intro()).toBe("seen");
		expect(await intro("POST", "pending")).toBe("seen");
		expect(existsSync(join(data, "onboarding"))).toBe(false);
		markTerminalDone(data, false);
		expect(introOf(data)).toBe("seen");
	});

	test("it is answered for the owner only, and a value other than seen or pending is refused", async () => {
		issueToken(data);
		markDone(data);
		const stranger = await ask("GET", undefined, "");
		expect(stranger.text).not.toContain("\"intro\"");
		expect((await ask("POST", "maybe")).status).toBe(400);
	});
});
