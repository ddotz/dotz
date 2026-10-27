// The run state line inside a mail conversation (web/js/41-runstate.js): a request deferred to a background worker shows
// "작업 중 · <description> · <elapsed>" there, on this computer and when the mail is opened from the other one. /api/state
// carries it under `runs["mail:<key>"]` (hub/routes.ts stateRuns), a peer snapshot under `items.runs` (hub/peer-monitor.ts).
import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const MINI = "http://mini.test";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 6, min)).toISOString();
type Run = { kind: string; reason?: string; since?: string; detail?: string; todos?: number };
const WORKING: Run = { kind: "working", since: ago(4), detail: "큐피드 연결 스크립트 흐름도 HTML · Opus 5.5 medium" };
const FAILED: Run = { kind: "error", since: ago(7), detail: "child turn produced no assistant output · 다시 맡기지 않았어요" };
const MAIL = { subject: "KDB 메일", from: "민수 <m@example.com>", source: "mail", at: at(20), summary: "흐름도 부탁드려요" };
const LAST = { ts: at(20), text: "KDB 메일", from: "bot" };
const MAIL_APP = { key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], unread: 1, notices: [], needs: { drafts: 0, unread: 1, sentToday: 0 } };
type Peer = { name: string; url: string; online: boolean; stale: boolean; items: Record<string, unknown> | null };
const peers: Peer[] = [{
	name: "맥미니", url: MINI, online: true, stale: false,
	items: {
		name: "맥미니", rev: "r1", monitors: [], notices: [], integrations: [MAIL_APP], available: [],
		conversations: [{ target: "mail:abc", unread: 1, read: null, mail: MAIL, last: LAST }],
		runs: { "mail:abc": WORKING },
	},
}];
const json = (v: unknown) => Response.json(v);
let RUNS: Record<string, Run> = { main: { kind: "idle" }, "mail:loc": FAILED };
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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 1, work: [], work_now: Date.now(), runs: RUNS });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, ...peers.map(x => ({ name: x.name, url: x.url, self: false, online: x.online }))]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 1, items: [{ id: "n1", kind: "watch", tone: "ok", title: "로컬", text: "소식", ts: at(5), read: false }] });
		if (p === "/api/integrations") return json({ items: [MAIL_APP] });
		if (p === "/api/conversations") return json({ items: [{ target: "mail:loc", unread: 1, read: null, mail: MAIL, last: LAST }] });
		if (p === "/api/monitoring/peers") return json(peers);
		if (p === "/api/peer/proxy") return json({ events: [] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [
			{ ts: at(20), kind: "mail", subject: MAIL.subject, from: MAIL.from, mail: "loc", conv: "mail:loc", text: "민수 · KDB 메일\n\n흐름도 부탁드려요" },
			// The delivery record the outbox keeps for an owner message (`kind: "delivery"`): no text of its own, so it must not be a bubble.
			{ ts: at(21), kind: "delivery", source: "gateway", target: "mail:loc", state: "answered", text: "" },
		] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/todo") return json({ phases: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
let load = 0;
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const boot = async (hash = "#chat") => {
	const v = new Bun.WebView({ width: 1280, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/?load=${++load}${hash}`);
	await waitFor(v, `S && typeof target === "string" && S.runs`);
	return v;
};
const line = (v: View) => v.evaluate(`document.querySelector("#runstate").hidden ? "" : document.querySelector("#runstate-tx").textContent`);

test("a mail conversation on this computer shows the background worker its request was deferred to", async () => {
	const v = await boot();
	await v.evaluate(`(go("chat", "mail:loc"), 0)`);
	await waitFor(v, `target === "mail:loc" && !$("#runstate").hidden`);
	expect(await line(v)).toBe("오류로 멈췄어요 · child turn produced no assistant output · 다시 맡기지 않았어요");
	expect(await v.evaluate(`[...document.querySelectorAll("#tl .bm")].every(n => n.textContent.trim().length > 0)`)).toBe(true);
	RUNS = { ...RUNS, "mail:loc": WORKING };
	await v.evaluate(`refreshState().then(() => true)`);
	await waitFor(v, `!$("#runstate").hidden && $("#runstate-tx").textContent.startsWith("작업 중")`);
	expect(await line(v)).toBe("작업 중 · 큐피드 연결 스크립트 흐름도 HTML · Opus 5.5 medium · 4분");
}, 20_000);

test("the same mail opened from the other computer shows that computer's run state", async () => {
	const v = await boot();
	await waitFor(v, `PQ.loaded === undefined || true`);
	await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|i:mail`)}), 0)`);
	await waitFor(v, `PQ.loaded && $("#mon-tl .mr")`);
	await v.evaluate(`($("#mon-tl .mr").click(), 0)`);
	await waitFor(v, `target === "mail:abc" && !$("#runstate").hidden`);
	expect(await v.evaluate(`pqPc(target) && pqPc(target).url`)).toBe(MINI);
	expect(await line(v)).toBe("작업 중 · 큐피드 연결 스크립트 흐름도 HTML · Opus 5.5 medium · 4분");
}, 20_000);
