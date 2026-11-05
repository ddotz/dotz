import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

// The composer's context chip (web/js/14-slash-commands.js renderCtxRing) on the session of the conversation on screen, as shipped,
// in a headless Bun.WebView against a stub gateway. Screenshots are written only when CTX_SHOTS names a folder.
const SHOTS = process.env.CTX_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OPUS = "anthropic/claude-opus-5-5";
const proc = { compaction: {}, compact_at: 300_000 };
const conv = (key: string, running: boolean, tokens: number, window: number, percent: number) => ({ key, kind: "conversation", status: running ? "idle" : "stopped", running, model: `${OPUS}:medium`, tokens, window, percent, ...proc });
const CONTEXT = {
	note: "",
	processes: [{ name: "orchestrator", kind: "orchestrator", status: "idle", running: true, model: `${OPUS}:medium`, tokens: 880_000, window: 1_000_000, percent: 88, ...proc }],
	conversations: [conv("ch:5", true, 120_000, 1_000_000, 12), conv("ch:6", false, 50_000, 200_000, 25), conv("mail:k1", true, 30_000, 1_000_000, 3), conv("settings:w", true, 40_000, 1_000_000, 4)],
	conversation_kinds: ["mail", "ch", "th", "settings", "alert", "worklog"],
	models: [],
	limits: { window: { min: 32_000, max: 10_000_000 }, compact_at: { min: 20_000 }, applies: "" },
};
let context: object = CONTEXT;
const puts = inbox<Record<string, unknown>>();
const targetOf = (t: string) => {
	const c = CONTEXT.conversations.find(x => x.key === t);
	return { target: t, key: "orchestrator", own: false, inherited: `${OPUS}:medium`, model: OPUS, thinking: "medium", running: !!c?.running, busy: false, context: c && { tokens: c.tokens, window: c.window, percent: c.percent, compaction: {} }, models: [], thinking_levels: [] };
};
const hub = fakeHub({
	state: { name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: { 5: "프로젝트", 6: "쉬는 프로젝트", 7: "새 프로젝트" } } },
	async api(req, url) {
		if (url.pathname === "/api/context") return json(context);
		if (url.pathname === "/api/target" && req.method === "PUT") {
			puts.push((await req.json()) as Record<string, unknown>);
			return json({ ok: true, compaction: "compacting" });
		}
		if (url.pathname === "/api/target") {
			return json(targetOf(url.searchParams.get("target") ?? "main"));
		}
		return undefined;
	},
});
afterAll(() => hub.stop());

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const chipAt = (v: View, t: string) => run(v, `target = ${JSON.stringify(t)}; renderCtxRing()`).then(() => q<{ hidden: boolean; text: string; title: string }>(v, `const b = document.querySelector("#ctx-ring"); return { hidden: b.hidden, text: b.textContent, title: b.title }`));
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const boot = async (v: View) => {
	context = CONTEXT;
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof go === "function" && S && C`);
};

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
	describe(`컨텍스트 칩 at ${width}x${height}`, async () => {
		const v = await hub.view({ width, height });

		test("a project shows its own session's numbers, not main's", async () => {
			await boot(v);
			expect((await chipAt(v, "main")).text).toBe("컨텍스트 88%");
			const r = await chipAt(v, "ch:5");
			expect(r).toEqual({ hidden: false, text: "컨텍스트 12%", title: "이 프로젝트 컨텍스트 12% · 120K/1M" });
			await shot(v, `project-${width}.png`);
		});

		test("a parked project shows its last figure and says so; one with no figure hides the chip", async () => {
			await boot(v);
			const r = await chipAt(v, "ch:6");
			expect(r.text).toBe("컨텍스트 25%");
			expect(r.title).toContain("마지막");
			expect((await chipAt(v, "ch:7")).hidden).toBe(true);
			await chipAt(v, "ch:6");
			await run(v, `document.querySelector("#ctx-ring").click()`);
			await waitFor(v, `document.querySelector(".menu")?.textContent.includes("다음 메시지")`);
			const text = await q<string>(v, `return document.querySelector(".menu").textContent`);
			expect(text).toContain("컨텍스트 25%");
			expect(text).not.toContain("지금 압축");
			await shot(v, `parked-menu-${width}.png`);
			await run(v, `closeMenu(false)`);
		});

		test("the chip's menu reads and compacts the session on screen", async () => {
			await boot(v);
			await chipAt(v, "ch:5");
			await run(v, `document.querySelector("#ctx-ring").click()`);
			await waitFor(v, `document.querySelector(".menu")?.textContent.includes("지금 압축")`);
			await run(v, `[...document.querySelectorAll(".menu button")].find(e => e.textContent.includes("지금 압축")).click()`);
			await puts.until(p => p.length > 0);
			expect(puts.shift()).toEqual({ target: "ch:5", compact: true });
		});

		test("mail threads and app settings follow the same rule, and a project on main (sessions off) reads main", async () => {
			await boot(v);
			expect((await chipAt(v, "mail:k1")).text).toBe("컨텍스트 3%");
			expect((await chipAt(v, "settings:w")).text).toBe("컨텍스트 4%");
			expect((await chipAt(v, "mail:gone")).hidden).toBe(true);
			await run(v, `C = { ...C, conversation_kinds: [], conversations: [] }`);
			expect((await chipAt(v, "ch:5")).text).toBe("컨텍스트 88%");
			expect((await chipAt(v, "mail:k1")).hidden).toBe(true);
		});

		test("a repaint fetches nothing", async () => {
			await boot(v);
			await run(v, `window.ctxCalls = []; const f = window.fetch; window.fetch = (...a) => (ctxCalls.push(String(a[0])), f(...a)); for (let i = 0; i < 50; i++) { target = i % 2 ? "ch:5" : "ch:6"; renderCtxRing(); }`);
			expect(await q<string[]>(v, `return ctxCalls.filter(u => u.includes("/api/context"))`)).toEqual([]);
		});
	});
}
