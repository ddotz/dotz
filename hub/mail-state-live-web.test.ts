// A mail whose draft went out turns 답장함 on the page at once, from the gateway's live frame alone: this computer's mail on its own
// mail_unreplied, the other computer's mail on the peer_counts this gateway forwards after that computer's change (hub/peer-stream.ts).
// Headless browser against a fake hub whose stores the test flips; no click, reload or navigation after the first paint.
import { afterAll, expect, test } from "bun:test";
import { broadcast, sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const json = (v: unknown, status = 200) => Response.json(v, { status });
const iso = (h: number) => new Date(Date.UTC(2026, 9, 27, h, 0)).toISOString();
const PEER = "http://mini.test";
const card = (subject: string, h: number, reply: string) => ({ subject, from: "Kim <kim@example.com>", source: "mail", at: iso(h), summary: "회신 부탁드려요.", reply });
let localReply = "draft", peerReply = "draft";
const convs = (target: string, subject: string, reply: string) => [{ target, unread: 0, read: null, mail: card(subject, 9, reply), last: { ts: iso(9), text: subject, from: "bot" } }];
const app = () => ({ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread: 0, unreplied: 0, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 } });

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
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, { name: "맥미니", url: PEER, self: false, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json([{ name: "맥미니", url: PEER, online: true, stale: false, items: { name: "맥미니", rev: `r-${peerReply}`, monitors: [], notices: [], available: [], integrations: [app()], conversations: convs("mail:peer-1", "견적 문의드립니다", peerReply) } }]);
		if (p === "/api/integrations") return json({ items: [app()], available: [] });
		if (p === "/api/conversations") return json({ items: convs("mail:loc-1", "계약서 확인 부탁드립니다", localReply) });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const v = new Bun.WebView({ width: 1280, height: 900 });
afterAll(() => { v.close(); server.stop(true); });

const waitFor = (expr: string, ms = 8000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const run = (code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const tag = `(document.querySelector("#mon-tl .mr .mr-state") || {}).textContent`;
async function openList(side: string) {
	await run(`go("monitoring")`);
	await waitFor(`document.querySelector('${side}')`);
	await run(`document.querySelector('${side}').click()`);
	await waitFor(`document.querySelector("#mon-tl .mr")`);
}

test("this computer's mail: 초안 있음 becomes 답장함 on the gateway's mail_unreplied, with no click", async () => {
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && S && typeof INTG !== "undefined" && INTG.items.length === 1`);
	await openList(`#mon-side .cv-row[data-k="i:mail"]`);
	await waitFor(`${tag} === "초안 있음"`);
	localReply = "replied";
	broadcast({ kind: "mail_unreplied", target: "mail:loc-1" });
	await waitFor(`${tag} === "답장함"`);
}, 30_000);

test("the other computer's mail: 초안 있음 becomes 답장함 on the forwarded peer_counts, with no click", async () => {
	await openList(`#mon-side .cv-row[data-k^="p:"][data-k$="i:mail"]`);
	await waitFor(`${tag} === "초안 있음"`);
	peerReply = "replied";
	broadcast({ kind: "peer_counts", source: "gateway", url: PEER, name: "맥미니", online: true, unread: 0, need: 0 });
	await waitFor(`${tag} === "답장함"`);
}, 30_000);
