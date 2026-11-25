import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.RUNTIME_LOGIN_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let signedIn = false;
const calls: string[] = [];
const omo = () => ({ id: "omo", label: "OmO (oh-my-openagent)", installed: true, version: "5.1.83", hasAdapter: true, usable: true, roles: [], pending_roles: [], login: { checked: true, ready: signedIn, accounts: signedIn ? 1 : 0, command: "omo" }, limits: {}, report: null, state: null, switchable: true, refusal: null });
const runtimes = () => ({ current: { orchestrator: "omp", lanes: "omp" }, pending: { orchestrator: "omp", lanes: "omp" }, restart_needed: false, checklist: [], runtimes: [{ ...omo(), id: "omp", label: "omp", roles: ["orchestrator", "lanes"], pending_roles: ["orchestrator", "lanes"], login: { checked: true, ready: true, accounts: 1, command: "omp login" } }, omo()] });

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
		if (p === "/api/runtimes") return json(runtimes());
		if (p === "/api/runtimes/omo") return json({ id: "omo", report: null, state: null });
		if (p === "/api/runtimes/omo/login") return json({ id: "omo", ...omo().login });
		if (p === "/api/providers/anthropic/login" && req.method === "POST") {
			const b = (await req.json().catch(() => ({}))) as { via?: string };
			calls.push(`POST login via ${b.via ?? "-"}`);
			return json({ ok: true, login_id: "L1", url: "https://claude.ai/oauth/authorize?state=stub", needs_code: true, prompt: "Paste the code:" });
		}
		if (p === "/api/providers/anthropic/login/complete" && req.method === "POST") {
			calls.push("complete");
			signedIn = true;
			return json({ ok: true, provider: "anthropic", status: "done" });
		}
		if (p === "/api/providers/anthropic/login" && req.method === "GET") return json({ status: "waiting" });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterEach(() => { for (const v of views.splice(0)) v.close(); });
afterAll(() => server.stop(true));

const waitFor = (v: View, expr: string, ms = 4000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
const acts = `return [...document.querySelector("dialog[open]").querySelectorAll(".dact button")].map(b => [b.textContent.trim(), b.disabled])`;
const button = (label: string) => `[...document.querySelectorAll("dialog[open] .dact button")].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;

for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1280, 860]] as const) {
	test(`${label} ${w}px: switching to OmO without its Claude login offers 로그인 right there; the finished login turns 바꾸기 on`, async () => {
		signedIn = false;
		calls.length = 0;
		const v = new Bun.WebView({ width: w, height: h });
		views.push(v);
		const { promise: opened, resolve } = Promise.withResolvers<void>();
		streamWaiters.push(resolve);
		await v.navigate(`http://127.0.0.1:${server.port}/`);
		await opened;
		await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
		await run(v, `go("runtime")`);
		await waitFor(v, `RT && RT.runtimes.length`);
		await run(v, `rtFlow(RT.runtimes.find(r => r.id === "omo"))`);
		await waitFor(v, `document.querySelector("dialog[open] .dact button")`);
		expect(await q(v, `return document.querySelector("dialog[open]").textContent.includes("아직 Claude 구독 로그인이 안 돼 있어요")`)).toBe(true);
		expect(await q(v, acts)).toEqual([["취소", false], ["로그인", false], ["로그인 확인", false], ["바꾸기", true]]);
		const o = await q<{ vw: number; doc: number }>(v, `return { vw: innerWidth, doc: document.documentElement.scrollWidth }`);
		expect(o.doc).toBeLessThanOrEqual(o.vw);
		await shot(v, `runtime-omo-login-${w}.png`);
		await run(v, `${button("로그인")}.click()`);
		await waitFor(v, `[...document.querySelectorAll("dialog[open] .dtitle")].pop().textContent === "OmO (oh-my-openagent) Claude 구독 로그인"`);
		expect(calls).toEqual(["POST login via omo"]);
		await run(v, `const i = [...document.querySelectorAll("dialog[open] input")].find(x => x.type === "text" && x.offsetParent); i.value = "code-1"; i.dispatchEvent(new Event("input")); ${button("완료")}.click()`);
		await waitFor(v, `document.querySelectorAll("dialog[open]").length === 1 && ${button("바꾸기")} && !${button("바꾸기")}.disabled`);
		expect(await q(v, acts)).toEqual([["취소", false], ["작동 검사", false], ["바꾸기", false]]);
	}, 20_000);
}
