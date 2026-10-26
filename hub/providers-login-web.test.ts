import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// 공급자 and 설정 → 계정 in a headless Bun.WebView against a stub gateway on an OmO install: the signed-in Claude row offers 계정 추가,
// 추가 lists login providers again, and a login (URL, the sign-in's own prompt, pasted code) ends with one more account on the row and in
// 설정 → 계정. Screenshots are written only when PROVIDERS_SHOTS names a folder.
const SHOTS = process.env.PROVIDERS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let accounts = ["default", "work"];
const calls: string[] = [];
let onAccounts: (() => void) | undefined;
const PROMPT = "Complete login in your browser, or paste the authorization code / redirect URL here:";
const providers = () => ({
	providers: [
		{ id: "anthropic", name: "Anthropic Subscription (Claude Pro/Max)", auth: "oauth", account: "work", accounts: accounts.length, models: 3, in_use: true, can_login: true, can_add_account: true, can_logout: true },
		{ id: "openrouter", name: "openrouter", auth: "api_key", masked: "or-…ijkl", models: 1, in_use: false, can_login: true, can_logout: true },
	],
	addable: [{ id: "github-copilot", name: "GitHub Copilot", kind: "oauth" }, { id: "xai", name: "xAI (Grok/X subscription)", kind: "oauth" }, { id: "openai", name: "openai", kind: "api_key" }],
});
const accountsBody = () => ({
	mode: "pinned",
	chosen: { name: "work", label: "work", source: "manual", blocked: null, text: "" },
	accounts: accounts.map((name, i) => ({ name, order: i + 1, alias: null, label: name, current: name === "work", blocked: null, blocked_until: null, blocked_tag: null, five_hour_left: null, seven_day_left: null })),
	rules: {},
	rules_text: [],
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
		if (p === "/api/monitors" || p === "/api/integrations") return json({ items: [] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: [] });
		if (p === "/api/update" || p === "/api/runtimes") return json({ error: "stub" }, 500);
		if (p === "/api/providers") return json(providers());
		if (p === "/api/accounts") {
			calls.push("GET /api/accounts");
			onAccounts?.();
			return json(accountsBody());
		}
		if (p === "/api/providers/anthropic/login" && req.method === "POST") {
			calls.push("POST login");
			return json({ ok: true, login_id: "L1", url: "https://claude.ai/oauth/authorize?state=stub", needs_code: true, prompt: PROMPT });
		}
		if (p === "/api/providers/anthropic/login/complete" && req.method === "POST") {
			const b = (await req.json()) as { login_id: string; code: string };
			calls.push(`complete ${b.login_id} ${b.code}`);
			accounts = [...accounts, `login-${accounts.length + 1}`];
			return json({ ok: true, provider: "anthropic", status: "done" });
		}
		if (p === "/api/providers/anthropic/login" && req.method === "GET") return json({ status: "waiting" });
		if (p === "/api/providers/anthropic/login" && req.method === "DELETE") {
			calls.push("DELETE login");
			return json({ ok: true });
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
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
const boot = async (v: View) => {
	const opened = new Promise<void>(r => streamWaiters.push(r));
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NM.loaded && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("providers")`);
	await waitFor(v, `document.querySelector("#providers .prow")`);
};
const anthropicRow = `[...document.querySelectorAll("#providers .prow")].find(r => r.textContent.includes("Claude Pro/Max"))`;
const button = (scope: string, label: string) => `[...${scope}.querySelectorAll("button")].find(b => b.textContent.trim().endsWith(${JSON.stringify(label)}))`;
const overflow = (v: View) => q<{ vw: number; doc: number }>(v, `return { vw: innerWidth, doc: document.documentElement.scrollWidth }`);

for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1280, 860]] as const) {
	test(`${label} ${w}px: 계정 추가 on the Claude row adds an account; 추가 lists login providers; 설정 → 계정 offers it too`, async () => {
		accounts = ["default", "work"];
		calls.length = 0;
		const v = open(w, h);
		await boot(v);
		expect(await q(v, `const r = ${anthropicRow}; return [r.textContent.includes("계정 2개"), !!${button("r", "계정 추가")}, !!${button("r", "다시 로그인")}]`)).toEqual([true, true, false]);
		const o = await overflow(v);
		expect(o.doc).toBeLessThanOrEqual(o.vw);
		await shot(v, `providers-${w}.png`);

		await run(v, `${button("document.querySelector('#providers .tools-bar')", "추가")}.click()`);
		await waitFor(v, `document.querySelector(".pickbox")`);
		expect(await q(v, `const secs = [...document.querySelectorAll(".pickbox .sec")].map(s => s.textContent); const login = document.querySelector(".pickbox .list").textContent; return [secs, login.includes("GitHub Copilot"), login.includes("xAI")]`)).toEqual([["로그인", "API 키"], true, true]);
		await shot(v, `providers-add-${w}.png`);
		await run(v, `${button("document.querySelector('dialog[open]')", "취소")}.click()`);
		await waitFor(v, `!document.querySelector("dialog[open]")`);

		await run(v, `${button(anthropicRow, "계정 추가")}.click()`);
		await waitFor(v, `[...document.querySelectorAll(".sup")].some(s => s.textContent.includes("authorization code"))`);
		expect(await q(v, `const t = document.querySelector("dialog[open] .dtitle")?.textContent ?? ""; return t.endsWith("계정 추가")`)).toBe(true);
		expect(await q(v, `return [...document.querySelectorAll("a.btn")].find(a => a.textContent.includes("로그인 페이지 열기"))?.getAttribute("href")`)).toBe("https://claude.ai/oauth/authorize?state=stub");
		await shot(v, `providers-login-${w}.png`);
		const refetched = new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("설정 → 계정 was not read again")), 4000); onAccounts = () => { clearTimeout(t); res(); }; });
		await run(v, `const i = [...document.querySelectorAll("input")].find(x => x.type === "text" && x.offsetParent); i.value = "code-abc"; ${button("document.querySelector('dialog[open]')", "완료")}.click()`);
		await waitFor(v, `(${anthropicRow})?.textContent.includes("계정 3개")`);
		await refetched;
		onAccounts = undefined;
		expect(calls).toEqual(["POST login", "complete L1 code-abc", "GET /api/accounts"]);

		await run(v, `go("settings")`);
		await waitFor(v, `document.querySelectorAll(".li.acc").length === 3`);
		expect(await q(v, `const row = [...document.querySelectorAll(".li")].find(r => r.textContent.startsWith("계정 추가")); return !!row && !!${button("row", "추가")}`)).toBe(true);
		await run(v, `[...document.querySelectorAll(".sec")].find(x => x.textContent === "계정").scrollIntoView()`);
		const s = await overflow(v);
		expect(s.doc).toBeLessThanOrEqual(s.vw);
		await shot(v, `settings-accounts-${w}.png`);
	}, 20_000);
}
