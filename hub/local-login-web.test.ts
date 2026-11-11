import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { HUB_TOKEN } from "./config.ts";
import type { DialogAnswer } from "./local-login-dialog.ts";
import { lanes } from "./lanes.ts";
import { localLogin, makeRoute, setLoginConfirm, webAccess } from "./routes.ts";
import { fakeHub, inbox, waitFor } from "./test-web.ts";

// The login page and its button in a headless Bun.WebView, with a fake confirmation dialog the test answers: press, see the number, allow, land on the app (or deny, see the text).
// The login link in a headless Bun.WebView against the real route (real gate, real socket): the page without a cookie says how to get a link, a fresh
// link lands on the app with its API working, the same link in another view is the expired message, and the cookie is HttpOnly.
lanes.clear();   // all files share one process: a fixture lane without a model left by another file fails /api/context, which the app loads on opening
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

const SHOTS = "/tmp/pr-triage";
const asked = inbox<string>();
let settleDialog: (a: DialogAnswer) => void = () => {};

beforeAll(async () => {
	setLoginConfirm(number => {
		asked.push(number);
		return new Promise<DialogAnswer>(resolve => {
			settleDialog = resolve;
		});
	});
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
		expect(await text(first)).toContain("로그인");

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

describe("이 컴퓨터만 로그인 페이지 (headless)", () => {
	const size = [{ width: 1280, height: 800, tag: "1280" }, { width: 390, height: 844, tag: "390" }] as const;
	const press = (v: Awaited<ReturnType<typeof views.view>>) => v.evaluate("document.getElementById('go').click()");
	const numberOf = (v: Awaited<ReturnType<typeof views.view>>) => v.evaluate("document.getElementById('number').textContent") as Promise<string>;

	for (const { width, height, tag } of size) {
		test(`allow at ${width}px: the button, the number, then the app with the API open and no cookie in script reach`, async () => {
			localLogin.clear();
			asked.length = 0;
			const v = await views.view({ width, height });
			await v.navigate(`${origin}/`);
			expect(await text(v)).toContain("이 컴퓨터에서만 들어올 수 있어요. 아래 버튼을 누르면 화면에 확인 창이 떠요.");
			const high = (await v.evaluate("document.getElementById('go').getBoundingClientRect().height")) as number;
			expect(high).toBeGreaterThanOrEqual(44);
			expect(await v.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
			await Bun.write(`${SHOTS}/login-page-${tag}.png`, await v.screenshot());

			await press(v);
			await waitFor(v, "!document.getElementById('number').hidden && document.getElementById('number').textContent.length === 4");
			await asked.until(items => items.length === 1, 10_000, "the dialog opened");
			expect(await numberOf(v)).toBe(asked[0]!);
			expect(await text(v)).toContain("화면에 뜬 확인 창에 같은 번호가 보이면 허용을 눌러 주세요.");
			await Bun.write(`${SHOTS}/login-number-${tag}.png`, await v.screenshot());

			const from = seen.length;
			settleDialog("allow");
			await seen.until(items => items.slice(from).includes("/api/state 200"), 15_000, "the app's /api/state with the cookie");
			await waitFor(v, "location.pathname === '/' && !!document.querySelector('#app')");
			expect(await v.evaluate("fetch('/api/state').then(r => r.status)")).toBe(200);
			expect(await v.evaluate("document.cookie")).not.toContain("dotz_local");
		});
	}

	test("deny: the page says it was not allowed and the button works again", async () => {
		localLogin.clear();
		asked.length = 0;
		const v = await views.view({});
		await v.navigate(`${origin}/`);
		await press(v);
		await asked.until(items => items.length === 1, 10_000, "the dialog opened");
		settleDialog("deny");
		await waitFor(v, "document.getElementById('msg').textContent.includes('허용하지 않았어요')", 15_000);
		expect(await text(v)).toContain("허용하지 않았어요. 다시 하려면 버튼을 눌러 주세요.");
		expect(await v.evaluate("document.getElementById('go').disabled")).toBe(false);
		expect(await v.evaluate("document.cookie")).not.toContain("dotz_local");
		expect(await v.evaluate("fetch('/api/state').then(r => r.status)")).toBe(403);
	});
});
