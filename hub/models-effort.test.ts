import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THINKING_LEVELS } from "./config.ts";
import { sseResponse } from "./events.ts";
import { modelsInUse } from "./models-in-use.ts";
import { EFFORT_KO, replyModelChoices } from "./reply-model-choices.ts";
import { REPLY_DEFAULT } from "./reply-model.ts";
import { appAsset, indexPage } from "./webapp.ts";

// Effort follows the model (owner 2026-11-03: the fallback editor listed the runtime's whole set for every model and said 최고 twice):
// the effort menus read each model's own `thinking` list from /api/models, keep off (dotz's own switch) and any saved level that is not
// in it, and every level has its own Korean word. Headless Bun.WebView against a stub gateway.
const SHOTS = process.env.MODELS_COMPACT_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const DEEP = "deepseek/deepseek-v4.1-flash-ultrafast";
const UNTIL = new Date(Date.UTC(2026, 10, 2, 18, 21)).toISOString();
const THINK = ["low", "medium", "high", "xhigh", "max"];
const m = (id: string, name: string, thinking?: string[]) => ({ provider: "anthropic", selector: `anthropic/${id}`, name, reasoning: true, family: "Claude", ...(thinking ? { thinking } : {}) });
const LIST = [m("claude-opus-5-5", "Claude Opus 5.5", THINK), m("claude-sonnet-5-5", "Claude Sonnet 5.5", THINK), { provider: "deepseek", selector: DEEP, name: DEEP, reasoning: true }];
const c = replyModelChoices(LIST);
const TARGET = { target: "main", key: "orchestrator", model: OPUS, thinking: "high", active_model: `${DEEP}:medium`, running: true, busy: false, context: { tokens: 12000, window: 200000, percent: 6, compaction: null }, models: LIST, thinking_levels: [...THINKING_LEVELS] };
const MODELS = {
	orchestrator: { model: OPUS, thinking: "high" },
	lanes_default: { model: OPUS, thinking: "high" },
	workers: { model: SONNET, thinking: "high" },
	lanes: [{ name: "pay", model: OPUS, thinking: "high", status: "idle", live: true, running: true, worker_model: `${SONNET}:high`, active_model: `${DEEP}:high` }],
	thinking_levels: [...THINKING_LEVELS],
	available: LIST,
	pickable: LIST,
	notes: {},
	fallbacks: {
		max: 6,
		orchestrator: { chain: [{ model: `${OPUS}:high`, enabled: true, id: "s" }, { model: `${DEEP}:medium`, enabled: true, id: "s2" }], hub_driven: true, active: [DEEP], primary_down: { down: "quota", until: UNTIL }, harness: { id: "omo", name: "OmO" }, conditions: true },
		lanes: { chain: [], hub_driven: true, active: [], primary_down: { down: "quota", until: UNTIL }, harness: { id: "omo", name: "OmO" }, conditions: true },
		workers: { chain: [], hub_driven: false, active: [], harness: { id: "omo", name: "OmO" }, conditions: true },
	},
	in_use: modelsInUse({
		orchestrator: { configured: `${OPUS}:high`, active: `${DEEP}:medium` },
		lanesDefault: `${OPUS}:high`,
		workers: `${SONNET}:high`,
		lanes: [
			{ name: "pay", title: "메일함 개선", configured: `${OPUS}:high`, active: `${DEEP}:high`, worker: `${SONNET}:high` },
			{ name: "mon", title: "모니터링 범주 정리", configured: `${OPUS}:high`, active: `${DEEP}:high`, worker: `${SONNET}:high` },
		],
		replyDefault: `${SONNET}:medium`,
		replies: [{ key: "mail", label: "메일", model: `${OPUS}:low` }],
		outlang: SONNET,
	}),
	replies: { value: "", model: REPLY_DEFAULT, default: REPLY_DEFAULT, default_label: "기본값 · Sonnet 5.5 · 보통", options: c.options, labels: c.labels },
};
const STATE = { name: "dotz", orchestrator: { status: "idle", activeModel: `${DEEP}:medium` }, lanes: [{ name: "pay", title: "메일함 개선", model: `${OPUS}:high`, status: "idle", live: true, startedAt: UNTIL, reports: [], context: {} }], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 };

const json = (v: unknown, status = 200) => Response.json(v, { status });
let targetModel = OPUS;
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
		if (p === "/api/state") return json(STATE);
		if (p === "/api/models") return json(MODELS);
		if (p === "/api/target") return json({ ...TARGET, model: targetModel });
		if (p === "/api/peers") return json([]);
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
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
let shared: View | undefined;
const boot = async (width = 1280, height = 900) => {
	if (shared && width === 1280) return shared;
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && M && M.in_use`);
	if (width === 1280) shared = v;
	return v;
};
const openModels = async (v: View) => {
	await run(v, `go("models")`);
	await waitFor(v, `document.querySelector('[data-target="in-use"]')`);
};

const menuLabels = async (v: View) => q<string[]>(v, `return [...document.querySelectorAll(".menu .mi .ml")].map(n => n.textContent)`);
const clickMenuLabel = async (v: View, part: string) => {
	await run(v, `const b = [...document.querySelectorAll(".menu .mi")].find(n => n.querySelector(".ml").textContent.includes(${JSON.stringify(part)})); if (!b) throw new Error("no menu item " + ${JSON.stringify(part)}); b.click()`);
};

describe("effort levels follow the model", () => {
	test("every level has its own Korean word, so no menu can show the same label twice", () => {
		const labels = THINKING_LEVELS.map(l => EFFORT_KO[l]);
		expect(labels.every(Boolean)).toBe(true);
		expect(new Set(labels).size).toBe(labels.length);
		expect(EFFORT_KO.xhigh).toBe("매우 높음");
		expect(EFFORT_KO.max).toBe("최고");
		const web = readFileSync(join(import.meta.dir, "../web/js/04-state.js"), "utf8");
		const table = JSON.parse(web.match(/const THINK_KO = (\{[^}]*\});/)![1]!.replace(/(\w+):/g, '"$1":'));
		expect(Object.fromEntries(THINKING_LEVELS.map(l => [l, table[l]]))).toEqual(EFFORT_KO);
	});
	test("a switched-off step says so once: on its switch, not again as a tag", async () => {
		const v = await boot();
		await openModels(v);
		await run(v, `M.fallbacks.orchestrator.chain[1].enabled = false; renderModels()`);
		const got = await q<{ sw: string; tags: string[] }>(v, `const n = document.querySelector('[data-target="orchestrator"] .fb-item[data-i="1"]'); return { sw: n.querySelector(".fb-sw").textContent, tags: [...n.querySelectorAll(".fb-tags .tag")].map(t => t.textContent) }`);
		expect(got.sw).toBe("꺼짐");
		expect(got.tags).not.toContain("꺼짐");
	});
	test("a fallback entry lists exactly its model's levels plus off, and the saved level stays when it is not one", async () => {
		const v = await boot();
		await openModels(v);
		await run(v, `document.querySelector('[data-target="orchestrator"] .fb-item[data-i="0"]').click()`);
		await waitFor(v, `document.querySelector('[data-target="orchestrator"] .fbe')`);
		await run(v, `document.querySelector('[data-target="orchestrator"] .fbe .fbe-grid').scrollIntoView({ block: "center" })`);
		await run(v, `document.querySelector('[data-target="orchestrator"] .fbe .fbe-grid .tf:nth-child(2) .sel').click()`);
		await waitFor(v, `document.querySelector(".menu .mi .ml")`);
		expect(await menuLabels(v)).toEqual(["기본 모델과 같게", "끔", "낮음", "보통", "높음", "매우 높음", "최고"]);
		await shot(v, "effort-opus.png");
		await run(v, `closeMenu(false)`);
		await run(v, `document.querySelector('[data-target="orchestrator"] .fbe .fbe-grid .tf:nth-child(2) .sel').click()`);
		await waitFor(v, `document.querySelector(".menu .mi .ml")`);
		await clickMenuLabel(v, "최고");
		await run(v, `document.querySelector('[data-target="orchestrator"] .fbe .fbe-grid .tf:nth-child(1) .sel').click()`);
		await waitFor(v, `document.querySelector(".menu .mi .ml")`);
		await clickMenuLabel(v, "deepseek-v4.1-flash-ultrafast");
		await run(v, `document.querySelector('[data-target="orchestrator"] .fbe .fbe-grid .tf:nth-child(2) .sel').click()`);
		await waitFor(v, `document.querySelector(".menu .mi .ml")`);
		const deep = await menuLabels(v);
		expect(deep).toEqual(["기본 모델과 같게", "끔", "최소", "낮음", "보통", "높음", "매우 높음", "최고", "자동"]);
		expect(new Set(deep).size).toBe(deep.length);
		await shot(v, "effort-deepseek.png");
		await run(v, `closeMenu(false)`);
	}, 30_000);
	test("the composer and home effort menus use the same per-model list", async () => {
		const v = await boot();
		await run(v, `go("chat")`);
		await waitFor(v, `current === "chat" && document.querySelector("#c-effort")`);
		targetModel = OPUS;
		await run(v, `target = MAIN; document.querySelector("#c-effort").click()`);
		await waitFor(v, `document.querySelector(".menu .mi .ml")`);
		expect((await menuLabels(v)).slice(0, -1)).toEqual(["끔", "낮음", "보통", "높음", "매우 높음", "최고"]);
		await run(v, `closeMenu(false)`);
		targetModel = DEEP;
		await run(v, `TV.clear(); document.querySelector("#c-effort").click()`);
		await waitFor(v, `document.querySelector(".menu .mi .ml")`);
		expect((await menuLabels(v)).slice(0, -1)).toEqual(["끔", "최소", "낮음", "보통", "높음", "매우 높음", "최고", "자동"]);
		await run(v, `closeMenu(false)`);
		await run(v, `homeMenu(document.body, MAIN)`);
		await waitFor(v, `document.querySelector(".menu .mi .ml")`);
		await clickMenuLabel(v, "추론 강도");
		await waitFor(v, `document.querySelector(".menu .mi .ml")`);
		expect(await menuLabels(v)).toEqual(["끔", "낮음", "보통", "높음", "매우 높음", "최고"]);
		await run(v, `closeMenu(false)`);
	}, 30_000);
});

describe("the in-use card is compact", () => {
	const rowGeometry = async (v: View, key = "main") => q<{ row: number[]; tx: number[]; m: number[]; tag: number[]; btn: number[]; text: string; label: string; title: string; aria: string }>(v, `
		const r = document.querySelector('.mt-use-row[data-use="${key}"]').getBoundingClientRect();
		const tx = document.querySelector('.mt-use-row[data-use="${key}"] .mt-use-tx').getBoundingClientRect();
		const mn = document.querySelector('.mt-use-row[data-use="${key}"] .mt-use-m').getBoundingClientRect();
		const tag = document.querySelector('.mt-use-row[data-use="${key}"] .tag').getBoundingClientRect();
		const b = document.querySelector('.mt-use-row[data-use="${key}"] .mt-use-act');
		const br = b.getBoundingClientRect();
		return { row: [r.top, r.height], tx: [tx.left, tx.top, tx.width], m: [mn.left, mn.top, mn.width, mn.height], tag: [tag.left, tag.top, tag.width], btn: [br.left, br.top, br.width, br.height], text: b.textContent, label: b.getAttribute("aria-label"), title: b.title + " · " + document.querySelector('.mt-use-row[data-use="${key}"] .mt-use-m').title, tagTitle: document.querySelector('.mt-use-row[data-use="${key}"] .tag').title };`);
	test("at 1280 a row is one line with the pencil at the far right, and no 바꾸기 text remains", async () => {
		const v = await boot();
		await openModels(v);
		await run(v, `document.querySelector('[data-target="in-use"]').scrollIntoView({ block: "start" })`);
		const g = await rowGeometry(v);
		expect(g.row[1]).toBeLessThan(45);
		expect(Math.abs(g.m[1] + g.m[3]! / 2 - (g.btn[1] + g.btn[3]! / 2))).toBeLessThan(4);
		expect(g.btn[2]).toBeGreaterThanOrEqual(28);
		expect(g.btn[2]).toBeLessThanOrEqual(32);
		expect(g.btn[3]).toBeGreaterThanOrEqual(28);
		expect(g.btn[3]).toBeLessThanOrEqual(32);
		expect(g.btn[0]).toBeGreaterThan(g.tag[0]);
		expect(g.text).toBe("");
		expect(g.label).toBe("메인 어시스턴트 바꾸기");
		expect(g.title).toContain("V4.1 flash ultrafast · 보통");
		expect(g.tagTitle).toContain("폴백 중 · 한도 소진");
		expect(g.tagTitle).toContain("기본 모델 Opus 5.5 · 높음 대신 쓰는 중");
		await shot(v, "after-1280.png");
		const noAct = await q<boolean>(v, `return !document.querySelector('.mt-use-row[data-use="lookups"] .mt-use-act') && !document.querySelector('.mt-use-row[data-use="outlang"] .mt-use-act')`);
		expect(noAct).toBe(true);
	}, 30_000);
	test("at 390 the row takes two tight lines and the icon stays on the model's line", async () => {
		const v = await boot(390, 1000);
		await openModels(v);
		await run(v, `document.querySelector('[data-target="in-use"]').scrollIntoView({ block: "start" })`);
		const g = await rowGeometry(v);
		await shot(v, "after-390.png");
		expect(g.row[1]).toBeLessThan(88);
		expect(g.m[1]).toBeGreaterThan(g.tx[1] + 8);
		expect(Math.abs(g.m[1] + g.m[3]! / 2 - (g.btn[1] + g.btn[3]! / 2))).toBeLessThan(4);
		await shot(v, "after-390.png");
	}, 30_000);
});
