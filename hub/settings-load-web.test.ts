// 설정 첫 화면을 열 때 업데이트(5분마다 갱신)와 공급자 목록은 방금 읽은 게 신선하면 다시 읽지 않고, 오래됐으면 다시 읽어요.
// Headless (Bun.WebView) against a fake hub; the page counts its own api() calls, so every call made is counted.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, run, ev, waitFor } from "./test-web.ts";

let providers = [{ id: "anthropic", label: "Anthropic" }];
const hub = fakeHub({
	api(_req, url) {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/providers") return json({ providers });
		return undefined;
	},
});
afterAll(() => hub.stop());
type Counts = { update: number; harness: number; providers: number; rest: number };

test("opening settings reuses fresh update and provider data and reads stale ones", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	await waitFor(v, `typeof UPD !== "undefined" && S && UPD.info && HV.info && P`);
	await v.evaluate(`Promise.all([loadUpdate(), loadProviderData()]).then(() => 1)`);
	await run(v, `window.__n = { update: 0, harness: 0, providers: 0, rest: 0 }; const o = api; api = (p, ...r) => { const k = p === "/api/update" ? "update" : p === "/api/harness/update" ? "harness" : p === "/api/providers" ? "providers" : "rest"; __n[k]++; return o(p, ...r); }`);
	await run(v, `go("settings")`);
	await waitFor(v, `current === "settings" && __n.rest >= 4`);
	expect(await ev<Counts>(v, `__n`)).toMatchObject({ update: 0, harness: 0, providers: 0 });

	// Ten minutes later both are stale: each is read again and the new answer is what the screen holds.
	providers = [{ id: "anthropic", label: "Anthropic" }, { id: "openai", label: "OpenAI" }];
	await run(v, `const off = 600000, real = Date.now.bind(Date); Date.now = () => real() + off; __n.update = __n.harness = __n.providers = __n.rest = 0; go("settings")`);
	await waitFor(v, `P.providers.length === 2`);
	await waitFor(v, `__n.update === 1 && __n.harness === 1`);
	expect(await ev<Counts>(v, `__n`)).toMatchObject({ update: 1, harness: 1, providers: 1 });
}, 30_000);
