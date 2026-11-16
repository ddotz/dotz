// The mail conversation's draft card over the one reply queue (design 4.4, lane U5; reply clarity Amendments A and B): a draft the queue holds is the queue's own card with
// the mail's parts from its notice (the folded 받는이, the 첨부 줄), which are only read there; 고치기 opens them in the panel, whose 반영 posts `edit` with the typed text as
// written and sends nothing. A mail that is not on the page is never quoted by the draft's own subject, and a failed send shows its reason in the card.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const REF = "RMAIL01";
const item = (o: Record<string, unknown> = {}) => ({ item: `mail:${REF}`, ref: REF, kind: "mail", app: "mail", label: "메일", conv: "mail:k1", at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", subject: "Re: 자료 요청", text: "자료는 금요일까지 드릴게요.", hash: `${REF}-v1` }, ...o });
let queue = [item()];
const posts: Record<string, unknown>[] = [];
let posted: () => void = () => undefined;
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 3, undoSec: 10 });
		if (url.pathname === `/api/drafts/${REF}/recipients`) return json({ to: ["kim@example.com"], cc: [], mode: "reply", editable: true, reply: true });
		if (url.pathname === `/api/drafts/${REF}/files`) return json({ files: [{ name: "견적서.pdf", size: "120KB" }], canAttach: true, library: false, editable: true, tracked: true, attachIssues: [] });
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
const notice = { id: "n1", kind: "decision", title: `이 답장 보낼까요? (${REF})`, ts: new Date(NOW).toISOString(), text: "", decision: { to: "mail:k1", state: "open", options: ["보내기", "고치기", "보내지 않기"].map((label, i) => ({ n: i + 1, label })), draft: { ref: REF, toLabel: "받는이", to: "kim@example.com", subject: "Re: 자료 요청", body: "자료는 금요일까지 드릴게요." } } };
const mount = () => run(`const box = document.getElementById("mp-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "mp-test" })); box.replaceChildren(draftCardNode(${JSON.stringify(notice)}))`);
const EDITABLE_ROW_CONTROLS = ".dr-rc-add, .dr-rc-x, button.dr-rc-t, .dr-files .dr-x, .dr-files .dr-add, .dr-seg button:not([disabled])";

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof draftCardNode === "function" && RA.loaded`);

test("a draft the queue holds is the queue's card with the three actions and the mail's 받는이 and 첨부 rows from its notice, which are only read there", async () => {
	await mount();
	await waitFor(`!!document.querySelector("#mp-test .dr-files .dr-fn")`);
	expect(await ev(`(() => { const c = document.querySelector("#mp-test .ra-card"); return { ref: c.dataset.ref, nid: c.dataset.nid, mail: c.classList.contains("rq-ml"), recv: !!c.querySelector(".rq-recvfold .rq-recv"), files: [...c.querySelectorAll(".dr-files .dr-fn")].map(n => n.textContent), keys: [...c.querySelectorAll(".rq-acts [data-k]")].map(b => b.dataset.k) }; })()`))
		.toEqual({ ref: REF, nid: "n1", mail: true, recv: true, files: ["견적서.pdf"], keys: ["send", "fix", "drop"] });
	await run(`document.querySelector("#mp-test .rq-recv").click()`);
	expect(await ev(`[document.querySelector("#mp-test .rq-recvbox").hidden, [...document.querySelectorAll("#mp-test .dr-rcrow[data-row=to] .dr-rc-t")].map(n => n.textContent), document.querySelectorAll("#mp-test ${EDITABLE_ROW_CONTROLS}").length]`)).toEqual([false, ["kim@example.com"], 0]);
});

test("the mail is not on the page: the card offers 원문 보기 and does not quote the draft's own subject as the original", async () => {
	await mount();
	expect(await ev(`(() => { const c = document.querySelector("#mp-test .ra-card"); return [MAILS.has("mail:k1"), !!c.querySelector(".rq-orig"), !!c.querySelector(".rq-og"), c.querySelector(".rq-sub").textContent]; })()`)).toEqual([false, false, true, "Re: 자료 요청"]);
});

test("고치기 opens the rows and the text in the panel, and 반영 posts edit with the typed text as written, with no send", async () => {
	await mount();
	await run(`document.querySelector("#mp-test [data-k=fix]").click()`);
	await waitFor(`!!document.querySelector("#mp-test [data-k=fix-text]") && !!document.querySelector("#mp-test .dr-recv [data-row=to] .dr-rc-add") && !!document.querySelector("#mp-test .dr-files .dr-x")`);
	expect(await ev(`[!!document.querySelector("#mp-test .rq-recvfold"), !!document.querySelector("#mp-test [data-k=send]"), document.querySelector("#mp-test [data-k=fix-subject]").value]`)).toEqual([false, false, "Re: 자료 요청"]);
	await run(`const f = document.querySelector("#mp-test [data-k=fix-text]"); f.value = "금요일 오전까지 드릴게요."; f.dispatchEvent(new Event("input"))`);
	const p = new Promise<void>(r => (posted = r));
	await run(`document.querySelector("#mp-test [data-k=fix-apply]").click()`);
	await p;
	expect(posts).toEqual([{ ref: REF, action: "edit", text: "금요일 오전까지 드릴게요.", hash: "RMAIL01-v1" }]);
	await waitFor(`!RA.fix.has("${REF}") && !!document.querySelector("#mp-test [data-k=send]")`);
});

test("a failed send shows its reason and the server's buttons in the card, and 다시 보내기 carries the hash of the version shown", async () => {
	queue = [item({ send: { state: "failed", at: NOW, reason: { code: "offline", text: "인터넷에 연결되지 않았어요" }, safeToAuto: false, attempts: 1, actions: ["retry"] } })];
	await run(`raLoad()`);
	await waitFor(`RA.items.get("${REF}") && RA.items.get("${REF}").send`);
	await mount();
	expect(await ev(`document.querySelector("#mp-test .rq-send.failed .rq-why").textContent`)).toContain("인터넷에 연결되지 않았어요");
	expect(await ev(`[...document.querySelectorAll("#mp-test .rq-send.failed [data-k]")].map(b => b.dataset.k)`)).toEqual(["retry", "fix", "drop"]);
	const p = new Promise<void>(r => (posted = r));
	await run(`document.querySelector("#mp-test [data-k=retry]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: REF, action: "retry", hash: `${REF}-v1` });
});
