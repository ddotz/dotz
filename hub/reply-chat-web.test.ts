// A send approval in a conversation is the one reply card in the message itself (design 4.4, lane U4): the dock holds no draft, and a decision that
// is not a send approval keeps its own card.
import { afterAll, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const REF = "RQCHAT1";
const item = { item: `mail:${REF}`, ref: REF, kind: "mail", app: "mail", label: "메일", conv: "web", at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "자료는 금요일까지 드릴게요." }, original: { who: "김팀장", text: "자료 되나요?" } };
const draftMsg = { ts: new Date(NOW - 2000).toISOString(), kind: "out", source: "orchestrator", target: "web", text: `[ask] 메일 답장 초안이에요\n${draftApprovalBlock({ to: "kim@example.com", toLabel: "받는이", body: "자료는 금요일까지 드릴게요.", ref: REF, question: "이 답장 보낼까요?" })}` };
const history: unknown[] = [draftMsg];
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/state") return json({ name: "땅콩", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/reply/queue") return json({ items: [item], counts: {}, triageMin: 3, undoSec: 10 });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
	},
});
const view = await hub.view({ width: 1280, height: 900, console: () => undefined });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const open = async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S && RA.loaded`);
	await run(`openTarget("main", "chat")`);
};

test("a draft message draws the one card in the message and the dock holds no draft", async () => {
	await open();
	await waitFor(`!!document.querySelector("#timeline .ra-inl .ra-card")`);
	expect(await ev(`document.querySelector("#timeline .ra-inl .ra-card").dataset.ref`)).toBe(REF);
	expect(await ev(`!!document.querySelector("#dcard .dr-send")`)).toBe(false);
});

test("a decision that is not a send approval keeps its own card", async () => {
	expect(await ev(`raInline([{ title: "어느 쪽으로 할까요?", options: [{ n: 1, label: "오전" }, { n: 2, label: "오후" }] }]) === null`)).toBe(true);
	expect(await ev(`raInline([{ title: "이 답장 보낼까요? (${REF})", options: ["보내기", "고치기", "보내지 않기"].map((label, i) => ({ n: i + 1, label })) }]) !== null`)).toBe(true);
});
