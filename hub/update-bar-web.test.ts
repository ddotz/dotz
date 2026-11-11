// The top update bar (web/js/24-settings-update.js, hub/update-now.ts flow): a new version offers itself with one tap, the tap runs
// download -> waiting -> restarting -> done (or failed with the reason and a retry), and the bar never covers the app. Headless
// (Bun.WebView) against a fake hub. Nothing sleeps: the page's poll timer and the "done" timer are held by the test and run on demand.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.UPDATE_SHOTS ?? join(tmpdir(), "dotz-update-bar");
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown, status = 200) => Response.json(v, { status });
const sha = (s: string) => ({ sha: s.repeat(40), short: s.repeat(7), date: new Date(Date.UTC(2026, 10, 1)).toISOString() });
const HEAD = "c".repeat(40);
const KEY = "dotz-upd-bar";
const FAIL_REASON = "새 버전이 테스트를 통과하지 못해서 지금 버전을 그대로 뒀어요";

type Mode = "new" | "download" | "waiting" | "down" | "done" | "failed";
let mode: Mode = "new", posts = 0;
const reset = (m: Mode) => { mode = m; posts = 0; };
const FLOW = { id: "f1", at: new Date().toISOString() };
const TEXT = { download: "새 버전을 받고 있어요", waiting: "진행 중인 작업이 끝나면 바로 적용해요", restarting: "다시 켜는 중이에요", done: "업데이트를 마쳤어요" };
const flowNow = () => mode === "download" || mode === "waiting" ? { ...FLOW, phase: mode, text: TEXT[mode] } : mode === "done" ? { ...FLOW, phase: "done", text: TEXT.done } : mode === "failed" ? { ...FLOW, phase: "failed", text: FAIL_REASON } : undefined;
const updateInfo = () => {
	const at = mode === "done" ? sha("b") : sha("a");
	return { running: { kind: "git", branch: "main", commit: at }, disk: { kind: "git", branch: "main", commit: at }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [],
		...(mode === "done" ? {} : { lastCheck: { at: FLOW.at, version: { kind: "git", branch: "main", commit: sha("a") }, ok: true, upstream: "origin/main", remoteHead: HEAD, incoming: [], incomingTotal: 2, ahead: [], dropped: [], dirty: [], blocked: [] } }),
		...(flowNow() ? { flow: flowNow() } : {}) };
};

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
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ items: [], unread: 0, gone: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/accounts") return json({ error: "no accounts here" }, 404);
		if (p === "/api/update/now" && req.method === "POST") { posts++; mode = "download"; return json({ flow: flowNow() }, 202); }
		if (p === "/api/update") return mode === "down" ? new Response("gateway down", { status: 503 }) : json(updateInfo());
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
// Polls the hub exactly when the test says so: the page's 2 s re-poll and its done timer (UB_DONE_MS) are recorded, never started.
const HOLD = `const st = window.setTimeout; window.heldDone = [];
	window.setTimeout = (f, ms, ...a) => { if (ms === UB_DONE_MS && f !== updBarTick) { window.heldDone.push(f); return -1; } return st(ms === 2000 && f === updBarTick ? () => {} : f, ms, ...a); };`;
async function boot(width: number, height: number, m: Mode) {
	reset(m);
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof UPD !== "undefined" && UPD.info`);
	await run(v, HOLD + ` localStorage.removeItem(${JSON.stringify(KEY)})`);
	await v.evaluate(`loadUpdate().then(() => 0)`);
	return v;
}
const poll = (v: View) => v.evaluate(`updBarTick().then(() => 0)`);
const shot = async (v: View, name: string, width: number) => Bun.write(join(SHOTS, `bar-${name}-${width}.png`), await v.screenshot());
const barText = `($("#upd-bar") && $("#upd-bar .ub-tx").textContent)`;

type Geo = { stray: string; text: string; tag: string; barBottom: number; appTop: number; hOverflow: boolean; barClips: boolean; xOverlap: boolean; pulse: string };
const geo = (v: View) => q<Geo>(v, `const b = $("#upd-bar"), tx = b.querySelector(".ub-tx"), x = b.querySelector(".x"), r = b.getBoundingClientRect(), t = tx.getBoundingClientRect(), xr = x && x.getBoundingClientRect();
	const doc = document.documentElement;
	return { stray: [...b.childNodes].filter(n => n.nodeType !== 1).map(n => n.textContent).join("|"), text: tx.textContent, tag: tx.tagName, barBottom: r.bottom, appTop: document.querySelector(".app").getBoundingClientRect().top,
		hOverflow: doc.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth, barClips: b.scrollWidth > b.clientWidth || t.left < r.left || t.right > r.right,
		xOverlap: !!xr && xr.left < t.right && xr.right > t.left && xr.top < t.bottom && xr.bottom > t.top, pulse: getComputedStyle(tx, "::after").animationName }`);
// Checks 4 and 5 for the state on screen: the bar sits above the app, nothing overflows or is clipped, the × stays off the text, and no test count reaches the owner.
async function sane(v: View, label: string): Promise<Geo> {
	const g = await geo(v);
	expect(g.barBottom, `${label}: bar bottom ${g.barBottom} vs app top ${g.appTop}`).toBeLessThanOrEqual(g.appTop);
	expect(g.hOverflow, `${label}: horizontal overflow`).toBe(false);
	expect(g.barClips, `${label}: text clipped`).toBe(false);
	expect(g.xOverlap, `${label}: × overlaps the text`).toBe(false);
	expect(g.stray, `${label}: loose text in the bar`).toBe("");
	expect(g.text, label).not.toMatch(/\d+ (pass|fail)/);
	return g;
}

describe.each([[390, 844], [1280, 900]] as const)("at %ipx", (width, height) => {
	test("a new version is a button; × dismisses it for that head and it stays away after a reload", async () => {
		const v = await boot(width, height, "new");
		await waitFor(v, `${barText} === "새 버전이 있어요 · 눌러서 업데이트"`);
		const g = await sane(v, "new");
		expect(g.tag).toBe("BUTTON");
		expect(await q<string>(v, `return $("#upd-bar").className`)).toBe("upd-bar new");
		await shot(v, "new", width);
		await run(v, `$("#upd-bar .x").click()`);
		await waitFor(v, `!$("#upd-bar")`);
		expect(await q<string | null>(v, `return localStorage.getItem(${JSON.stringify(KEY)})`)).toBe(HEAD);
		await v.navigate(`http://127.0.0.1:${server.port}/`);
		await waitFor(v, `typeof UPD !== "undefined" && UPD.info && UPD.info.lastCheck`);
		expect(await q<boolean>(v, `return updAvailable() && !$("#upd-bar")`)).toBe(true);
		expect(posts).toBe(0);
	}, 30_000);

	test("the tap posts once and the bar follows download, waiting, the gateway restart and done; done hides itself", async () => {
		const v = await boot(width, height, "new");
		await waitFor(v, `${barText} === "새 버전이 있어요 · 눌러서 업데이트"`);
		await run(v, `$("#upd-bar .ub-tx").click(); $("#upd-bar .ub-tx") && $("#upd-bar .ub-tx").click()`);   // a double tap is still one request
		await waitFor(v, `${barText} === ${JSON.stringify(TEXT.download)} && UB.timer && !UB.busy`);
		expect(posts).toBe(1);
		let g = await sane(v, "download");
		expect(g.tag).toBe("SPAN");
		expect(g.pulse).toBe("none");
		expect(await q<boolean>(v, `return !$("#upd-bar .x")`)).toBe(true);
		await shot(v, "download", width);

		mode = "waiting";
		await poll(v);
		await waitFor(v, `${barText} === ${JSON.stringify(TEXT.waiting)}`);
		g = await sane(v, "waiting");
		expect(g.pulse).toBe("none");
		await shot(v, "waiting", width);

		mode = "down";   // the gateway exits: /api/update stops answering
		await poll(v);
		await waitFor(v, `${barText} === ${JSON.stringify(TEXT.restarting)}`);
		g = await sane(v, "restarting");
		expect(g.pulse).toBe("none");
		await shot(v, "restarting", width);

		mode = "done";   // back, with the new version running
		await poll(v);
		await waitFor(v, `${barText} === "업데이트를 마쳤어요 · 지금 버전 ${"b".repeat(7)}"`);
		g = await sane(v, "done");
		expect(g.pulse).toBe("none");
		expect(await q<string>(v, `return $("#upd-bar").className`)).toBe("upd-bar done");
		await shot(v, "done", width);
		expect(await q<number>(v, `return document.querySelectorAll("#upd-bar .x").length`)).toBe(0);   // a finished update has no × to press
		expect(await q<number>(v, `return window.heldDone.length`)).toBe(1);   // the done timer is armed once
		expect(await q<string | null>(v, `return localStorage.getItem(${JSON.stringify(KEY)})`)).toBeNull();
		await run(v, `window.heldDone[0]()`);   // ... and when it fires the result is marked seen and the bar goes
		await waitFor(v, `!$("#upd-bar")`);
		expect(await q<string | null>(v, `return localStorage.getItem(${JSON.stringify(KEY)})`)).toBe("f1");
		expect(posts).toBe(1);
	}, 30_000);

	test("a failed update names the reason, is a button, and a tap asks the hub again", async () => {
		const v = await boot(width, height, "failed");
		const want = `업데이트하지 못했어요: ${FAIL_REASON} · 눌러서 다시 시도`;
		await waitFor(v, `${barText} === ${JSON.stringify(want)}`);
		const g = await sane(v, "failed");
		expect(g.tag).toBe("BUTTON");
		await shot(v, "failed", width);
		await run(v, `$("#upd-bar .ub-tx").click()`);
		await waitFor(v, `${barText} === ${JSON.stringify(TEXT.download)}`);
		expect(posts).toBe(1);
		expect(mode).toBe("download");
	}, 30_000);
});
