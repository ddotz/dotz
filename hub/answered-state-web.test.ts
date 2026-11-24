import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cardBlock } from "./choices.ts";
import { emit } from "./events.ts";
import { answerDecision, type DecisionSend, listNotices, resetNoticesForTest, unreadCount } from "./notices.ts";
import { ANSWER_HOLD_MS, SessionEnded, unholdDecision } from "./notices-answers.ts";
import { watchChoice } from "./watch-ask.ts";
import { advance } from "./runtime/test-clock.ts";
import { fakeHub, idleState, inbox, json, on, type View } from "./test-web.ts";
import { msg } from "./i18n.ts";

const SUBJECTS = ["업데이트", "실패 작업", "토큰"];
const card = (subject: string) =>
	cardBlock({ subject, question: "원인을 찾아볼까요?", evidence: [`${subject} 근거 줄이에요.`], options: [{ name: "찾아봐요", result: "원인부터 찾아봐요" }, { name: "이번엔 둬요", result: "그대로 둬요" }] });
const delivered = inbox<Parameters<DecisionSend>[0]>();
const bodies: Record<string, unknown>[] = [];
let failFor: Record<string, () => Error> = {};
let likeSendWeb = false;
const send: DecisionSend = async a => {
	const fail = failFor[a.notice];
	if (fail) throw fail();
	if (likeSendWeb) {
		const heard = { ts: new Date(Date.now()).toISOString(), kind: "message", source: "web", channel: "web:alert", author: "local", text: a.text, decision: a.notice, picks: a.picks, reply_to: a.replyTo };
		history.push(heard);
		emit("inbox", heard);
	}
	delivered.push(a);
};
let history: unknown[] = [];
const hub = fakeHub({
	state: () => idleState({ notices_unread: unreadCount() }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "alert" ? history : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices" && req.method === "GET") return json(listNotices(300, true));
		const answering = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/answer$/.exec(p) : null;
		if (answering) {
			const b = await req.json();
			bodies.push(b);
			const r = await answerDecision(answering[1]!, b, send);
			return json(r.body, r.status);
		}
		const unhold = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/unhold$/.exec(p) : null;
		if (unhold) {
			const r = unholdDecision(unhold[1]!);
			return json(r.body, r.status);
		}
	},
});
let view!: View;
const waitFor = (expr: string, ms?: number) => on(view).waitFor(expr, ms);
const ev = <T = unknown>(expr: string) => on(view).ev<T>(expr);
const run = (code: string) => on(view).run(code);
afterAll(() => {
	hub.stop();
	resetNoticesForTest();
});

const ids = () => Object.fromEntries(listNotices(300).items.filter(n => n.decision).map(n => [n.title.split(" · ")[0]!, n.id])) as Record<string, string>;
const stateOf = (id: string) => listNotices(300).items.find(n => n.id === id)!.decision!.state;
let visits = 0;
beforeEach(async () => {
	resetNoticesForTest();
	delivered.length = 0;
	bodies.length = 0;
	failFor = {};
	likeSendWeb = false;
	const e = { ts: new Date(Date.now()).toISOString(), kind: "out", source: "gateway", target: "alert", text: `닥터 점검: 정할 것이 3가지 있어요.\n\n${SUBJECTS.map(card).join("\n\n")}` };
	emit("outbox", e);
	history = [e];
	view = await hub.view({ width: 390, height: 844 });
	await view.navigate(`${hub.origin}/?v=${++visits}`);
	await waitFor(`typeof noticeSheetOpen === "function" && S && NT.loaded && NT.items.filter(n => n.kind === "decision").length === 3`);
}, 20_000);
afterEach(() => hub.release());

const openSheet = async (id: string) => {
	await run(`noticeSheetOpen(${JSON.stringify(id)})`);
	await waitFor(`NS.node && NS.id === ${JSON.stringify(id)} && document.querySelector("#ds-t")`);
};
const sheet = () => ev<{ id: string; count: string | null; opts: string[]; said: string }>(`({ id: NS.id, count: (document.querySelector('.fs-hd [data-k="count"]') || {}).textContent || null,
	opts: [...document.querySelectorAll(".fs-ft .ds-opt")].map(b => b.dataset.k).filter(k => /^o[0-9]/.test(k)), said: (document.querySelector(".fs-ft .ds-res") || {}).textContent || "" })`);
const press = (sel: string) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);

describe("an answer to a plain card waits 5 seconds with 되돌리기", () => {
	test("되돌리기 inside the window reopens the card as it was and nothing reaches the asking side", async () => {
		const id = ids()["업데이트"]!;
		await openSheet(id);
		await press('.fs-ft [data-k="o1"]');
		await waitFor(`document.querySelector(".snack .sa")`);
		expect(await ev<string>(`document.querySelector(".snack span").textContent`)).toBe("업데이트 · 원인을 찾아볼까요? → 찾아봐요");
		expect(await ev<string>(`document.querySelector(".snack .sa").textContent`)).toBe("되돌리기");
		expect(delivered.length).toBe(0);
		await press(".snack .sa");
		await waitFor(`NS.id === ${JSON.stringify(id)} && document.querySelector("#ds-t").textContent.startsWith("업데이트") && document.querySelectorAll('.fs-ft .ds-opt[data-k^="o"]').length === 2`);
		expect(await sheet()).toMatchObject({ id, count: " · 남은 질문 3개", opts: ["o1", "o2"] });
		await advance(ANSWER_HOLD_MS * 2);
		expect(delivered.length).toBe(0);
		expect(stateOf(id)).toBe("open");
	}, 30_000);

	test("no 되돌리기: the answer goes out once, after the window", async () => {
		const id = ids()["업데이트"]!;
		await openSheet(id);
		await press('.fs-ft [data-k="o1"]');
		await waitFor(`document.querySelector(".snack .sa")`);
		expect(delivered.length).toBe(0);
		await advance(ANSWER_HOLD_MS);
		await delivered.until(d => d.length > 0, 10_000, "the held answer");
		await advance(ANSWER_HOLD_MS * 2);
		expect(delivered.map(d => d.notice)).toEqual([id]);
		expect(stateOf(id)).toBe("answered");
	}, 30_000);
});

describe("the cards of one message", () => {
	test("the sheet walks them in the order the message lists them, counts what is left and skips an answered one", async () => {
		const q = ids();
		expect(await ev<string[]>(`ntSibs(ntById(${JSON.stringify(q["업데이트"])})).map(n => n.id)`)).toEqual(SUBJECTS.map(s => q[s]));
		await openSheet(q["업데이트"]!);
		expect(await sheet()).toMatchObject({ count: " · 남은 질문 3개" });
		await press('.fs-ft [data-k="next"]');
		await waitFor(`NS.id === ${JSON.stringify(q["실패 작업"])}`);
		await press('.fs-ft [data-k="o2"]');
		await waitFor(`NS.id === ${JSON.stringify(q["토큰"])}`);
		expect(await sheet()).toMatchObject({ count: " · 남은 질문 2개" });
		await press('.fs-ft [data-k="next"]');
		await waitFor(`NS.id === ${JSON.stringify(q["업데이트"])}`);
		await press('.fs-ft [data-k="next"]');
		await waitFor(`NS.id === ${JSON.stringify(q["토큰"])}`);
	}, 30_000);

	test("the alert conversation shows each question once, on its own paragraph, open or answered with the option's name; an answered line opens that card with no options", async () => {
		const q = ids();
		await run(`openTarget("alert", "chat")`);
		await waitFor(`document.querySelectorAll("#tl .bm[data-dat] .dq-p").length === 3`);
		const lines = () => ev<string[][]>(`[...document.querySelectorAll("#tl .bm[data-dat] .dq-p")].map(p => [p.childNodes[0].textContent, p.querySelector(".dq-st").textContent])`);
		expect(await lines()).toEqual(SUBJECTS.map(s => [`${s} · 원인을 찾아볼까요?`, "답변 필요"]));
		const message = await ev<string>(`document.querySelector("#tl .bm[data-dat]").textContent`);
		expect(SUBJECTS.map(s => message.split(`${s} · 원인을 찾아볼까요?`).length - 1)).toEqual([1, 1, 1]);
		expect(await ev<number>(`document.querySelectorAll("#tl .dq-list").length`)).toBe(0);
		await openSheet(q["실패 작업"]!);
		await press('.fs-ft [data-k="o2"]');
		await waitFor(`document.querySelector(".snack .sa")`);
		await advance(ANSWER_HOLD_MS);
		await delivered.until(d => d.length > 0, 10_000, "the held answer");
		await run(`ntSheetClose(false)`);
		await waitFor(`!NS.node && document.querySelector("#tl .dq-p:not(.dq-open)")`);
		expect(await lines()).toEqual([["업데이트 · 원인을 찾아볼까요?", "답변 필요"], ["실패 작업 · 원인을 찾아볼까요?", "답했어요 · 이번엔 둬요"], ["토큰 · 원인을 찾아볼까요?", "답변 필요"]]);
		await press("#tl .dq-p:not(.dq-open)");
		await waitFor(`NS.node && NS.id === ${JSON.stringify(q["실패 작업"])}`);
		const s = await sheet();
		expect(s.opts).toEqual([]);
		expect(s.said).toContain("이번엔 둬요");
		expect(await ev<string>(`document.querySelector(".fs-body").textContent`)).toContain("실패 작업 근거 줄이에요.");
		await press('.fs-ft [data-k="close"]');
		await waitFor(`!NS.node`);
		await run(`noticeOpen(ntById(${JSON.stringify(q["실패 작업"])}))`);
		await waitFor(`NS.node && document.querySelector("#ds-t")`);
		expect(await ev<string>(`NS.id`)).toBe(q["실패 작업"]!);
	}, 30_000);

	test("an answered card opened again offers 다음 질문 to the cards still open", async () => {
		const q = ids();
		await answerDecision(q["실패 작업"]!, { n: 2 }, send);
		await waitFor(`ntById(${JSON.stringify(q["실패 작업"])}).decision.state === "answered"`);
		await run(`noticeOpen(ntById(${JSON.stringify(q["실패 작업"])}))`);
		await waitFor(`NS.node && NS.id === ${JSON.stringify(q["실패 작업"])}`);
		expect(await sheet()).toMatchObject({ count: " · 남은 질문 2개", opts: [] });
		await press('.fs-ft [data-k="next"]');
		await waitFor(`NS.id === ${JSON.stringify(q["토큰"])} && document.querySelectorAll('.fs-ft .ds-opt[data-k^="o"]').length === 2`);
	}, 30_000);
});

describe("while an answer is held", () => {
	test("a second answer from another tab is not reported as sent: the page names the answer that waits, stays on the card and shows it held with 되돌리기", async () => {
		const q = ids();
		await openSheet(q["업데이트"]!);
		await run(`window.__stale = ntById(${JSON.stringify(q["업데이트"])})`);
		await answerDecision(q["업데이트"]!, { n: 1, hold: true }, send);
		await run(`ntAnswer(window.__stale, window.__stale.decision.options[1])`);
		await waitFor(`document.querySelector(".snack") && !NS.busy`);
		const said = await ev<string>(`[...document.querySelectorAll(".snack")].map(s => s.textContent).join(" | ")`);
		expect(said).toContain(msg().answerHeld("찾아봐요"));
		expect(said).not.toContain("답을 보냈어요");
		await waitFor(`document.querySelector('.fs-ft [data-k="unhold"]')`);
		expect(await sheet()).toMatchObject({ id: q["업데이트"], opts: [], said: "곧 전해요1) 찾아봐요" });
		await advance(ANSWER_HOLD_MS);
		await delivered.until(d => d.length > 0, 10_000, "the first answer");
		await advance(ANSWER_HOLD_MS * 2);
		expect(delivered.map(d => d.text)).toEqual([`업데이트 · 원인을 찾아볼까요?: 1) 찾아봐요`]);
	}, 30_000);

	test("a page loaded inside the window shows the card held with its 되돌리기, which takes the answer back", async () => {
		const q = ids();
		await answerDecision(q["업데이트"]!, { n: 1, hold: true }, send);
		await view.navigate(`${hub.origin}/?v=${++visits}`);
		await waitFor(`typeof noticeSheetOpen === "function" && NT.loaded && NT.items.filter(n => n.kind === "decision").length === 3`);
		await openSheet(q["업데이트"]!);
		expect(await sheet()).toMatchObject({ opts: [], said: "곧 전해요1) 찾아봐요" });
		await press('.fs-ft [data-k="unhold"]');
		await waitFor(`document.querySelectorAll('.fs-ft .ds-opt[data-k^="o"]').length === 2`);
		await advance(ANSWER_HOLD_MS * 2);
		expect(delivered.length).toBe(0);
		expect(stateOf(q["업데이트"]!)).toBe("open");
	}, 30_000);

	test("a delivery that fails after the window is shown on the page: the reason as before, and the hand-off offer when the asking session ended", async () => {
		const q = ids();
		failFor[q["토큰"]!] = () => new Error("이 메일 대화를 찾을 수 없어요");
		failFor[q["업데이트"]!] = () => new SessionEnded("gone");
		await openSheet(q["토큰"]!);
		await press('.fs-ft [data-k="o1"]');
		await waitFor(`document.querySelector(".snack .sa")`);
		await advance(ANSWER_HOLD_MS);
		await waitFor(`[...document.querySelectorAll(".snack")].some(s => s.textContent === "토큰 · 원인을 찾아볼까요? · 이 메일 대화를 찾을 수 없어요")`);
		expect(await ev<boolean>(`ntOpenDec(ntById(${JSON.stringify(q["토큰"])}))`)).toBe(true);
		await answerDecision(q["업데이트"]!, { n: 1, hold: true }, send);
		await advance(ANSWER_HOLD_MS);
		await openSheet(q["업데이트"]!);
		await waitFor(`document.querySelector('.fs-ft [data-k="main"]')`);
		expect(await ev<string>(`document.querySelector('.fs-ft [data-k="main"] .ds-ds').textContent`)).toBe("1) 찾아봐요");
		expect((await sheet()).opts).toEqual(["o1", "o2"]);
		expect(delivered.length).toBe(0);
	}, 30_000);

	test("the monitor's 다시 연결 is answered at once: the page asks for no hold and the answer goes out with its action", async () => {
		emit("outbox", { ts: new Date(Date.now() + 1000).toISOString(), kind: "out", source: "gateway", target: "alert", text: `메일 모니터링 로그인이 풀렸어요.\n${watchChoice("메일", "", true)}` });
		await waitFor(`NT.items.some(n => n.decision && n.decision.options.some(o => o.action === "watch-reconnect"))`);
		const id = await ev<string>(`String(NT.items.find(n => n.decision && n.decision.options.some(o => o.action === "watch-reconnect")).id)`);
		await openSheet(id);
		await press('.fs-ft [data-k="o1"]');
		await delivered.until(d => d.length > 0, 10_000, "the reconnect answer");
		expect(bodies.at(-1)).not.toHaveProperty("hold");
		expect(delivered.map(d => d.action)).toEqual(["watch-reconnect"]);
	}, 30_000);

	test("되돌리기 puts back the words typed with the answer", async () => {
		const q = ids();
		await openSheet(q["업데이트"]!);
		await press('.fs-ft [data-k="direct"]');
		await waitFor(`document.querySelector(".fs-ft .dc-note")`);
		await run(`const ta = document.querySelector(".fs-ft .dc-note"); ta.value = "로그부터 보내 주세요"; ta.dispatchEvent(new Event("input"))`);
		await press('.fs-ft [data-k="send"]');
		await waitFor(`document.querySelector(".snack .sa")`);
		await press(".snack .sa");
		await waitFor(`NS.id === ${JSON.stringify(q["업데이트"])} && document.querySelector(".fs-ft .dc-note") && document.querySelector(".fs-ft .dc-note").value === "로그부터 보내 주세요"`);
		await advance(ANSWER_HOLD_MS * 2);
		expect(delivered.length).toBe(0);
	}, 30_000);

	test("once the held answer has gone out the way the web sends it, the sheet and the alert conversation read it as answered, with no 되돌리기", async () => {
		const q = ids(), id = q["업데이트"]!;
		likeSendWeb = true;
		await run(`openTarget("alert", "chat")`);
		await waitFor(`document.querySelectorAll("#tl .bm[data-dat] .dq-p").length === 3`);
		await openSheet(id);
		await press('.fs-ft [data-k="o1"]');
		await waitFor(`document.querySelector(".snack .sa") && NS.id === ${JSON.stringify(q["실패 작업"])}`);
		await advance(ANSWER_HOLD_MS);
		await delivered.until(d => d.length > 0, 10_000, "the held answer");
		await waitFor(`ntById(${JSON.stringify(id)}).decision.state === "answered" && !(ntById(${JSON.stringify(id)}).decision.hold || {}).shown`);
		await run(`ntSheetGo(${JSON.stringify(id)})`);
		await waitFor(`NS.id === ${JSON.stringify(id)} && document.querySelector("#ds-t")`);
		const foot = `[...document.querySelectorAll(".fs-ft [data-k]")].map(b => b.dataset.k)`;
		expect(await ev<string[]>(foot)).not.toContain("unhold");
		expect((await sheet()).said).not.toContain("곧 전해요");
		expect((await sheet()).said).toContain("찾아봐요");
		await run(`ntApply({ ...ntById(${JSON.stringify(id)}), decision: { ...ntById(${JSON.stringify(id)}).decision, hold: { state: "held", label: "1) 찾아봐요", until: Date.now(), left: 0, n: 1 } } })`);
		expect(await ev<string[]>(foot)).not.toContain("unhold");
		expect((await sheet()).said).not.toContain("곧 전해요");
		await run(`ntSheetClose(false)`);
		await waitFor(`!NS.node && document.querySelectorAll("#tl .bm[data-dat] .dq-p").length === 3`);
		expect(await ev<string[]>(`[...document.querySelectorAll("#tl .bm[data-dat] .dq-p")].map(p => p.querySelector(".dq-st").textContent)`)).toEqual(["답했어요 · 찾아봐요", "답변 필요", "답변 필요"]);
		expect(delivered.map(d => d.notice)).toEqual([id]);
	}, 30_000);

	test("a held answer that fails because the asking session ended is told on the page while the sheet is on another card; that card's sheet keeps its hand-off", async () => {
		const q = ids(), id = q["업데이트"]!;
		failFor[id] = () => new SessionEnded("gone");
		await openSheet(id);
		await press('.fs-ft [data-k="o1"]');
		await waitFor(`document.querySelector(".snack .sa") && NS.id === ${JSON.stringify(q["실패 작업"])}`);
		await advance(ANSWER_HOLD_MS);
		await waitFor(`[...document.querySelectorAll(".snack")].some(s => s.textContent === "업데이트 · 원인을 찾아볼까요? · 이 세션은 이미 끝나서 전달하지 못했어요")`, 5000);
		expect(await ev<string>(`NS.id`)).toBe(q["실패 작업"]!);
		await run(`ntSheetGo(${JSON.stringify(id)})`);
		await waitFor(`NS.id === ${JSON.stringify(id)} && document.querySelector('.fs-ft [data-k="main"]')`);
		expect(await ev<string>(`document.querySelector('.fs-ft [data-k="main"] .ds-ds').textContent`)).toBe("1) 찾아봐요");
		expect(delivered.length).toBe(0);
	}, 30_000);
});
