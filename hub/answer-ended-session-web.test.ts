import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { answerDecision, type DecisionSend, listNotices, resetNoticesForTest, SessionEnded, unreadCount } from "./notices.ts";
import { fakeHub, idleState, inbox, json, on, type View } from "./test-web.ts";

const LANE = "sample-2";
const QUESTION = "어디로 받을까요?";
const delivered = inbox<Parameters<DecisionSend>[0]>();
const hub = fakeHub({
	state: () => idleState({ notices_unread: unreadCount() }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices" && req.method === "GET") return json(listNotices(300));
		const answering = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/answer$/.exec(p) : null;
		if (answering) {
			const r = await answerDecision(answering[1]!, await req.json(), async a => {
				if (a.to === `lane:${LANE}`) throw new SessionEnded(LANE);
				delivered.push(a);
			});
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
beforeEach(async () => {
	resetNoticesForTest();
	delivered.length = 0;
	emit("inbox", { ts: new Date(Date.now() - 3_600_000).toISOString(), kind: "lane_report", source: `lane:${LANE}`, lane: LANE, text: `[ask] ${QUESTION}\n결정: ${QUESTION}\n**1) 회사 메일로 받기**\n**2) 집 메일로 받기**` });
	view = await hub.view({ width: 390, height: 844 });
}, 20_000);
afterEach(() => hub.release());

const openSheet = async () => {
	await view.navigate(`${hub.origin}/#notices`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && document.querySelector('#v-notices .list[data-g="need"] .nsc-r')`);
	await run(`document.querySelector('#v-notices .list[data-g="need"] .nsc-r .nsc-tx').click()`);
	await waitFor(`document.querySelector('.ds-opt[data-k="o1"]')`);
};
const text = (selector: string) => ev<string>(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ""`);

test("answering a question of a session that is gone keeps the sheet open with the reason and a 메인에 넘기기 button, never the answered state", async () => {
	await openSheet();
	await run(`document.querySelector('.ds-opt[data-k="o1"]').click()`);
	await waitFor(`document.querySelector(".fs-ft [data-k='gone']")`);
	expect(await text(".fs-ft [data-k='gone']")).toBe(await ev<string>(`TX("decision.gone_fail")`));
	expect(await ev<number>(`document.querySelectorAll('.fs-ft [data-k="main"]').length`)).toBe(1);
	expect(await ev<boolean>(`!!document.querySelector('.fs-ft .ds-opt[data-k="o2"]')`)).toBe(true);
	expect(await ev<boolean>(`!document.querySelector(".fs-ft .ds-res")`)).toBe(true);
	expect(listNotices(300).items.find(n => n.kind === "decision")!.decision!.state).toBe("open");
}, 20_000);

test("메인에 넘기기 sends the question and the chosen answer to main and the sheet then reads answered", async () => {
	await openSheet();
	await run(`document.querySelector('.ds-opt[data-k="o1"]').click()`);
	await waitFor(`document.querySelector('.fs-ft [data-k="main"]')`);
	await run(`document.querySelector('.fs-ft [data-k="main"]').click()`);
	const [sent] = await delivered.until(s => s.length > 0);
	expect(sent).toMatchObject({ to: "main" });
	for (const part of [LANE, QUESTION, "1) 회사 메일로 받기"]) expect(sent!.text).toContain(part);
	await waitFor(`document.querySelector(".fs-ft .ds-res")`);
	expect(await text(".fs-ft .ds-ra")).toContain("1) 회사 메일로 받기");
	expect(listNotices(300).items.find(n => n.kind === "decision")!.decision!.state).toBe("answered");
}, 20_000);
