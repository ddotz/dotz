import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The composer's model and effort chips (web/js/14-slash-commands.js renderCtxRing) on conversations that have a session of their own but no
// model choice: 작업내역 and a mail thread read that session's model, as the project chat does. Headless Bun.WebView against a stub gateway.
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const proc = { compaction: {}, compact_at: 300_000 };
const conv = (key: string, running: boolean, model: string, tokens: number, window: number, percent: number) => ({ key, kind: "conversation", status: running ? "idle" : "stopped", running, model, tokens, window, percent, ...proc });
const CONTEXT = {
	note: "",
	processes: [{ name: "orchestrator", kind: "orchestrator", status: "idle", running: true, model: `${OPUS}:medium`, tokens: 880_000, window: 1_000_000, percent: 88, ...proc }],
	conversations: [conv("worklog", true, `${SONNET}:high`, 120_000, 1_000_000, 12), conv("mail:k1", false, `${OPUS}:low`, 50_000, 200_000, 25), conv("mail:k2", false, `${OPUS}:medium`, 10_000, 200_000, 5)],
	conversation_kinds: ["mail", "ch", "th", "settings", "alert", "worklog"],
	models: [],
	limits: { window: { min: 32_000, max: 10_000_000 }, compact_at: { min: 20_000 }, applies: "" },
};
const MODELS = { orchestrator: { model: OPUS, thinking: "medium" }, lanes: [], conversations: {}, thinking_levels: ["off", "low", "medium", "high"], available: [], pickable: [] };
const puts: unknown[] = [];
let onPut: (() => void) | undefined;
const TARGET_K2 = { target: "mail:k2", key: "orchestrator", own: false, inherited: `${OPUS}:medium`, inherited_kind: true, model: OPUS, thinking: "medium", active_model: "", running: false, busy: false, thinking_levels: ["off", "low", "medium", "high"], note: "", models: [{ selector: OPUS, name: "Opus 5.5", provider: "anthropic", reasoning: true }, { selector: SONNET, name: "Sonnet 5.5", provider: "anthropic", reasoning: true }] };
const hub = fakeHub({
	state: { name: "dotz", orchestrator: { status: "idle", activeModel: `${OPUS}:medium` }, lanes: [], terminals: {}, channels: { work: {} } },
	async api(req, url) {
		if (url.pathname === "/api/context") return json(CONTEXT);
		if (url.pathname === "/api/models") return json(MODELS);
		if (url.pathname === "/api/target" && req.method === "PUT") { puts.push(await req.json()); onPut?.(); return json({ ok: true }); }
		if (url.pathname === "/api/target" && url.searchParams.get("target") === "mail:k2") return json(TARGET_K2);
		return undefined;
	},
});
afterAll(() => hub.stop());

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
type Chips = { model: string; modelHidden: boolean; effort: string; effortHidden: boolean; ctx: string; ctxHidden: boolean };
const chipsAt = async (v: View, t: string) => {
	await run(v, `setTarget(${JSON.stringify(t)}); updateComposerMeta(); renderCtxRing()`);
	return q<Chips>(v, `const t = s => document.querySelector(s); return { model: t("#c-model").textContent, modelHidden: t("#c-model").hidden, effort: t("#c-effort").textContent, effortHidden: t("#c-effort").hidden, ctx: t("#ctx-ring").textContent, ctxHidden: t("#ctx-ring").hidden }`);
};

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
	describe(`모델 칩 at ${width}x${height}`, async () => {
		const v = await hub.view({ width, height }, "/");
		await waitFor(v, `typeof setTarget === "function" && S && C && M && M.orchestrator`);

		test("작업내역 shows its own session's model, effort and context, not main's", async () => {
			const main = await chipsAt(v, "main");
			expect(main).toMatchObject({ model: "Opus 5.5", effort: "보통", ctx: "컨텍스트 88%" });
			const r = await chipsAt(v, "worklog");
			expect(r).toEqual({ model: "Sonnet 5.5", modelHidden: false, effort: "높음", effortHidden: false, ctx: "컨텍스트 12%", ctxHidden: false });
		});

		test("a parked mail thread keeps its last context figure and shows the model it will start on", async () => {
			const r = await chipsAt(v, "mail:k1");
			expect(r).toEqual({ model: "Opus 5.5", modelHidden: false, effort: "낮음", effortHidden: false, ctx: "컨텍스트 25%", ctxHidden: false });
		});

		test("picking a model from the chip of a mail conversation saves it for that conversation", async () => {
			await chipsAt(v, "mail:k2");
			puts.length = 0;
			const saved = new Promise<void>(res => (onPut = res));
			await run(v, `document.querySelector("#c-model").click()`);
			await waitFor(v, `document.querySelector(".menu .mi")`);
			expect(await q<string[]>(v, `return [...document.querySelectorAll(".menu .mi")].map(b => b.textContent)`)).toEqual(expect.arrayContaining([expect.stringContaining("이 메일 기본값과 같게")]));
			await run(v, `[...document.querySelectorAll(".menu .mi")].find(b => b.textContent.includes("Sonnet 5.5")).click()`);
			await saved;
			expect(puts).toEqual([{ target: "mail:k2", model: SONNET }]);
		});

		test("tapping the model chip of a conversation without its own model choice never changes main's", async () => {
			await chipsAt(v, "worklog");
			puts.length = 0;
			await run(v, `document.querySelector("#c-model").click()`);
			await run(v, `document.querySelector("#c-effort").click()`);
			await waitFor(v, `!document.querySelector(".menu")`);
			expect(puts).toEqual([]);
		});
	});
}
