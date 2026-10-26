// A user app's web UI through the gateway (hub/app-proxy.ts): GET a page, POST a body, status and query passthrough, the
// prefix modes, the auth of the API, an app that is off, and a websocket bridged to the app's own server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appProxySocket } from "./app-proxy.ts";
import { HUB_TOKEN } from "./config.ts";
import { makeRoute } from "./routes.ts";

const DATA = process.env.DOTZ_DIR!;
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const put = (id: string, v: unknown) => {
	mkdirSync(join(DATA, "custom/apps", id), { recursive: true });
	writeFileSync(join(DATA, "custom/apps", id, "app.json"), JSON.stringify(v));
};

const upstream = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	websocket: {
		message(ws, m) { ws.send(`echo:${m}`); },
		open() {},
	},
	fetch(req, srv) {
		const u = new URL(req.url);
		if (u.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 });
		if (u.pathname === "/") return new Response(`<!doctype html><html><head><title>app</title></head><body><script src="/boot.js"></script><a href="/docs">docs</a></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
		if (u.pathname === "/boot.js") return new Response(`fetch("/api/ping")`, { headers: { "content-type": "text/javascript" } });
		if (u.pathname === "/api/ping" && req.method === "POST") return req.text().then(t => Response.json({ got: t }));
		if (u.pathname === "/api/ping") return Response.json({ q: u.search });
		if (u.pathname === "/base/page") return new Response(`base page ${u.search}`, { headers: { "content-type": "text/plain" } });
		if (u.pathname === "/teapot") return new Response("short and stout", { status: 418, headers: { "x-upstream": "yes" } });
		if (u.pathname === "/set-cookie") return new Response("ok", { headers: { "set-cookie": "a=1; Path=/; HttpOnly; Domain=127.0.0.1" } });
		if (u.pathname === "/to") return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
		return new Response("not found", { status: 404 });
	},
});
const port = upstream.port;
const gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", websocket: appProxySocket, fetch: (req, srv) => route(req, srv) });
const base = `http://127.0.0.1:${gateway.port}`;
const call = (path: string, opts: RequestInit & { auth?: boolean } = {}) => {
	const { auth, ...init } = opts;
	return route(new Request(`${base}${path}`, { ...init, headers: auth === false ? {} : { ...(init.headers as Record<string, string> | undefined), "x-dotz-token": HUB_TOKEN } }));
};
const callAs = (path: string, init?: RequestInit) => route(new Request(`${base}${path}`, init));

beforeAll(() => {
	put("rw", { label: "리라이트 앱", kind: "tool", icon: "file", web: { url: `http://127.0.0.1:${port}`, mode: "rewrite" } });
	put("px", { label: "프리픽스 앱", kind: "tool", web: { url: `http://127.0.0.1:${port}`, path: "/base/", mode: "prefix" } });
	put("ws", { label: "웹소켓 앱", kind: "tool", web: { url: `http://127.0.0.1:${port}` } });
});
afterAll(() => { gateway.stop(true); upstream.stop(true); });

describe("the proxied page", () => {
	test("rewrite mode prefixes the page's own root-absolute urls and adds the run-time shim", async () => {
		const r = await call("/apps/rw/");
		expect(r.status).toBe(200);
		const html = await r.text();
		expect(html).toContain(`<script src="/apps/rw/boot.js">`);
		expect(html).toContain(`<a href="/apps/rw/docs">`);
		expect(html).toContain(`var P="/apps/rw"`);
		expect(html).toContain("window.fetch=function");
		expect(r.headers.get("content-type")).toContain("text/html");
	});

	test("a script answer is passed through untouched (the shim prefixes its fetch at run time)", async () => {
		const js = await call("/apps/rw/boot.js");
		expect([js.status, await js.text()]).toEqual([200, `fetch("/api/ping")`]);
	});

	test("prefix mode strips the gateway prefix and keeps the app's own path and the query", async () => {
		const r = await call("/apps/px/page?day=2");
		expect([r.status, await r.text()]).toEqual([200, "base page ?day=2"]);
	});

	test("a POST body reaches the app and its json answer comes back", async () => {
		const r = await call("/apps/rw/api/ping", { method: "POST", body: "안녕", headers: { "content-type": "text/plain" } });
		expect(await r.json()).toEqual({ got: "안녕" });
	});

	test("an upstream status and header pass through", async () => {
		const r = await call("/apps/rw/teapot");
		expect([r.status, r.headers.get("x-upstream"), await r.text()]).toEqual([418, "yes", "short and stout"]);
	});

	test("a redirect and a cookie point back under /apps/<id>/", async () => {
		const red = await call("/apps/rw/to");
		expect([red.status, red.headers.get("location")]).toEqual([302, "/apps/rw/elsewhere"]);
		const c = await call("/apps/rw/set-cookie");
		const cookie = c.headers.getSetCookie()[0]!;
		expect(cookie).toContain("Path=/apps/rw/");
		expect(cookie).not.toContain("Domain=");
	});

	test("without the API's auth nothing is served; an unknown app is 404", async () => {
		expect((await call("/apps/rw/", { auth: false })).status).toBe(403);
		expect((await call("/apps/nope/")).status).toBe(404);
	});

	test("an app switched off answers 409 instead of its page", async () => {
		put("off", { label: "꺼 둔 앱", kind: "tool", web: { url: `http://127.0.0.1:${port}` } });
		const r = await callAs("/api/apps/off", { method: "PATCH", body: JSON.stringify({ off: true }), headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" } });
		expect(r.status).toBe(200);
		expect((await call("/apps/off/")).status).toBe(409);
		const list = await (await call("/api/apps")).json() as { items: { id: string; source: string; status: string; off?: boolean }[]; errors: unknown[] };
		expect(list.items.find(i => i.id === "off")).toMatchObject({ source: "manifest", status: "off", off: true });
		expect((await callAs("/api/apps/off", { method: "DELETE", headers: { "x-dotz-token": HUB_TOKEN } })).status).toBe(200);
		expect((await call("/apps/off/")).status).toBe(404);
	});

	test("the app list carries the manifest's name, icon, health and href beside the monitoring apps", async () => {
		const r = (await (await call("/api/apps")).json()) as { items: Record<string, any>[]; errors: unknown[] };
		const hd = r.items.find(i => i.id === "rw")!;
		expect(hd).toMatchObject({ label: "리라이트 앱", kind: "tool", source: "manifest", icon: "file", status: "running", web: { url: `http://127.0.0.1:${port}`, path: "/", mode: "rewrite", href: "/apps/rw/" } });
		expect(r.errors).toEqual([]);
	});

	test("a websocket on /apps/<id>/ is bridged to the app", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/apps/ws/ws`, { headers: { "x-dotz-token": HUB_TOKEN } } as never);
		const got = await new Promise<string>((res, rej) => {
			const t = setTimeout(() => rej(new Error("websocket timeout")), 8000);
			ws.onopen = () => ws.send("hello");
			ws.onmessage = ev => { clearTimeout(t); res(String(ev.data)); };
			ws.onerror = () => { clearTimeout(t); rej(new Error("websocket error")); };
		});
		expect(got).toBe("echo:hello");
		ws.close();
	});
});
