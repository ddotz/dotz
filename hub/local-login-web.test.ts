import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { HUB_TOKEN } from "./config.ts";
import { localLogin, makeRoute, webAccess } from "./routes.ts";
import { fakeHub, inbox, waitFor } from "./test-web.ts";

// The login link in a headless Bun.WebView against the real route (real gate, real socket): the page without a cookie says how to get a link, a fresh
// link lands on the app with its API working, the same link in another view is the expired message, and the cookie is HttpOnly.
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const seen = inbox<string>();
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req, srv) {
		const res = await route(req, srv);
		seen.push(`${new URL(req.url).pathname} ${res.status}`);
		return res;
	},
});
const origin = `http://127.0.0.1:${server.port}`;
const views = fakeHub();
const text = (v: Awaited<ReturnType<typeof views.view>>) => v.evaluate("document.body.innerText") as Promise<string>;
const freshLink = async () => {
	const r = await fetch(`${origin}/api/web-access/login-link`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN } });
	return `${origin}/local-login${new URL(((await r.json()) as { url: string }).url).search}`;
};

beforeAll(async () => {
	await webAccess.change({ mode: "local" });
});
afterAll(async () => {
	views.stop();
	server.stop(true);
	localLogin.clear();
	await webAccess.change({ mode: "tailscale" });
	rmSync(join(process.env.DOTZ_DIR!, "web-access.json"), { force: true });
});

describe("이 컴퓨터만 로그인 링크 (headless)", () => {
	test("without a cookie the page says how to get a link; a fresh link lands on the app; the same link in another view is expired", async () => {
		const first = await views.view({});
		await first.navigate(`${origin}/`);
		expect(await text(first)).toContain("bun hub/web-login-cli.ts");

		const link = await freshLink();
		const from = seen.length;
		await first.navigate(link);
		await waitFor(first, "location.pathname === '/' && !!document.querySelector('#app')");
		await seen.until(items => items.slice(from).includes("/api/state 200"), 10_000, "the app's /api/state with the cookie");
		expect(await first.evaluate("fetch('/api/state').then(r => r.status)")).toBe(200);
		expect(await first.evaluate("document.cookie")).not.toContain("dotz_local");

		const second = await views.view({});
		await second.navigate(link);
		expect(await text(second)).toContain("링크가 만료됐거나 이미 썼어요");
	});
});
