import { afterAll, describe, expect, test } from "bun:test";
import { normalizeAsk } from "./ask-normalize.ts";
import { ASK_A } from "./ask-normalize.fixture.ts";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// The answer of 2026-11-04 as the gateway now stores it: the web docks it as the decision card with three buttons. Headless, nothing is sent.
const events = [
	{ ts: "2026-11-04T08:10:00.000Z", kind: "message", source: "web", channel: "web", text: "2부 어떻게 됐어?" },
	{ ts: "2026-11-04T08:19:17.721Z", kind: "out", source: "orchestrator", target: "web", reply_to: "ec330340", auto: true, text: normalizeAsk(ASK_A) },
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

describe("a final answer ending in a plain option list", () => {
	test("shows its options as the decision card's buttons", async () => {
		await view.navigate(`${hub.origin}/`);
		await waitFor(`typeof openTarget === "function" && S`);
		await view.evaluate(`(openTarget("main", "chat"), 0)`);
		await waitFor(`document.querySelectorAll("#dcard .dc-row").length === 3`);
		expect(await view.evaluate(`[...document.querySelectorAll("#dcard .dc-row")].map(b => b.querySelector(".dc-lb").textContent.replace("추천", "")).join("|")`)).toBe("그대로 반영|알림 행만 조정하고 반영|반영 보류");
		expect(await view.evaluate(`document.querySelector("#dcard .dc-q").textContent`)).toBe("어떻게 할까요?");
	});
});
