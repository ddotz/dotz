import { afterAll, expect, test } from "bun:test";
import { fakeHub, idleState, inbox, json, waitFor, ev, run, type View } from "./test-web.ts";

// 고치기 of a reply draft that a later message pushed out of the docked card (owner 2026-11-03: the options live only in the card, so the
// dock keeps one 답 대기 row that opens the notice sheet). 고치기 there must still open the "어떻게 고칠까요?" field first and send nothing,
// since the hub refuses a draft 고치기 without the change (notices.ts answerDecision). Shapes from the live channel of 2026-10-30
// (names and texts are placeholders).
const CH = "ch:7001";
const AT = "2026-10-30T12:19:13.516Z";
const CARD = [
	"[ask] 유튜브 댓글 답글 - 영상 제목",
	"원댓글(@viewer, 10/29쯤): 좋아요",
	"메일 대조: 못 찾음.",
	"",
	"> 대상: 유튜브 @viewer 댓글",
	">",
	"> 감사합니다",
	"결정: 이대로 보낼까? (youtube:c1)",
	"**1) 보내기**",
	"유튜브 @viewer 댓글에 이 글을 그대로 보내요",
	"**2) 고치기 …**",
	"어떻게 고칠지 알려 주면 고쳐서 다시 물어봐요",
	"**3) 보내지 않기**",
	"이 초안은 버려요",
].join("\n");
const notice = {
	id: "n1", ts: AT, updated: AT, kind: "decision", tone: "ask", title: "이대로 보낼까? (youtube:c1)", text: CARD.slice(6), open: CH, src: CH, at: AT, key: "dec:c1", by: "orchestrator", read: true,
	decision: {
		options: [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }],
		to: CH, reply_to: AT, group: 1, state: "open",
		draft: { toLabel: "대상", to: "유튜브 @viewer 댓글", body: "감사합니다", ref: "youtube:c1" },
	},
};
const events = [
	{ ts: AT, kind: "out", source: "orchestrator", target: CH, text: CARD },
	{ ts: "2026-10-30T12:19:23.780Z", kind: "out", source: "orchestrator", target: CH, text: "[done] 카드에 메일 대조 줄을 넣었어." },
];
const answers = inbox<{ path: string; body: unknown }>();
const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/state") return json(idleState({ channels: { work: { "7001": { name: "유튜브" } } } }));
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === CH ? events : [] });
		if (p === "/api/notices" && req.method === "GET") return json({ unread: 0, items: [notice] });
		if (/^\/api\/notices\/[^/]+\/answer$/.test(p) || p === "/api/message") {
			answers.push({ path: p, body: await req.json() });
			return json({ error: "무엇을 고칠지 적어 주세요" }, 400);
		}
	},
});
afterAll(() => hub.stop());

test("a draft that left the dock answers through its 답 대기 row, and 고치기 opens the change field and sends nothing", async () => {
	const v: View = await hub.view({ width: 390, height: 844 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof S !== "undefined" && S && NT.items.length`);
	await run(v, `go("chat", ${JSON.stringify(CH)})`);
	await waitFor(v, `target === ${JSON.stringify(CH)} && document.querySelector("#dcard .dc-wait")`);
	expect(await ev(v, `!!DC.cur`)).toBe(false);   // the [done] after the draft: no docked question, no option rows in the body
	expect(await ev(v, `document.querySelectorAll("#tl .dcm-row").length`)).toBe(0);
	await run(v, `document.querySelector("#dcard .dc-wait").click()`);
	await waitFor(v, `document.querySelectorAll(".fs-ft .dc-act").length === 3`);
	await run(v, `[...document.querySelectorAll(".fs-ft .dc-act")].find(b => b.textContent === "고치기").click()`);
	await waitFor(v, `document.querySelector(".fs-ft .dc-note")`);
	expect(answers).toEqual([]);
	await run(v, `const ta = document.querySelector(".fs-ft .dc-note"); ta.value = "더 짧게"; ta.dispatchEvent(new Event("input"))`);
	await run(v, `document.querySelector(".fs-ft .dc-go").click()`);
	const got = await answers.until(a => a.length > 0, 10_000, "the 고치기 answer");
	expect(got[0]!.path).toBe("/api/notices/n1/answer");
	expect(got[0]!.body).toMatchObject({ n: 2, note: "더 짧게" });
}, 30_000);
