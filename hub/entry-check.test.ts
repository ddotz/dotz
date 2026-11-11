import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, HUB_TOKEN, PORT } from "./config.ts";
import { rememberName } from "./entry-check.ts";
import { PAIR_PATH } from "./peer-pair.ts";
import { ALLOW, makeRoute, webAccess } from "./routes.ts";

// The entry check (hub/entry-check.ts) on the real route: own Host names only, the tailnet identity only on this node's tailnet name, no
// cross-site or non-JSON writes on an ambient credential, the hub and peer tokens exempt, and web.entry_check: false for the old behaviour.
const DATA = process.env.DOTZ_DIR!;
const OWNER = "owner@example.com";
const TS = "mini.tailnet.ts.net";
const PEER = "peer-token-for-the-entry-test-0123456789";
const PEER_FILE = join(DATA, "secrets", "peer-token");
const route = makeRoute({ tailnetName: async () => TS, busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const LOOPBACK = `127.0.0.1:${PORT}`;

type Hit = { method?: string; host?: string; headers?: Record<string, string>; body?: string };
const hit = (path: string, o: Hit = {}) =>
	route(new Request(`http://${o.host ?? TS}${path}`, { method: o.method ?? "GET", headers: { ...(o.host === "" ? {} : { host: o.host ?? TS }), ...o.headers }, ...(o.body === undefined ? {} : { body: o.body }) }));
const status = (path: string, o: Hit = {}) => hit(path, o).then(r => r.status);
const tailnet = { "tailscale-user-login": OWNER };
const page = { ...tailnet, "sec-fetch-site": "same-origin", origin: `https://${TS}`, "content-type": "application/json" };
const viewing = JSON.stringify({ id: "entry-test", conv: "" });
const logText = () => (existsSync(join(DATA, "hub.log")) ? readFileSync(join(DATA, "hub.log"), "utf8") : "");

beforeAll(async () => {
	ALLOW.add(OWNER);
	await webAccess.change({ mode: "tailscale" });
	mkdirSync(join(DATA, "secrets"), { recursive: true });
	writeFileSync(PEER_FILE, PEER);
});
afterAll(() => {
	ALLOW.delete(OWNER);
	rmSync(PEER_FILE, { force: true });
	rmSync(join(DATA, "web-access.json"), { force: true });
	delete (cfg.web as { entry_check?: boolean }).entry_check;
});

describe("입구 검사", () => {
	test("a forged Host with the owner's tailnet login is refused before any owner check", async () => {
		expect(await status("/api/web-access", { host: "evil.example:7420", headers: tailnet })).toBe(403);
		expect(await status("/manifest.webmanifest", { host: "evil.example:7420" })).toBe(403);
		expect(logText()).toContain("entry: refused (host) GET /api/web-access host=evil.example:7420");
	});

	test("the tailnet login counts only on this node's tailnet name, not on a loopback Host or with no Host", async () => {
		expect(await status("/api/web-access", { headers: tailnet })).toBe(200);
		expect(await status("/api/web-access", { host: `${TS}:${cfg.web?.tailscale_https_port || 443}`.replace(/:443$/, ""), headers: tailnet })).toBe(200);
		expect(await status("/api/web-access", { host: LOOPBACK, headers: tailnet })).toBe(403);
		expect(await status("/api/web-access", { host: "", headers: tailnet })).toBe(403);
		expect(await status(PAIR_PATH, { method: "POST", host: LOOPBACK, headers: tailnet })).toBe(403);
	});

	test("the owner's own page may write; another site's page and a text/plain simple request may not", async () => {
		expect(await status("/api/viewing", { method: "POST", headers: page, body: viewing })).toBe(200);
		expect(await status("/api/viewing", { method: "POST", headers: { ...page, "sec-fetch-site": "cross-site", origin: "https://evil.example" }, body: viewing })).toBe(403);
		expect(await status("/api/viewing", { method: "POST", headers: { ...page, "content-type": "text/plain;charset=UTF-8" }, body: viewing })).toBe(403);
		// A browser without fetch metadata: Origin decides.
		const { "sec-fetch-site": _, ...old } = page;
		expect(await status("/api/viewing", { method: "POST", headers: old, body: viewing })).toBe(200);
		expect(await status("/api/viewing", { method: "POST", headers: { ...old, origin: "https://evil.example" }, body: viewing })).toBe(403);
		// A peer gateway's push relay (hub/push.ts) comes through tailscale serve with the identity and no browser headers.
		const { origin: __, ...relay } = old;
		expect(await status("/api/viewing", { method: "POST", headers: relay, body: viewing })).toBe(200);
		expect(await status("/api/viewing", { method: "POST", headers: { ...relay, "content-type": "text/plain" }, body: viewing })).toBe(403);
	});

	test("the hub token from the CLI or the extension writes with no Origin and no fetch metadata", async () => {
		expect(await status("/api/viewing", { method: "POST", host: LOOPBACK, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: viewing })).toBe(200);
		expect(await status("/api/viewing", { method: "POST", host: LOOPBACK, headers: { "x-dotz-token": `${HUB_TOKEN}x`, "content-type": "application/json" }, body: viewing })).toBe(403);
	});

	test("a peer gateway with its peer token gets its paths through the tailnet name", async () => {
		const peer = { "x-dotz-peer": PEER, ...tailnet };
		expect(await status("/api/notices", { headers: peer })).toBe(200);
		expect(await status("/api/peer/lease", { method: "POST", headers: { ...peer, "content-type": "application/json" }, body: "{}" })).not.toBe(403);
	});

	test("a peer token counts only on a request that came through the tailnet name, not on a loopback Host with a login header", async () => {
		const peer = { "x-dotz-peer": PEER, ...tailnet };
		expect(await status("/api/notices", { host: LOOPBACK, headers: peer })).toBe(403);
		expect(await status("/api/notices", { host: "", headers: peer })).toBe(403);
		expect(await status("/api/notices", { headers: peer })).toBe(200);
	});

	test("pairing is answered after the write check and only for a JSON body", async () => {
		const reachedPairing = async (r: Response) => ((await r.json().catch(() => null)) as { error?: string } | null)?.error === "pairing refused";
		const body = JSON.stringify({ origin: "https://other.tailnet.ts.net" });
		const server = { ...tailnet, "content-type": "application/json" };
		// A peer gateway asking (hub/peer-pair.ts createPairer): JSON, the tailnet login, no browser headers.
		expect(await reachedPairing(await hit(PAIR_PATH, { method: "POST", headers: server, body }))).toBe(true);
		// Another site's page, with fetch metadata or with an Origin only.
		const site = { ...server, "sec-fetch-site": "cross-site", origin: "https://evil.example" };
		expect(await status(PAIR_PATH, { method: "POST", headers: site, body })).toBe(403);
		expect(await status(PAIR_PATH, { method: "POST", headers: { ...server, origin: "https://evil.example" }, body })).toBe(403);
		expect(await reachedPairing(await hit(PAIR_PATH, { method: "POST", headers: site, body }))).toBe(false);
		// A simple text/plain or form post, and a body with no type at all.
		for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", undefined]) {
			const headers: Record<string, string> = { ...tailnet, ...(type ? { "content-type": type } : {}) };
			const res = await hit(PAIR_PATH, { method: "POST", headers, body });
			expect([type, res.status, await reachedPairing(res)]).toEqual([type, 403, false]);
		}
		// The owner's own page asking from the same site is still answered.
		expect(await reachedPairing(await hit(PAIR_PATH, { method: "POST", headers: { ...server, "sec-fetch-site": "same-origin", origin: `https://${TS}` }, body }))).toBe(true);
	});

	test("web.entry_check: false brings back the old behaviour", async () => {
		(cfg.web as { entry_check?: boolean }).entry_check = false;
		try {
			expect(await status("/api/web-access", { host: "evil.example:7420", headers: tailnet })).toBe(200);
			expect(await status("/api/web-access", { host: LOOPBACK, headers: tailnet })).toBe(200);
			expect(await status("/api/viewing", { method: "POST", headers: { ...page, "sec-fetch-site": "cross-site", "content-type": "text/plain" }, body: viewing })).toBe(200);
		} finally {
			delete (cfg.web as { entry_check?: boolean }).entry_check;
		}
	});

	test("the tailnet name is read once, a failed read is retried after 5 s, and an old name is refreshed in the background", async () => {
		let now = 0;
		const answers: Array<string | undefined> = [undefined, "a.ts.net", "b.ts.net"];
		let reads = 0;
		const name = rememberName(async () => answers[reads++], () => now);
		expect(await name()).toBeUndefined();
		now = 1_000;
		expect(await name()).toBeUndefined();
		expect(reads).toBe(1);
		now = 6_000;
		expect(await name()).toBe("a.ts.net");
		now = 7_000;
		expect(await name()).toBe("a.ts.net");
		expect(reads).toBe(2);
		now = 700_000;
		expect(await name()).toBe("a.ts.net");
		expect(reads).toBe(3);
	});
});
