import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// docs/ui-spec.md 검사할 수 있는 규칙, measured in a headless browser on the settings screens that hold rows with controls:
// a control in a settings row sits in the row's one right-hand slot (.li > .li-end), a button there is the 행 안 tier (.inrow, 32px),
// a button in a section header is the small tier (.sm), the right-hand slots of one list share one right edge, and a screen, an open
// sheet or one repeated card holds at most one filled button.
const json = (v: unknown, status = 200) => Response.json(v, { status });
const commit = { sha: "a".repeat(40), short: "aaaaaaa", date: new Date(0).toISOString() };
const room = { ask: true, alert: true, result: true, news: true, conv: true, log: true };
const API: Record<string, unknown> = {
	"/api/state": { name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 },
	"/api/activity": { items: [], more: false, history: false },
	"/api/notices": { items: [], unread: 0 },
	"/api/update": { running: { kind: "git", branch: "main", commit }, disk: { kind: "git", branch: "main", commit }, settings: { auto_check: true, auto_apply: false, at: "09:00" }, busy: [] },
	"/api/accounts": {
		mode: "auto", chosen: { name: "default", label: "개인 계정", source: "auto", blocked: null, text: "" },
		accounts: [{ name: "default", order: 1, alias: null, label: "개인 계정", current: true, blocked: null, blocked_until: null, blocked_tag: null }],
		rules: {}, rules_text: [], script: { path: null, timeout_ms: 5000, every_minutes: 5, last: null },
		providers: [{ id: "anthropic", name: "Claude 구독", auth: "oauth", multi: true, can_add: true, can_pin: true, can_delete: true, accounts: [
			{ name: "default", order: 1, label: "개인 계정", current: true, pinned: true, blocked: null, blocked_until: null, blocked_tag: null, windows: [] }] }],
		login_providers: [{ id: "anthropic", name: "Claude 구독", configured: true }],
	},
	"/api/providers": { providers: [
		{ id: "anthropic", name: "Claude 구독", auth: "oauth", account: "개인 계정", accounts: 2, in_use: true, can_add_account: true, can_logout: true },
		{ id: "chatgpt-subscription", name: "ChatGPT 구독", auth: "oauth", account: "회사용 GPT", can_login: true, can_logout: true },
		{ id: "google", name: "Gemini", auth: "api_key", masked: "AIza…x9Qd", can_login: true, can_logout: true },
		{ id: "cursor", name: "Cursor", auth: "none", can_login: true },
	] },
	"/api/discord/connection": { enabled: true, connected: true, user: "dotz-bot", error: "", guild: "1", owner_id: "2", app_id: "3", has_token: true, restart_needed: true },
	"/api/discord/post": { chat: true, lanes: true, alert: true, worklog: true, web_lanes: false, ask: true, result: false, news: true, conv: true },
	"/api/messengers": { items: [{ id: "discord", label: "Discord", enabled: true, state: "ok", configured: true }, { id: "jandi", label: "JANDI", enabled: true, state: "ok", configured: true }] },
	"/api/messengers/jandi": {
		enabled: true, help: [], fields: [{ key: "incoming_url", label: "기본 수신 웹훅 URL", type: "secret", set: true }],
		allow: { label: "말을 걸 수 있는 사람", hint: "이메일이나 JANDI 이름", items: ["kim@example.com"] },
		rooms: { label: "방", editable: true, hint: "", fields: [], items: [{ id: "m1", name: "메인", kind: "main", values: {}, set: {} }] },
		notify: room,
	},
};
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname in API) return json(API[url.pathname]);
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

const waitFor = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(
		`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`,
	);

// Violations on the visible screen, one line each: "<rule> <view> <control>".
const MEASURE = `(() => {
  const out = [];
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const name = e => (e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 20);
  const add = (rule, e) => out.push(rule + " " + (e.closest("[id]") || {}).id + " " + name(e));
  for (const li of [...document.querySelectorAll(".li")].filter(vis)) {
    if (li.classList.contains("dcs-form")) continue;
    for (const c of li.querySelectorAll(".btn, .hs-sw, .sel")) {
      if (!vis(c) || c.closest(".tx") || c.closest(".li") !== li) continue;
      if (c.parentElement.closest(".li-end") === null || c.closest(".li-end").parentElement !== li) { add("slot", c); continue; }
      if (c.classList.contains("btn") && (!c.classList.contains("inrow") || Math.round(c.getBoundingClientRect().height) !== 28)) add("row-tier", c);
    }
  }
  for (const b of [...document.querySelectorAll(".sec .btn, .tools-bar .btn")].filter(vis))
    if (!b.classList.contains("sm") && !b.classList.contains("inrow")) add("header-tier", b);
  for (const list of [...document.querySelectorAll(".list")].filter(vis)) {
    const rights = [...list.querySelectorAll(":scope > .li > .li-end")].filter(vis).map(e => Math.round(e.getBoundingClientRect().right));
    if (rights.length > 1 && Math.max(...rights) - Math.min(...rights) > 1) add("column", list);
  }
  // one filled button per screen, open sheet or repeated card (each 답장 확인 card keeps its own 보내기)
  const filled = new Map();
  for (const b of [...document.querySelectorAll(".btn:not(.tonal):not(.outlined):not(.text):not(.danger), .btn.danger.fill")].filter(vis)) {
    const box = b.closest(".rq, dialog[open], section.view");
    if (box) filled.set(box, (filled.get(box) || 0) + 1);
  }
  for (const [box, n] of filled) if (n > 1) add("one-filled", box);
  return JSON.stringify(out);
})()`;

// Each screen and a row that shows it has finished loading.
const SCREENS: Array<[string, string]> = [
	["settings", `document.querySelector("#settings [data-ms-hub]")`],
	["update", `document.querySelector("#update [aria-label='자동 확인']")`],
	["runtime", `document.querySelector("#runtime .li")`],
	["messengers", `document.querySelectorAll("#messengers [data-ms-row]").length === 4`],
	["provider/anthropic", `document.querySelector("#provider [aria-label='자동 전환']") && document.querySelector("#provider .sec-act")`],
	["providers", `document.querySelectorAll("#providers .prow").length === 4`],
	["discord", `document.querySelector("[data-ms-connect='discord']") && document.querySelector("[data-dc]")`],
	["jandi", `document.querySelector("[data-ms-connect='jandi']") && document.querySelector("#jandi [data-k]")`],
];

for (const width of [390, 1280])
	test(`${width}px: settings rows keep controls in the right-hand slot at the row tier, header actions at the small tier`, async () => {
		const v = new Bun.WebView({ width, height: 900 });
		views.push(v);
		await v.navigate(`http://127.0.0.1:${server.port}/`);
		await waitFor(v, `typeof go === "function" && S`);
		const found: string[] = [];
		for (const [view, ready] of SCREENS) {
			const [name, tgt] = view.split("/");
			await v.evaluate(`(go(${JSON.stringify(name)}, ${JSON.stringify(tgt)}), 0)`);
			await waitFor(v, ready);
			found.push(...(JSON.parse((await v.evaluate(MEASURE)) as string) as string[]));
		}
		expect(found).toEqual([]);
	}, 60_000);

// docs/ui-spec.md 목록 행 선택: a selected or pressed row inside a card has its own fill, never the page's grey, so the first or last row
// does not look cut out of the card; the card clips it to its rounded corners.
for (const theme of ["light", "dark"])
	test(`${theme}: a selected row in a card differs from the page and from the card, and the card clips it`, async () => {
		const v = new Bun.WebView({ width: 390, height: 844 });
		views.push(v);
		await v.navigate(`http://127.0.0.1:${server.port}/`);
		await waitFor(v, `typeof go === "function" && S`);
		const r = JSON.parse((await v.evaluate(`(() => {
			document.documentElement.dataset.theme = ${JSON.stringify(theme)};
			const bg = c => getComputedStyle(c).backgroundColor;
			const out = [];
			for (const [box, row] of [["list", "li"], ["pl-list", "pl-row"], ["list", "mth-row"]]) {
				const list = document.createElement("div"); list.className = box;
				for (let i = 0; i < 3; i++) { const li = document.createElement("button"); li.className = row + (i === 0 ? " on" : ""); li.textContent = "행"; list.append(li); }
				document.body.append(list);
				out.push({ row, sel: bg(list.firstChild), page: bg(document.body), card: bg(list), clip: getComputedStyle(list).overflow, radius: parseFloat(getComputedStyle(list).borderTopLeftRadius) });
				list.remove();
			}
			return JSON.stringify(out);
		})()`)) as string);
		for (const x of r as Array<{ row: string; sel: string; page: string; card: string; clip: string; radius: number }>) {
			expect(`${x.row} ${x.sel}`).not.toBe(`${x.row} ${x.page}`);
			expect(`${x.row} ${x.sel}`).not.toBe(`${x.row} ${x.card}`);
			expect(`${x.row} ${x.clip} ${x.radius > 0}`).toBe(`${x.row} hidden true`);
		}
	});
