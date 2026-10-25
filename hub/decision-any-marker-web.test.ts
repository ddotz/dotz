import { afterAll, describe, expect, test } from "bun:test";
import { DONE_REPLY } from "./decision-any-marker.fixture.ts";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// A [done]-style chat answer ending in a 결정: choice block shows the buttons in the message and the decision card, at 390px.
// Headless browser against a fixture history; nothing is sent. Before the fix the same message rendered as plain text.
const SNAP = "/tmp/dotz-decision-any-marker";
const events = [
	{ ts: "2026-10-22T08:10:00.000Z", kind: "message", source: "web", channel: "web", text: "방문 예약 잡아줘" },
	{ ts: "2026-10-22T08:19:17.721Z", kind: "out", source: "orchestrator", target: "web", reply_to: "ec330340", auto: true, text: DONE_REPLY },
];
const hub = fakeHub({
	state: idleState({ name: "땅콩" }),
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? events : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view();
afterAll(() => hub.stop());
const { waitFor } = on(view);

describe("a [done] answer with a choice block", () => {
	test("shows its options as buttons in the message and in the decision card at 390px", async () => {
		await view.navigate(`${hub.origin}/`);
		await waitFor(`typeof openTarget === "function" && S`);
		await view.evaluate(`(openTarget("main", "chat"), 0)`);
		await waitFor(`document.querySelectorAll(".dcm-row").length === 3 && document.querySelectorAll("#dcard .dc-row").length === 3`);
		expect(await view.evaluate(`[...document.querySelectorAll(".dcm-row")].map(b => b.querySelector(".dc-lb").textContent.replace("추천", "")).join("|")`)).toBe("압구정 본점 10/28(화) 15:00|청담 메종 10/31(금) 14:00|다른 날짜나 매장");
		expect(await view.evaluate(`[...document.querySelectorAll(".dcm-row")].every(b => !b.disabled)`)).toBe(true);
		expect(await view.evaluate(`!document.querySelector("#dcard").hidden && document.querySelector("#dcard .dc-q").textContent`)).toBe("방문 예약");
		expect(await view.evaluate(`document.body.textContent.includes("제일 빨리 가서 직접 물어볼 수 있어요")`)).toBe(true);
		expect(await view.evaluate(`document.querySelector(".bm").textContent.includes("까르띠에 고객관리팀으로")`)).toBe(true);
		const seen = JSON.parse(await view.evaluate(`JSON.stringify([...document.querySelectorAll(".dcm-row, #dcard .dc-row")].map(b => { const r = b.getBoundingClientRect(); return r.width > 200 && r.height >= 40 && r.left >= 0 && r.right <= innerWidth; }))`));
		expect(seen).toHaveLength(6);
		expect(seen.every(Boolean)).toBe(true);
		Bun.spawnSync(["mkdir", "-p", SNAP]);
		await Bun.write(`${SNAP}/done-choice-390.png`, await view.screenshot());
	});
});
