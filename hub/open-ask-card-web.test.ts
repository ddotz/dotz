import { afterAll, describe, expect, test } from "bun:test";
import { decisionsOf } from "./notices.ts";
import { LOAD_QA_ASK, PEER_STATUS } from "./ask-normalize.fixture.ts";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// An open [ask] keeps its dock card and buttons whatever follows it, until the owner answers. Headless, against fixture history and notices.
const ASK_AT = "2026-11-05T03:47:48.784Z";
const ask = (text: string) => ({ ts: ASK_AT, kind: "out", source: "orchestrator", target: "chat", text });
const bot = (ts: string, text: string) => ({ ts, kind: "out", source: "orchestrator", target: "web", text });
const peer = { ts: "2026-11-05T03:51:10.699Z", ...PEER_STATUS };
const noticesOf = (e: ReturnType<typeof ask>) => decisionsOf(e).map((d, i) => ({ id: `n${i}`, ts: e.ts, updated: e.ts, kind: "decision", tone: "ask", title: d.title, text: d.detail, open: d.to, src: d.to, at: e.ts, key: d.key, by: "orchestrator", read: false, decision: { options: d.options, to: d.to, reply_to: e.ts, group: d.group, state: "open" } }));

let events: unknown[] = [];
type Notice = ReturnType<typeof noticesOf>[number];
let items: unknown[] = [];
const answers: unknown[] = [];
const hub = fakeHub({
	state: idleState({ name: "땅콩" }),
	api: async (req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? events : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: items.length, items });
		if (/^\/api\/notices\/[^/]+\/answer$/.test(url.pathname)) {
			answers.push({ path: url.pathname, ...(await req.json()) });
			const item = (items as Notice[]).find(n => url.pathname.includes(`/${n.id}/`))!;
			items = [];
			return json({ ok: true, unread: 0, item: { ...item, read: true, decision: { ...item.decision, state: "answered" } } });
		}
	},
});
const view = await hub.view();
afterAll(() => hub.stop());
const { waitFor } = on(view);

const open = async (rows: number) => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await view.evaluate(`(openTarget("main", "chat"), 0)`);
	await waitFor(`document.body.textContent.includes("여러 앱 전체 점검") && document.querySelectorAll("#dcard .dc-row").length === ${rows}`, 2000);
	return view.evaluate(`[...document.querySelectorAll("#dcard .dc-row")].filter(b => !b.disabled).map(b => b.querySelector(".dc-lb").textContent).join("|")`);
};

describe("an open [ask] followed by other messages", () => {
	test("the exact two-decision [ask] keeps both decisions on the card after bot messages and a peer message", async () => {
		const e = ask(LOAD_QA_ASK);
		events = [e, bot("2026-11-05T03:51:05.000Z", "맥북도 재시작했어요."), peer, bot("2026-11-05T03:51:15.377Z", "두 기기가 맞아요.")];
		items = noticesOf(e);
		expect(await open(4)).toBe("앱별 상한 두기|지금처럼 전부 쓰기|앱마다 따로 배우기|한 말투로 같이 쓰기");
	});

	test("a one-decision [ask] keeps its card after a bot message and is answered through its notice", async () => {
		const e = ask(LOAD_QA_ASK.slice(0, LOAD_QA_ASK.indexOf("결정 2:")).replace("결정 1:", "결정:"));
		events = [e, bot("2026-11-05T03:51:15.377Z", "두 기기가 맞아요.")];
		items = noticesOf(e);
		expect(await open(2)).toBe("앱별 상한 두기|지금처럼 전부 쓰기");
		await view.evaluate(`(document.querySelector("#dcard .dc-row").click(), 0)`);
		await waitFor(`document.querySelector("#dcard").hidden`, 2000);
		expect(answers).toEqual([{ path: "/api/notices/n0/answer", n: 1, label: "앱별 상한 두기" }]);
	});

	test("a peer message is not the owner's answer: the message's own card stays when no notice is loaded", async () => {
		events = [ask(LOAD_QA_ASK), peer];
		items = [];
		expect(await open(4)).toBe("앱별 상한 두기|지금처럼 전부 쓰기|앱마다 따로 배우기|한 말투로 같이 쓰기");
	});

	test("once the owner answers, the card goes away", async () => {
		const e = ask(LOAD_QA_ASK);
		events = [e, { ts: "2026-11-05T03:52:00.000Z", kind: "message", source: "web", channel: "web", text: "1번으로 해" }];
		items = [];
		await open(0);
		expect(await view.evaluate(`document.querySelector("#dcard").hidden`)).toBe(true);
	});
});
