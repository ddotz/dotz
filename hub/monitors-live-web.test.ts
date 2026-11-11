// A burst of live watch notices must not re-read the monitor list once per notice: one load at once and one trailing load, as for mail (31-conversations.js coalesced).
// Headless (Bun.WebView) against a fake hub that counts the GETs.
import { afterAll, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { ev, fakeHub, json, run, waitFor } from "./test-web.ts";

const hub = fakeHub({
	api(req, url) {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());
const watchNotice = (i: number) => {
	const at = new Date(Date.UTC(2026, 10, 5, 1, 0, i)).toISOString();
	emit("outbox", { kind: "notice", ts: at, source: "gateway", channel: "web", text: "", item: { id: `w${i}`, cls: "news", kind: "watch", tone: "", title: "가격 소식", text: "가격 소식", open: "alert", src: "alert", at, ts: at, updated: at, read: false } } as never);
};

test("50 watch notices make at most 2 monitor loads", async () => {
	const v = await hub.view({ width: 1280, height: 900 }, "/");
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await v.evaluate(`LIVE_GAP = 1500, 0`);
	// Counted in the page when the call is made, so every frame handled means every load counted.
	await run(v, `window.__mon = 0; const o = api; api = (p, ...r) => { if (p === "/api/monitors") __mon++; return o(p, ...r); }`);
	for (let i = 0; i < 50; i++) watchNotice(i);
	await waitFor(v, `NT.items.length === 50`);
	await waitFor(v, `!monitorsLive.busy()`, 15_000);
	const loads = await ev<number>(v, `__mon`);
	expect(loads).toBeGreaterThanOrEqual(1);
	expect(loads).toBeLessThanOrEqual(2);
}, 30_000);
