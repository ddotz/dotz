// The chat-window audit's web items (2026-11-16) in the real page against a fake hub: every card of a ref follows its item, the 고치기 panel's edit carries the
// version it opened on and keeps the owner's text, a lost 되돌리기 is never taken for success, typed text outlives repaints, failures and a reload, and the note
// fields' keys close only the field. Every POST is recorded; nothing leaves the process.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
type Item = Record<string, unknown> & { ref: string };
const item = (ref: string, o: Record<string, unknown> = {}): Item => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "확인해 보고 말씀드릴게요.", hash: `h-${ref}` }, original: { who: "김팀장", text: "자료 되나요?" }, ...o });
const comment = (ref: string): Item => ({ ...item(ref), item: `comment:${ref}`, kind: "comment", app: "comment", label: "댓글", conv: `comment:${ref}`, draft: { state: "pending", toLabel: "댓글", to: "블로그", text: "감사합니다.", hash: `h-${ref}`, mail: { ref: `${ref}M`, to: "kim@example.com", subject: "Re: 문의", text: "메일 본문" } } });
let queue: Item[] = [item("RA1"), item("RA2"), item("RA3"), comment("RC1")];
const posts: Record<string, unknown>[] = [];
let answer: (b: Record<string, unknown>) => Response = () => json({ ok: true });
let hold: Promise<void> = Promise.resolve();
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 1, undoSec: 10 });
		if (url.pathname === "/api/reply/act" && req.method === "POST") {
			const b = (await req.json()) as Record<string, unknown>;
			posts.push(b);
			await hold;
			return answer(b);
		}
	},
});
const view = await hub.view({ width: 1280, height: 900, console: () => undefined });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const mount = (code: string) => run(`const box = document.getElementById("au-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "au-test" })); box.replaceChildren(); ${code}`);
const type = (sel: string, text: string) => run(`const f = document.querySelector(${JSON.stringify(sel)}); f.focus(); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.blur()`);
const load = async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof rqItemCard === "function" && RA.loaded`);
};
await load();

test("every card of a ref follows its item; a detached one is forgotten; next moves them all", async () => {
	await mount(`const a = document.createElement("div"), b = document.createElement("div"); a.id = "c1"; b.id = "c2"; box.append(a, b); a.append(rqItemCard(RA.items.get("RA1"))); b.append(rqItemCard(RA.items.get("RA1")))`);
	const v = (text: string, ref = "RA1") => JSON.stringify({ ...item(ref), draft: { ...(item(ref).draft as object), text } });
	await run(`raLive({ kind: "reply", ref: "RA1", item: ${v("v2")} })`);
	expect(await ev(`["c1", "c2"].map(id => document.querySelector("#" + id + " .ra-card .rq-text").textContent)`)).toEqual(["v2", "v2"]);
	await run(`document.getElementById("c2").remove(); raLive({ kind: "reply", ref: "RA1", item: ${v("v3")} })`);
	expect(await ev(`document.querySelector("#c1 .ra-card .rq-text").textContent`)).toBe("v3");
	expect(await ev(`[...RA.nodes.get("RA1")].every(r => r.node.isConnected)`)).toBe(true);
	await run(`raLive({ kind: "reply", ref: "RA1", next: "RN1", item: ${v("v4", "RN1")} })`);
	expect(await ev(`document.querySelector("#c1 .ra-card").dataset.ref`)).toBe("RN1");
	expect(await ev(`RA.nodes.has("RA1")`)).toBe(false);
});

test("the panel's edit carries the hash it opened on; 409 changed keeps the typed text; a revise elsewhere carries it to the new ref", async () => {
	await mount(`raFixOpen(RA.items.get("RA2")); box.append(rqItemCard(RA.items.get("RA2")))`);
	await type("#au-test [data-k=fix-text]", "직접 쓴 답장");
	answer = b => (b.action === "edit" ? json({ ok: false, code: "changed", error: "changed", item: { ...item("RA2"), draft: { ...(item("RA2").draft as object), text: "다른 기기", hash: "h-moved" } } }, 409) : json({ ok: true }));
	await run(`document.querySelector("#au-test [data-k=fix-apply]").click()`);
	await waitFor(`RA.fail.get("RA2") && RA.fail.get("RA2").code === "changed"`);
	expect(posts.at(-1)).toMatchObject({ ref: "RA2", action: "edit", text: "직접 쓴 답장", hash: "h-RA2" });
	expect(await ev(`document.querySelector("#au-test [data-k=fix-text]").value`)).toBe("직접 쓴 답장");
	expect(await ev(`RA.fix.get("RA2").hash`)).toBe("h-moved");
	await run(`raLive({ kind: "reply", ref: "RA2", next: "RN2", item: ${JSON.stringify(item("RN2"))} })`);
	expect(await ev(`RA.fix.get("RN2").text.reply`)).toBe("직접 쓴 답장");
	expect(await ev(`RA.fix.has("RA2")`)).toBe(false);
});

test("the panel's part survives a repaint, and the AI line comes back when the revise fails", async () => {
	answer = () => json({ ok: true }, 202);
	await mount(`raFixOpen(RA.items.get("RC1")); box.append(rqItemCard(RA.items.get("RC1")))`);
	await run(`document.querySelector("#au-test [data-k=part-mail]").click()`);
	await run(`raPaint("RC1", undefined, true)`);
	await type("#au-test [data-k=fix-note]", "더 짧게");
	await run(`document.querySelector("#au-test [data-k=fix-apply]").click()`);
	await waitFor(`!RA.fix.has("RC1")`);
	expect(posts.at(-1)).toMatchObject({ ref: "RC1", action: "revise", change: "더 짧게", part: "mail" });
	await run(`raLive({ kind: "reply", ref: "RC1", why: "모델이 답하지 않았어요" })`);
	await waitFor(`!!document.querySelector("#au-test [data-k=fix-note]")`);
	expect(await ev(`[document.querySelector("#au-test [data-k=fix-note]").value, RA.fix.get("RC1").note, RA.fix.get("RC1").part]`)).toEqual(["더 짧게", "더 짧게", "mail"]);
});

test("a 되돌리기 whose answer was lost succeeds only when the send is gone", async () => {
	await run(`window.__fetch ||= window.fetch; window.fetch = (u, o) => String(u).includes("/api/reply/act") ? Promise.reject(new TypeError("Load failed")) : window.__fetch(u, o)`);
	queue = queue.map(i => (i.ref === "RA3" ? { ...i, send: { state: "sending", at: NOW, actions: [] } } : i));
	await run(`raAct(RA.items.get("RA3"), "undo").then(ok => { window.__undo = ok; })`);
	await waitFor(`window.__undo === false`);
	expect(await ev(`RA.fail.get("RA3").text === TX("reply.undo_net")`)).toBe(true);
	queue = queue.map(i => (i.ref === "RA3" ? item("RA3") : i));
	await run(`window.__undo = null; raAct(RA.items.get("RA3"), "undo").then(ok => { window.__undo = ok; })`);
	await waitFor(`window.__undo === true`);
	await run(`window.fetch = window.__fetch`);
});

test("the KakaoTalk request bar gets its text back when the change is refused", async () => {
	answer = () => json({ ok: false, error: "no" }, 422);
	await run(`KK.open = "room1"; KK.pc = null; KK.drafting = null; KK.drafts = [{ created: 1, code: "RA3" }]; kkAskBot("더 다정하게")`);
	await waitFor(`kkTa.value === "더 다정하게"`);
	expect(posts.at(-1)).toMatchObject({ ref: "RA3", action: "revise", change: "더 다정하게" });
});

test("Esc in a card's note field closes the field, not the sheet; Cmd+Enter is its button", async () => {
	await run(`window.__pick = pickOption; pickOption = (...a) => { window.__picked = a.slice(2); }; const h = fsOpen({ label: "t" }); window.__h = h; DC.edit.k9 = { bi: 0, opt: { n: 2, label: "안 됨" } }; DC.note.k9 = "이유"; h.box.append(editNode({ key: "k9" }, DC.edit.k9, ""))`);
	const key = (k: string, meta = false) => run(`window.__h.box.querySelector(".dc-note").dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", metaKey: ${meta}, bubbles: true, cancelable: true }))`);
	await key("Enter", true);
	expect(await ev(`window.__picked`)).toEqual([{ n: 2, label: "안 됨" }, "이유"]);
	await key("Escape");
	expect(await ev(`[FS.includes(window.__h), "k9" in DC.edit]`)).toEqual([true, false]);
	await run(`raFixOpen(RA.items.get("RA3")); window.__h.box.append(rqItemCard(RA.items.get("RA3"))); window.__h.box.querySelector("[data-k=fix-text]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
	expect(await ev(`[FS.includes(window.__h), RA.fix.has("RA3")]`)).toEqual([true, false]);
	await run(`pickOption = window.__pick; window.__h.close()`);
});

test("a refused answer keeps the typed reason and opens its field again", async () => {
	await run(`window.__send = sendMsgOut; sendMsgOut = () => Promise.reject(new Error("offline")); DC.note.k6 = "이유가 있어요"; pickOption({ key: "k6", t: "main", blocks: [{ title: "q", options: [{ n: 1, label: "좋아" }, { n: 2, label: "안 됨" }] }] }, 0, { n: 2, label: "안 됨" }, "이유가 있어요")`);
	await waitFor(`!DC.st.k6 && !!DC.edit.k6`);
	expect(await ev(`[DC.note.k6, DC.edit.k6.opt.n]`)).toEqual(["이유가 있어요", 2]);
	await run(`sendMsgOut = window.__send`);
});

test("decision text mirrors the hub: a doubled head is one head, 아니요 answers at once", async () => {
	expect(await ev(`parseChoices("결정: [ask] 결정: 고를까요?\\n**1) 네**\\n**2) 아니요**").blocks[0].title`)).toBe("고를까요?");
	expect(await ev(`[detailOf({ label: "아니요" }), detailOf({ label: "다른 날로" }), detailOf({ label: "안 됨" })]`)).toEqual([false, false, true]);
});

test("고른 것 처리 runs once: a repaint while it runs draws its button off", async () => {
	answer = () => json({ ok: true });
	let open: () => void = () => undefined;
	hold = new Promise<void>(r => (open = r));
	const before = posts.length;
	await run(`tqOpen(); TQ.list = true; for (const r of ["RA1", "RA3"]) TQ.picks[r] = { k: "send", it: RA.items.get(r) }; tqPaint(); tqGoPicked(); tqGoPicked(); tqPaint()`);
	await waitFor(`TQ.running && document.querySelector("[data-k=go-picked]").disabled`);
	open();
	await waitFor(`!TQ.running`);
	expect(posts.slice(before).filter(p => p.action === "send").map(p => p.ref)).toEqual(["RA1", "RA3"]);
	hold = Promise.resolve();
	await run(`TQ.h.close()`);
});

test("an open panel and a typed reason outlive a reload of the tab", async () => {
	await mount(`raFixOpen(RA.items.get("RA1")); box.append(rqItemCard(RA.items.get("RA1")))`);
	await type("#au-test [data-k=fix-text]", "새로 쓴 답장");
	await run(`DC.note.kr = "적던 이유"; window.dispatchEvent(new Event("pagehide"))`);
	await load();
	expect(await ev(`[RA.fix.get("RA1").text.reply, RA.fix.get("RA1").hash, DC.note.kr]`)).toEqual(["새로 쓴 답장", "h-RA1", "적던 이유"]);
	expect(await ev(`RA.fix.has("RN2")`)).toBe(false);
});
