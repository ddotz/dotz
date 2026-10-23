import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "./app-settings.ts";
import { paths } from "./config.ts";
import { readWatchSettings, writeWatchSettings } from "./watch-settings.ts";
import { addWatch, allWatches, removeWatch, startWatches } from "./watch.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The settings conversation of an app and of a monitor (web/js/32-app-settings.js) in a headless Bun.WebView against a stub gateway whose settings
// routes call the real hub code: the control panel has the conversation's width, a monitor's switches PATCH, a change card writes only on 적용.
// Screenshots are written only when SETTINGS_SHOTS names a folder.
const SHOTS = process.env.SETTINGS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const data = mkdtempSync(join(tmpdir(), "ms-web-"));
startWatches(() => {});
addWatch({ name: "t-web", command: "true", every_minutes: 60, on: "change", to: "alert", label: "웹 감시" }, "");
const stored = () => JSON.parse(readFileSync(paths.watches, "utf8")).find((w: { name: string }) => w.name === "t-web");

const ts = (m: number) => new Date(Date.UTC(2026, 9, 23, 3, m)).toISOString();
const PROPOSAL = { app: "w:t-web", changes: { every_minutes: 15, to: "chat" } };
const history = (target: string) => target === "settings:w:t-web" ? [
	{ ts: ts(1), kind: "message", source: "web", channel: target, author: "local", text: "15분마다로 하고 알림은 채팅으로 줘" },
	{ ts: ts(2), kind: "out", source: "orchestrator", target, text: `확인 간격과 알림 방식을 바꾸는 변경이에요.\n\`\`\`dotz-settings\n${JSON.stringify(PROPOSAL)}\n\`\`\`` },
] : [];

const sent: Record<string, unknown>[] = [];
const patches: Record<string, unknown>[] = [];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let streamWaiters: (() => void)[] = [];
const te = new TextEncoder();
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
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: history(url.searchParams.get("target") ?? "") });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [{ name: "웹 감시", watch: "t-web", kind: "watch", every: "60분마다", last_run: ts(0), next_run: ts(60), last_result: "ok" }] });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } }] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: [] });
		const m = /^\/api\/(?:integrations|watches)\/([a-z0-9-]+)\/settings$/.exec(p), isWatch = p.startsWith("/api/watches/");
		if (m) {
			try {
				if (req.method === "PATCH") {
					const b = (await req.json()) as { values: unknown };
					patches.push({ app: isWatch ? `w:${m[1]}` : m[1], values: b.values });
					return json({ key: m[1], fields: isWatch ? writeWatchSettings(m[1]!, b.values) : writeSettings(data, m[1]!, b.values) });
				}
				return json({ key: m[1], fields: isWatch ? readWatchSettings(m[1]!) : readSettings(data, m[1]!) });
			} catch (e) {
				return json({ error: (e as Error).message }, 400);
			}
		}
		if (p === "/api/message") { sent.push((await req.json()) as Record<string, unknown>); return json({ ok: true }); }
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = (width: number, height: number): View => { const v = new Bun.WebView({ width, height }); views.push(v); return v; };
afterAll(() => { for (const v of views) v.close(); for (const c of streams) { try { c.close(); } catch { /* already closed */ } } server.stop(true); rmSync(data, { recursive: true, force: true }); for (const w of allWatches()) removeWatch(w.id); });

const waitFor = (v: View, expr: string, ms = 4000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const boot = async (v: View, route: string) => {
	const opened = new Promise<void>(r => streamWaiters.push(r));
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NM.loaded && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring", ${JSON.stringify(route)})`);
};
// The panel above the conversation and the conversation column: same left edge and width.
const frame = (v: View) => q<{ sw: number; tl: number; swL: number; tlL: number; vw: number }>(v, `const a = document.querySelector("#app-sw").getBoundingClientRect(), b = document.querySelector("#tl").getBoundingClientRect(); return { sw: a.width, tl: b.width, swL: a.left, tlL: b.left, vw: innerWidth }`);
const expectSameColumn = async (v: View) => {
	const f = await frame(v);
	expect(Math.abs(f.sw - f.tl)).toBeLessThanOrEqual(1);
	expect(Math.abs(f.swL - f.tlL)).toBeLessThanOrEqual(1);
	expect(f.sw).toBeLessThanOrEqual(f.vw);
};

describe("the control panel has the conversation's width (app and monitor settings)", () => {
	for (const [label, w, h] of [["desktop", 1280, 800], ["fold", 880, 900], ["phone", 390, 844]] as const) {
		test(`${label} ${w}px`, async () => {
			const v = open(w, h);
			await boot(v, "c:settings:mail");
			await waitFor(v, `target === "settings:mail" && document.querySelector("#app-sw .as-row") && document.querySelector("#tl")`);
			await expectSameColumn(v);
			await run(v, `go("monitoring", "c:settings:w:t-web")`);
			await waitFor(v, `target === "settings:w:t-web" && document.querySelector('#app-sw [data-k="every_minutes"]') && document.querySelector("#tl .as-card")`);
			await expectSameColumn(v);
			expect((await frame(v)).tl).toBeGreaterThan(300);
			await shot(v, `monitor-settings-${label}-${w}.png`);
		});
	}
});

describe("monitor settings at desktop width", () => {
	const v = open(1280, 800);

	test("a monitor's header has a 설정 button that opens its settings conversation with the controls", async () => {
		await boot(v, "m:웹 감시");
		await waitFor(v, `document.querySelector("#mon-head .as-hd")`);
		expect(await q(v, `return document.querySelectorAll(".as-pin").length`)).toBe(0);
		await shot(v, "monitor-pinned-row-desktop.png");
		await run(v, `document.querySelector("#mon-head .as-hd").click()`);
		await waitFor(v, `target === "settings:w:t-web" && document.querySelector('#app-sw [data-k="enabled"]')`);
		const names = await q<string[]>(v, `return [...document.querySelectorAll("#app-sw .as-row:not(.as-stat) .as-n")].map(n => n.textContent)`);
		expect(names).toEqual(["켜기", "확인 간격(분)", "알림 방식", "이름"]);
	});

	test("the switch and the boxes PATCH the one watch settings route with no message to the bot", async () => {
		await run(v, `document.querySelector('#app-sw [data-k="enabled"]').click()`);
		await waitFor(v, `document.querySelector('#app-sw [data-k="enabled"]').getAttribute("aria-checked") === "false"`);
		expect(patches).toEqual([{ app: "w:t-web", values: { enabled: false } }]);
		expect(stored().paused).toBe(true);
		await run(v, `const i = document.querySelector('#app-sw [data-k="every_minutes"]'); i.value = "30"; i.dispatchEvent(new Event("change"))`);
		await waitFor(v, `document.querySelector('#app-sw [data-k="every_minutes"]').value === "30" && AS.by["w:t-web"].find(f => f.key === "every_minutes").value === 30`);
		expect(patches[1]).toEqual({ app: "w:t-web", values: { every_minutes: 30 } });
		expect(stored().every_minutes).toBe(30);
		await run(v, `const s = document.querySelector('#app-sw [data-k="to"]'); s.value = "chat"; s.dispatchEvent(new Event("change"))`);
		await waitFor(v, `AS.by["w:t-web"].find(f => f.key === "to").value === "chat"`);
		expect(stored().to).toBe("chat");
		expect(sent).toEqual([]);
	});

	test("a bad number is refused by the route and the box shows the stored value again", async () => {
		const before = stored().every_minutes;
		await run(v, `const i = document.querySelector('#app-sw [data-k="every_minutes"]'); i.value = "0"; i.dispatchEvent(new Event("change"))`);
		await waitFor(v, `document.querySelector('#app-sw [data-k="every_minutes"]').value === "${before}"`);
		expect(stored().every_minutes).toBe(before);
	});

	test("an answer with a dotz-settings block is a change card; nothing is written until 적용", async () => {
		await run(v, `localStorage.removeItem("dotz.settings.cards"); AS.done = {}; renderAll()`);
		await waitFor(v, `document.querySelector('#tl .as-card [data-as="apply"]')`);
		const card = await q<{ rows: string[]; buttons: string[] }>(v, `const c = document.querySelector("#tl .as-card"); return { rows: [...c.querySelectorAll(".as-cr")].map(r => r.textContent), buttons: [...c.querySelectorAll("button")].map(b => b.textContent) }`);
		expect(card.buttons).toEqual(["적용", "취소"]);
		expect(card.rows.some(r => r.includes("확인 간격") && r.includes("30 → 15"))).toBe(true);
		const before = patches.length;
		expect(stored().every_minutes).toBe(30);
		await shot(v, "monitor-settings-desktop.png");
		await run(v, `document.querySelector('#tl .as-card [data-as="apply"]').click()`);
		await waitFor(v, `document.querySelector("#tl .as-done.applied")`);
		expect(patches.length).toBe(before + 1);
		expect(patches.at(-1)).toEqual({ app: "w:t-web", values: PROPOSAL.changes });
		expect(stored()).toMatchObject({ every_minutes: 15, to: "chat" });
	});

	test("a card the owner cancels writes nothing; the composer sends settings:w:<name> to the orchestrator", async () => {
		await run(v, `localStorage.removeItem("dotz.settings.cards"); AS.done = {}; renderAll()`);
		await waitFor(v, `document.querySelector('#tl .as-card [data-as="cancel"]')`);
		const before = patches.length;
		await run(v, `document.querySelector('#tl .as-card [data-as="cancel"]').click()`);
		await waitFor(v, `document.querySelector("#tl .as-done.cancelled")`);
		expect(patches.length).toBe(before);
		await run(v, `ta.value = "밤에는 확인하지 마"; sendChat()`);
		const deadline = Date.now() + 3000;
		while (!sent.length && Date.now() < deadline) await Bun.sleep(25);
		expect(sent[0]).toMatchObject({ text: "밤에는 확인하지 마", settings: "w:t-web" });
	});
});
