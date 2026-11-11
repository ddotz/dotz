import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, inbox, json, on } from "./test-web.ts";

// An answered decision stays in the conversation as a quiet record (owner 2026-11-03): the owner answers only inside the card, the agent
// gets the same number message as before, and 질문 … · 답: … remains in the body (the owner's answer event carries the `picks`, so the same
// record is drawn again from history after a reload). A several-decision card sends only once every block has an answer.
// Headless browser against fixture histories; the hub's own answer event is pushed the way events.ts broadcasts it. Nothing leaves the process.
const ASK = "[ask] 배포 공지를 어떤 형태로 정리할까요?\n\n결정: 공지 형태\n**1) 짧은 공지**\n한 문단으로 핵심만 전해요\n**2) 목록 공지**\n바뀐 항목을 순서대로 적어요\n**3) 공지 없이 배포**\n릴리스 노트만 남겨요";
const TWO = "[ask] 두 가지를 정해 주세요\n\n결정: 공지 형태\n**1) 짧은 공지**\n한 문단으로 핵심만 전해요\n**2) 목록 공지**\n바뀐 항목을 순서대로 적어요\n\n결정: 보낼 곳\n**1) 채널**\n바로 올려요\n**2) 메일**\n메일로도 보내요";
const AT = "2026-11-03T09:19:00.000Z";
const sent = inbox<Record<string, any>>();
let history: unknown[] = [];
let notices: Record<string, any>[] = [];
const answered = inbox<{ id: string; n: number }>();
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices" && req.method === "GET") return json({ unread: notices.length, items: notices });
		const an = /^\/api\/notices\/([^/]+)\/answer$/.exec(url.pathname);
		if (an && req.method === "POST") {
			const { n } = await req.json() as { n: number };
			answered.push({ id: an[1]!, n });
			const item = notices.find(x => x.id === an[1])!;
			item.decision = { ...item.decision, state: "answered", answer: `${n})` };
			return json({ item, unread: 0 });
		}
		if (url.pathname === "/api/message" && req.method === "POST") { sent.push(await req.json()); return json({ ok: true }); }
	},
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor, ev, run } = on(view);
// The answer as the hub emits it (intake.ts sendWeb → emit("inbox") with the picks the card posted).
const answer = (picks: { q: string; n: number; label: string }[]) => ({ ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", mid: "m-answer", text: picks.map(p => `${p.n}) ${p.label}`).join(" · "), picks });
const open = async (events: unknown[]) => {
	history = events;
	sent.length = 0;
	const opened = hub.nextStream();
	await view.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(`typeof openTarget === "function" && S`);
	await run(`openTarget("main", "chat")`);
};

describe("an answered decision in the conversation", () => {
	test("the answer's message is drawn as a record (question + chosen label), not as option rows in the body", async () => {
		await open([
			{ ts: "2026-11-03T09:10:00.000Z", kind: "message", source: "web", channel: "web", text: "배포 공지 정리해 줘" },
			{ ts: AT, kind: "out", source: "orchestrator", target: "web", text: ASK },
			{ ts: "2026-11-03T09:20:00.000Z", kind: "message", source: "web", channel: "web", text: "1) 짧은 공지", picks: [{ q: "공지 형태", n: 1, label: "짧은 공지" }] },
		]);
		await waitFor(`document.querySelector("#tl .dc-rec")`);
		expect(await ev<string>(`document.querySelector("#tl .dc-rec .dc-rec-r").textContent`)).toBe("질문공지 형태· 답:1) 짧은 공지");
		expect(await ev<boolean>(`!!document.querySelector("#tl .dc-rec .mt").textContent.trim()`)).toBe(true);
		// options live only in the card: neither the body nor the answer draws a choice row
		expect(await ev(`document.querySelectorAll("#tl .dcm-row, #tl .dc-row").length`)).toBe(0);
		expect(await ev(`[...document.querySelectorAll("#tl .ub")].some(b => b.textContent.includes("짧은 공지"))`)).toBe(false);
		expect(await ev(`document.querySelector("#tl .bm").textContent.includes("배포 공지를 어떤 형태로 정리할까요?")`)).toBe(true);
		expect(await ev(`[...document.querySelectorAll("#tl .bm")].some(b => b.textContent.includes("한 문단으로 핵심만 전해요"))`)).toBe(false);
	}, 30_000);

	test("answering the card posts today's number message and the card folds as the record lands", async () => {
		await open([
			{ ts: "2026-11-03T09:10:00.000Z", kind: "message", source: "web", channel: "web", text: "배포 공지 정리해 줘" },
			{ ts: AT, kind: "out", source: "orchestrator", target: "web", text: ASK },
		]);
		await waitFor(`document.querySelectorAll("#dcard .dc-row").length === 3`);
		expect(await ev(`!!document.querySelector("#tl .dc-rec")`)).toBe(false);
		await run(`document.querySelectorAll("#dcard .dc-row")[0].click()`);
		const posted = await sent.until(items => items.length > 0, 10_000, "the answer message");
		expect(posted[0]).toMatchObject({ text: "1) 짧은 공지", reply_to: AT, picks: [{ q: "공지 형태", n: 1, label: "짧은 공지" }] });
		hub.push(answer([{ q: "공지 형태", n: 1, label: "짧은 공지" }]));
		await waitFor(`document.querySelector("#tl .dc-rec") && document.querySelector("#dcard").hidden`);
		expect(await ev(`document.querySelector("#tl .dc-rec .dc-rec-r").textContent.startsWith("질문공지 형태· 답:1) 짧은 공지")`)).toBe(true);
		expect(await ev(`document.querySelector("#dcard").hidden`)).toBe(true);
	}, 30_000);

	test("several decisions with their own notices are answered one by one: a pick answers that decision, the others stay, and each sheet shows only its own", async () => {
		const opt = (n: number, label: string) => ({ n, label, desc: "", rec: false });
		const dec = (id: string, title: string, text: string) => ({ id, ts: AT, updated: AT, at: AT, kind: "decision", tone: "ask", title, text, open: "main", src: "main", read: false, decision: { options: [opt(1, "하나"), opt(2, "둘")], to: "main", reply_to: AT, group: 2, state: "open" } });
		notices = [dec("d1", "공지 형태", "두 가지를 정해 주세요"), dec("d2", "보낼 곳", "두 가지를 정해 주세요")];
		await open([{ ts: AT, kind: "out", source: "orchestrator", target: "web", text: TWO }]);
		await waitFor(`document.querySelectorAll("#dcard .dc-row").length === 4`);
		expect(await ev(`document.querySelector("#dcard .dc-send")`)).toBe(null);
		await run(`noticeSheetOpen("d2")`);
		await waitFor(`document.querySelector(".ds-t")`);
		expect(await ev<string>(`document.querySelector(".ds-t").textContent`)).toBe("보낼 곳");
		expect(await ev<string>(`document.querySelector(".fs-body").textContent`)).not.toContain("공지 형태");
		await run(`ntSheetClose()`);
		await waitFor(`!document.querySelector(".ds-t")`);
		await run(`document.querySelectorAll("#dcard .dc-row")[0].click()`);
		await answered.until(items => items.length > 0, 10_000, "the first answer");
		expect([...answered]).toEqual([{ id: "d1", n: 1 }]);
		await waitFor(`document.querySelectorAll("#dcard .dc-row").length === 2`);
		expect(await ev<string>(`document.querySelector("#dcard").textContent`)).toContain("보낼 곳");
		expect(sent).toEqual([]);
		notices = [];
	}, 30_000);

	test("a several-block decision sends nothing until every block is answered, then one message with both picks and two records", async () => {
		await open([
			{ ts: "2026-11-03T09:10:00.000Z", kind: "message", source: "web", channel: "web", text: "둘 다 정해 줘" },
			{ ts: AT, kind: "out", source: "orchestrator", target: "web", text: TWO },
		]);
		await waitFor(`document.querySelectorAll("#dcard .dc-row").length === 4`);
		// one of two: the send stays off, nothing goes out and no record is written
		await run(`document.querySelectorAll("#dcard .dc-row")[0].click()`);
		await waitFor(`document.querySelector("#dcard .dc-send") && document.querySelector("#dcard .dc-send").textContent === "보내기 (1/2 선택)"`);
		expect(await ev(`document.querySelector("#dcard .dc-send").disabled`)).toBe(true);
		expect(sent).toEqual([]);
		expect(await ev(`!!document.querySelector("#tl .dc-rec")`)).toBe(false);
		await run(`document.querySelectorAll("#dcard .dc-row")[2].click()`);
		await waitFor(`!document.querySelector("#dcard .dc-send").disabled`);
		await run(`document.querySelector("#dcard .dc-send").click()`);
		const posted = await sent.until(items => items.length > 0, 10_000, "the several-block answer");
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({ text: "결정 답: 1) 짧은 공지 · 1) 채널", picks: [{ q: "공지 형태", n: 1, label: "짧은 공지" }, { q: "보낼 곳", n: 1, label: "채널" }] });
		hub.push(answer([{ q: "공지 형태", n: 1, label: "짧은 공지" }, { q: "보낼 곳", n: 1, label: "채널" }]));
		await waitFor(`document.querySelectorAll("#tl .dc-rec .dc-rec-r").length === 2 && document.querySelector("#dcard").hidden`);
		expect(await ev<string[]>(`[...document.querySelectorAll("#tl .dc-rec .dc-rec-r")].map(r => r.textContent)`)).toEqual(["질문공지 형태· 답:1) 짧은 공지", "질문보낼 곳· 답:1) 채널"]);
	}, 30_000);
});
