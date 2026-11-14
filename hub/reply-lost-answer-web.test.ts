// A press whose answer never comes back (issue #5: Safari "Load failed" on a phone, the mail went out 14 s later): the queue is read again, an item the
// hub took moves on like any send, and only an item still waiting shows the connection line. The fetch rejects with no status, as a lost answer does.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const item = (ref: string, at: number, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: `초안 ${ref}` }, original: { who: `사람${ref.slice(-1)}`, text: "자료 되나요?" }, ...o });
const taken = new Set<string>();
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: [item("RCCCCC3", NOW - 3000), item("RAAAAA1", NOW - 2000), item("RBBBBB2", NOW - 1000)].map(i => (taken.has(i.ref) ? { ...i, send: { state: "undo", at: NOW, until: Date.now() + 10_000, actions: [] } } : i)), counts: {}, triageMin: 1, undoSec: 10 });
		if (req.method === "POST" && url.pathname === "/api/reply/act") {
			const b = (await req.json()) as Record<string, unknown>;
			taken.add(String(b.ref));
			return json({ ok: true });
		}
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof tqOpen === "function" && RA.loaded`);
// reach: "hub" posts and then loses the answer; "none" loses it before the hub hears anything.
await run(`window.__lose = ""; const f0 = window.fetch; window.fetch = async (p, o) => {
  if (String(p).includes("/api/reply/act") && window.__lose) { const how = window.__lose; window.__lose = ""; if (how === "hub") await f0(p, o); throw new TypeError("Load failed"); }
  return f0(p, o);
}`);
await run(`go("monitoring", "replies")`);
await waitFor(`document.querySelector(".rq-fast") && !document.querySelector(".rq-fast").hidden`);
await run(`document.querySelector(".rq-fast").click()`);
await waitFor(`TQ.h && document.querySelector(".tq-body .ra-card")`);

test("the hub took the send but the answer was lost: the card counts as sent and 빠른 처리 moves on, with no failure line", async () => {
	expect(await ev(`document.querySelector(".tq-body .ra-card").dataset.ref`)).toBe("RBBBBB2");
	await run(`window.__lose = "hub"; document.querySelector(".tq-body .ra-card [data-k=send]").click()`);
	await waitFor(`document.querySelector(".tr-pos").textContent === "빠른 처리 2 / 3"`);
	expect(taken.has("RBBBBB2")).toBe(true);
	expect(await ev(`RA.fail.has("RBBBBB2")`)).toBe(false);
	expect(await ev(`document.querySelector(".tq-r[data-ref=RBBBBB2] .tq-st").textContent`)).toMatch(/초 후 보내요$/);
});

test("the press never reached the hub: the card stays with the connection line and can be pressed again", async () => {
	expect(await ev(`document.querySelector(".tq-body .ra-card").dataset.ref`)).toBe("RAAAAA1");
	await run(`window.__lose = "none"; document.querySelector(".tq-body .ra-card [data-k=send]").click()`);
	await waitFor(`RA.fail.has("RAAAAA1")`);
	expect(taken.has("RAAAAA1")).toBe(false);
	expect(await ev(`RA.fail.get("RAAAAA1").text`)).toBe("연결이 끊겨서 못 보냈어요. 다시 눌러 주세요");
	expect(await ev(`document.querySelector(".tr-pos").textContent`)).toBe("빠른 처리 2 / 3");
	await waitFor(`!document.querySelector(".tq-body .ra-card [data-k=send]").disabled`);
});
