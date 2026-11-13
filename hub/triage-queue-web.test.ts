// 빠른 처리 over the one reply queue (design 4.4, lane U3): every waiting item of every channel, the same card, Enter sends and moves on,
// 진행 shows each item's state, and the list posts only the picked rows.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const item = (ref: string, at: number, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: `초안 ${ref}` }, original: { who: `사람${ref.slice(-1)}`, text: "자료 되나요?" }, ...o });
const kakao = { kind: "kakao", app: "kakao", label: "카카오톡" };
const posts: Record<string, unknown>[] = [];
let posted: () => void = () => undefined;
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: [item("RAAAAA1", NOW - 3000), item("RBBBBB2", NOW - 2000, kakao), item("RCCCCC3", NOW - 1000)], counts: {}, triageMin: 1, undoSec: 10 });
		if (req.method === "POST" && url.pathname === "/api/reply/act") {
			const b = (await req.json()) as Record<string, unknown>;
			posts.push(b);
			posted();
			return json({ ok: true, item: { ...item(String(b.ref), NOW), send: { state: "undo", at: NOW, until: Date.now() + 10_000, actions: [] } } });
		}
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const nextPost = () => new Promise<void>(r => (posted = r));

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof tqOpen === "function" && RA.loaded`);
await run(`go("monitoring", "replies")`);
await waitFor(`document.querySelector(".rq-fast") && !document.querySelector(".rq-fast").hidden`);

test("빠른 처리 takes every waiting item of every channel, newest first, with the head count and a rail of all of them", async () => {
	await run(`document.querySelector(".rq-fast").click()`);
	await waitFor(`TQ.h && document.querySelector(".tq-body .ra-card")`);
	expect(await ev(`TQ.items.map(i => i.ref)`)).toEqual(["RCCCCC3", "RBBBBB2", "RAAAAA1"]);
	expect(await ev(`document.querySelector(".tr-pos").textContent`)).toBe("빠른 처리 1 / 3");
	expect(await ev(`[...document.querySelectorAll(".tq-r")].map(r => r.dataset.ref)`)).toEqual(["RCCCCC3", "RBBBBB2", "RAAAAA1"]);
	expect(await ev(`document.querySelector(".tq-body .ra-card").dataset.ref`)).toBe("RCCCCC3");
});

test("Enter sends the item on screen once and moves on; the rail shows its undo window", async () => {
	const p = nextPost();
	await run(`document.body.focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: "RCCCCC3", action: "send" });
	await waitFor(`document.querySelector(".tr-pos").textContent === "빠른 처리 2 / 3"`);
	expect(await ev(`document.querySelector(".tq-r[data-ref=RCCCCC3] .tq-st").textContent`)).toMatch(/초 후 보내요$/);
	expect(posts).toHaveLength(1);
});

test("the list posts only the picked rows", async () => {
	await run(`document.querySelector(".tr-tog").click()`);
	await waitFor(`document.querySelectorAll(".tq-row").length === 3`);
	await run(`document.querySelector(".tq-row[data-ref=RAAAAA1] [data-k=send]").click()`);
	await waitFor(`!document.querySelector("[data-k=go-picked]").disabled`);
	const p = nextPost();
	await run(`document.querySelector("[data-k=go-picked]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: "RAAAAA1", action: "send" });
	expect(posts.map(b => b.ref)).not.toContain("RBBBBB2");
});
