import { afterAll, describe, expect, test } from "bun:test";
import { ev, fakeHub, inbox, json, run, waitFor } from "./test-web.ts";

// Quick chat in the page: its row sits between the main chat and 작업내역 in the conversation list, opens target "quick", sends to
// web:quick and shows answers of web:quick in that conversation only. Headless Bun.WebView against a stub gateway; it asserts data-t,
// targets and request bodies, never visible text.
const KINDS = ["mail", "ch", "th", "settings", "alert", "worklog"];
let kinds = [...KINDS, "quick"];
const posts = inbox<Record<string, unknown>>();
const hub = fakeHub({
	stream: "fake",
	async api(req, url) {
		if (url.pathname === "/api/context") return json({ note: "", processes: [], conversations: [], conversation_kinds: kinds, models: [], limits: { window: { min: 32_000, max: 10_000_000 }, compact_at: { min: 20_000 }, applies: "" } });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/message" && req.method === "POST") {
			posts.push((await req.json()) as Record<string, unknown>);
			return json({ ok: true });
		}
		return undefined;
	},
});
afterAll(() => hub.stop());

const ANSWER = "quick-answer-marker";
const rowOrder = (v: Parameters<typeof run>[0]) => ev<string[]>(v, `[...document.querySelectorAll(".cv-row[data-t]")].map(r => r.dataset.t).filter(t => t === "main" || t === "quick" || t === "worklog")`);
const timelineHas = (text: string) => `document.querySelector("#timeline").textContent.includes(${JSON.stringify(text)})`;

async function openList(width: number, height: number) {
	const v = await hub.view({ width, height }, "/?light#chat/list");
	await waitFor(v, `typeof go === "function" && C && C.conversation_kinds && CV.loaded && current === "chat" && !!document.querySelector('.cv-row[data-t="main"]')`);
	return v;
}

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
	describe(`가벼운 대화 at ${width}x${height}`, () => {
		test("the list shows main, quick and worklog in that order, and one tap on the quick row opens it", async () => {
			kinds = [...KINDS, "quick"];
			const v = await openList(width, height);
			await waitFor(v, `!!document.querySelector('.cv-row[data-t="quick"]')`, 4000);
			expect(await rowOrder(v)).toEqual(["main", "quick", "worklog"]);
			await run(v, `document.querySelector('.cv-row[data-t="quick"]').click()`);
			await waitFor(v, `current === "chat" && target === "quick" && !convListing()`);
		}, 20_000);

		test("a message typed there is posted for web:quick, and an answer for web:quick shows in that conversation and not in main", async () => {
			kinds = [...KINDS, "quick"];
			const v = await openList(width, height);
			await waitFor(v, `!!document.querySelector('.cv-row[data-t="quick"]')`, 4000);
			await run(v, `document.querySelector('.cv-row[data-t="quick"]').click()`);
			await waitFor(v, `target === "quick"`);
			const before = posts.length;
			await run(v, `const t = document.querySelector("#text"); t.value = "quick question"; t.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#send-btn").click()`);
			const sent = (await posts.until(p => p.length > before, 10_000, "a POST /api/message from the quick chat"))[before]!;
			expect(sent.text).toBe("quick question");
			expect(sent.conv).toBe("quick");
			expect(sent.project).toBeUndefined();
			expect(sent.lane).toBeUndefined();

			await hub.streamConnected();
			hub.push({ ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web:quick", text: ANSWER });
			await waitFor(v, timelineHas(ANSWER));
			await run(v, `setTarget("main")`);
			await waitFor(v, `target === "main" && !${timelineHas(ANSWER)}`);
			await run(v, `setTarget("quick")`);
			await waitFor(v, timelineHas(ANSWER));
		}, 20_000);

		test("without quick in conversation_kinds there is no quick row and the order is main, worklog", async () => {
			kinds = [...KINDS];
			const v = await openList(width, height);
			await waitFor(v, `!!document.querySelector('.cv-row[data-t="worklog"]')`);
			expect(await rowOrder(v)).toEqual(["main", "worklog"]);
			expect(await ev<number>(v, `document.querySelectorAll('.cv-row[data-t="quick"]').length`)).toBe(0);
		}, 20_000);
	});
}
