import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
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

	test("in local mode a browser on this computer gets in; a forwarded, foreign-Host, cross-site or remote request does not", async () => {
		const at = (ip: string) => ({ requestIP: () => ({ address: ip, family: "IPv4", port: 50000 }) }) as unknown as Server<unknown>;
		const local = (headers: Record<string, string> = {}, base = "http://127.0.0.1:7420", ip = "127.0.0.1", init: RequestInit = {}) =>
			route(new Request(`${base}/api/state`, { ...init, headers }), at(ip)).then(r => r.status);
		expect(await get()).toMatchObject({ mode: "local" });
		expect(await local()).toBe(200);
		expect(await local({}, "http://localhost:7420")).toBe(200);
		expect(await local({}, "http://[::1]:7420", "::1")).toBe(200);
		expect(await local({}, undefined, "::ffff:127.0.0.1")).toBe(200);
		expect(await local({ origin: "http://127.0.0.1:7420", "sec-fetch-site": "same-origin" })).toBe(200);
		expect(await local({ "sec-fetch-site": "none" })).toBe(200);
		const denied: [Record<string, string>, string?, string?][] = [
			[{}, undefined, "192.168.0.7"],
			[{}, "http://dotz.test"],
			[{}, "http://rebind.evil.com:7420"],
			[{ "x-forwarded-for": "203.0.113.9" }],
			[{ forwarded: "for=203.0.113.9" }],
			[{ "cf-connecting-ip": "203.0.113.9" }],
			[{ "tailscale-user-login": "someone@example.com" }],
			[{ origin: "https://evil.com" }],
			[{ origin: "http://localhost:7420" }],
			[{ "sec-fetch-site": "cross-site" }],
			[{ "sec-fetch-site": "same-site" }],
		];
		for (const [h, base, ip] of denied) expect([h, base, ip, await local(h, base, ip)]).toEqual([h, base, ip, 403]);
		expect((await route(new Request("http://127.0.0.1:7420/api/state"))).status).toBe(403);
		expect(await local({ origin: "https://evil.com" }, undefined, undefined, { method: "PUT" })).toBe(403);
		await mode("tailscale");
		expect(await local()).toBe(403);
		await mode("local");
	});
});
