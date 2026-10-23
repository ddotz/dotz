import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { viewOf } from "./app-settings.ts";
import { sseResponse } from "./events.ts";
import { WATCH_FIELDS } from "./watch-settings.ts";
import { appAsset, indexPage } from "./webapp.ts";

// Every monitor has a conversation with the orchestrator of the computer that owns it (web/js/32-app-settings.js, 34-peer-monitoring.js): a
// failing login keeper shows quick-action chips that fill the composer, a message to a local monitor goes to this gateway, a message to a peer's
// monitor goes through /api/peer/proxy as the 'message' act, and the peer's answer shows here. Headless; the peer is a fixture.
const SHOTS = process.env.SETTINGS_SHOTS ?? "/tmp/mon-chat-shots";
mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 3, min)).toISOString();
const failing = (name: string, label: string) => ({ name: label, watch: name, kind: "watch", last_run: at(32), last_result: "fail", next_run: at(62), every: "30분마다", fails: 3, last_ok: at(2), last_output: "로그인이 풀렸어요 로그인 화면이 다시 나왔어요", keeper: true });
const PEER_T = "settings:w:login-cartier-com";
const fields = () => WATCH_FIELDS.map(f => viewOf(f, f.key === "enabled" ? true : f.key === "every_minutes" ? 30 : f.key === "to" ? "alert" : "까르띠에 로그인 유지"));

const sent: Record<string, unknown>[] = [];
const acts: { action: string; args: Record<string, unknown> }[] = [];
const peerHistory: Record<string, unknown>[] = [];
const json = (v: unknown, status = 200) => Response.json(v, { status });
const peers = [{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: [failing("login-cartier-com", "까르띠에 로그인 유지")], notices: [], integrations: [], conversations: [] } }];

async function proxy(req: Request, url: URL): Promise<Response> {
	const p = url.searchParams.get("p") ?? "";
	if (req.method === "POST") {
		const a = (await req.json()) as (typeof acts)[number];
		acts.push(a);
		if (a.action === "message") {
			peerHistory.push({ ts: at(40), kind: "message", source: "web", channel: PEER_T, author: "local", text: a.args.text, via: "맥북" });
			peerHistory.push({ ts: at(41), kind: "out", source: "orchestrator", target: PEER_T, text: "맥미니에서 다시 로그인했어요. 다음 확인 때 정상으로 바뀌는지 볼게요." });
		}
		return json({ ok: true });
	}
	if (p === "/api/watches/login-cartier-com/settings") return json({ key: "login-cartier-com", fields: fields() });
	if (p.startsWith("/api/history")) return json({ target: PEER_T, events: peerHistory });
	return json({});
}
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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, ...peers.map(x => ({ name: x.name, url: x.url, self: false, online: x.online }))]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitors") return json({ items: [failing("login-local", "로컬 로그인 유지"), { name: "정상 감시", watch: "ok-watch", kind: "watch", last_run: at(30), last_result: "ok", next_run: at(60), every: "30분마다", fails: 0, last_ok: at(30) }] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitoring/peers") return json(peers);
		if (p === "/api/peer/proxy") return proxy(req, url);
		if (/^\/api\/watches\/[a-z-]+\/settings$/.test(p)) return json({ key: "local", fields: fields() });
		if (p === "/api/message") { sent.push((await req.json()) as Record<string, unknown>); return json({ ok: true }); }
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const PEER_KEY = `p:${MINI}|m:까르띠에 로그인 유지`;
const boot = async (width: number, height: number, key: string) => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && PQ.list.length && monItems().some(i => i.key === ${JSON.stringify(key)})`);
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	return v;
};
const CHIPS = ["다시 로그인해 줘", "원인 찾아 줘", "일시정지"];

describe("a failing peer monitor", () => {
	test("the detail view says what failed in words, with the machine, the settings row and the quick-action chips", async () => {
		const v = await boot(1280, 800, PEER_KEY);
		await waitFor(v, `document.querySelector("#mon-tl .as-pin") && document.querySelector("#mon-tl [data-chip]")`);
		const t = await q<string>(v, `return document.querySelector("#mon-tl").textContent`);
		for (const s of ["연속 실패 3번", "마지막 정상", "로그인이 풀렸어요"]) expect(t).toContain(s);
		expect(await q(v, `return document.querySelector("#mon-head .mon-pc").textContent`)).toBe("맥미니");
		expect(await q(v, `return [...document.querySelectorAll("#mon-tl [data-chip]")].map(b => b.dataset.chip)`)).toEqual(CHIPS);
		expect(await q(v, `return [...document.querySelectorAll("#mon-side .cv-row")].find(r => r.dataset.k === ${JSON.stringify(PEER_KEY)}).textContent`)).toContain("실패");
	});

	test("a chip fills the composer of the peer's conversation, the switches are the peer's, a message is forwarded and the answer shows", async () => {
		const v = await boot(1280, 800, PEER_KEY);
		await waitFor(v, `document.querySelector("#mon-tl [data-chip]")`);
		await run(v, `document.querySelector('#mon-tl [data-chip="다시 로그인해 줘"]').click()`);
		await waitFor(v, `target === "${PEER_T}" && document.querySelector('#app-sw [data-k="enabled"]') && document.querySelector("#mon-chips [data-chip]")`);
		expect(await q(v, `return ta.value`)).toBe("다시 로그인해 줘");
		expect(await q(v, `return [...document.querySelectorAll("#mon-chips [data-chip]")].map(b => b.dataset.chip)`)).toEqual(CHIPS);
		await run(v, `document.querySelector('#app-sw [data-k="enabled"]').click()`);
		const deadline = Date.now() + 5000;
		while (!acts.some(a => a.action === "watch") && Date.now() < deadline) await Bun.sleep(25);
		expect(acts.find(a => a.action === "watch")).toEqual({ action: "watch", args: { op: "settings", name: "login-cartier-com", values: { enabled: false } } });
		await run(v, `sendChat()`);
		const d2 = Date.now() + 5000;
		while (!acts.some(a => a.action === "message") && Date.now() < d2) await Bun.sleep(25);
		expect(acts.find(a => a.action === "message")).toMatchObject({ args: { target: PEER_T, text: "다시 로그인해 줘" } });
		expect(sent).toEqual([]);
		await waitFor(v, `document.querySelector("#tl").textContent.includes("맥미니에서 다시 로그인했어요")`, 15_000);
	});

	test("390px phone: the failing peer monitor's detail", async () => {
		const v = await boot(390, 844, PEER_KEY);
		await waitFor(v, `document.querySelector("#mon-tl .as-pin") && document.querySelector("#mon-tl [data-chip]")`);
		await Bun.write(join(SHOTS, "peer-monitor-detail-390.png"), await v.screenshot());
		expect(await q<number>(v, `return document.documentElement.scrollWidth`)).toBeLessThanOrEqual(390);
	});
});

describe("a failing local monitor", () => {
	test("shows the same chips and a message goes to this gateway's orchestrator as the monitor's settings target; a healthy one has no chips", async () => {
		const v = await boot(1280, 800, "m:로컬 로그인 유지");
		await waitFor(v, `document.querySelector("#mon-tl [data-chip]")`);
		expect(await q(v, `return [...document.querySelectorAll("#mon-tl [data-chip]")].map(b => b.dataset.chip)`)).toEqual(CHIPS);
		await run(v, `document.querySelector('#mon-tl [data-chip="원인 찾아 줘"]').click()`);
		await waitFor(v, `target === "settings:w:login-local" && ta.value === "원인 찾아 줘"`);
		await run(v, `sendChat()`);
		const deadline = Date.now() + 5000;
		while (!sent.length && Date.now() < deadline) await Bun.sleep(25);
		expect(sent[0]).toMatchObject({ text: "원인 찾아 줘", settings: "w:login-local" });
		await run(v, `go("monitoring", "m:정상 감시")`);
		await waitFor(v, `document.querySelector("#mon-tl .rc")`);
		expect(await q(v, `return document.querySelectorAll("#mon-tl [data-chip]").length`)).toBe(0);
	});
});
