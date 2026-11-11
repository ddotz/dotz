import { afterAll, describe, expect, test } from "bun:test";
import { shownEvent } from "./owner-text.ts";
import { SHOT_BULLETS, SHOT_DRAFT } from "./owner-text.fixture.ts";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// The two messages of 2026-11-05 as a card in the message, read through the hub's stored-message rule. Headless, nothing leaves the test.
const T1 = "2026-11-05T07:21:16.022Z", T2 = "2026-11-05T07:22:11.894Z";
const rep = (lane: string, ts: string, text: string) => shownEvent({ ts, kind: "lane_report", source: `lane:${lane}`, lane, text });
const owner = (lane: string, ts: string, text: string, extra = {}) => ({ ts, kind: "lane_message", source: "web", author: "me", lane, text, ...extra });
const events: Record<string, unknown[]> = {
	"lane:open": [owner("open", "2026-11-05T07:20:00.000Z", "해 줘"), rep("open", T1, SHOT_BULLETS)],
	"lane:closed": [rep("closed", T2, SHOT_DRAFT), owner("closed", "2026-11-05T07:28:34.481Z", "1) 보내기", { reply_to: T2, picks: [{ q: "이 메일을 회사 메일로 보낼까요? (pilot-2769e70)", n: 1, label: "보내기" }] })],
	"lane:passed": [rep("passed", T1, SHOT_BULLETS), owner("passed", "2026-11-05T07:22:00.000Z", "나중에 볼게")],
};
const sent: Record<string, unknown>[] = [];
const hub = fakeHub({
	state: idleState({ name: "땅콩", lanes: ["open", "closed", "passed"].map(name => ({ name, title: name, status: "idle", live: true, alive: true })) }),
	api: async (req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: events[url.searchParams.get("target") ?? ""] ?? [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
		if (url.pathname === "/api/message") {
			sent.push(await req.json() as Record<string, unknown>);
			return json({ ok: true });
		}
	},
});
const view = await hub.view();
afterAll(() => hub.stop());
const { waitFor } = on(view);
const open = async (t: string) => {
	await view.evaluate(`(openTarget(${JSON.stringify(t)}, "chat"), 0)`);
	await waitFor(`target === ${JSON.stringify(t)} && document.querySelectorAll("#timeline .dc-inl").length > 0`);
};
const rows = () => view.evaluate(`JSON.stringify([...document.querySelectorAll("#timeline .dc-inl .dc-row")].map(b => [b.querySelector(".dc-lb").textContent, b.disabled, b.classList.contains("on")]))`).then(s => JSON.parse(s as string));
const body = () => view.evaluate(`[...document.querySelectorAll("#timeline .bm .md")].map(m => m.textContent).join(" ")`) as Promise<string>;

describe("a decision as a card in its message", () => {
	test("the bullets become a live card and the raw block is gone", async () => {
		await view.navigate(`${hub.origin}/`);
		await waitFor(`typeof openTarget === "function" && S`);
		await open("lane:open");
		expect(await rows()).toEqual([["보내기", false, false], ["보내지 않기", false, false]]);
		expect(await body()).not.toContain("- 보내기");
		expect((await body()).replace(/.*보낼까요\?/s, "")).not.toContain("결정:");
	});
	test("a tap answers its session once", async () => {
		await view.evaluate(`document.querySelector("#timeline .dc-inl .dc-row").click(), 0`);
		await waitFor(`DC.st[Object.keys(DC.st)[0]] === "sent"`);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ text: "1) 보내기", lane: "open", reply_to: T1 });
		expect(await rows()).toEqual([["보내기", true, true], ["보내지 않기", true, false]]);
	});
	test("an answered decision has no rows to fire: its answer is the record", async () => {
		await open("lane:closed");
		await waitFor(`document.querySelector("#timeline .dc-rec")`);
		expect(await rows()).toEqual([]);
		expect(await body()).not.toContain("결정:");
	});
	test("a decision the owner talked past is closed too", async () => {
		await open("lane:passed");
		expect(await rows()).toEqual([["보내기", true, false], ["보내지 않기", true, false]]);
		await view.evaluate(`document.querySelector("#timeline .dc-inl .dc-row").click(), 0`);
		expect(sent).toHaveLength(1);
	});
});
