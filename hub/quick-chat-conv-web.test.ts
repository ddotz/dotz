import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, inbox, json, run, waitFor, type View } from "./test-web.ts";

// The quick chat (target "quick", gateway target web:quick) is a conversation with a session of its own, not a feed: its composer model chip is its
// own (the kind default before it runs, a choice saved for "quick"), and a running turn shows the run state line a mail conversation shows
// (/api/state `runs["web:quick"]`, hub/routes.ts stateRuns keys a session by its primary target). Headless Bun.WebView against a stub gateway.
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const proc = { compaction: {}, compact_at: 300_000 };
const CONTEXT = {
	note: "",
	processes: [{ name: "orchestrator", kind: "orchestrator", status: "idle", running: true, model: `${OPUS}:medium`, tokens: 880_000, window: 1_000_000, percent: 88, ...proc }],
	conversations: [],
	conversation_kinds: ["mail", "ch", "th", "settings", "alert", "worklog", "quick"],
	models: [],
	limits: { window: { min: 32_000, max: 10_000_000 }, compact_at: { min: 20_000 }, applies: "" },
};
const LEVELS = ["off", "low", "medium", "high"];
const MODELS = { orchestrator: { model: OPUS, thinking: "medium" }, lanes: [], conversations: { quick: { own: "", active: "", kind: `${SONNET}:high` } }, thinking_levels: LEVELS, available: [], pickable: [] };
const PICK = [{ selector: OPUS, name: "Opus 5.5", provider: "anthropic", reasoning: true }, { selector: SONNET, name: "Sonnet 5.5", provider: "anthropic", reasoning: true }];
const TARGET_QUICK = { target: "quick", key: "orchestrator", own: false, inherited: `${SONNET}:high`, inherited_kind: true, model: SONNET, thinking: "high", active_model: "", running: false, busy: false, thinking_levels: LEVELS, note: "", models: PICK };
const WORKING = { kind: "working", since: new Date().toISOString(), detail: "샘플 질문 답하는 중" };
const puts = inbox<Record<string, unknown>>();
let runs: Record<string, unknown> = { main: { kind: "idle" } };
const hub = fakeHub({
	state: () => idleState({ orchestrator: { status: "idle", activeModel: `${OPUS}:medium` }, runs, work: [], work_now: Date.now() }),
	async api(req, url) {
		if (url.pathname === "/api/context") return json(CONTEXT);
		if (url.pathname === "/api/models") return json(MODELS);
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/target" && req.method === "PUT") { puts.push((await req.json()) as Record<string, unknown>); return json({ ok: true }); }
		if (url.pathname === "/api/target" && url.searchParams.get("target") === "quick") return json(TARGET_QUICK);
		return undefined;
	},
});
afterAll(() => hub.stop());

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
type Chips = { model: string; modelHidden: boolean; effort: string; effortHidden: boolean };
const chipsAt = async (v: View, t: string) => {
	await run(v, `setTarget(${JSON.stringify(t)}); updateComposerMeta(); renderCtxRing()`);
	return q<Chips>(v, `const t = s => document.querySelector(s); return { model: t("#c-model").textContent, modelHidden: t("#c-model").hidden, effort: t("#c-effort").textContent, effortHidden: t("#c-effort").hidden }`);
};
const runLine = (v: View) => q<{ hidden: boolean; dot: string; on: boolean }>(v, `return { hidden: document.querySelector("#runstate").hidden, dot: document.querySelector("#runstate-dot").className, on: document.querySelector("#composer").classList.contains("rs-on") }`);

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
	describe(`가벼운 대화 모델과 실행 상태 at ${width}x${height}`, () => {
		test("before it runs the chip shows the quick chat's own default model and effort, not main's, and a pick is saved for quick", async () => {
			const v = await hub.view({ width, height }, "/?light");
			await waitFor(v, `typeof setTarget === "function" && S && C && M && M.orchestrator && quickOn()`);
			expect(await chipsAt(v, "main")).toMatchObject({ model: "Opus 5.5", effort: "보통" });
			expect(await chipsAt(v, "quick")).toEqual({ model: "Sonnet 5.5", modelHidden: false, effort: "높음", effortHidden: false });

			puts.length = 0;
			await run(v, `document.querySelector("#c-model").click()`);
			await waitFor(v, `document.querySelector(".menu .mi")`);
			await run(v, `[...document.querySelectorAll(".menu .mi")].find(b => b.textContent.includes("Opus 5.5")).click()`);
			await puts.until(p => p.length > 0, 10_000, "a PUT /api/target for quick");
			expect(puts).toEqual([{ target: "quick", model: OPUS }]);
		}, 20_000);

		test("a running quick session shows the run state a running mail conversation shows", async () => {
			runs = { main: { kind: "idle" }, "mail:m1": WORKING, "web:quick": WORKING };
			const v = await hub.view({ width, height }, "/?light");
			await waitFor(v, `typeof setTarget === "function" && S && S.runs && S.runs["web:quick"] && C && quickOn()`);
			await run(v, `setTarget("mail:m1")`);
			await waitFor(v, `target === "mail:m1" && !$("#runstate").hidden`);
			const mail = await runLine(v);
			await run(v, `setTarget("quick")`);
			await waitFor(v, `target === "quick" && !$("#runstate").hidden`);
			const quick = await runLine(v);
			expect(quick).toEqual(mail);
			expect(quick).toMatchObject({ hidden: false, on: true });
			expect(quick.dot).toContain("pri");
		}, 20_000);
	});
}
