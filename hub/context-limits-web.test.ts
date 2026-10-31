import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

// 컨텍스트 > 모델별 컨텍스트 설정 (web/js/19-project-main.js) as shipped, in a headless Bun.WebView against a stub gateway.
// Screenshots are written only when CONTEXT_SHOTS names a folder.
const SHOTS = process.env.CONTEXT_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const OPUS = "anthropic/claude-opus-5-5", SONNET = "anthropic/claude-sonnet-5-5";
const view = (sonnet: { window: number | null; compact_at: number | null }) => ({
	note: "",
	processes: [
		{ name: "orchestrator", kind: "orchestrator", status: "idle", running: true, model: `${OPUS}:medium`, tokens: 120_000, window: 1_000_000, percent: 12, compact_at: 300_000, compaction: {} },
		{ name: "alpha", kind: "lane", status: "idle", running: true, live: true, model: `${SONNET}:high`, tokens: 90_000, window: sonnet.window ?? 1_000_000, percent: 9, compact_at: 300_000, compaction: {} },
	],
	models: [
		{ model: OPUS, used_by: ["orchestrator"], window: null, window_default: 1_000_000, compact_at: null, compact_at_default: 300_000 },
		{ model: SONNET, used_by: ["alpha", "lanes"], window: sonnet.window, window_default: 1_000_000, compact_at: sonnet.compact_at, compact_at_default: 300_000 },
	],
	limits: { window: { min: 32_000, max: 10_000_000 }, compact_at: { min: 20_000 }, applies: "저장하면 다음 턴부터 적용돼요." },
});
let current = view({ window: null, compact_at: null });
const puts = inbox<Record<string, unknown>>();
const hub = fakeHub({
	state: { name: "dotz", orchestrator: { status: "idle" }, lanes: [{ name: "alpha", status: "idle", model: `${SONNET}:high` }], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 },
	async api(req, url) {
		if (url.pathname !== "/api/context" && url.pathname !== "/api/context/model") return undefined;
		if (req.method === "PUT") {
			const b = (await req.json()) as { window: number | null; compact_at: number | null };
			puts.push(b);
			current = view({ window: b.window, compact_at: b.compact_at });
		}
		return json(current);
	},
});
afterAll(() => hub.stop());

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const shot = async (v: View, name: string) => { if (SHOTS) { await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`); await Bun.write(join(SHOTS, name), await v.screenshot()); } };
const button = (scope: string, label: string) => `[...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.offsetParent)`;
const boot = async (v: View) => {
	current = view({ window: null, compact_at: null });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof go === "function" && S`);
	await run(v, `go("context")`);
	await waitFor(v, `document.querySelectorAll("#context .ctx-model").length === 2`);
};

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
	describe(`모델별 컨텍스트 설정 at ${width}x${height}`, async () => {
		const v = await hub.view({ width, height });

		test("each model in use shows its window and compaction point with the default, and who uses it", async () => {
			await boot(v);
			const cards = await q<string[]>(v, `return [...document.querySelectorAll("#context .ctx-model")].map(c => c.innerText.replace(/\\s+/g, " "))`);
			expect(cards[0]).toContain("1,000,000 토큰 · 기본");
			expect(cards[0]).toContain("300,000 토큰 (30%) · 기본");
			expect(cards[1]).toContain("alpha, 새 세션 기본");
			await shot(v, `${width}-01-list.png`);
		});

		test("a percent is turned into tokens of the window; an empty field is sent as the default (null)", async () => {
			const before = puts.length;
			await run(v, `${button("#context .ctx-model:nth-child(2) button", "설정")}.click()`);
			await waitFor(v, `document.querySelectorAll("dialog[open] input").length === 2`);
			await run(v, `const [w, a] = document.querySelectorAll("dialog[open] input"); w.value = "400k"; a.value = "80%";`);
			await shot(v, `${width}-02-dialog.png`);
			await run(v, `${button("dialog[open] button", "저장")}.click()`);
			await puts.until(p => p.length > before);
			expect(puts.at(-1)).toEqual({ model: SONNET, window: 400_000, compact_at: 320_000 });
			await waitFor(v, `!document.querySelector("dialog[open]") && document.querySelector("#context .ctx-model:nth-child(2)").innerText.includes("직접 설정")`);
			await shot(v, `${width}-03-saved.png`);
		});

		test("a set model can go back to the defaults", async () => {
			const before = puts.length;
			await run(v, `${button("#context .ctx-model:nth-child(2) button", "설정")}.click()`);
			await waitFor(v, button("dialog[open] button", "기본값으로"));
			await run(v, `${button("dialog[open] button", "기본값으로")}.click()`);
			await puts.until(p => p.length > before);
			expect(puts.at(-1)).toEqual({ model: SONNET, window: null, compact_at: null });
		});

		test("an unreadable value is refused in the dialog without a request", async () => {
			const before = puts.length;
			await run(v, `${button("#context .ctx-model:nth-child(1) button", "설정")}.click()`);
			await waitFor(v, `document.querySelectorAll("dialog[open] input").length === 2`);
			await run(v, `document.querySelectorAll("dialog[open] input")[1].value = "lots"; ${button("dialog[open] button", "저장")}.click()`);
			await waitFor(v, `document.querySelector("dialog[open] [role=alert]").textContent.length > 0`);
			expect(puts.length).toBe(before);
			await run(v, `${button("dialog[open] button", "취소")}.click()`);
		});
	});
}
