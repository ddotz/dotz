// 메일 목록을 열 때 모니터 목록은 방금 읽은 게 신선하면 다시 읽지 않고, 오래됐으면 다시 읽어요(앱 목록은 늘 읽어요).
// Headless (Bun.WebView) against a fake hub; the page counts its own api() calls, so every call made is counted.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, run, ev, waitFor } from "./test-web.ts";

let items: object[] = [];
const hub = fakeHub({
	api(_req, url) {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items });
		if (p === "/api/integrations") return json({ items: [], available: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());
const mon = (id: string) => ({ id, kind: "watch", watch: id, label: id, last_result: "ok", next_run: "2026-11-09T04:00:00.000Z" });

test("opening the mail list reuses a fresh monitor list and reads a stale one", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	await waitFor(v, `typeof NM !== "undefined" && NM.loaded && INTG.loaded && S`);
	await v.evaluate(`loadMonitors().then(() => 1)`);
	await waitFor(v, `!document.hidden`);
	await run(v, `window.__n = { mon: 0, intg: 0 }; const o = api; api = (p, ...r) => { if (p === "/api/monitors") __n.mon++; if (p === "/api/integrations") __n.intg++; return o(p, ...r); }`);
	await run(v, `go("monitoring", "i:mail")`);
	await waitFor(v, `MON.sel === "i:mail" && INTG.loaded`);
	await waitFor(v, `__n.intg === 1`);
	expect(await ev<{ mon: number; intg: number }>(v, `__n`)).toEqual({ mon: 0, intg: 1 });

	// Two minutes later the list is stale: it is read again and the new answer is what the screen holds.
	items = [mon("w-new")];
	await run(v, `const off = 120000, real = Date.now.bind(Date); Date.now = () => real() + off; __n.mon = 0; go("monitoring", "i:mail")`);
	await waitFor(v, `NM.items.length === 1`);
	expect(await ev<number>(v, `__n.mon`)).toBe(1);
}, 30_000);
