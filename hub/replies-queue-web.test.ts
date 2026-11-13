// 답장 대기 over the one reply queue (design 4.4, lane U2): its cards are the queue's items, failures first, only the first waiting card's
// 보내기 is filled, and a press posts to /api/reply/act (another computer's item to /api/peer/act as "reply").
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const item = (ref: string, at: number, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: `초안 ${ref}` }, original: { who: "김팀장", text: "자료 되나요?" }, ...o });
const failed = { state: "failed", at: NOW, reason: { code: "offline", text: "인터넷에 연결되지 않았어요" }, safeToAuto: false, attempts: 1, actions: ["retry"] };
const posts: { path: string; body: Record<string, unknown> }[] = [];
let posted: () => void = () => undefined;
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: [item("RAAAAAA", NOW - 2000), item("RBBBBBB", NOW - 1000), item("RCCCCCC", NOW - 5000, { send: failed })], counts: {}, triageMin: 1, undoSec: 10 });
		if (req.method === "POST" && (url.pathname === "/api/reply/act" || url.pathname === "/api/peer/proxy")) {
			posts.push({ path: url.pathname, body: (await req.json()) as Record<string, unknown> });
			posted();
			return json({ ok: true });
		}
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof rqItemCard === "function" && RA.loaded`);
await run(`go("monitoring", "replies")`);
await waitFor(`document.querySelectorAll("#mon-timeline .rq-c").length === 3`);

test("the cards are the queue's items: the failure first, then the waiting newest first; only the first waiting card's 보내기 is filled", async () => {
	expect(await ev(`[...document.querySelectorAll("#mon-timeline .rq-c [data-ref]")].map(n => n.dataset.ref).filter((r, i, a) => a.indexOf(r) === i)`)).toEqual(["RCCCCCC", "RBBBBBB", "RAAAAAA"]);
	expect(await ev(`[...document.querySelectorAll("#mon-timeline .rq-c [data-k=send]")].map(b => b.classList.contains("tonal"))`)).toEqual([false, true]);
	expect(await ev(`rqWaiting()`)).toBe(3);
});

test("보내기 on a card posts once to /api/reply/act", async () => {
	const p = new Promise<void>(r => (posted = r));
	await run(`document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=send]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ path: "/api/reply/act", body: { ref: "RBBBBBB", action: "send" } });
});

test("another computer's item is acted on through /api/peer/act as reply", async () => {
	const p = new Promise<void>(r => (posted = r));
	await run(`raAct({ ref: "RPEER01", pc: { url: "http://peer.test", name: "맥미니" } }, "send")`);
	await p;
	expect(posts.at(-1)).toMatchObject({ path: "/api/peer/proxy", body: { action: "reply", args: { ref: "RPEER01", action: "send" } } });
});
