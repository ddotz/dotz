// 첫 화면을 그릴 때 같은 목록을 두 번 읽지 않고, 실패한 화면 보고는 2초마다 다시 보내지 않아요.
// Headless (Bun.WebView) against a fake hub; the page counts its own api() calls, so every call made is counted.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, run, ev, waitFor } from "./test-web.ts";

const hub = fakeHub({
	api(req, url) {
		if (url.pathname === "/api/viewing" && req.method === "POST") return json({ error: "forbidden" }, 403);
		return undefined;
	},
});
afterAll(() => hub.stop());
const count = `window.__n = {}; window.__out = 0; const o = api; api = (p, ...r) => { const k = p.split("?")[0]; __n[k] = (__n[k] || 0) + 1; __out++; const x = o(p, ...r); x.then(() => __out--, () => __out--); return x; }`;

test("loads that boot and refreshState both start are one request each", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	await waitFor(v, `typeof NM !== "undefined" && NM.loaded && NT.loaded && S && P && C && MN.info && INTG.loaded`);
	await run(v, count);
	await waitFor(v, `__out === 0`);
	// Counted in the same page turn as the calls: an answer that comes later (ntSync reads again when the answer disagrees with the state's count) is a separate, legitimate request.
	const n = await ev<Record<string, number>>(v, `(() => { stripAt = 0; loadHomeData(); loadStrip(); loadMonitors(); loadProviderData(); loadContext(true); loadContext(true); mnLoad(); mnLoad(); ntSync({ notices_unread: 5 }); ntSync({ notices_unread: 6 }); return { ...__n }; })()`);
	expect({ quota: n["/api/quota"], monitors: n["/api/monitors"], providers: n["/api/providers"], context: n["/api/context"], machine: n["/api/machine"], notices: n["/api/notices"] })
		.toEqual({ quota: 1, monitors: 1, providers: 1, context: 1, machine: 1, notices: 1 });
}, 30_000);

test("a viewing report that fails waits 10 s, then 20 s, instead of going out every tick", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	await waitFor(v, `typeof VIEW !== "undefined" && S`);
	await run(v, `window.__v = 0; const o = api; api = (p, ...r) => { if (p === "/api/viewing") __v++; return o(p, ...r); }; current = "chat"; viewReport()`);
	await waitFor(v, `VIEW.sent === "?"`);
	for (let i = 0; i < 4; i++) await run(v, `viewReport()`);
	expect(await ev<number>(v, `__v`)).toBe(1);

	// 11 s later it is tried once more and fails again; the next wait is 20 s.
	await run(v, `const real = Date.now.bind(Date); Date.now = () => real() + 11000; viewReport()`);
	await waitFor(v, `__v === 2 && VIEW.fails === 2`);
	await run(v, `viewReport(); viewReport()`);
	expect(await ev<number>(v, `__v`)).toBe(2);
	await run(v, `const real = Date.now.bind(Date); Date.now = () => real() + 20000; viewReport()`);
	await waitFor(v, `__v === 3`);
}, 30_000);
