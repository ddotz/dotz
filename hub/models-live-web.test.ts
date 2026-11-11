import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { modelsInUse } from "./models-in-use.ts";
import { replyModelChoices } from "./reply-model-choices.ts";
import { REPLY_DEFAULT } from "./reply-model.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The model a target really answers on (home cards, the composer chip, 모델·폴백's 실제로 쓰는 모델): the running process's model first,
// with 대체 모델 사용 중 and why when it is not the configured one. Headless Bun.WebView against a stub gateway.
const SHOTS = process.env.MODELS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const UNTIL = new Date(Date.UTC(2026, 9, 27, 6, 0)).toISOString();
const m = (id: string, name: string) => ({ provider: "anthropic", selector: `anthropic/${id}`, name, reasoning: true, family: "Claude" });
const LIST = [m("claude-opus-5-5", "Claude Opus 5.5"), m("claude-sonnet-5-5", "Claude Sonnet 5.5")];
const c = replyModelChoices(LIST);
const MODELS = {
	orchestrator: { model: OPUS, thinking: "high" },
	lanes_default: { model: OPUS, thinking: "high" },
	workers: { model: SONNET, thinking: "high" },
	lanes: [{ name: "pay", model: OPUS, thinking: "high", status: "idle", live: true, running: true, worker_model: `${SONNET}:high`, active_model: `${SONNET}:high` }],
	thinking_levels: ["off", "low", "medium", "high"],
	available: LIST,
	pickable: LIST,
	notes: {},
	fallbacks: {
		max: 6,
		orchestrator: { chain: [{ model: `${SONNET}:high`, enabled: true, id: "s" }, { model: `${SONNET}:medium`, enabled: true, id: "s2" }], hub_driven: true, active: [SONNET], primary_down: { down: "quota", until: UNTIL }, harness: { id: "omo", name: "OmO" }, conditions: true },
		lanes: { chain: [], hub_driven: true, active: [SONNET], primary_down: { down: "quota", until: UNTIL }, harness: { id: "omo", name: "OmO" }, conditions: true },
		workers: { chain: [], hub_driven: false, active: [], harness: { id: "omo", name: "OmO" }, conditions: true },
	},
	conversations: { "ch:5": { own: `${OPUS}:low` } },
	in_use: modelsInUse({
		orchestrator: { configured: `${OPUS}:high`, active: `${SONNET}:high` },
		lanesDefault: `${OPUS}:high`,
		lookups: `${SONNET}:medium`,
		workers: `${SONNET}:high`,
		lanes: [{ name: "pay", title: "결제", configured: `${OPUS}:high`, active: `${SONNET}:high`, worker: `${SONNET}:high` }],
		replyDefault: REPLY_DEFAULT,
		replies: [{ key: "mail", label: "메일", model: `${OPUS}:low` }],
		outlang: SONNET,
	}),
	replies: { value: "", model: REPLY_DEFAULT, default: REPLY_DEFAULT, default_label: "기본값 · Sonnet 5.5 · 높음", options: c.options, labels: c.labels },
};
const STATE = { name: "dotz", orchestrator: { status: "idle", activeModel: `${SONNET}:high` }, lanes: [{ name: "pay", title: "결제", model: `${OPUS}:high`, worker_model: `${SONNET}:high`, status: "working", live: true, startedAt: UNTIL, reports: [], context: {} }], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 };

const json = (v: unknown, status = 200) => Response.json(v, { status });
const projectChange = Promise.withResolvers<unknown>();
const modelsPut = Promise.withResolvers<{ target: string; model: string }>();
let modelsPuts = 0;
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
		if (p === "/api/models" && req.method === "PUT") {
			const body = (await req.json()) as { target: string; model: string };
			modelsPuts++;
			modelsPut.resolve(body);
			const row = MODELS.in_use.find(r => r.key === "lanes")!;
			row.model = `${body.model}:high`;
			return json({ applied: "live" });
		}
		if (p === "/api/models") return json(MODELS);
		if (p === "/api/peers") return json([]);
		if (p === "/api/target" && req.method === "PUT") { projectChange.resolve(await req.json()); return json({ applied: "next-turn" }); }
		if (p === "/api/target" && url.searchParams.get("target") === "ch:5") return json({ target: "ch:5", key: "orchestrator", own: true, inherited: `${SONNET}:high`, model: OPUS, thinking: "low", models: LIST });
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
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
let shared: View | undefined;
const boot = async () => {
	if (shared) return shared;
	const v = new Bun.WebView({ width: 1280, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && M && M.in_use`);
	return (shared = v);
};

describe("REQ1: home cards and the composer chip show the model in use", () => {
	test("the greeting shows the fallback model and 대체 모델 사용 중 with the reason and return time, not the configured model", async () => {
		const v = await boot();
		await run(v, `go("home"); renderHome()`);
		await waitFor(v, `document.querySelector("#home-now .hgreet .meta")`);
		const r = await q<{ meta: string; tag: string }>(v, `const g = document.querySelector("#home-now .hgreet"); return { meta: g.querySelector(".meta").textContent, tag: (g.querySelector(".tag.warn") || {}).textContent || "" }`);
		expect(r.meta).toContain("Sonnet 5.5");
		expect(r.meta).not.toContain("Opus");
		expect(r.tag).toStartWith("대체 모델 사용 중 · 한도 소진 · ");
		expect(r.tag).toEndWith("에 복귀");
		await shot(v, "home.png");
	});
	test("a session row on home shows its running model and its fallback", async () => {
		const v = await boot();
		const r = await q<{ model: string; tag: string }>(v, `const n = document.querySelector("#v-home .smodel"); return { model: n ? n.firstChild.textContent : "", tag: n ? n.querySelector(".tag.warn").textContent : "" }`);
		expect(r.model).toEndWith("Sonnet 5.5 · 높음");
		expect(r.tag).toStartWith("대체 모델 사용 중 · 한도 소진");
	});
	test("the composer chip names the model in use and shows 대체 모델 사용 중 beside it; the configured model is gone", async () => {
		const v = await boot();
		await run(v, `target = MAIN; renderCtxRing()`);
		const r = await q<{ model: string; fb: string; hidden: boolean; title: string }>(v, `const f = document.querySelector("#c-fb"); return { model: document.querySelector("#c-model").textContent, fb: f.textContent, hidden: f.hidden, title: f.title }`);
		expect(r.model).toBe("Sonnet 5.5");
		expect(r.hidden).toBe(false);
		expect(r.fb).toStartWith("대체 모델 사용 중 · 한도 소진");
		expect(r.title).toContain("Opus 5.5");
	});
	test("a project conversation's row reads as main's; its model chip shows its own choice and the menu leads back to main's", async () => {
		const v = await boot();
		await run(v, `target = MAIN; renderCtxRing()`);
		const main = await q<string>(v, `return document.querySelector("#c-own").textContent`);
		await run(v, `target = "ch:5"; renderCtxRing()`);
		const r = await q(v, `const t = id => document.querySelector(id).textContent; return { owner: t("#c-own"), model: t("#c-model"), effort: t("#c-effort") }`);
		expect(r).toEqual({ owner: main, model: "Opus 5.5", effort: "낮음" });
		await run(v, `document.querySelector("#c-model").click()`);
		await waitFor(v, `document.querySelector(".menu .mi")`);
		await run(v, `[...document.querySelectorAll(".menu .mi")].find(b => b.textContent.startsWith("메인 대화와 같게")).click()`);
		expect(await projectChange.promise).toEqual({ target: "ch:5", inherit: true });
		await run(v, `target = MAIN; renderCtxRing()`);
	});
	test("the subagent chip of a session reads its worker_model and is clickable", async () => {
		const v = await boot();
		await run(v, `target = "lane:pay"; renderCtxRing()`);
		const r = await q<{ text: string; hidden: boolean; click: boolean }>(v, `const w = document.querySelector("#c-worker"); return { text: w.textContent, hidden: w.hidden, click: typeof w.onclick === "function" }`);
		expect(r).toEqual({ text: "서브에이전트 Sonnet 5.5 · 높음", hidden: false, click: true });
		await run(v, `target = MAIN; renderCtxRing()`);
	});
});

describe("REQ2/REQ3/REQ5 on 모델·폴백: one list, a row opens its editor in place", () => {
	const openModels = async () => {
		const v = await boot();
		await run(v, `modelsOpen = ""; go("models"); renderModels()`);
		await waitFor(v, `document.querySelector('.mt-use-row')`);
		return v;
	};
	const press = (v: View, key: string) => run(v, `document.querySelector('[data-use="${key}"]').click()`);
	const state = (v: View) => q<{ open: string[]; editors: string[] }>(v, `return { open: [...document.querySelectorAll('.mt-use-row[aria-expanded="true"]')].map(r => r.dataset.use), editors: [...document.querySelectorAll('#models [data-target]')].map(n => n.dataset.target) }`);
	test("every place is one row in three groups with the model in use and the fallback marked; nothing is expanded at first", async () => {
		const v = await openModels();
		const groups = await q<string[][]>(v, `return [...document.querySelectorAll("#models .mt-card")].map(c => [...c.querySelectorAll(".mt-use-row")].map(r => r.dataset.use))`);
		expect(groups).toEqual([["main", "background", "lookups"], ["lanes", "lane:pay", "workers"], ["replies", "reply:mail", "outlang"]]);
		const rows = await q<{ key: string; model: string; tag: string; role: string | null; expanded: string | null; fb: string }[]>(v, `return [...document.querySelectorAll(".mt-use-row")].map(r => ({ key: r.dataset.use, model: r.querySelector(".mt-use-m").textContent, tag: (r.querySelector(".tag.warn") || {}).textContent || "", role: r.getAttribute("role"), expanded: r.getAttribute("aria-expanded"), fb: (r.querySelector(".mt-use-fb") || {}).textContent || "" }))`);
		const by = Object.fromEntries(rows.map(r => [r.key, r]));
		expect(by.main!.model).toBe("Sonnet 5.5 · 높음");
		expect(by.main!.tag).toStartWith("대체 모델 사용 중 · 한도 소진");
		expect(by.main!.fb).toBe("대체 2");
		expect(by.lookups!.model).toBe("Sonnet 5.5 · 보통");
		expect(by["lane:pay"]!.tag).toStartWith("대체 모델 사용 중");
		expect(by["reply:mail"]!.model).toBe("Opus 5.5 · 낮음");
		expect(by.replies!.model).toBe("Sonnet 5.5 · 높음");
		for (const k of ["main", "lanes", "lane:pay", "workers", "replies"]) expect([by[k]!.role, by[k]!.expanded]).toEqual(["button", "false"]);
		expect([by["reply:mail"]!.role, by["reply:mail"]!.expanded]).toEqual(["button", null]);
		for (const k of ["lookups", "outlang"]) expect([by[k]!.role, by[k]!.expanded]).toEqual([null, null]);
		expect(await state(v)).toEqual({ open: [], editors: [] });
		await shot(v, "models.png");
	});
	test("pressing a row opens its editor right under it; pressing another closes the first; pressing it again closes it", async () => {
		const v = await openModels();
		await press(v, "main");
		expect(await state(v)).toEqual({ open: ["main"], editors: ["orchestrator"] });
		expect(await q<boolean>(v, `const r = document.querySelector('[data-use="main"]'); return r.nextElementSibling === document.querySelector('[data-target="orchestrator"]')`)).toBe(true);
		await press(v, "lanes");
		expect(await state(v)).toEqual({ open: ["lanes"], editors: ["lanes"] });
		await press(v, "lanes");
		expect(await state(v)).toEqual({ open: [], editors: [] });
	});
	test("Enter on a focused row opens it too", async () => {
		const v = await openModels();
		await run(v, `document.querySelector('[data-use="workers"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
		expect(await state(v)).toEqual({ open: ["workers"], editors: ["workers"] });
	});
	test("a row on a target already listed above is read-only; a row that changes in an app opens that app's settings screen", async () => {
		const v = await openModels();
		await press(v, "background");
		expect(await state(v)).toEqual({ open: [], editors: [] });
		await run(v, `window.__app = ""; asScreen = a => { window.__app = a; }; document.querySelector('[data-use="reply:mail"]').click()`);
		expect(await q<string>(v, `return window.__app`)).toBe("mail");
		expect(await state(v)).toEqual({ open: [], editors: [] });
	});
	test("openModels(key) opens that row and scrolls to it", async () => {
		const v = await openModels();
		await run(v, `window.__scrolled = ""; Element.prototype.scrollIntoView = function () { window.__scrolled = this.dataset.use || ""; }; openModels("lanes")`);
		await waitFor(v, `window.__scrolled === "lanes"`);
		expect(await state(v)).toEqual({ open: ["lanes"], editors: ["lanes"] });
	});
	test("a hub that names no place to change a row still gets an openable row for every target this screen edits", async () => {
		const v = await boot();
		await run(v, `window.__mOld = M; modelsOpen = ""; go("models")`);
		await waitFor(v, `M !== window.__mOld && document.querySelector('.mt-use-row')`);
		await run(v, `M = { ...M, in_use: [{ key: "main", label: "dotz", model: M.in_use[0].model }] }; renderModels()`);
		const rows = Object.fromEntries(await q<[string, string | null][]>(v, `return [...document.querySelectorAll(".mt-use-row")].map(r => [r.dataset.use, r.getAttribute("role")])`));
		for (const k of ["main", "lanes", "workers", "replies"]) expect([k, rows[k]]).toEqual([k, "button"]);
		await press(v, "main");
		expect(await state(v)).toEqual({ open: ["main"], editors: ["orchestrator"] });
	});
	test("답장 기본값 opens its picker naming Sonnet 5.5 높음 as the default, the same model the rows say drafts use", async () => {
		const v = await openModels();
		await press(v, "replies");
		const r = await q<{ field: string; note: string }>(v, `const c = document.querySelector('[data-target="replies"]'); return { field: c.querySelector(".mt-model").textContent, note: c.querySelector(".mt-note").textContent }`);
		expect(r.field).toContain("기본값 · Sonnet 5.5 · 높음");
		expect(r.note).toContain("API 키로 넘어가지 않아요");
	});
	test("effort is said in Korean and the last step number is the number of drawn steps", async () => {
		const v = await openModels();
		await press(v, "main");
		const r = await q<{ eff: string; count: string; steps: number }>(v, `const c = document.querySelector('[data-target="orchestrator"]'); return { eff: c.querySelector(".mt-eff").textContent, count: [...c.querySelectorAll(".fb-n")].at(-1).textContent, steps: c.querySelectorAll(".fb-list > .fb-item").length }`);
		expect(r.eff).toContain("높음");
		expect(r.eff).not.toContain("high");
		expect(r.steps).toBe(3);
		expect(r.count).toBe(String(r.steps));
	});
	test("changing the model and pressing 적용 sends one PUT for that target and the row shows the new model", async () => {
		const v = await openModels();
		await press(v, "lanes");
		await run(v, `document.querySelector('[data-target="lanes"] .mt-model .sel').click()`);
		await waitFor(v, `document.querySelector(".menu .mi")`);
		await run(v, `[...document.querySelectorAll(".menu .mi")].find(n => n.querySelector(".ml").textContent.includes("Sonnet")).click()`);
		await waitFor(v, `document.querySelector('[data-target="lanes"] .mt-apply .btn:not(.text)')`);
		await run(v, `document.querySelector('[data-target="lanes"] .mt-apply .btn:not(.text)').click()`);
		expect(await modelsPut.promise).toEqual({ target: "lanes", model: SONNET });
		await waitFor(v, `document.querySelector('[data-use="lanes"] .mt-use-m').textContent === "Sonnet 5.5 · 높음"`);
		expect(modelsPuts).toBe(1);
	});
});
