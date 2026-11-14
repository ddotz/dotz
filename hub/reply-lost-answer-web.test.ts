// A press whose answer never comes back (issue #5: Safari "Load failed" on a phone, the mail went out 14 s later): 빠른 처리 counts the send at once and moves
// on while the request goes behind; the queue is read again on a lost answer, an item the hub took stays sent, and only an item still waiting comes back
// as failed in the rail with one toast. A refusal comes back the same way with its reason. The fetch rejects with no status, as a lost answer does.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const item = (ref: string, at: number, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: `초안 ${ref}` }, original: { who: `사람${ref.slice(-1)}`, text: "자료 되나요?" }, ...o });
const taken = new Set<string>();
const REFUSED = "RCCCCC3";
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: [item("RCCCCC3", NOW - 3000), item("RAAAAA1", NOW - 2000), item("RBBBBB2", NOW - 1000)].map(i => (taken.has(i.ref) ? { ...i, send: { state: "undo", at: NOW, until: Date.now() + 10_000, actions: [] } } : i)), counts: {}, triageMin: 1, undoSec: 10 });
		if (req.method === "POST" && url.pathname === "/api/reply/act") {
			const b = (await req.json()) as Record<string, unknown>;
			if (b.ref === REFUSED) return json({ error: "받는 사람 주소가 없어요" }, 409);
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
// Every /api/reply/act waits on the gate until the test opens it. __lose: "hub" posts and then loses the answer; "none" loses it before the hub hears anything.
await run(`window.__lose = ""; window.__hold = () => { window.__gate = new Promise(r => (window.__open = r)); }; window.__hold();
const f0 = window.fetch; window.fetch = async (p, o) => {
  if (!String(p).includes("/api/reply/act")) return f0(p, o);
  const how = window.__lose; window.__lose = "";
  await window.__gate;
  if (how === "hub") await f0(p, o);
  if (how) throw new TypeError("Load failed");
  return f0(p, o);
};
window.__toasts = []; const t0 = toast; window.toast = (m, ...r) => { window.__toasts.push(String(m)); return t0(m, ...r); };`);
await run(`go("monitoring", "replies")`);
await waitFor(`document.querySelector(".rq-fast") && !document.querySelector(".rq-fast").hidden`);
await run(`document.querySelector(".rq-fast").click()`);
await waitFor(`TQ.h && document.querySelector(".tq-body .ra-card")`);
const railSt = (ref: string) => ev<string>(`document.querySelector(".tq-r[data-ref=${ref}] .tq-st").textContent`);

test("보내기 moves on before the hub answers; the hub took it and the answer was lost: it stays sent, with no failure and no toast", async () => {
	expect(await ev(`document.querySelector(".tq-body .ra-card").dataset.ref`)).toBe("RBBBBB2");
	await run(`window.__lose = "hub"; document.querySelector(".tq-body .ra-card [data-k=send]").click()`);
	await waitFor(`document.querySelector(".tr-pos").textContent === "빠른 처리 2 / 3"`, 2000);
	expect(await ev(`RA.busy.has("RBBBBB2")`)).toBe(true);   // the request still waits on the gate
	expect(await railSt("RBBBBB2")).toBe("보내는 중…");
	await run(`window.__open()`);
	await waitFor(`!RA.busy.has("RBBBBB2")`);
	expect(taken.has("RBBBBB2")).toBe(true);
	expect(await ev(`RA.fail.has("RBBBBB2")`)).toBe(false);
	expect(await railSt("RBBBBB2")).toMatch(/초 후 보내요$/);
	expect(await ev(`window.__toasts`)).toEqual([]);
});

test("the press never reached the hub: the view has moved on, the item comes back as failed with one toast and can be pressed again", async () => {
	await run(`window.__hold()`);
	expect(await ev(`document.querySelector(".tq-body .ra-card").dataset.ref`)).toBe("RAAAAA1");
	await run(`window.__lose = "none"; document.querySelector(".tq-body .ra-card [data-k=send]").click()`);
	await waitFor(`document.querySelector(".tr-pos").textContent === "빠른 처리 3 / 3"`, 2000);
	await run(`window.__open()`);
	await waitFor(`!RA.busy.has("RAAAAA1") && RA.fail.has("RAAAAA1")`);
	expect(taken.has("RAAAAA1")).toBe(false);
	expect(await ev(`RA.fail.get("RAAAAA1").text`)).toBe("연결이 끊겨서 못 보냈어요. 다시 눌러 주세요");
	expect(await ev(`window.__toasts`)).toEqual(["연결이 끊겨서 못 보냈어요. 다시 눌러 주세요"]);
	expect(await ev(`document.querySelector(".tr-pos").textContent`)).toBe("빠른 처리 3 / 3");
	expect(await railSt("RAAAAA1")).toBe("보내지 못했어요");
	expect(await ev(`document.querySelector(".tq-r[data-ref=RAAAAA1]").classList.contains("bad")`)).toBe(true);
	await run(`document.querySelector(".tq-r[data-ref=RAAAAA1]").click()`);
	await waitFor(`document.querySelector(".tq-body .ra-card").dataset.ref === "RAAAAA1" && !document.querySelector(".tq-body .ra-card [data-k=send]").disabled`);
});

test("the hub refused the send: the item comes back as failed with the hub's reason, in one toast", async () => {
	await run(`window.__toasts = []; window.__open(); TQ.i = 2; tqPaint()`);
	expect(await ev(`document.querySelector(".tq-body .ra-card").dataset.ref`)).toBe(REFUSED);
	await run(`document.querySelector(".tq-body .ra-card [data-k=send]").click()`);
	await waitFor(`!RA.busy.has("${REFUSED}") && RA.fail.has("${REFUSED}")`);
	expect(taken.has(REFUSED)).toBe(false);
	expect(await ev(`RA.fail.get("${REFUSED}").text`)).toBe("받는 사람 주소가 없어요");
	expect(await ev(`window.__toasts`)).toEqual(["받는 사람 주소가 없어요"]);
	expect(await railSt(REFUSED)).toBe("보내지 못했어요");
});
