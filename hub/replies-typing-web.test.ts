import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const item = (ref: string, at: number, text: string) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text }, original: { who: "김팀장", text: "자료 되나요?" } });
const hub = fakeHub({
	api: async (_req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: [item("RAAAAAA", NOW - 2000, "초안 가"), item("RBBBBBB", NOW - 1000, "초안 나")], counts: {}, triageMin: 1, undoSec: 10 });
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof rqItemCard === "function" && RA.loaded`);
await run(`go("monitoring", "replies")`);
await waitFor(`document.querySelectorAll("#mon-timeline .rq-c").length === 2`);

test("a redraw of the list for a change in the card being typed in keeps its field; the card is drawn again once the field is left", async () => {
	await run(`document.querySelector("#mon-timeline [data-ref=RAAAAAA] [data-k=fix]").click()`);
	await waitFor(`!!document.querySelector("#mon-timeline [data-ref=RAAAAAA] [data-k=fix-note]")`);
	await run(`const f = document.querySelector("#mon-timeline [data-ref=RAAAAAA] [data-k=fix-note]"); window.__f = f; f.focus(); f.value = "더 짧게"; f.dispatchEvent(new Event("input"))`);
	expect(await ev(`document.activeElement === window.__f`)).toBe(true);
	await run(`raLive({ ref: "RAAAAAA", item: { ...RA.items.get("RAAAAAA"), draft: { ...RA.items.get("RAAAAAA").draft, text: "다른 곳에서 바뀐 초안" } } })`);
	await run(`monDirty()`);
	await waitFor(`MON.sig === rqSig()`);
	expect(await ev(`window.__f.isConnected && document.activeElement === window.__f && window.__f.value`)).toBe("더 짧게");
	await run(`window.__f.blur()`);
	await waitFor(`!window.__f.isConnected && MON.sig === rqSig()`);
	expect(await ev(`document.querySelector("#mon-timeline [data-ref=RAAAAAA] [data-k=fix-note]").value`)).toBe("더 짧게");
});
