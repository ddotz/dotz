// A burst of live `mail_unreplied` frames (one per mail, one per finished summary) must not re-read the whole conversation list once per frame:
// the page answers the burst with one load at once and one trailing load, and a lone frame later still loads straight away.
// Headless (Bun.WebView) against a fake hub that counts the GETs; the answer carries the request number so the last answer is the one that shows.
import { afterAll, afterEach, expect, test } from "bun:test";
import { emit, sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const json = (v: unknown) => Response.json(v);
let convReqs = 0;

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }]);
		if (p === "/api/integrations") { return json({ items: [], available: [] }); }
		if (p === "/api/conversations") {
			const n = ++convReqs;
			return json({ items: [{ target: "main", unread: n, read: null, last: { ts: new Date(Date.UTC(2026, 10, 5, 1, 0, 0)).toISOString(), text: "새 메일", from: "bot" } }] });
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterEach(() => { for (const v of views.splice(0)) v.close(); });
afterAll(() => server.stop(true));
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else setTimeout(tick, 20); }; tick(); })`);
// A bounded wait for requests the page makes to the fake hub (no fixed sleep decides anything).
const until = async (ok: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timeout waiting for the hub"); await Bun.sleep(20); } };
const mailFrame = () => emit("outbox", { kind: "mail_unreplied", ts: new Date().toISOString(), source: "gateway", channel: "web", text: "" } as never);

test("50 mail_unreplied frames make at most 2 conversation loads; a lone frame later loads at once", async () => {
	const v = new Bun.WebView({ width: 1280, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && CV.loaded && INTG.loaded && !mailLive.busy()`);
	// A window wider than the hub round trip, so "at once" and "trailing" cannot be confused.
	await v.evaluate(`LIVE_GAP = 1500, 0`);
	const base = convReqs;

	for (let i = 0; i < 50; i++) mailFrame();
	await until(() => convReqs - base >= 1);
	await waitFor(v, `!mailLive.busy()`, 15_000);
	expect(convReqs - base).toBeLessThanOrEqual(2);
	// the last answer is the one applied
	await waitFor(v, `ts(MAIN).unread === ${convReqs}`);

	const before = convReqs;
	mailFrame();
	await until(() => convReqs === before + 1, 1000);
	await waitFor(v, `ts(MAIN).unread === ${convReqs}`);
}, 30_000);
