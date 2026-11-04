import { afterAll, describe, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { fakeHub, json, on } from "./test-web.ts";

// The chat with send approvals waiting (web/js/10-decision-card.js dcLine): one card keeps its dock card; 2 or more are ONE line above the composer
// ("답장 초안 N건 기다려요 · 확인하기", N = the 답 필요 count of 답장 대기) that opens 답장 대기, and nothing stacks in the conversation, also when ONE [ask]
// message carries several draft blocks (their notices are group > 1). A question that is not a draft keeps its dock card. Headless browser, fixture notices.
const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
const TS = "2026-11-01T08:05:00.000Z";
let notices: unknown[] = [];
let history: unknown[] = [];
let groups: unknown[] = [];
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/state") return json({ name: "땅콩", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: notices.length });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
		if (url.pathname === "/api/approvals") return json({ groups, results: [], triageMin: 3 });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ items: notices, unread: notices.length });
	},
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor, ev, run } = on(view);

const draft = (ref: string) => ({ toLabel: "받는이", to: "kim@example.com", subject: `Re: 견적 ${ref}`, body: `보내 드립니다 ${ref}`, ref });
const notice = (ref: string, group: number, at: string) => ({
	id: `n-${ref}`, ts: at, updated: at, at, kind: "decision", tone: "ask", title: `이 답장 보낼까요? (${ref})`, text: "이 답장 보낼까요?", open: "main", src: "main", read: false,
	decision: { options: OPTS, to: "main", reply_to: at, group, state: "open", draft: draft(ref) },
});
const message = (refs: string[], at: string) => ({
	ts: at, kind: "out", source: "orchestrator", target: "main",
	text: `[ask] 답장 초안이에요\n${refs.map(ref => draftApprovalBlock({ ...draft(ref), question: "이 답장 보낼까요?" })).join("\n")}`,
});
const cards = (n: number) => {
	const refs = Array.from({ length: n }, (_, i) => `R${n}x${i}`);
	notices = refs.map(ref => notice(ref, n, TS));
	groups = [];
	history = [{ ts: "2026-11-01T08:00:00.000Z", kind: "message", source: "web", channel: "web", text: "초안 만들어 줘" }, message(refs, TS)];
};
const open = async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S && NT.loaded && TR.groups !== undefined`);
	await run(`go("chat", "main")`);
	await waitFor(`target === "main" && ts("main").msgs.length > 0`);
	await run(`trLoad().then(paintDecision)`);
};

describe("the chat with send approvals waiting", () => {
	test("one card keeps its dock card and shows no line", async () => {
		cards(1);
		await open();
		await waitFor(`DC.cur && !document.querySelector("#dcard").hidden`);
		expect(await ev<boolean>(`document.querySelector("#qline").hidden`)).toBe(true);
	});

	test("one [ask] message with several draft blocks: one line with the count, no dock card, no pointer, no rows in the conversation; the line opens 답장 대기", async () => {
		cards(3);
		await open();
		await waitFor(`!document.querySelector("#qline").hidden`);
		const got = await ev<{ line: string; dock: boolean; pointer: boolean; n: number }>(`({ line: document.querySelector("#qline").textContent, dock: !document.querySelector("#dcard").hidden,
			pointer: !!document.querySelector("#dcard .dc-wait"), n: rqAskCount() })`);
		expect(got.line).toBe("답장 초안 3건 기다려요·확인하기");
		expect(got.n).toBe(3);
		expect(got.dock).toBe(false);
		expect(got.pointer).toBe(false);
		await run(`document.querySelector("#qline").click()`);
		await waitFor(`current === "monitoring" && MON.sel === "replies" && document.querySelectorAll("#mon-tl .rq-r.ask").length === 3`);
	});

	test("a question that is not a draft keeps its dock card next to the line", async () => {
		cards(2);
		history = [...history, { ts: "2026-11-01T08:10:00.000Z", kind: "out", source: "orchestrator", text: "[ask] 어느 화면으로 할까요?\n결정: 어느 화면으로 할까요?\n1) 캔버스\n2) 앱 화면" }];
		await open();
		await waitFor(`!document.querySelector("#qline").hidden && DC.cur && !document.querySelector("#dcard").hidden`);
		expect(await ev<string>(`document.querySelector("#dcard").textContent`)).toContain("어느 화면으로 할까요?");
		expect(await ev<number>(`rqAskCount()`)).toBe(2);
	});

	test("a held card of GET /api/approvals counts with the open ones", async () => {
		cards(1);
		groups = [{ key: "mail", label: "메일", count: 1, cards: [{ ref: "H1", to: "main", draft: { toLabel: "받는이", to: "lee@example.com", subject: "보류", body: "보류 초안" }, question: "보낼까요?" }] }];
		await open();
		await waitFor(`!document.querySelector("#qline").hidden`);
		expect(await ev<number>(`rqAskCount()`)).toBe(2);
		expect(await ev<string>(`document.querySelector("#qline").textContent`)).toBe("답장 초안 2건 기다려요·확인하기");
	});

	test("with 30 cards the conversation still scrolls to the very top and nothing stacks", async () => {
		cards(30);
		// A conversation long enough to scroll: what must stay reachable is its first message, not only the fold of the drafts.
		history = [...Array.from({ length: 40 }, (_, i) => ({ ts: `2026-11-01T07:${String(i + 10).padStart(2, "0")}:00.000Z`, kind: "message", source: "web", channel: "web", text: `앞선 대화 ${i}` })), ...history];
		await open();
		await waitFor(`!document.querySelector("#qline").hidden`);
		// The page holds the newest message for a moment after a load; once a scroll to the top sticks, repainting the line must not move it.
		await waitFor(`(timeline.scrollTop = 0, timeline.scrollTop === 0 && timeline.scrollHeight > timeline.clientHeight)`);
		await run(`paintDecision()`);
		const got = await ev<{ top: number; first: number; box: number; line: string; drafts: boolean }>(`(() => { const f = timeline.firstElementChild.getBoundingClientRect(); return { top: timeline.scrollTop, first: Math.round(f.top), box: Math.round(timeline.getBoundingClientRect().top), line: document.querySelector("#qline").textContent, drafts: timeline.innerText.includes("보내 드립니다") }; })()`);
		expect(got.top).toBe(0);
		expect(got.drafts).toBe(false);
		expect(got.first).toBeGreaterThanOrEqual(got.box);
		expect(got.line).toBe("답장 초안 30건 기다려요·확인하기");
	});
});
