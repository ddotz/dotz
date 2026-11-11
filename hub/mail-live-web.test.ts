// A burst of live `mail_unreplied` frames (one per mail, one per finished summary) must not re-read the whole conversation list once per frame:
// the page answers the burst with one load at once and one trailing load, and a lone frame later still loads straight away.
// Headless (Bun.WebView) against a fake hub that counts the GETs; the answer carries the request number so the last answer is the one that shows.
import { afterEach, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { fakeHub, inbox, json, waitFor } from "./test-web.ts";

// One entry per GET /api/conversations; until() wakes on the push that reaches the count (no polling, no fixed sleep).
const convReqs = inbox<number>();

const hub = fakeHub({
	api(req, url) {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/peers") return json([{ name: "맥북", url: hub.origin, self: true, online: true }]);
		if (p === "/api/integrations") return json({ items: [], available: [] });
		if (p === "/api/conversations") {
			const n = convReqs.length + 1;
			convReqs.push(n);
			return json({ items: [{ target: "main", unread: n, read: null, last: { ts: new Date(Date.UTC(2026, 10, 5, 1, 0, 0)).toISOString(), text: "새 메일", from: "bot" } }] });
		}
		return undefined;
	},
});
afterEach(() => hub.stop());
const mailFrame = () => emit("outbox", { kind: "mail_unreplied", ts: new Date().toISOString(), source: "gateway", channel: "web", text: "" } as never);

test("50 mail_unreplied frames make at most 2 conversation loads; a lone frame later loads at once", async () => {
	const v = await hub.view({ width: 1280, height: 900 }, "/");
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && CV.loaded && INTG.loaded && !mailLive.busy()`);
	// A window wider than the hub round trip, so "at once" and "trailing" cannot be confused.
	await v.evaluate(`LIVE_GAP = 1500, 0`);
	const base = convReqs.length;

	for (let i = 0; i < 50; i++) mailFrame();
	await convReqs.until(r => r.length - base >= 1, 5000, "the first load");
	await waitFor(v, `!mailLive.busy()`, 15_000);
	expect(convReqs.length - base).toBeLessThanOrEqual(2);
	// the last answer is the one applied
	await waitFor(v, `ts(MAIN).unread === ${convReqs.length}`);

	const before = convReqs.length;
	mailFrame();
	await convReqs.until(r => r.length === before + 1, 1000, "the lone frame's load");
	await waitFor(v, `ts(MAIN).unread === ${convReqs.length}`);
}, 30_000);
