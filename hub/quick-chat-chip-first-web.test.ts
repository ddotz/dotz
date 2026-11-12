import { afterAll, expect, test } from "bun:test";
import { fakeHub, idleState, json, run, waitFor, type View } from "./test-web.ts";

// The quick chat's composer chip on its first paint, before /api/models and /api/target have answered: it must never show main's model
// (the quick chat runs on its own default, not main's), and once /api/models answers it shows that default without another tap.
// Headless Bun.WebView against a stub gateway whose two model answers are held until the test lets them go.
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const CONTEXT = {
	note: "",
	processes: [{ name: "orchestrator", kind: "orchestrator", status: "idle", running: true, model: `${OPUS}:medium`, tokens: 1000, window: 1_000_000, percent: 0, compaction: {}, compact_at: 300_000 }],
	conversations: [],
	conversation_kinds: ["mail", "ch", "th", "settings", "alert", "worklog", "quick"],
	models: [],
	limits: { window: { min: 32_000, max: 10_000_000 }, compact_at: { min: 20_000 }, applies: "" },
};
const LEVELS = ["off", "low", "medium", "high"];
const MODELS = { orchestrator: { model: OPUS, thinking: "medium" }, lanes: [], conversations: { quick: { own: "", active: "", kind: `${SONNET}:high` } }, thinking_levels: LEVELS, available: [], pickable: [] };
const TARGET_QUICK = { target: "quick", key: "orchestrator", own: false, inherited: `${SONNET}:high`, inherited_kind: true, model: SONNET, thinking: "high", active_model: "", running: false, busy: false, thinking_levels: LEVELS, note: "", models: [] };
const models = Promise.withResolvers<void>();
const target = Promise.withResolvers<void>();
const hub = fakeHub({
	state: () => idleState({ orchestrator: { status: "idle", activeModel: `${OPUS}:medium` }, runs: { main: { kind: "idle" } }, work: [], work_now: Date.now() }),
	async api(_req, url) {
		if (url.pathname === "/api/context") return json(CONTEXT);
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/models") { await models.promise; return json(MODELS); }
		if (url.pathname === "/api/target") { await target.promise; return json(TARGET_QUICK); }
		return undefined;
	},
});
afterAll(() => { models.resolve(); target.resolve(); hub.stop(); });

const chip = async (v: View) => JSON.parse((await v.evaluate(`JSON.stringify({ model: $("#c-model").textContent, hidden: $("#c-model").hidden })`)) as string) as { model: string; hidden: boolean };

test("가벼운 대화를 막 열면 칩이 메인 모델을 보이지 않고, /api/models가 오면 제 기본 모델을 보인다 (390px)", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/?light#chat/quick");
	await waitFor(v, `typeof renderCtxRing === "function" && S && C && quickOn() && target === "quick" && M === null`);
	await run(v, `renderCtxRing()`);
	const first = await chip(v);
	expect(first.hidden || !first.model.includes("Opus")).toBe(true);

	models.resolve();
	await waitFor(v, `M && $("#c-model").textContent === "Sonnet 5.5" && !$("#c-model").hidden`);
	expect(await chip(v)).toEqual({ model: "Sonnet 5.5", hidden: false });
}, 20_000);
