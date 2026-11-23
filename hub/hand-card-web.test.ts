import { afterAll, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = new Date().toISOString();
const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
const BODY1 = ["안녕하세요, Kim님.", "fileA.xlsx 첨부합니다.", "감사합니다."];
const BODY2 = ["안녕하세요, Kim님.", "fileA.xlsx 수정본 첨부합니다.", "일정은 금요일이에요.", "감사합니다."];
const BODY3 = ["Kim님, 수정본이에요.", "fileA.xlsx 확인 부탁드려요."];
const BODY4 = ["Kim님, 다시 보내요.", "제목은 그대로예요.", "fileA.xlsx 다시 확인해 주세요."];

const card = { id: "n-hand-1", ref: "hand-3", state: "open", body: BODY1 };
const notice = () => ({ id: card.id, ts: NOW, updated: NOW, kind: "decision", tone: "ask", title: `메일 보낼까요? (${card.ref})`, text: `> 받는이: Kim <kim@example.com>\n> 제목: RE: 제목A\n>\n${card.body.map(l => `> ${l}`).join("\n")}\n메일 보낼까요? (${card.ref})`, open: "web", src: "web", at: NOW, read: false,
	decision: { options: OPTS, to: "web", reply_to: NOW, group: 1, state: card.state, draft: { toLabel: "받는이", to: "Kim <kim@example.com>", subject: "RE: 제목A", body: card.body.join("\n"), ref: card.ref } } });
const queueItem = () => ({ item: `card:web|${card.ref}`, ref: card.ref, kind: "card", app: "card", label: "메일 보낼까요?", conv: "web", notice: card.id, at: Date.now(), can: { send: true, revise: true, edit: false, drop: true, restore: false },
	draft: { state: "pending", toLabel: "받는이", to: "Kim <kim@example.com>", subject: "RE: 제목A", text: card.body.join("\n") } });
const other = { id: "n-other-1", ts: NOW, updated: NOW, kind: "alert", tone: "info", title: "점검이 끝났어요", text: "점검이 끝났어요", open: "web", src: "web", at: NOW, read: false };
const askOnly = { id: "n-other-2", ts: NOW, updated: NOW, kind: "decision", tone: "ask", title: "어느 쪽으로 할까요?", text: "어느 쪽으로 할까요?", open: "web", src: "web", at: NOW, read: false, decision: { options: [{ n: 1, label: "오전", desc: "", rec: false }, { n: 2, label: "오후", desc: "", rec: false }], to: "web", reply_to: NOW, group: 2, state: "open" } };

let queueGets = 0;
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ items: [notice()], unread: 1 });
		if (url.pathname === "/api/reply/queue") {
			queueGets++;
			return json({ items: card.state === "open" ? [queueItem()] : [], counts: {}, triageMin: 3, undoSec: 10 });
		}
	},
});
const view = await hub.view({ width: 1280, height: 900, console: () => undefined });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

const reload = () => view.evaluate(`rqLoad().then(() => 0)`);
const wait = (ms: number) => view.evaluate(`new Promise(r => setTimeout(r, ${ms})).then(() => 0)`);
const event = (n: object) => run(`noticeLive({ kind: "notice", item: ${JSON.stringify(n)} })`);
const sheetLines = () => ev<string[] | null>(`(() => { const b = document.querySelector(".rq-sheet .rq-text"); return b ? b.innerText.split("\\n") : null; })()`);
const openSheet = async () => {
	await run(`ntDraftSheet(NT.items.find(n => n.id === ${JSON.stringify(card.id)}))`);
	await waitFor(`!!document.querySelector(".rq-sheet .rq-text")`);
};
const closeSheet = () => run(`if (RQ.sheet) RQ.sheet.close(false)`);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof noticeLive === "function" && RA.loaded && NT.loaded && NT.items.some(n => n.id === ${JSON.stringify(card.id)})`);

test("a notice rewritten under the same ref: its sheet shows the new body, line for line", async () => {
	expect(await ev(`RA.items.get("hand-3").draft.text`)).toBe(BODY1.join("\n"));
	card.body = BODY2;
	await event(notice());
	await waitFor(`RA.items.get("hand-3")?.draft.text === ${JSON.stringify(BODY2.join("\n"))}`, 3000);
	expect(await ev(`RA.items.get("hand-3").draft.text`)).toBe(BODY2.join("\n"));
	await openSheet();
	expect(await sheetLines()).toEqual(BODY2);
	await closeSheet();
});

test("a 답장 확인 sheet open when the notice is rewritten never keeps the old body", async () => {
	card.body = BODY2;
	await reload();
	await openSheet();
	expect(await sheetLines()).toEqual(BODY2);
	card.body = BODY3;
	await event(notice());
	await waitFor(`!RQ.sheet || document.querySelector(".rq-sheet .rq-text")?.innerText.includes(${JSON.stringify(BODY3[0])})`, 3000);
	const lines = await sheetLines();
	expect(lines === null || lines.join("\n") === BODY3.join("\n")).toBe(true);
	expect(lines === null ? "" : lines.join("\n")).not.toContain(BODY2[1]);
	await closeSheet();
});

test("a notice that moves to a new ref leaves only the new ref in the queue, and its sheet shows the new body", async () => {
	card.ref = "hand-4";
	card.body = BODY4;
	await event(notice());
	await waitFor(`RA.items.has("hand-4") && !RA.items.has("hand-3")`, 3000);
	expect(await ev(`[...RA.items.keys()]`)).toEqual(["hand-4"]);
	await openSheet();
	expect(await sheetLines()).toEqual(BODY4);
	await closeSheet();
});

test("a new open draft notice whose ref the queue does not hold reads the queue", async () => {
	card.ref = "hand-5";
	card.id = "n-hand-2";
	await run(`NT.items.push(${JSON.stringify(notice())})`);
	await event(notice());
	await waitFor(`RA.items.has("hand-5")`, 3000);
	expect(await ev(`[...RA.items.keys()]`)).toEqual(["hand-5"]);
});

test("a notice that matches no card of the queue and holds no new draft reads no queue; one that does reads it once", async () => {
	await wait(600);
	const before = queueGets;
	await event(other);
	await event(askOnly);
	await wait(1000);
	expect(queueGets).toBe(before);
	await event(notice());
	await event(notice());
	await wait(1200);
	expect(queueGets).toBe(before + 1);
});

test("a notice that closes leaves no card in the queue and nothing waiting", async () => {
	expect(await ev(`rqWaiting()`)).toBe(1);
	card.state = "answered";
	await event(notice());
	await waitFor(`rqWaiting() === 0 && RA.items.size === 0`, 3000);
	expect(await ev(`rqWaiting()`)).toBe(0);
	expect(await ev(`[...RA.items.keys()]`)).toEqual([]);
});

test("a quoted draft keeps the indentation of every line and no line is added", async () => {
	const src = "> 받는이: Kim <kim@example.com>\n>\n> 1. 항목\n>  - 하위 줄\n>   · 더 깊은 줄";
	const lines = await ev<string[]>(`(() => {
		const box = document.body.appendChild(el("div", { class: "md" }));
		box.innerHTML = mdHtml(${JSON.stringify(src)});
		const q = box.querySelector("blockquote"), out = q.innerText.split("\\n");
		box.remove();
		return out;
	})()`);
	expect(lines).toEqual(src.split("\n").map(l => l.slice(2)));
});

test("a hand-written card whose ref has dashes is the reply card in its chat message, not a past decision", async () => {
	const ref = "hand-reply-20261123-4";
	const draft = { toLabel: "받는이", to: "Kim <kim@example.com>", subject: "RE: 제목A" };
	const message = { ts: NOW, kind: "out", source: "orchestrator", target: "web", text: `[ask] 초안을 고쳤어요.\n${draftApprovalBlock({ ...draft, body: BODY1.join("\n"), ref, question: "메일 보낼까요?" })}` };
	const item = { ...queueItem(), item: `card:web|${ref}`, ref, draft: { state: "pending", ...draft, text: BODY1.join("\n") } };
	const chat = fakeHub({
		api: (_req, url) => {
			if (url.pathname === "/api/reply/queue") return json({ items: [item], counts: {}, triageMin: 3, undoSec: 10 });
			if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? [message] : [] });
		},
	});
	try {
		const page = await chat.view({ width: 1280, height: 900, console: () => undefined });
		const at = on(page);
		await page.navigate(`${chat.origin}/`);
		await at.waitFor(`typeof openTarget === "function" && S && RA.loaded`);
		await at.run(`openTarget("main", "chat")`);
		await at.waitFor(`!!document.querySelector("#timeline .ra-inl .ra-card, #timeline .dc-inl")`);
		expect(await at.ev(`document.querySelector("#timeline .ra-inl .ra-card")?.dataset.ref ?? null`)).toBe(ref);
		expect(await at.ev(`document.querySelectorAll("#timeline .dc-inl").length`)).toBe(0);
		expect(await at.ev(`[...document.querySelectorAll("#timeline .ra-inl .rq-acts [data-k]")].map(b => b.dataset.k)`)).toEqual(["send", "fix", "drop"]);
	} finally {
		chat.stop();
	}
});
