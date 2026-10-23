import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// The 계정 card in a headless Bun.WebView against a stub gateway that holds five accounts: the 자동 전환 switch, the order numbers, the
// drag-to-reorder grips (synthetic pointer events) and the tap-to-fix rows work through the real page, and the card fits 390px without sideways scrolling.
// Screenshots are written only when ACCOUNTS_SHOTS names a folder.
const SHOTS = process.env.ACCOUNTS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NAMES = ["default", "miseol-shared", "work-long-account-name@example.com", "backup", "team"];
const LABELS: Record<string, string> = { default: "개인 계정", "miseol-shared": "미설 공용 계정", "work-long-account-name@example.com": "회사 계정 (긴 이름 확인용)", backup: "backup", team: "팀" };
let mode: "auto" | "pinned" = "auto";
let pin = "default";
let order = [...NAMES];
const calls: Array<[string, unknown]> = [];
const stateBody = () => ({
	mode,
	chosen: { name: pin, label: LABELS[pin], source: mode === "pinned" ? "manual" : "auto", blocked: null, text: "" },
	accounts: order.map((name, i) => ({
		name,
		order: i + 1,
		alias: LABELS[name] === name ? null : LABELS[name],
		label: LABELS[name],
		current: name === pin,
		blocked: name === "miseol-shared" ? "rate_limit" : null,
		blocked_until: null,
		blocked_tag: name === "miseol-shared" ? "한도 걸림 · 01:00까지" : null,
		five_hour_left: 62 - i * 9,
		seven_day_left: 80 - i * 11,
	})),
	rules: { order },
	rules_text: [{ index: 0, text: "평일 09:00-18:00 · 회사 계정" }],
	script: { path: null, timeout_ms: 5000, every_minutes: 5, last: null },
});

const te = new TextEncoder();
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let streamWaiters: (() => void)[] = [];
const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") {
			let ctl: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({
				start(c) { ctl = c; streams.add(c); c.enqueue(te.encode(": open\n\n")); const w = streamWaiters; streamWaiters = []; for (const f of w) f(); },
				cancel() { streams.delete(ctl); },
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
		}
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: [] });
		if (p === "/api/update" || p === "/api/runtimes") return json({ error: "stub" }, 500);
		if (p === "/api/accounts") {
			if (req.method === "PUT") {
				const b = (await req.json()) as { mode?: "auto" | "pinned"; account?: string; order?: string[] };
				calls.push([p, b]);
			}
			return json(stateBody());
		}
		if (p === "/api/accounts/mode" && req.method === "PUT") {
			const b = (await req.json()) as { mode: "auto" | "pinned"; account?: string };
			calls.push([p, b]);
			mode = b.mode;
			if (b.account) pin = b.account;
			return json(stateBody());
		}
		if (p === "/api/accounts/order" && req.method === "PUT") {
			const b = (await req.json()) as { order: string[] };
			calls.push([p, b]);
			order = b.order;
			return json(stateBody());
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = (width: number, height: number): View => { const v = new Bun.WebView({ width, height }); views.push(v); return v; };
afterAll(() => { for (const v of views) v.close(); for (const c of streams) { try { c.close(); } catch { /* already closed */ } } server.stop(true); });

const waitFor = (v: View, expr: string, ms = 4000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await run(v, `[...document.querySelectorAll(".sec")].find(x => x.textContent === "계정").scrollIntoView()`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
const boot = async (v: View) => {
	const opened = new Promise<void>(r => streamWaiters.push(r));
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NM.loaded && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("settings")`);
	await waitFor(v, `document.querySelectorAll(".li.acc").length === 5`);
};
const reset = () => { mode = "auto"; pin = "default"; order = [...NAMES]; calls.length = 0; };
// the card's rows: numbers, names, nothing wider than the screen
const fit = (v: View) => q<{ vw: number; doc: number; over: string[]; nums: string[]; sw: string | null }>(v, `
	const vw = innerWidth, rows = [...document.querySelectorAll(".li.acc")];
	const over = rows.filter(r => r.scrollWidth > r.clientWidth + 1 || r.getBoundingClientRect().right > vw + 1).map(r => r.textContent);
	return { vw, doc: document.documentElement.scrollWidth, over, nums: rows.map(r => r.querySelector(".acc-no").textContent), sw: document.querySelector('.hs-sw[aria-label="자동 전환"]')?.getAttribute("aria-checked") ?? null };`);

for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1440, 900]] as const) {
	test(`${label} ${w}px: five accounts fit, numbered 1-5, in both states`, async () => {
		reset();
		const v = open(w, h);
		await boot(v);
		let f = await fit(v);
		expect(f.nums).toEqual(["1", "2", "3", "4", "5"]);
		expect(f.sw).toBe("true");
		expect(f.over).toEqual([]);
		expect(f.doc).toBeLessThanOrEqual(f.vw);
		expect(await q(v, `return [document.querySelectorAll(".li.acc .acc-grip").length, document.querySelectorAll(".acc-mv").length]`)).toEqual([5, 0]);
		await shot(v, `accounts-auto-${w}.png`);
		await run(v, `document.querySelector('.hs-sw[aria-label="자동 전환"]').click()`);
		await waitFor(v, `document.querySelector('.hs-sw[aria-label="자동 전환"]').getAttribute("aria-checked") === "false"`);
		f = await fit(v);
		expect(f.over).toEqual([]);
		expect(f.doc).toBeLessThanOrEqual(f.vw);
		expect(await q(v, `return document.querySelector(".li.acc.on").textContent.includes("사용 중 · 고정")`)).toBe(true);
		expect(await q(v, `return document.querySelectorAll("select").length`)).toBe(0);
		await shot(v, `accounts-pinned-${w}.png`);
		expect(calls).toEqual([["/api/accounts/mode", { mode: "pinned" }]]);
	});
}

const fire = (v: View, type: string, target: string, y: number, pointerType = "mouse") =>
	run(v, `const t = ${target}, r = t.getBoundingClientRect ? t.getBoundingClientRect() : null; if (r) window.__px = r.left + r.width / 2; t.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { pointerId: 7, pointerType: ${JSON.stringify(pointerType)}, isPrimary: true, button: 0, buttons: 1, clientX: window.__px, clientY: ${y}, bubbles: true, cancelable: true }))`);
const rowRect = (v: View, i: number) => q<{ top: number; bottom: number; mid: number }>(v, `const r = document.querySelectorAll(".li.acc")[${i}].getBoundingClientRect(); return { top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 }`);
const rowEl = (i: number, sel = "") => `document.querySelectorAll(".li.acc")[${i}]${sel ? `.querySelector("${sel}")` : ""}`;
const firstName = (v: View) => q<string>(v, `return document.querySelector(".li.acc .acc-grip").dataset.acc`);

for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1440, 900]] as const) {
	test(`${label} ${w}px: dragging a grip moves the row, the others shift, and the drop saves the new order`, async () => {
		reset();
		const v = open(w, h);
		await boot(v);
		const [r0, r2] = [await rowRect(v, 0), await rowRect(v, 2)];
		await fire(v, "pointerdown", rowEl(2, ".acc-grip"), r2.mid);
		// the row lifts only after it moved more than a few pixels
		expect(await q(v, `return document.querySelectorAll(".li.acc.drag").length`)).toBe(0);
		await fire(v, "pointermove", "document", r2.mid + 2);
		expect(await q(v, `return document.querySelectorAll(".li.acc.drag").length`)).toBe(0);
		await fire(v, "pointermove", "document", r0.top + 1);
		expect(await q(v, `return [document.querySelectorAll(".li.acc.drag").length, [...document.querySelectorAll(".li.acc")].map(r => r.style.transform !== "")]`)).toEqual([1, [true, true, true, false, false]]);
		await fire(v, "pointerup", "document", r0.top + 1);
		await waitFor(v, `document.querySelector(".li.acc .acc-grip").dataset.acc === "work-long-account-name@example.com"`);
		expect(calls.at(-1)).toEqual(["/api/accounts/order", { order: ["work-long-account-name@example.com", "default", "miseol-shared", "backup", "team"] }]);
		const f = await fit(v);
		expect(f.nums).toEqual(["1", "2", "3", "4", "5"]);
		expect(f.over).toEqual([]);
		expect(await q(v, `return document.querySelectorAll(".li.acc.drag, .acc-dragging, .li.acc[style]").length`)).toBe(0);
		await shot(v, `accounts-dragged-${w}.png`);
	});
}

test("touch: a long press on a row lifts it and a drag saves the order; a tap and a click right after a drop do not pick", async () => {
	reset();
	const v = open(390, 844);
	await boot(v);
	const r3 = await rowRect(v, 3), r4 = await rowRect(v, 4);
	await fire(v, "pointerdown", rowEl(4, ".acc-main"), r4.mid, "touch");
	await waitFor(v, `document.querySelectorAll(".li.acc")[4].classList.contains("drag")`);
	await fire(v, "pointermove", "document", r3.top + 1, "touch");
	await fire(v, "pointerup", "document", r3.top + 1, "touch");
	await waitFor(v, `[...document.querySelectorAll(".li.acc .acc-grip")].at(-1).dataset.acc === "backup"`);
	expect(calls.at(-1)).toEqual(["/api/accounts/order", { order: ["default", "miseol-shared", "work-long-account-name@example.com", "team", "backup"] }]);
	// 고정: a quick touch tap never starts a drag and still picks the row
	await run(v, `document.querySelector('.hs-sw[aria-label="자동 전환"]').click()`);
	await waitFor(v, `document.querySelector(".li.acc.on")`);
	const r1 = await rowRect(v, 1);
	await fire(v, "pointerdown", rowEl(1, ".acc-main"), r1.mid, "touch");
	await fire(v, "pointerup", "document", r1.mid, "touch");
	expect(await q(v, `return document.querySelectorAll(".li.acc.drag").length`)).toBe(0);
	await run(v, `${rowEl(1, ".acc-main")}.click()`);
	await waitFor(v, `document.querySelector(".li.acc.on .acc-grip").dataset.acc === "miseol-shared"`);
	expect(calls.at(-1)).toEqual(["/api/accounts/mode", { mode: "pinned", account: "miseol-shared" }]);
	// a drag in 고정 mode reorders without picking, and the click that follows the drop is ignored
	const [a, b] = [await rowRect(v, 3), await rowRect(v, 0)];
	await fire(v, "pointerdown", rowEl(3, ".acc-main"), a.mid, "touch");
	await waitFor(v, `document.querySelectorAll(".li.acc")[3].classList.contains("drag")`);
	await fire(v, "pointermove", "document", b.top + 1, "touch");
	await fire(v, "pointerup", "document", b.top + 1, "touch");
	await waitFor(v, `document.querySelector(".li.acc .acc-grip").dataset.acc === "team"`);
	const n = calls.length;
	await run(v, `${rowEl(2, ".acc-main")}.click()`);
	expect(calls).toHaveLength(n);
	expect(calls.at(-1)?.[0]).toBe("/api/accounts/order");
});
