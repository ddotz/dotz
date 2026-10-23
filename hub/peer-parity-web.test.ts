import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isSettingsTarget, viewOf } from "./app-settings.ts";
import { sseResponse } from "./events.ts";
import { WATCH_FIELDS } from "./watch-settings.ts";
import { appAsset, indexPage } from "./webapp.ts";

// A monitor kept on the Mac mini (a peer's watch) looks exactly like the same monitor on this computer: the list row, the detail, the status card, the
// chips, the settings conversation (chat only) and the settings screen behind its ⋯ button; only the machine chip differs. A peer's app has the same
// title-bar gear and its name is a field of the settings screen. Headless; both computers are fixtures with the same data.
const SHOTS = process.env.PARITY_SHOTS ?? "/tmp/parity-shots";
mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 3, min)).toISOString();
const TITLE = "나스 패키지 새 버전";
const watch = (watch: string) => ({ name: TITLE, watch, kind: "watch", last_run: at(32), last_result: "fail", next_run: at(62), every: "30분마다", fails: 2, last_ok: at(2), last_output: "로그인이 풀렸어요", keeper: true });
const report = (n: number) => ({ id: `n${n}`, ts: at(n), updated: at(n), at: at(n), kind: "watch", tone: "fail", title: TITLE, open: "alert", src: "alert", read: true, text: "새 버전을 확인하지 못했어요" });
const fields = () => WATCH_FIELDS.map(f => viewOf(f, f.key === "enabled" ? true : f.key === "every_minutes" ? 30 : f.key === "to" ? "alert" : TITLE));
const LOCAL_W = "nas-pkg-local", PEER_W = "nas-pkg-mini";
const LOCAL_T = `settings:w:${LOCAL_W}`, PEER_T = `settings:w:${PEER_W}`;
const labelField = (value: string) => ({ key: "label", label: "앱 이름", type: "text", help: "", max: 30, switch: true, value });
const MAIL = { key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } };

const acts: { action: string; args: Record<string, unknown> }[] = [];
const sent: Record<string, unknown>[] = [];
const history: Record<string, Record<string, unknown>[]> = {
	[LOCAL_T]: [{ ts: at(40), kind: "message", source: "web", channel: LOCAL_T, author: "owner", text: "왜 실패했어?" }, { ts: at(41), kind: "out", source: "orchestrator", target: LOCAL_T, text: "로그인이 풀렸어요." }],
	[PEER_T]: [{ ts: at(40), kind: "message", source: "web", channel: PEER_T, author: "owner", text: "왜 실패했어?" }, { ts: at(41), kind: "out", source: "orchestrator", target: PEER_T, text: "로그인이 풀렸어요." }],
};
const json = (v: unknown, status = 200) => Response.json(v, { status });
const peers = [{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: [watch(PEER_W)], notices: [report(30)], integrations: [MAIL], conversations: [] } }];
let mailName = "메일";

const historyOf = (target: string) => (isSettingsTarget(target) ? json({ target, events: history[target] ?? [] }) : json({ error: "target must be main" }, 400));
async function proxy(req: Request, url: URL): Promise<Response> {
	const p = url.searchParams.get("p") ?? "";
	if (req.method === "POST") {
		const a = (await req.json()) as (typeof acts)[number];
		acts.push(a);
		if (a.action === "app" && a.args.op === "settings") { mailName = String((a.args.values as { label: string }).label); return json({ ok: true, fields: [labelField(mailName)] }); }
		return json({ ok: true });
	}
	if (p === `/api/watches/${PEER_W}/settings`) return json({ key: PEER_W, fields: fields() });
	if (p === "/api/integrations/mail/settings") return json({ key: "mail", fields: [labelField(mailName)] });
	if (p.startsWith("/api/history")) return historyOf(new URL(p, MINI).searchParams.get("target") ?? "");
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
		if (p === "/api/monitors") return json({ items: [watch(LOCAL_W)] });
		if (p === "/api/notices") return json({ unread: 0, items: [report(30)] });
		if (p === "/api/integrations") return json({ items: [] });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitoring/peers") return json(peers);
		if (p === "/api/peer/proxy") return proxy(req, url);
		if (p === "/api/history") return historyOf(url.searchParams.get("target") ?? "");
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
const KEYS = { local: `m:${TITLE}`, peer: `p:${MINI}|m:${TITLE}` };
const boot = async (width: number, height: number, key: string) => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && PQ.list.length && monItems().some(i => i.key === ${JSON.stringify(key)})`);
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	await waitFor(v, `document.querySelector("#mon-tl .rc") && document.querySelector("#mon-tl [data-chip]") && document.querySelector("#mon-head .as-hd")`);
	return v;
};
const NORMALIZE = `
const clean = n => {
	const c = n.cloneNode(true);
	for (const x of c.querySelectorAll(".mon-pc")) x.remove();
	for (const x of c.querySelectorAll(".tag")) if (x.textContent === "맥미니") x.remove();
	for (const x of [c, ...c.querySelectorAll("*")]) for (const a of [...x.attributes]) if (/^(data-k|data-t|data-run|data-watch|data-nid|data-as-open|data-as-more|data-sig|id|aria-labelledby)$/.test(a.name)) x.removeAttribute(a.name);
	return c.outerHTML;
};`;
const parts = (v: View, side: "local" | "peer") =>
	q<{ row: string; detail: string; head: string; box: Record<string, number> }>(v, `${NORMALIZE}
		const row = [...document.querySelectorAll("#mon-side .cv-row")].find(r => r.dataset.k === ${JSON.stringify(KEYS[side])});
		const r = n => { const b = n.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
		return { row: clean(row), detail: clean(document.querySelector("#mon-tl")), head: clean(document.querySelector("#mon-head")), box: { row: r(row), tl: r(document.querySelector("#mon-tl")), head: r(document.querySelector("#mon-head")) } };`);
const openScreen = async (v: View) => {
	await waitFor(v, `[...document.querySelectorAll("[data-as-more]")].some(b => b.offsetParent && !b.hidden)`);
	await run(v, `[...document.querySelectorAll("[data-as-more]")].find(b => b.offsetParent && !b.hidden).click()`);
	await waitFor(v, `document.querySelector(".as-screen #app-sw .as-stat") && document.querySelector('.as-screen #app-sw [data-k="enabled"]')`);
};

describe.each([[390, 844], [1280, 800]])("a monitor on the Mac mini and the same one here at %ipx", (width, height) => {
	test("the list row, the detail and the title bar are the same except the machine chip", async () => {
		const local = await parts(await boot(width, height, KEYS.local), "local");
		const peerView = await boot(width, height, KEYS.peer);
		const peer = await parts(peerView, "peer");
		expect(peer.row).toBe(local.row);
		expect(peer.detail).toBe(local.detail);
		expect(peer.head).toBe(local.head);
		expect(peer.box).toEqual(local.box);
		expect(await q(peerView, `return document.querySelector("#mon-head .mon-pc").textContent`)).toBe("맥미니");
		expect(await q(peerView, `return [...document.querySelectorAll("#mon-side .cv-row")].find(r => r.dataset.k === ${JSON.stringify(KEYS.peer)}).textContent`)).toContain("맥미니");
		expect(await q<number>(peerView, `return document.documentElement.scrollWidth`)).toBeLessThanOrEqual(width);
	});

	test("the screenshots", async () => {
		for (const side of ["local", "peer"] as const) {
			const v = await boot(width, height, KEYS[side]);
			await Bun.write(join(SHOTS, `${side}-detail-${width}.png`), await v.screenshot());
		}
	});

	test("the conversation is chat only; ⋯ opens the settings screen with the same status card and rows, back returns", async () => {
		const screens: string[] = [];
		for (const side of ["local", "peer"] as const) {
			const v = await boot(width, height, KEYS[side]);
			const t = side === "local" ? LOCAL_T : PEER_T;
			await run(v, `document.querySelector("#mon-head .as-hd").click()`);
			await waitFor(v, `target === ${JSON.stringify(t)} && document.querySelector("#tl").textContent.includes("로그인이 풀렸어요.") && document.querySelector("#mon-chips [data-chip]")`);
			expect(await q(v, `return document.querySelector("#app-sw")`)).toBeNull();
			expect(await q(v, `return [...document.querySelectorAll("#mon-chips [data-chip]")].map(b => b.dataset.chip)`)).toEqual(["다시 로그인해 줘", "원인 찾아 줘", "일시정지"]);
			expect(await q(v, `return document.querySelector("#tl").textContent.includes("대화를 불러오지 못했어요")`)).toBe(false);
			await openScreen(v);
			screens.push(await q<string>(v, `${NORMALIZE} return clean(document.querySelector(".as-screen #app-sw"))`));
			expect(await q<number>(v, `return document.querySelector(".as-screen").scrollWidth`)).toBeLessThanOrEqual(width);
			await waitFor(v, `document.getAnimations().length === 0`);
			await Bun.write(join(SHOTS, `${side}-settings-${width}.png`), await v.screenshot());
			await run(v, `document.querySelector('.as-screen [data-k="as-back"]').click()`);
			await waitFor(v, `!document.querySelector(".as-screen") && target === ${JSON.stringify(t)}`);
		}
		expect(screens[1]).toBe(screens[0]);
	});
});

describe("a peer's app", () => {
	test("has the title-bar gear; its name is a field of the settings screen and is written through the peer", async () => {
		const key = `p:${MINI}|i:mail`;
		const v = await boot0(1280, 800, key);
		await waitFor(v, `document.querySelector("#mon-head .as-hd")`);
		expect(await q(v, `return document.querySelector("#mon-tl .as-name")`)).toBeNull();
		await run(v, `document.querySelector("#mon-head .as-hd").click()`);
		await openScreen0(v);
		expect(await q(v, `return document.querySelector('.as-screen #app-sw [data-k="label"]').value`)).toBe("메일");
		await run(v, `const i = document.querySelector('.as-screen #app-sw [data-k="label"]'); i.value = "맥미니 메일"; i.dispatchEvent(new Event("change"))`);
		await waitFor(v, `document.querySelector('.as-screen #app-sw [data-k="label"]').value === "맥미니 메일"`);
		const deadline = Date.now() + 5000;
		while (!acts.some(a => a.action === "app") && Date.now() < deadline) await Bun.sleep(25);
		expect(acts.find(a => a.action === "app")).toEqual({ action: "app", args: { op: "settings", app: "mail", values: { label: "맥미니 메일" } } });
		expect(sent).toEqual([]);
	});
});

const boot0 = async (width: number, height: number, key: string) => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && PQ.list.length && monItems().some(i => i.key === ${JSON.stringify(key)})`);
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	return v;
};
const openScreen0 = async (v: View) => {
	await waitFor(v, `[...document.querySelectorAll("[data-as-more]")].some(b => b.offsetParent && !b.hidden)`);
	await run(v, `[...document.querySelectorAll("[data-as-more]")].find(b => b.offsetParent && !b.hidden).click()`);
	await waitFor(v, `document.querySelector('.as-screen #app-sw [data-k="label"]')`);
};
