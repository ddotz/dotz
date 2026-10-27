import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { modelsInUse } from "./models-in-use.ts";
import { replyModelChoices } from "./reply-model-choices.ts";
import { REPLY_DEFAULT } from "./reply-model.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The model a target really answers on (home cards, the composer chip, 모델·폴백's 실제로 쓰는 모델): the running process's model first,
// with 폴백 중 and why when it is not the configured one. Headless Bun.WebView against a stub gateway.
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
	in_use: modelsInUse({
		orchestrator: { configured: `${OPUS}:high`, active: `${SONNET}:high` },
		lanesDefault: `${OPUS}:high`,
		workers: `${SONNET}:high`,
		lanes: [{ name: "pay", title: "결제", configured: `${OPUS}:high`, active: `${SONNET}:high`, worker: `${SONNET}:high` }],
		replyDefault: REPLY_DEFAULT,
		replies: [{ key: "mail", label: "메일", model: `${OPUS}:low` }],
		outlang: SONNET,
	}),
	replies: { value: "", model: REPLY_DEFAULT, default: REPLY_DEFAULT, default_label: "기본값 · Sonnet 5.5 · 보통", options: c.options, labels: c.labels },
};
const STATE = { name: "dotz", orchestrator: { status: "idle", activeModel: `${SONNET}:high` }, lanes: [{ name: "pay", title: "결제", model: `${OPUS}:high`, status: "idle", live: true, startedAt: UNTIL, reports: [], context: {} }], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 };

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
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json(STATE);
		if (p === "/api/models") return json(MODELS);
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
	test("the main card shows the fallback model and 폴백 중 with the reason and return time, not the configured model", async () => {
		const v = await boot();
		await run(v, `go("home"); renderHome()`);
		await waitFor(v, `document.querySelector("#home-cards .big")`);
		const r = await q<{ big: string; tag: string }>(v, `const card = document.querySelector("#home-cards .big").closest(".card") || document.querySelector("#home-cards .big").parentNode; return { big: document.querySelector("#home-cards .big").textContent, tag: (card.querySelector(".sub .tag.warn") || {}).textContent || "" }`);
		expect(r.big).toEndWith("Sonnet 5.5");
		expect(r.big).not.toContain("Opus");
		expect(r.tag).toStartWith("폴백 중 · 한도 소진 · ");
		expect(r.tag).toEndWith("에 복귀");
		await shot(v, "home.png");
	});
	test("a session card shows its running model and its fallback", async () => {
		const v = await boot();
		const r = await q<{ model: string; tag: string }>(v, `const n = [...document.querySelectorAll("#home-cards .sup:not(.sub)")].find(x => x.querySelector(".tag.warn")); return { model: n ? n.firstChild.textContent : "", tag: n ? n.querySelector(".tag.warn").textContent : "" }`);
		expect(r.model).toEndWith("Sonnet 5.5 · 높음");
		expect(r.tag).toStartWith("폴백 중 · 한도 소진");
	});
	test("the composer chip names the model in use and shows 폴백 중 beside it; the configured model is gone", async () => {
		const v = await boot();
		await run(v, `target = MAIN; renderCtxRing()`);
		const r = await q<{ model: string; fb: string; hidden: boolean; title: string }>(v, `const f = document.querySelector("#c-fb"); return { model: document.querySelector("#c-model").textContent, fb: f.textContent, hidden: f.hidden, title: f.title }`);
		expect(r.model).toBe("Sonnet 5.5");
		expect(r.hidden).toBe(false);
		expect(r.fb).toStartWith("폴백 중 · 한도 소진");
		expect(r.title).toContain("Opus 5.5");
	});
});

describe("REQ2/REQ3/REQ5 on 모델·폴백", () => {
	const openModels = async () => {
		const v = await boot();
		await run(v, `go("models")`);
		await waitFor(v, `document.querySelector('[data-target="in-use"]')`);
		return v;
	};
	test("실제로 쓰는 모델 lists every place with the model in use, the fallback marked, each row linking to where it changes", async () => {
		const v = await openModels();
		const rows = await q<{ key: string; label: string; model: string; tag: string; btn: boolean }[]>(v, `return [...document.querySelectorAll(".mt-use-row")].map(r => ({ key: r.dataset.use, label: r.querySelector(".nm").textContent, model: r.querySelector(".mt-use-m").textContent, tag: (r.querySelector(".tag.warn") || {}).textContent || "", btn: !!r.querySelector("button") }))`);
		expect(rows.map(r => r.key)).toEqual(["main", "background", "lookups", "lanes", "lane:pay", "workers", "replies", "reply:mail", "outlang"]);
		const by = Object.fromEntries(rows.map(r => [r.key, r]));
		expect(by.main!.model).toBe("Sonnet 5.5 · 높음");
		expect(by.main!.tag).toStartWith("폴백 중 · 한도 소진");
		expect(by.background!.model).toBe("Sonnet 5.5 · 높음");
		expect(by.lookups!.model).toBe("Sonnet 5.5 · 보통");
		expect(by["lane:pay"]!.tag).toStartWith("폴백 중");
		expect(by["reply:mail"]!.model).toBe("Opus 5.5 · 낮음");
		expect(by.replies!.model).toBe("Sonnet 5.5 · 보통");
		for (const k of ["main", "background", "lanes", "lane:pay", "workers", "replies", "reply:mail"]) expect(by[k]!.btn).toBe(true);
		expect(by.lookups!.btn).toBe(false);
		await shot(v, "models.png");
	});
	test("바꾸기 on a row opens that place: the card on this screen, or the app's settings screen", async () => {
		const v = await openModels();
		await run(v, `window.__scrolled = ""; Element.prototype.scrollIntoView = function () { window.__scrolled = this.dataset.target || ""; }; document.querySelector('[data-use="replies"] button').click()`);
		await waitFor(v, `window.__scrolled === "replies"`);
		await run(v, `window.__app = ""; asScreen = a => { window.__app = a; }; document.querySelector('[data-use="reply:mail"] button').click()`);
		expect(await q<string>(v, `return window.__app`)).toBe("mail");
	});
	test("답장 기본값 is its own card naming Sonnet 5.5 보통 as the default, the same model the rows say drafts use", async () => {
		const v = await openModels();
		const r = await q<{ field: string; note: string }>(v, `const c = document.querySelector('[data-target="replies"]'); return { field: c.querySelector(".mt-model").textContent, note: c.querySelector(".note").textContent }`);
		expect(r.field).toContain("기본값 · Sonnet 5.5 · 보통");
		expect(r.note).toContain("API 키로 넘어가지 않아요");
	});
	test("effort is said in Korean and the fallback count is the number of drawn steps", async () => {
		const v = await openModels();
		const r = await q<{ eff: string; count: string; steps: number }>(v, `const c = document.querySelector('[data-target="orchestrator"]'); return { eff: c.querySelector(".mt-eff").textContent, count: c.querySelector(".mt-fb-h .sup").textContent, steps: c.querySelectorAll(".fb-list > .fb-item").length }`);
		expect(r.eff).toContain("높음");
		expect(r.eff).not.toContain("high");
		expect(r.steps).toBe(3);
		expect(r.count).toBe(`기본 포함 ${r.steps}단계`);
	});
});
