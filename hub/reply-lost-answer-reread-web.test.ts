import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const PEER = { name: "맥미니", url: "http://peer.test" };
const item = (ref: string, text: string, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at: NOW - 1000, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text, hash: `${ref}-v1` }, original: { who: "김팀장", text: "자료 되나요?" }, ...o });
const undo = { state: "undo", at: NOW, until: NOW + 10_000, actions: [] };
let queue: unknown[] = [];
let peers: unknown[] = [];
let refuse: unknown = null;
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 1, undoSec: 10 });
		if (url.pathname === "/api/monitoring/peers") return json(peers);
		if (req.method === "POST" && url.pathname === "/api/reply/act" && refuse) return json(refuse, 409);
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

queue = [item("RAAAAAA", "초안 가"), item("RBBBBBB", "초안 나")];
await view.navigate(`${hub.origin}/`);
await waitFor(`typeof rqItemCard === "function" && RA.loaded`);
await run(`window.__lose = false; const f0 = window.fetch; window.fetch = async (p, o) => {
  if (window.__lose && o && o.method === "POST" && (String(p).includes("/api/reply/act") || String(p).includes("/api/peer/proxy"))) throw new TypeError("Load failed");
  return f0(p, o);
};
window.__press = (it, action) => { window.__r = undefined; window.__lose = true; raAct(it, action).then(r => { window.__lose = false; window.__r = r; }); };`);
const pressed = async (it: string, action: string) => {
	await run(`window.__press(${it}, "${action}")`);
	await waitFor(`window.__r !== undefined`);
	return ev<boolean>(`window.__r`);
};
const peerItem = (send?: unknown) => item("RPEER01", "초안 피어", send ? { send } : {});
const peerPress = () => `{ ...${JSON.stringify(peerItem())}, pc: ${JSON.stringify(PEER)} }`;
const snapshot = (reply?: unknown) => [{ ...PEER, online: true, stale: false, items: { monitors: [], notices: [], integrations: [], conversations: [], ...(reply ? { reply } : {}) } }];

test("a lost send answer where another device only changed the text is not a sent mail: the failure line is shown", async () => {
	queue = [item("RAAAAAA", "다른 기기에서 바꾼 글"), item("RBBBBBB", "초안 나")];
	expect(await pressed(`RA.items.get("RAAAAAA")`, "send")).toBe(false);
	expect(await ev(`RA.fail.get("RAAAAAA").text`)).toBe("연결이 끊겨서 못 보냈어요. 다시 눌러 주세요");
});

test("a lost send answer where the queue now holds the send is handled", async () => {
	queue = [item("RAAAAAA", "초안 가", { send: undo }), item("RBBBBBB", "초안 나")];
	expect(await pressed(`RA.items.get("RAAAAAA")`, "send")).toBe(true);
});

test("another computer's item with a lost answer is read from its snapshot: a send there is handled", async () => {
	peers = snapshot({ items: [peerItem(undo)] });
	expect(await pressed(peerPress(), "send")).toBe(true);
	expect(await ev(`RA.fail.has("RPEER01")`)).toBe(false);
});

test("another computer's item still waiting, or one whose queue cannot be read, shows the lost-answer line", async () => {
	peers = snapshot({ items: [peerItem()] });
	expect(await pressed(peerPress(), "send")).toBe(false);
	expect(await ev(`RA.fail.get("RPEER01").text`)).toBe("연결이 끊겨서 못 보냈어요. 다시 눌러 주세요");
	peers = snapshot();
	expect(await pressed(peerPress(), "send")).toBe(false);
	expect(await ev(`RA.fail.get("RPEER01").text`)).toBe("연결이 끊겨서 못 보냈어요. 다시 눌러 주세요");
});

test("an edit refused as changed shows the version the other device saved in the panel, and keeps the typed text", async () => {
	queue = [item("RAAAAAA", "초안 가"), item("RBBBBBB", "초안 나")];
	await run(`RA.fail.clear(); RA.items = new Map(${JSON.stringify(queue)}.map(i => [i.ref, i])); go("monitoring", "replies")`);
	await waitFor(`document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=fix]")`);
	refuse = { code: "changed", error: "바뀌었어요", item: item("RBBBBBB", "다른 기기에서 쓴 글", { draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "다른 기기에서 쓴 글", hash: "RBBBBBB-v2" } }) };
	await run(`document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=fix]").click()`);
	await waitFor(`document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=fix-text]")`);
	await run(`const a = document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=fix-text]"); a.value = "내가 쓴 글"; a.dispatchEvent(new Event("input")); document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=fix-apply]").click()`);
	await waitFor(`RA.fail.get("RBBBBBB") && RA.fail.get("RBBBBBB").code === "changed"`);
	await waitFor(`document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=fix-other]")`);
	expect(await ev(`document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=fix-other]").textContent`)).toContain("다른 기기에서 쓴 글");
	expect(await ev(`document.querySelector("#mon-timeline [data-ref=RBBBBBB] [data-k=fix-text]").value`)).toBe("내가 쓴 글");
});
