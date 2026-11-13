// The mail conversation's draft card over the one reply queue (design 4.4, lane U5): its actions are the queue's, 직접 수정 posts `edit` with the typed
// text as written (no "이 내용으로 고쳐 주세요" for the model), and a failed send shows its reason in the card.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const REF = "RMAIL01";
const item = (o: Record<string, unknown> = {}) => ({ item: `mail:${REF}`, ref: REF, kind: "mail", app: "mail", label: "메일", conv: "mail:k1", at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "자료는 금요일까지 드릴게요." }, ...o });
let queue = [item()];
const posts: Record<string, unknown>[] = [];
let posted: () => void = () => undefined;
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 3, undoSec: 10 });
		if (req.method === "POST" && url.pathname === "/api/reply/act") {
			posts.push((await req.json()) as Record<string, unknown>);
			posted();
			return json({ ok: true });
		}
	},
});
const view = await hub.view({ width: 1280, height: 900, console: () => undefined });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const notice = { id: "n1", kind: "decision", title: `이 답장 보낼까요? (${REF})`, ts: new Date(NOW).toISOString(), text: "", decision: { to: "mail:k1", state: "open", options: ["보내기", "고치기", "보내지 않기"].map((label, i) => ({ n: i + 1, label })), draft: { ref: REF, toLabel: "받는이", to: "kim@example.com", body: "자료는 금요일까지 드릴게요." } } };
const mount = () => run(`const box = document.getElementById("mp-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "mp-test" })); box.replaceChildren(draftCardNode(${JSON.stringify(notice)}))`);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof draftCardNode === "function" && RA.loaded`);

test("직접 수정 opens the draft as a field and 이대로 보내기 posts edit with the typed text as written", async () => {
	await mount();
	expect(await ev(`document.querySelector("#mp-test .rq").dataset.ref`)).toBe(REF);
	await run(`document.querySelector("#mp-test [data-k=manual]").click()`);
	await waitFor(`!!document.querySelector("#mp-test .ra-edit")`);
	await run(`const f = document.querySelector("#mp-test .ra-edit"); f.value = "금요일 오전까지 드릴게요."; f.dispatchEvent(new Event("input"))`);
	const p = new Promise<void>(r => (posted = r));
	await run(`document.querySelector("#mp-test [data-k=edit-send]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: REF, action: "edit", text: "금요일 오전까지 드릴게요.", send: true });
});

test("a failed send shows its reason and the server's buttons in the card", async () => {
	queue = [item({ send: { state: "failed", at: NOW, reason: { code: "offline", text: "인터넷에 연결되지 않았어요" }, safeToAuto: false, attempts: 1, actions: ["retry"] } })];
	await run(`raLoad()`);
	await waitFor(`RA.items.get("${REF}") && RA.items.get("${REF}").send`);
	await mount();
	expect(await ev(`document.querySelector("#mp-test .rq-send.failed .rq-why").textContent`)).toContain("인터넷에 연결되지 않았어요");
	expect(await ev(`!!document.querySelector("#mp-test .rq-send.failed [data-k=retry]")`)).toBe(true);
});
