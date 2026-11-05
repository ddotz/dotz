import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// The text must not jump from text to card: an answer comes whole, so it is a card from the frame it lands in, and the live status and progress
// notes before it never get shapes. A MutationObserver records each message at the moment it enters the timeline.
const LABELS = "- **원인:** 찾는 중이에요.\n- **고친 것:** 아직이에요.";
const ts = (n: number) => `2026-11-04T08:${String(10 + n).padStart(2, "0")}:00.000Z`;
const out = (n: number, text: string, extra: object = {}) => ({ ts: ts(n), kind: "out", source: "orchestrator", target: "web", text, ...extra });
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
const page = async <T>(expr: string) => (await view.evaluate(`JSON.stringify(${expr})`).then(s => JSON.parse(s as string))) as T;
type Seen = { ts: string; live: boolean; cards: number; lis: number; h: number };

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof openTarget === "function" && S`);
await view.evaluate(`(openTarget("main", "chat"), 0)`);
await hub.streamConnected();
await view.evaluate(`(window.__seen = [], new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.matches?.(".bm")) __seen.push({ ts: n.dataset.ts, live: !!n.querySelector(".lv"), cards: n.querySelectorAll(".ans-card").length, lis: n.querySelectorAll("li").length, h: n.offsetHeight }); }).observe(document.querySelector("#tl"), { childList: true, subtree: true }), 0)`);

test("the live status and a progress note stay text, the answer is a card from its first frame", async () => {
	hub.push(out(0, `작업 중이에요\n${LABELS}`, { update_key: "progress", live: true }));
	await waitFor(`document.querySelector("#tl .lv")`);
	hub.push(out(1, LABELS, { update_key: "note" }));
	await waitFor(`document.querySelector('[data-ts="${ts(1)}"]')`);
	hub.push(out(2, `찾았어요. 고쳤어요.\n\n${LABELS}`));
	await waitFor(`document.querySelector("#tl .ans-card")`);
	const seen = await page<Seen[]>("__seen");
	const of = (n: number) => seen.filter(s => s.ts === ts(n));
	expect(of(0).map(s => [s.live, s.cards])).toEqual([[true, 0]]);
	expect(of(1).map(s => s.cards)).toEqual([0]);
	expect(of(1)[0].lis).toBe(2);
	expect(of(2).map(s => [s.cards, s.lis])).toEqual([[1, 0]]);
	expect(await page<number>(`document.querySelector('[data-ts="${ts(2)}"]').offsetHeight`)).toBe(of(2)[0].h);
});
