import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The owner on the MacBook writes in a mail conversation of the Mac mini whose bot is paused. The page reads that conversation through the proxy and never
// gets the mini's events on its own stream, so the notice the mini writes afterwards has to arrive by the page's repeated read; the composer says the bot is
// paused. Headless; the two gateways are fixtures.
const MINI = "http://mini.test";
const T = "mail:kdb-66931568";
const THREAD = "th:1563113405412282505";
const json = (v: unknown, status = 200) => Response.json(v, { status });
const MAIL = { key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } };
const asked = { ts: "2026-10-23T12:50:00.000Z", kind: "message", source: "web", channel: THREAD, conv: T, author: "hyuns", mid: "m1", text: "답장 초안 작성해." };
const history: Record<string, unknown>[] = [asked];
const miniBot = { status: "rate-limited", pauseKind: "owner" };
const localBot = { status: "rate-limited", pauseKind: "rate" };
const peers = () => [{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: [], notices: [], integrations: [MAIL], available: [], conversations: [{ target: T, mail: { key: "kdb-66931568", subject: "견적 요청", from: "Kim", source: "kdb", at: asked.ts }, last: { text: "메일 본문", via: "kdb" }, unread: 0 }], orchestrator: miniBot } }];

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: localBot, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, { name: "맥미니", url: MINI, self: false, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json(peers());
		if (p === "/api/peer/proxy" && (url.searchParams.get("p") ?? "").startsWith("/api/history")) return json({ target: T, events: history });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/monitors" || p === "/api/notices" || p === "/api/integrations" || p === "/api/conversations") return json({ items: [], unread: 0 });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 12_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);

test("a peer's mail conversation gets the mini's later notice and held state, and the composer says its bot is paused", async () => {
	const v = new Bun.WebView({ width: 1280, height: 800 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, "S && PR.fresh");
	await run(v, "go('monitoring')");
	await waitFor(v, `PQ.loaded && PQ.of.has(${JSON.stringify(T)})`);
	await run(v, `setTarget(${JSON.stringify(T)})`);
	await waitFor(v, `$("#tl").textContent.includes("답장 초안 작성해.")`);
	await waitFor(v, `!$("#pausenote").hidden && $("#pausenote").textContent === "맥미니 봇이 멈춰 있어요: 로그인 필요"`);
	expect(await v.evaluate(`$("#tl").textContent.includes("멈춰 있어요")`)).toBe(false);

	history.push(
		{ ts: "2026-10-23T12:50:01.000Z", kind: "delivery", source: "gateway", target: THREAD, conv: T, ref: "m1", state: "held", text: "" },
		{ ts: "2026-10-23T12:50:02.000Z", kind: "out", source: "gateway", target: THREAD, conv: T, text: "지금 모델 제공자 결제/인증 문제로 멈춰 있어요. 해결되면 받은 메시지부터 이어서 처리할게요.", reply_to: "m1" },
	);
	await waitFor(v, `$("#tl").textContent.includes("모델 제공자 결제/인증 문제로 멈춰 있어요") && $("#tl").textContent.includes("한도가 풀리면 전달")`);
}, 30_000);

test("a conversation of this computer reads its own bot's pause from the orchestrator status", async () => {
	const v = new Bun.WebView({ width: 1280, height: 800 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, "S && PR.fresh");
	await waitFor(v, `!$("#pausenote").hidden && $("#pausenote").textContent === "맥북 봇이 멈춰 있어요: 사용량 한도"`);
	await run(v, "go('monitoring')");
	await waitFor(v, `PQ.loaded && PQ.of.has(${JSON.stringify(T)})`);
	await run(v, "setTarget('lane:x')");
	await waitFor(v, `$("#pausenote").hidden`);
}, 30_000);
