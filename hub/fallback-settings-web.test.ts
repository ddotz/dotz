import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.FB_SETTINGS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const UNTIL = new Date(Date.UTC(2026, 10, 23, 6, 0)).toISOString();
const m = (id: string, name: string) => ({ provider: "anthropic", selector: `anthropic/${id}`, name, reasoning: true, family: "Claude" });
const LIST = [m("claude-opus-5-5", "Claude Opus 5.5"), m("claude-sonnet-5-5", "Claude Sonnet 5.5")];
type Entry = Record<string, unknown> & { model: string };
const KEY_STEP: Entry = { model: OPUS, key_file: "anthropic-api-key", when: "quota", enabled: true, down: "error", down_reason: "api_key_off", until: UNTIL, id: "k" };
const START: Entry[] = [{ model: `${SONNET}:high`, enabled: true, id: "s" }, { model: `${SONNET}:medium`, enabled: true, id: "s2" }, KEY_STEP];
const fallbacks = (chain: Entry[]) => ({
	max: 6,
	orchestrator: { chain, hub_driven: true, active: [OPUS], harness: { id: "omo", name: "OmO" }, conditions: true },
	lanes: { chain: [], hub_driven: true, active: [OPUS], harness: { id: "omo", name: "OmO" }, conditions: true },
	workers: { chain: [], hub_driven: false, active: [], harness: { id: "omo", name: "OmO" }, conditions: true },
});
const MODELS = {
	orchestrator: { model: OPUS, thinking: "high" },
	lanes_default: { model: OPUS, thinking: "high" },
	workers: { model: SONNET, thinking: "high" },
	lanes: [],
	thinking_levels: ["off", "low", "medium", "high"],
	available: LIST,
	pickable: LIST,
	notes: {},
	fallbacks: fallbacks(START),
};
const STATE = { name: "dotz", orchestrator: { status: "idle", activeModel: `${OPUS}:high` }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 };

let keysOn = false;
const keyPuts: unknown[] = [];
const chainPuts: { target: string; chain: unknown[] }[] = [];
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
		if (p === "/api/guard/allow-api-key" && req.method === "PUT") {
			const b = (await req.json()) as { allow: boolean; confirm?: boolean };
			keyPuts.push(b);
			if (b.allow && b.confirm !== true) return json({ error: "turning API keys on needs confirm: true", confirm_required: true }, 400);
			keysOn = b.allow;
			return json({ allow: keysOn });
		}
		if (p === "/api/guard/allow-api-key") return json({ allow: keysOn });
		if (p === "/api/fallbacks" && req.method === "PUT") {
			const b = (await req.json()) as { target: string; chain: (string | Entry)[] };
			chainPuts.push(b);
			const chain = b.chain.map((e, i) => (typeof e === "string" ? { model: e, enabled: true, id: `p${i}` } : { ...e, enabled: e.enabled !== false, id: `p${i}` }));
			MODELS.fallbacks = fallbacks(chain);
			return json({ ok: true, target: b.target, applied: "updated", chain });
		}
		if (p === "/api/models") return json(MODELS);
		if (p === "/api/apikeys") return json({ providers: [] });
		if (p === "/api/peers") return json([]);
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 4_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const pressButton = (v: View, scope: string, label: string) => run(v, `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
const confirmOpen = (v: View) => q<string>(v, `const t = [...document.querySelectorAll(".dtitle")].find(n => n.textContent === "API 키 사용을 켤까요?" && n.offsetParent); return t ? t.textContent : ""`);
let shared: View | undefined;
const openModels = async () => {
	if (!shared) {
		shared = new Bun.WebView({ width: 1280, height: 900 });
		views.push(shared);
		await shared.navigate(`http://127.0.0.1:${server.port}/`);
		await waitFor(shared, `S && M && M.fallbacks`);
	}
	const v = shared;
	await run(v, `document.querySelectorAll("dialog[open]").forEach(d => d.close()); document.querySelectorAll(".snack").forEach(n => n.remove()); fbOpen = null; modelsOpen = ""; go("home"); go("models")`);
	await waitFor(v, `M.fallbacks.orchestrator.chain.length === ${START.length} && document.querySelector('#models .mt-use-row') && (typeof fbKeysOn === "undefined" || document.querySelector('#models [data-keys] [role="switch"]').getAttribute("aria-checked") === "${keysOn}")`);
	return v;
};
const masterSwitch = (v: View) => q<string | null>(v, `const s = document.querySelector('#models [data-keys] [role="switch"]'); return s ? s.getAttribute("aria-checked") : null`);

beforeEach(() => {
	keysOn = false;
	keyPuts.length = 0;
	chainPuts.length = 0;
	MODELS.fallbacks = fallbacks(START);
});

describe("N9: the API-key master switch on 모델 · 폴백", () => {
	test("turning it on asks first: cancel sends nothing, 켜기 sends one confirmed PUT and the switch reads on", async () => {
		const v = await openModels();
		expect(await masterSwitch(v)).toBe("false");
		await run(v, `document.querySelector('#models [data-keys] [role="switch"]').click()`);
		await waitFor(v, `[...document.querySelectorAll(".dtitle")].some(n => n.textContent === "API 키 사용을 켤까요?")`);
		expect(keyPuts).toEqual([]);
		await shot(v, "keys-confirm.png");
		await pressButton(v, ".dact", "취소");
		await waitFor(v, `![...document.querySelectorAll(".dtitle")].some(n => n.textContent === "API 키 사용을 켤까요?" && n.offsetParent)`);
		expect(keyPuts).toEqual([]);
		expect(await masterSwitch(v)).toBe("false");
		await run(v, `document.querySelector('#models [data-keys] [role="switch"]').click()`);
		await waitFor(v, `[...document.querySelectorAll(".dtitle")].some(n => n.textContent === "API 키 사용을 켤까요?" && n.offsetParent)`);
		await pressButton(v, ".dact", "켜기");
		await waitFor(v, `document.querySelector('#models [data-keys] [role="switch"]').getAttribute("aria-checked") === "true"`);
		expect(keyPuts).toEqual([{ allow: true, confirm: true }]);
	});
	test("turning it off is one tap with no question", async () => {
		keysOn = true;
		const v = await openModels();
		expect(await masterSwitch(v)).toBe("true");
		await run(v, `document.querySelector('#models [data-keys] [role="switch"]').click()`);
		await waitFor(v, `document.querySelector('#models [data-keys] [role="switch"]').getAttribute("aria-checked") === "false"`);
		expect(keyPuts).toEqual([{ allow: false }]);
		expect(await confirmOpen(v)).toBe("");
	});
	test("the API 키 사용 안 함 tag opens the explanation and the same switch, not the step editor; turning it on there still asks", async () => {
		const v = await openModels();
		await run(v, `document.querySelector('[data-use="main"]').click()`);
		await waitFor(v, `document.querySelector('[data-target="orchestrator"] .fb-item[data-i="2"] .tag.warn')`);
		const tag = await q<{ text: string; tag: string }>(v, `const t = document.querySelector('[data-target="orchestrator"] .fb-item[data-i="2"] .tag.warn'); return { text: t.textContent, tag: t.tagName }`);
		expect(tag).toEqual({ text: "API 키 사용 안 함(설정)", tag: "BUTTON" });
		await run(v, `document.querySelector('[data-target="orchestrator"] .fb-item[data-i="2"] .tag.warn').click()`);
		await waitFor(v, `document.querySelector('dialog[open] [role="switch"]')`);
		const d = await q<{ title: string; body: string; checked: string | null; editor: boolean }>(v, `const d = document.querySelector("dialog[open]"); return { title: d.querySelector(".dtitle").textContent, body: d.querySelector(".dbody").textContent, checked: d.querySelector('[role="switch"]').getAttribute("aria-checked"), editor: !!document.querySelector("#models .fbe") }`);
		expect(d.title).toBe("API 키 사용");
		expect(d.body).toContain("구독 한도");
		expect(d.checked).toBe("false");
		expect(d.editor).toBe(false);
		await shot(v, "keys-tag-dialog.png");
		await run(v, `document.querySelector('dialog[open] [role="switch"]').click()`);
		await waitFor(v, `[...document.querySelectorAll(".dtitle")].some(n => n.textContent === "API 키 사용을 켤까요?" && n.offsetParent)`);
		expect(keyPuts).toEqual([]);
		await pressButton(v, "dialog[open] .dact", "켜기");
		await waitFor(v, `document.querySelector('dialog[open] [role="switch"]') && document.querySelector('dialog[open] [role="switch"]').getAttribute("aria-checked") === "true"`);
		expect(keyPuts).toEqual([{ allow: true, confirm: true }]);
	});
});

describe("N11: deleting a fallback step offers 되돌리기, not a question", () => {
	test("삭제 saves the chain without the step at once; 되돌리기 on the toast PUTs the previous chain back", async () => {
		const v = await openModels();
		await run(v, `document.querySelector('[data-use="main"]').click()`);
		await waitFor(v, `document.querySelector('[data-target="orchestrator"] .fb-item[data-i="0"] .fb-body')`);
		await run(v, `document.querySelector('[data-target="orchestrator"] .fb-item[data-i="0"] .fb-body').click()`);
		await waitFor(v, `document.querySelector("#models .fbe")`);
		await pressButton(v, "#models .fbe", "삭제");
		await waitFor(v, `document.querySelector(".snack")`);
		expect(await confirmOpen(v)).toBe("");
		const before = START.map(({ model, key_file, when, enabled }) => (key_file ? { model, key_file, when, enabled } : { model, enabled }));
		expect(chainPuts).toEqual([{ target: "orchestrator", chain: before.slice(1) }]);
		const toastText = await q<{ text: string; action: string }>(v, `const s = document.querySelector(".snack"); return { text: s.querySelector("span").textContent, action: (s.querySelector(".sa") || {}).textContent || "" }`);
		expect(toastText.action).toBe("되돌리기");
		expect(toastText.text).toContain("Sonnet 5.5");
		await shot(v, "fb-delete-undo.png");
		await run(v, `document.querySelector(".snack .sa").click()`);
		await waitFor(v, `document.querySelectorAll('[data-target="orchestrator"] .fb-item[data-i]').length === 3`);
		expect(chainPuts).toEqual([{ target: "orchestrator", chain: before.slice(1) }, { target: "orchestrator", chain: before }]);
	});
});
