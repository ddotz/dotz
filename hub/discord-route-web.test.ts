// 설정 → Discord: 앱 · 알림 shows only the web-app notifications; the Discord row opens its own screen with the bot connection and the
// "디스코드에도 보내기" switches (GET/PUT /api/discord/post, hub/discord-post.ts; /api/discord/connection, hub/discord-connection.ts).
// Headless (Bun.WebView) against a fake hub.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.DISCORD_SHOTS ?? join(tmpdir(), "dotz-discord-screen");
mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown, status = 200) => Response.json(v, { status });

const STORED_TOKEN = "STORED-TOKEN-NEVER-IN-THE-PAGE";
const NEW_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC";
const INVITE = "https://discord.com/oauth2/authorize?client_id=999000111222333444&scope=bot&permissions=8&guild_id=111111111111111111";
const NOTE = "개발자 포털 > Bot > Privileged Gateway Intents > MESSAGE CONTENT를 켜 주세요";
const POST = { chat: true, lanes: true, alert: true, worklog: true, web_lanes: false, ask: true, result: false, news: true, conv: true };

type Hub = ReturnType<typeof hub>;
function hub(configured: boolean) {
	const h = {
		puts: [] as Record<string, boolean>[],
		saves: [] as Record<string, string>[],
		restarts: [] as unknown[],
		checks: 0,
		post: { ...POST } as Record<string, boolean>,
		conn: {} as Record<string, unknown>,
		server: undefined as unknown as ReturnType<typeof Bun.serve>,
		reset() {
			h.puts.length = h.saves.length = h.restarts.length = 0;
			h.checks = 0;
			h.post = { ...POST };
			h.conn = configured
				? { enabled: true, connected: true, user: "dotz-bot", error: "", guild: "111111111111111111", owner_id: "222222222222222222", app_id: "999000111222333444", has_token: true, restart_needed: false }
				: { enabled: false, connected: false, user: "", error: "", guild: "", owner_id: "", app_id: "", has_token: false, restart_needed: false };
		},
	};
	h.reset();
	h.server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url), p = url.pathname;
			if (p === "/") return indexPage(req);
			const asset = appAsset(req, p);
			if (asset) return asset;
			if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
			if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: configured ? { enabled: true, connected: true } : {}, notices_unread: 0 });
			if (p === "/api/conversations") return json({ items: [] });
			if (p === "/api/notices") return json({ items: [], unread: 0, gone: [] });
			if (p === "/api/activity") return json({ items: [], more: false, history: false });
			if (p === "/api/update") {
				const at = { sha: "a".repeat(40), short: "a".repeat(7), date: new Date(0).toISOString() };
				return json({ running: { kind: "git", branch: "main", commit: at }, disk: { kind: "git", branch: "main", commit: at }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [] });
			}
			if (p === "/api/push/classes") return json({ classes: { ask: true, alert: true, result: true, news: true, conv: true, log: false } });
			if (p === "/api/discord/post") {
				if (req.method !== "GET") {
					const b = (await req.json()) as Record<string, boolean>;
					h.puts.push(b);
					h.post = { ...h.post, ...b };
					queueMicrotask(settle);
				}
				return json(h.post);
			}
			if (p === "/api/discord/connection") {
				if (req.method === "PUT") {
					const b = (await req.json()) as Record<string, string>;
					h.saves.push(b);
					queueMicrotask(settle);
					if (b.guild !== undefined && !/^\d{17,20}$/.test(b.guild)) return json({ error: "서버 ID는 17~20자리 숫자여야 해요" }, 400);
					h.conn = { ...h.conn, ...(b.guild ? { guild: b.guild } : {}), ...(b.owner_id ? { owner_id: b.owner_id } : {}), ...(b.token ? { has_token: true } : {}), restart_needed: true };
				}
				return json(h.conn);
			}
			if (p === "/api/discord/connection/check") {
				h.checks++;
				queueMicrotask(settle);
				return json({ ok: true, app_id: "999000111222333444", bot_name: "dotz-bot", admin: false, invite_url: INVITE, intent_note: NOTE });
			}
			if (p === "/api/update/restart") {
				h.restarts.push(await req.json());
				queueMicrotask(settle);
				return json({ ok: true });
			}
			if (p === "/api/accounts") return json({ error: "no accounts here" }, 404);
			return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
		},
	});
	return h;
}
const on = hub(true), off = hub(false);

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
beforeEach(() => { on.reset(); off.reset(); });
afterEach(() => { for (const v of views.splice(0)) v.close(); });
afterAll(() => { on.server.stop(true); off.server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
// Resolved by the fake hub when a write lands (timers run on the preload's fake clock, hub/runtime/test-clock.ts; the test timeout bounds the wait).
const waiters = new Set<{ ok: () => boolean; done: () => void }>();
function settle() { for (const w of waiters) if (w.ok()) { waiters.delete(w); w.done(); } }
const hubState = (ok: () => boolean) => new Promise<void>(done => { if (ok()) done(); else waiters.add({ ok, done }); });
async function settings(h: Hub, width: number, height: number) {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${h.server.port}/`);
	await waitFor(v, `typeof S !== "undefined" && S && S.discord !== undefined`);
	await run(v, `go("settings")`);
	await waitFor(v, `document.querySelectorAll(".hs-sw[data-k]").length === 5`);
	return v;
}
const openScreen = async (v: View) => {
	await run(v, `[...document.querySelectorAll("#settings .li.tap")].find(b => b.querySelector(".hd").textContent === "Discord").click()`);
	await waitFor(v, `current === "discord" && DCS.v && document.querySelector("#discord .dcs-form")`);
};
const shot = async (v: View, name: string) => Bun.write(join(SHOTS, name), await v.screenshot());
const noOverflow = (v: View) => q<boolean>(v, `return document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...document.querySelectorAll("#discord .list")].every(l => l.scrollWidth <= l.clientWidth)`);
const type = (v: View, sel: string, value: string) => run(v, `const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input", { bubbles: true }))`);
const click = (v: View, sel: string) => run(v, `document.querySelector(${JSON.stringify(sel)}).click()`);
const clickText = (v: View, sel: string, text: string) => run(v, `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);

describe.each([[390, 844], [1280, 900]] as const)("at %ipx", (width, height) => {
	test("connected: 앱 · 알림 is web only and the Discord row opens the screen with every setting", async () => {
		const v = await settings(on, width, height);
		expect(await q<number>(v, `return document.querySelectorAll("#settings [data-dc], #settings [data-dc-hint]").length`)).toBe(0);
		expect(await q<string>(v, `return document.querySelector("#settings .sec:not(:first-child)") && [...document.querySelectorAll("#settings .sec")].map(s => s.textContent).join("|")`)).not.toContain("디스코드");
		expect(await q<string>(v, `return [...document.querySelectorAll("#settings .li.tap")].find(b => b.querySelector(".hd").textContent === "Discord").querySelector(".tag").textContent`)).toBe("연결됨");
		if (width === 390) {
			await run(v, `[...document.querySelectorAll("#settings .li.tap")].find(b => b.querySelector(".hd").textContent === "Discord").scrollIntoView({ block: "center" })`);
			await shot(v, "settings-390.png");
		}
		await openScreen(v);
		await waitFor(v, `document.querySelectorAll("#discord .hs-sw[data-dc]").length === 9`);
		expect(await q<string>(v, `return document.querySelector("#discord .li .tag").textContent + "|" + document.querySelector("#discord .li .sup").textContent`)).toBe("연결됨|dotz-bot 봇으로 연결돼 있어요.");
		expect(await q<string[]>(v, `return [DCS.guild.value, DCS.owner.value, DCS.tok.value, document.querySelector("#discord .dcs-saved").textContent]`)).toEqual(["111111111111111111", "222222222222222222", "", "저장됨"]);
		expect(await q<string[][]>(v, `return [...document.querySelectorAll("#discord .hs-sw[data-dc]")].map(b => [b.dataset.dc, b.getAttribute("aria-checked")])`)).toEqual([
			["ask", "true"], ["alert", "true"], ["result", "false"], ["news", "true"], ["conv", "true"], ["chat", "true"], ["lanes", "true"], ["worklog", "true"], ["web_lanes", "false"]]);
		expect(await q<number>(v, `return document.querySelectorAll("#discord [data-dc=alert]").length`)).toBe(1);
		expect(await q<boolean>(v, `return !document.documentElement.outerHTML.includes(${JSON.stringify(STORED_TOKEN)})`)).toBe(true);

		await click(v, `#discord .hs-sw[data-dc="result"]`);
		await hubState(() => on.puts.length === 1);
		expect(on.puts).toEqual([{ result: true }]);
		await waitFor(v, `document.querySelector('#discord .hs-sw[data-dc="result"]').getAttribute("aria-checked") === "true"`);
		await click(v, `#discord .hs-sw[data-dc="web_lanes"]`);
		await hubState(() => on.puts.length === 2);
		expect(on.puts[1]).toEqual({ web_lanes: true });
		await waitFor(v, `document.querySelector('#discord .hs-sw[data-dc="web_lanes"]').getAttribute("aria-checked") === "true"`);

		await clickText(v, "#discord .btn", "연결 확인");
		await hubState(() => on.checks === 1);
		await waitFor(v, `document.querySelector("#discord .dcs-res a")`);
		expect(await q<string[]>(v, `const a = document.querySelector("#discord .dcs-res a"); return [document.querySelector("#discord .dcs-ok").textContent, a.textContent, a.href, document.querySelector("#discord .dcs-res").textContent.includes(${JSON.stringify(NOTE)})]`)).toEqual(["봇 dotz-bot", "봇 권한 다시 승인", INVITE, true]);

		await type(v, "#discord input[name=discord-guild]", "123");
		await clickText(v, "#discord .btn", "저장");
		await waitFor(v, `document.querySelector("#discord .dcs-err")`);
		expect(await q<string>(v, `return document.querySelector("#discord .dcs-err").textContent`)).toBe("서버 ID는 17~20자리 숫자여야 해요");
		expect(on.saves).toEqual([{ guild: "123" }]);
		expect(await q<number>(v, `return [...document.querySelectorAll("#discord .btn")].filter(b => b.textContent === "다시 시작").length`)).toBe(0);

		await type(v, "#discord input[name=discord-guild]", "333333333333333333");
		await type(v, "#discord input[name=discord-token]", NEW_TOKEN);
		await clickText(v, "#discord .btn", "저장");
		await waitFor(v, `!document.querySelector("#discord .dcs-err") && [...document.querySelectorAll("#discord .btn")].some(b => b.textContent === "다시 시작")`);
		expect(on.saves[1]).toEqual({ token: NEW_TOKEN, guild: "333333333333333333" });
		expect(await q<string[]>(v, `return [DCS.tok.value, document.querySelector("#discord .dcs-saved").textContent, document.querySelector("#discord").textContent.includes("게이트웨이를 다시 시작하면 적용돼요").toString()]`)).toEqual(["", "저장됨", "true"]);
		expect(await q<boolean>(v, `return !document.documentElement.outerHTML.includes(${JSON.stringify(NEW_TOKEN)})`)).toBe(true);
		await shot(v, `discord-on-${width}.png`);
		if (width === 390) {
			await run(v, `document.querySelector("#discord .hs-sw[data-dc=ask]").scrollIntoView({ block: "start" })`);
			await shot(v, "discord-on-390-switches.png");
		}
		expect(await noOverflow(v)).toBe(true);
		await clickText(v, "#discord .btn", "다시 시작");
		await hubState(() => on.restarts.length === 1);
		expect(on.restarts).toEqual([{}]);
	}, 60_000);

	test("not configured: the row says 설정 안 됨 and the screen shows the guide, no switches", async () => {
		const v = await settings(off, width, height);
		expect(await q<string>(v, `return [...document.querySelectorAll("#settings .li.tap")].find(b => b.querySelector(".hd").textContent === "Discord").querySelector(".tag").textContent`)).toBe("설정 안 됨");
		expect(await q<number>(v, `return document.querySelectorAll("#settings [data-dc], #settings [data-dc-hint]").length`)).toBe(0);
		await openScreen(v);
		expect(await q<string>(v, `return document.querySelector("#discord .li .tag").textContent`)).toBe("설정 안 됨");
		expect(await q<number>(v, `return document.querySelectorAll("#discord [data-dc-guide] li").length`)).toBeGreaterThanOrEqual(3);
		expect(await q<number>(v, `return document.querySelectorAll("#discord .hs-sw").length`)).toBe(0);
		expect(await q<number>(v, `return [...document.querySelectorAll("#discord .sup")].filter(s => s.textContent === "연결하면 고를 수 있어요").length`)).toBe(2);
		expect(await q<number>(v, `return [...document.querySelectorAll("#discord .btn")].filter(b => b.textContent === "토큰 지우기").length`)).toBe(0);
		await shot(v, `discord-off-${width}.png`);
		expect(await noOverflow(v)).toBe(true);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `current === "settings"`);
		expect(off.puts.length + off.saves.length + off.restarts.length).toBe(0);
	}, 60_000);
});
