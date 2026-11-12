import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { answerDecision, type DecisionSend, listNotices, resetNoticesForTest, unreadCount } from "./notices.ts";
import { putDecision } from "./notices-store.ts";
import { fakeHub, idleState, inbox, json, on, type View } from "./test-web.ts";

// "직접 답하기" on a question card (web/js/30-notices.js ntDirect): the composer quotes the asking message and what the owner writes next is sent with that
// question's id, which the hub settles alone (hub/notices-store.ts ownerReplied). Cancelling the quote, moving to another conversation or quoting another
// message drops the id. Headless browser, fixture history, the real notice store; the fake hub's /api/message makes the same inbox event the route makes.
type Sent = { text: string; reply?: { id: string; content: string }; decision?: string };
const sent = inbox<Sent>();
const delivered = inbox<Parameters<DecisionSend>[0]>();
let history: unknown[] = [];
const hub = fakeHub({
	state: () => idleState({ notices_unread: unreadCount(), lanes: [{ name: "web", title: "웹", status: "idle", live: true, alive: true, home: "ch:7" }], channels: { work: { 7: "웹" } } }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices" && req.method === "GET") return json(listNotices(300));
		// A button or typed answer of the notice sheet goes through the real answerDecision; what it would hand the asking chat is recorded.
		const answering = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/answer$/.exec(p) : null;
		if (answering) {
			const r = await answerDecision(answering[1]!, await req.json(), async a => void delivered.push(a));
			return json(r.body, r.status);
		}
		if (p === "/api/message" && req.method === "POST") {
			const b = (await req.json()) as Sent;
			emit("inbox", { ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", text: b.text, ...(b.reply ? { reply: b.reply } : {}), ...(b.decision ? { decision: b.decision } : {}) });
			sent.push(b);
			return json({ ok: true });
		}
	},
});
// Each test owns its window: a test that timed out leaves an evaluate() pending in its view, and that view is closed, not handed to the next test.
let view!: View;
const waitFor = (expr: string, ms?: number) => on(view).waitFor(expr, ms);
const ev = <T = unknown>(expr: string) => on(view).ev<T>(expr);
const run = (code: string) => on(view).run(code);
afterAll(() => {
	hub.stop();
	resetNoticesForTest();
});

const T_PLAIN = "2026-11-10T09:00:00.000Z";
const T_ASK = "2026-11-10T09:05:00.000Z";
const T_OTHER = "2026-11-10T09:10:00.000Z";
const plain = { ts: T_PLAIN, kind: "out", source: "orchestrator", target: "main", text: "확인했어요" };
const ask = (at: string, text: string) => {
	const e = { ts: at, kind: "out", source: "orchestrator", target: "main", text };
	emit("outbox", e);
	history = [...history, e];
};
const ONE = "[ask] 보고서를 언제 보낼까요?\n결정: 보고서를 언제 보낼까요?\n**1) 오늘**\n**2) 내일**";
const TWO = "[ask] 두 가지를 정해 주세요\n결정 1: 파일은 어디에 둘까요?\n1) 서버\n2) 로컬\n\n결정 2: 언제 지울까요?\n1) 바로\n2) 한 달 뒤";
const decisions = () => listNotices(300).items.filter(n => n.kind === "decision").map(n => ({ id: n.id, title: n.title, at: n.decision!.reply_to, state: n.decision!.state, answer: n.decision!.answer }));
const idOf = (part: string) => decisions().find(d => d.title.includes(part))!.id;
const stateOf = (part: string) => decisions().find(d => d.title.includes(part))!.state;

beforeEach(async () => {
	resetNoticesForTest();
	history = [plain];
	sent.length = 0;
	delivered.length = 0;
	view = await hub.view({ width: 1280, height: 760 });
}, 20_000);
afterEach(() => hub.release());

// The notice's sheet opened from 알림, "직접 답하기" pressed: the chat of the asking message with the quote bar on.
let visits = 0;
const direct = async (part: string) => {
	await view.navigate(`${hub.origin}/?v=${++visits}#notices`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && document.querySelector('#v-notices .list[data-g="need"] .nsc-r')`);
	await run(`[...document.querySelectorAll('#v-notices .list[data-g="need"] .nsc-r')].find(r => r.textContent.includes(${JSON.stringify(part)})).querySelector(".nsc-tx").click()`);
	await waitFor(`document.querySelector(".ds-direct")`);
	await run(`document.querySelector(".ds-direct").click()`);
	await waitFor(`target === "main" && RP.cur && !document.querySelector("#replybar").hidden`);
};
const write = async (text: string) => {
	await run(`const t = document.querySelector("#text"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#send-btn").click()`);
	return (await sent.until(s => s.length > 0))[0]!;
};

// Each test loads the whole app into a window of its own: 20s, not the default 5s, so a busy machine running other work does not fail it.
describe("직접 답하기 on a question card", () => {
	test("the owner's words go with the question's id and the quote, and only that question closes", async () => {
		ask(T_ASK, ONE);
		ask(T_OTHER, "[ask] 폴더를 지울까요?\n결정: 폴더를 지울까요?\n**1) 지우기**\n**2) 두기**");
		await direct("보고서");
		expect(await ev<boolean>(`document.activeElement === document.querySelector("#text")`)).toBe(true);
		const body = await write("이미 완료됨");
		expect(body.decision).toBe(idOf("보고서"));
		expect(body.reply?.id).toBe(T_ASK);
		expect(stateOf("보고서")).toBe("answered");
		expect(decisions().find(d => d.title.includes("보고서"))!.answer).toBe("이미 완료됨");
		expect(stateOf("폴더")).toBe("open");
		// sent: the quote is gone and the next message carries no question
		expect(await ev<boolean>(`document.querySelector("#replybar").hidden && RP.cur === null`)).toBe(true);
	}, 20_000);

	test("of two questions in one message only the pressed one closes", async () => {
		ask(T_ASK, TWO);
		await direct("언제 지울까요");
		const body = await write("그냥 두세요");
		expect(body.decision).toBe(idOf("언제 지울까요"));
		expect(stateOf("언제 지울까요")).toBe("answered");
		expect(stateOf("파일은")).toBe("open");
	}, 20_000);

	test("cancelling the quote sends a plain message that closes nothing", async () => {
		ask(T_ASK, ONE);
		await direct("보고서");
		await run(`document.querySelector(".rp-x").click()`);
		await waitFor(`document.querySelector("#replybar").hidden`);
		const body = await write("그건 그렇고 날씨 어때?");
		expect(body.decision).toBeUndefined();
		expect(body.reply).toBeUndefined();
		expect(stateOf("보고서")).toBe("open");
	}, 20_000);

	test("moving to another conversation and coming back drops the question", async () => {
		ask(T_ASK, ONE);
		await direct("보고서");
		await run(`go("chat", "lane:web")`);
		await waitFor(`target === "lane:web"`);
		await run(`go("chat", "main")`);
		await waitFor(`target === "main" && ts("main").msgs.length > 0`);
		const body = await write("그건 그렇고 날씨 어때?");
		expect(body.decision).toBeUndefined();
	}, 20_000);

	test("quoting another message drops the question", async () => {
		ask(T_ASK, ONE);
		await direct("보고서");
		await run(`document.querySelector('[data-ts="${T_PLAIN}"] .rp-btn').click()`);
		await waitFor(`RP.cur && RP.cur.id === ${JSON.stringify(T_PLAIN)}`);
		const body = await write("그건 그렇고 날씨 어때?");
		expect(body.decision).toBeUndefined();
		expect(body.reply?.id).toBe(T_PLAIN);
		expect(stateOf("보고서")).toBe("open");
	}, 20_000);
});

// The 알림 conversation has no composer (web/js/31-conversations.js convTakesText), so a question asked there is answered in the sheet's own text field.
describe("직접 답하기 on a question asked in the 알림 conversation", () => {
	const askAlert = () => putDecision({ key: "ask:alert", title: "보고서를 보낼까요?", detail: "", to: "alert", options: [{ n: 1, label: "보내기" }, { n: 2, label: "두기" }], group: 1, replyTo: T_ASK }, T_ASK);
	const sheetDirect = async () => {
		await view.navigate(`${hub.origin}/?v=${++visits}#notices`);
		await waitFor(`typeof NT !== "undefined" && NT.loaded && document.querySelector('#v-notices .list[data-g="need"] .nsc-r')`);
		await run(`document.querySelector('#v-notices .list[data-g="need"] .nsc-r .nsc-tx').click()`);
		await waitFor(`document.querySelector('.ds-direct[data-k="direct"]')`);
		await run(`document.querySelector('.ds-direct[data-k="direct"]').click()`);
	};
	const typing = `(() => { const t = document.querySelector(".dc-note"), r = t && t.getBoundingClientRect(); return !!t && !t.disabled && !t.readOnly && r.width > 0 && r.height > 0; })()`;

	test("it opens a text field that is there to type in, and the text is that question's answer", async () => {
		askAlert();
		await sheetDirect();
		await waitFor(typing);
		expect(await ev<string>(`current`)).toBe("notices");
		await run(`const t = document.querySelector(".dc-note"); t.value = "이미 보냈어요"; t.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector('.dc-go[data-k="send"]').click()`);
		const [a] = await delivered.until(d => d.length > 0);
		await waitFor(`NT.items.some(n => n.decision && n.decision.state === "answered")`);   // the page heard the hub settle it
		const id = decisions().find(d => d.title.includes("보고서"))!.id;
		expect(a).toMatchObject({ to: "alert", text: "이미 보냈어요", replyTo: T_ASK, notice: id });
		expect(a!.picks).toBeUndefined();
		expect(stateOf("보고서")).toBe("answered");
		expect(decisions()[0]!.answer).toBe("이미 보냈어요");
	}, 20_000);

	test("an empty field sends nothing, and 돌아가기 returns to the options", async () => {
		askAlert();
		await sheetDirect();
		await waitFor(typing);
		expect(await ev<boolean>(`document.querySelector('.dc-go[data-k="send"]').disabled`)).toBe(true);
		await run(`document.querySelector('.dc-back').click()`);
		await waitFor(`document.querySelector('.ds-opt') && !document.querySelector(".dc-note")`);
		expect(delivered).toHaveLength(0);
		expect(stateOf("보고서")).toBe("open");
	}, 20_000);
});
