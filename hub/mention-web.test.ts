// @ in the composer (web/js/14-slash-commands.js mnItems): the menu lists what runs now from /api/state (the assistant's background
// work, a conversation with its own session and its worker, live sessions), filters as typed, and a pick writes "@<title> " and sends
// {kind, id, label} with the message (hub/mentions.ts turns it into the turn's [지칭] line).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// MENTION_SHOTS names a folder for desktop and phone screenshots of the open menu.
const SHOTS = process.env.MENTION_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ago = (min: number) => Date.now() - min * 60_000;
const WORK = [
	{ id: "st_mail", description: "메일 알림 마무리", status: "running", started_at: ago(4), model: "Opus 5.5 medium", folder: "/tmp/wt-mail" },
	{ id: "st_old", description: "끝난 요약", status: "done", started_at: ago(30), ended_at: ago(20) },
];
const CONVS = [{ target: "mail:abc", name: "견적 회신", work: [{ id: "st_conv", description: "견적서 정리", status: "running", started_at: ago(2) }] }];
const RUNS = { "mail:abc": { kind: "working", since: new Date(ago(2)).toISOString() } };
const LANES = [
	{ name: "fix", title: "기술부채 정리", status: "working", startedAt: new Date(ago(60)).toISOString(), model: "anthropic/claude-opus-5-5" },
	{ name: "gone", title: "끝난 세션", status: "exited", startedAt: new Date(ago(90)).toISOString() },
];
const sent: Record<string, unknown>[] = [];
const waiters: ((b: Record<string, unknown>) => void)[] = [];
const nextSent = () => new Promise<Record<string, unknown>>(res => waiters.push(res));
const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (req.method === "POST" && p === "/api/message") { const b = (await req.json()) as Record<string, unknown>; sent.push(b); waiters.shift()?.(b); return json({ ok: true }); }
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle", lastText: "ok" }, lanes: LANES, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, work: WORK, convs: CONVS, work_now: Date.now(), runs: RUNS });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
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
const q = async <T>(v: View, body: string): Promise<T> => JSON.parse(String(await v.evaluate(`JSON.stringify((() => { ${body} })())`))) as T;
const boot = async (width: number, height: number) => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/?load=${++load}#chat`);
	await waitFor(v, `S && S.runs && S.work && typeof target === "string" && current === "chat" && !$("#text").disabled`);
	return v;
};
const type = (v: View, text: string) => v.evaluate(`(() => { const t = $("#text"); t.focus(); t.value = ${JSON.stringify(text)}; t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new Event("input")); })()`);
const key = (v: View, k: string) => v.evaluate(`$("#text").dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
const menu = (v: View) => q<string[]>(v, `return $("#hints").hidden ? [] : [...document.querySelectorAll("#hints .sl-i")].map(n => n.textContent.replace(/\\s+/g, " ").trim());`);
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };

test("@ lists what runs now, filters as typed, Enter writes the token that the sent message names by id, and a mail address opens nothing", async () => {
	const v = await boot(1280, 800);
	await type(v, "@");
	await waitFor(v, `!$("#hints").hidden`);
	const all = await menu(v);
	expect(all.map(r => r.split(" ")[0])).toEqual(["@메일", "@견적", "@견적서", "@기술부채"]);
	expect(all[0]).toContain("백그라운드 작업 · Opus 5.5 medium");
	expect(all.join("|")).not.toContain("끝난");
	await shot(v, "desktop-1280x800.png");
	await type(v, "이거 @기술");
	await waitFor(v, `document.querySelectorAll("#hints .sl-i").length === 1`);
	await key(v, "Escape");
	await waitFor(v, `$("#hints").hidden`);
	await type(v, "@견적");
	await waitFor(v, `document.querySelectorAll("#hints .sl-i").length === 2`);
	await key(v, "ArrowDown");
	await key(v, "Enter");
	expect(await v.evaluate(`$("#text").value`)).toBe("@견적서 정리 ");
	await v.evaluate(`(() => { const t = $("#text"); t.value += "이거 상태?"; t.dispatchEvent(new Event("input")); })()`);
	const got = nextSent();
	await key(v, "Enter");
	const body = await got;
	expect(body.text).toBe("@견적서 정리 이거 상태?");
	expect(body.refs).toEqual([{ kind: "task", id: "st_conv", label: "견적서 정리" }]);
	await type(v, "me@x.com");
	expect(await menu(v)).toEqual([]);
}, 30_000);

test("phone: a tap on a row picks it and keeps the keyboard's focus; a deleted token sends no reference", async () => {
	const v = await boot(390, 844);
	await type(v, "확인 @");
	await waitFor(v, `!$("#hints").hidden`);
	await shot(v, "phone-390x844.png");
	await v.evaluate(`[...document.querySelectorAll("#hints .sl-i")].find(n => n.textContent.includes("기술부채")).click()`);
	expect(await q<[string, boolean]>(v, `return [$("#text").value, document.activeElement === $("#text")];`)).toEqual(["확인 @기술부채 정리 ", true]);
	const first = nextSent();
	await key(v, "Enter");
	expect((await first).refs).toEqual([{ kind: "lane", id: "fix", label: "기술부채 정리" }]);
	await type(v, "@");
	await waitFor(v, `!$("#hints").hidden`);
	await key(v, "Enter");
	await type(v, "그냥 글");
	const second = nextSent();
	await key(v, "Enter");
	const b = await second;
	expect(b.text).toBe("그냥 글");
	expect(b.refs).toBeUndefined();
}, 30_000);
