import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { painted, startDemoServer, waitFor, type View } from "./layout-measure.ts";

// The file reader, 카카오톡's 사용자별 분석 and 지켜볼 대화방, and a comment app's 지켜볼 글 open through dialog() (web/js/02-basic-markdown.js) like every other
// window. A wide screen gives an overlay no history entry (32-history-nav.js histFlat), so the window closes by ✕ there and by the back button on a phone.
// Run on the demo server (fake data only); screenshots are written only when DIALOG_SHOTS names a folder (DIALOG_PREFIX = before | after).
const SHOTS = process.env.DIALOG_SHOTS;
const PREFIX = process.env.DIALOG_PREFIX ?? "after";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NOW = Date.UTC(2026, 10, 9, 3);
const server = startDemoServer({ now: NOW });
const views: View[] = [];
afterEach(() => { for (const v of views.splice(0)) v.close(); });
afterAll(() => server.stop());

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => q(v, `${code}; return 0`);
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, `${PREFIX}-${name}.png`), await v.screenshot()); };
const page = async (width: number): Promise<View> => {
	const v = new Bun.WebView({ width, height: width < 600 ? 844 : 800 });
	views.push(v);
	await v.navigate(`${server.origin}/?dw=${width}#home`);
	await waitFor(v, `typeof S !== "undefined" && S && typeof target === "string" && CV.loaded && NT.loaded`);
	await run(v, `localStorage.setItem("dotz-theme", "light"); document.documentElement.dataset.theme = "light"`);
	return v;
};

// The demo has no route for a sender's numbers: answered in the page, in the shape of GET /api/kakao/person/<id>.
const PERSON = { stats: { roomMessages: 42, watchedMessages: 120, watchedRooms: 4, firstAt: NOW - 90 * 86_400_000, lastAt: NOW - 360_000, replyToOwnerMs: 420_000, ownerReplyMs: 120_000, windowDays: 30,
	mentions: 10, mentionShare: .25, hours: Array.from({ length: 24 }, (_, h) => (h > 7 ? (h * 7) % 11 : 0)), weekdays: [2, 9, 7, 8, 6, 11, 4], recentUnanswered: [{ at: NOW - 360_000, text: "그리고 장작은 어디서 살까?" }] } };
const STUB_PERSON = `const demoFetch = window.fetch; window.fetch = (input, init) => new URL(typeof input === "string" ? input : input.url, location.href).pathname.startsWith("/api/kakao/person/")
	? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(PERSON))}, { headers: { "Content-Type": "application/json" } })) : demoFetch(input, init)`;

// under: the overlay steps already open before the window (a phone's open KakaoTalk room is one back step of its own, 32-history-nav.js bkStep); the
// next back takes that one off too.
type Case = { name: string; setup: (v: View) => Promise<unknown>; open: string; shown: string; under?: (width: number) => number };
const kakao = async (v: View) => { await run(v, `go("monitoring", "i:kakao")`); await waitFor(v, `KK.loaded && KK.rooms.length > 0 && document.querySelector("#kk-add-btn")`); };
const CASES: Case[] = [
	{ name: "reader", setup: async () => {}, open: `viewer("reports/주간-보고서.md", "주간-보고서.md")`, shown: `document.querySelector("dialog.tbox[open] .tv-body .md")` },
	{ name: "person", setup: async v => { await kakao(v); await run(v, `${STUB_PERSON}; kkOpen("r1")`); await waitFor(v, `KK.open === "r1" && KK.msgs.length > 0`); },
		open: `kkPerson("u2")`, shown: `document.querySelector("dialog.kk-pd[open] .kk-prow")`, under: width => (width < 1100 ? 1 : 0) },
	{ name: "rooms", setup: kakao, open: `document.querySelector("#kk-add-btn").click()`, shown: `document.querySelector("#kk-add[open] .kk-pr")` },
	{ name: "posts", setup: async v => { await run(v, `go("monitoring", "i:youtube")`); await waitFor(v, `MON.sel === "i:youtube" && cmSrcOf("youtube").length > 0`); },
		open: `cmPickOpen("youtube")`, shown: `document.querySelector("#cm-pick[open] .kk-pick-src")` },
];

for (const width of [390, 1280]) for (const c of CASES)
	test(`${width}px ${c.name}: the shared window, one step on the overlay stack, one window after a second open, and closing takes the step off`, async () => {
		const v = await page(width), under = c.under?.(width) ?? 0;
		await run(v, `dispatchEvent(new Event("pointerup"))`);
		await c.setup(v);
		expect(await q(v, `return OV.length`)).toBe(under);
		await run(v, c.open);
		await waitFor(v, c.shown);
		await painted(v);
		await shot(v, `${c.name}-${width}`);
		expect(await q(v, `${c.open}; return [document.querySelectorAll("dialog[open]").length, OV.length]`)).toEqual([1, under + 1]);
		expect(await q(v, `const d = document.querySelector("dialog[open]"); return [d.matches("dialog.dlg.fs-card"), !!d.querySelector(":scope > .fs-hd .dtitle")?.textContent, !!d.querySelector(":scope > .fs-hd .fs-x")]`)).toEqual([true, true, true]);
		await v.evaluate(`new Promise((res, rej) => { const d = document.querySelector("dialog[open]"), t = setTimeout(() => rej(new Error("the window did not close")), 8000);
			d.addEventListener("close", () => { clearTimeout(t); res(true); }, { once: true }); ${width < 1100 ? "history.back()" : `d.querySelector(".fs-x").click()`}; })`);
		expect(await q(v, `return [document.querySelectorAll("dialog[open]").length, OV.length]`)).toEqual([0, under]);
		if (!under) return;
		await v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("no popstate")), 8000); addEventListener("popstate", () => { clearTimeout(t); res(true); }, { once: true }); history.back(); })`);
		expect(await q(v, `return OV.length`)).toBe(0);
	}, 30_000);
