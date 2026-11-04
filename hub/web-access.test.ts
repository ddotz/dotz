import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, HUB_TOKEN } from "./config.ts";
import { ALLOW, makeRoute, webAccess } from "./routes.ts";
import { createWebAccess } from "./web-access.ts";
import { flush } from "./runtime/test-clock.ts";
import { webBase } from "./weblink.ts";

// 설정 → 웹 접속 on the real route: the mode starts as Tailscale with no tunnel, PUT /api/web-access switches the gate and the tunnel live, and
// the tunnel token never comes back in a body or a log. cloudflared is a stand-in script (DOTZ_CLOUDFLARED_BIN) that only sleeps: no network.
const DATA = process.env.DOTZ_DIR!;
const TOKEN = "eyJhIjoiZmFrZSIsInQiOiJzZWNyZXQtdHVubmVsLXRva2VuIn0";
const OWNER = "owner@example.com";
const HOST = "dotz.example.com";
const FILE = join(DATA, "web-access.json");
const TOKEN_FILE = join(DATA, "secrets", "cloudflared-tunnel-token");
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });

const bin = mkdtempSync(join(tmpdir(), "dotz-wa-"));
const fake = join(bin, "cloudflared");
const previousBin = process.env.DOTZ_CLOUDFLARED_BIN;

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
	route(new Request(`http://dotz.test${path}`, { method: init.method ?? "GET", headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }));
const owner = { "x-dotz-token": HUB_TOKEN };
const put = (body: unknown) => call("/api/web-access", { method: "PUT", headers: owner, body });
const get = async () => (await call("/api/web-access", { headers: owner })).json() as Promise<Record<string, any>>;
const mode = (m: string, extra: object = {}) => put({ mode: m, ...extra });
const fmode = (p: string) => statSync(p).mode & 0o777;
const logText = () => (existsSync(join(DATA, "hub.log")) ? readFileSync(join(DATA, "hub.log"), "utf8") : "");

beforeAll(() => {
	writeFileSync(fake, "#!/bin/sh\nexec sleep 300\n");
	chmodSync(fake, 0o755);
	process.env.DOTZ_CLOUDFLARED_BIN = fake;
	ALLOW.add(OWNER);
});
afterAll(async () => {
	await webAccess.change({ mode: "tailscale", token: "" });
	ALLOW.delete(OWNER);
	rmSync(FILE, { force: true });
	rmSync(bin, { recursive: true, force: true });
	if (previousBin === undefined) delete process.env.DOTZ_CLOUDFLARED_BIN;
	else process.env.DOTZ_CLOUDFLARED_BIN = previousBin;
});

describe("웹 접속", () => {
	test("default: Tailscale, no tunnel, the Tailscale login and the token get in, a stranger does not", async () => {
		const v = await get();
		expect(v).toMatchObject({ mode: "tailscale", token_set: false, cloudflared_found: true, devices: 0, tunnel: { state: "off" } });
		expect(existsSync(FILE)).toBe(false);
		expect((await call("/api/web-access", { headers: { "tailscale-user-login": OWNER } })).status).toBe(200);
		expect((await call("/api/web-access")).status).toBe(403);
		expect((await call("/pair")).status).toBe(403);
	});

	test("a bad body changes nothing: no file, no tunnel, same gate", async () => {
		const bad: [object, RegExp][] = [
			[{}, /접속 방식/],
			[{ mode: "wifi" }, /접속 방식/],
			[{ mode: "tailscale", hostname: "evil.com/path" }, /도메인/],
			[{ mode: "tailscale", hostname: "a b.com" }, /도메인/],
			[{ mode: "tailscale", hostname: 5 }, /주소/],
			[{ mode: "tailscale", team: "My Team!", aud: "x".repeat(32) }, /팀 이름/],
			[{ mode: "tailscale", team: "myteam" }, /함께/],
			[{ mode: "tailscale", token: "has space and \n newline" }, /토큰/],
			[{ mode: "cloudflare" }, /주소를 먼저/],
			[{ mode: "cloudflare", hostname: HOST }, /토큰이 필요/],
		];
		for (const [body, msg] of bad) {
			const r = await put(body);
			expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, expect.stringMatching(msg)]);
		}
		expect(existsSync(FILE)).toBe(false);
		expect(existsSync(TOKEN_FILE)).toBe(false);
		expect(await get()).toMatchObject({ mode: "tailscale", tunnel: { state: "off" } });
		expect((await call("/api/web-access", { headers: { "tailscale-user-login": OWNER } })).status).toBe(200);
	});

	test("PUT cloudflare starts the tunnel and the device gate; the token is stored 0600 and never comes back", async () => {
		const r = await mode("cloudflare", { hostname: `https://${HOST.toUpperCase()}/`, token: TOKEN });
		expect(r.status).toBe(200);
		const text = await r.text();
		expect(text).not.toContain(TOKEN);
		expect(JSON.parse(text)).toMatchObject({ mode: "cloudflare", hostname: HOST, team: "", aud: "", token_set: true, tunnel: { state: "running" }, cloudflared_found: true });
		const again = JSON.stringify(await get());
		expect(again).not.toContain(TOKEN);
		expect(logText()).not.toContain(TOKEN);
		expect(fmode(FILE)).toBe(0o600);
		expect(fmode(TOKEN_FILE)).toBe(0o600);
		expect(readFileSync(TOKEN_FILE, "utf8").trim()).toBe(TOKEN);
		expect(readFileSync(FILE, "utf8")).not.toContain(TOKEN);
		expect(webBase()).toBe(`https://${HOST}`);
	});

	test("in cloudflare mode an unpaired visitor only sees /pair, the Tailscale login is not trusted, x-dotz-token still works", async () => {
		const page = await call("/", { headers: { accept: "text/html" } });
		expect([page.status, page.headers.get("location")]).toEqual([302, "/pair"]);
		const api = await call("/api/state");
		expect([api.status, api.headers.get("x-dotz-pair")]).toEqual([403, "1"]);
		expect((await call("/api/web-access", { headers: { "tailscale-user-login": OWNER } })).status).toBe(403);
		expect((await call("/pair")).status).toBe(200);
		expect((await call("/api/state", { headers: owner })).status).toBe(200);
		expect(await get()).toMatchObject({ mode: "cloudflare", devices: 0 });
	});

	test("a restart reads the saved choice back; a fresh install without the file follows config.json", async () => {
		const deps = { dir: DATA, allow: new Set<string>(), notify: () => {} };
		expect(createWebAccess(deps).view()).toMatchObject({ mode: "cloudflare", hostname: HOST, token_set: true });
		const saved = readFileSync(FILE);
		rmSync(FILE);
		const web = cfg.web;
		cfg.web = { ...web, access: "cloudflare", cloudflare: { hostname: "cfg.example.com", team: "t", aud: "a".repeat(32) } };
		try {
			expect(createWebAccess(deps).view()).toMatchObject({ mode: "cloudflare", hostname: "cfg.example.com", team: "t", token_set: true });
		} finally {
			cfg.web = web;
			writeFileSync(FILE, saved, { mode: 0o600 });
		}
	});

	test("a fresh install without a Tailscale login starts on this computer, one with a login on Tailscale", () => {
		const saved = readFileSync(FILE);
		rmSync(FILE);
		const web = cfg.web!;
		const { access: _, ...unset } = web;
		cfg.web = unset;
		try {
			expect(createWebAccess({ dir: DATA, allow: new Set<string>(), notify: () => {} }).mode()).toBe("local");
			expect(createWebAccess({ dir: DATA, allow: new Set([OWNER]), notify: () => {} }).mode()).toBe("tailscale");
		} finally {
			cfg.web = web;
			writeFileSync(FILE, saved, { mode: 0o600 });
		}
	});

	test("PUT back to Tailscale stops the tunnel and the Tailscale login works again; the token is kept until cleared", async () => {
		const r = await mode("tailscale");
		expect(await r.json()).toMatchObject({ mode: "tailscale", token_set: true, tunnel: { state: "off" } });
		await flush();
		expect((await call("/api/web-access", { headers: { "tailscale-user-login": OWNER } })).status).toBe(200);
		expect((await call("/api/state")).status).toBe(403);
		expect((await call("/pair")).status).toBe(403);
		expect(JSON.parse(readFileSync(FILE, "utf8")).mode).toBe("tailscale");
		expect(await (await mode("local", { token: "" })).json()).toMatchObject({ mode: "local", token_set: false });
		expect(existsSync(TOKEN_FILE)).toBe(false);
		mkdirSync(join(DATA, "secrets"), { recursive: true });
	});

	test("the owner check comes first: nobody else can read or change it", async () => {
		expect((await call("/api/web-access", { method: "PUT", body: { mode: "local" } })).status).toBe(403);
		expect(await get()).toMatchObject({ mode: "local" });
	});
});
