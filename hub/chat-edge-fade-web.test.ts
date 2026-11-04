import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, waitFor } from "./test-web.ts";

// The chat timeline fades only at an edge with more to scroll (web/css/07-chat.css): at rest on the newest message the bottom edge is sharp.
const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, i)).toISOString();
const events = Array.from({ length: 40 }, (_, i) => ({ ts: at(i), kind: "out", source: "orchestrator", target: "main", text: `답변 ${i}\n\n${"긴 줄입니다. ".repeat(30)}` }));
const hub = fakeHub({
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? events : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

const box = `$("#v-chat .chatbox")`;
const edges = `(() => { const s = getComputedStyle($("#timeline")); return [s.getPropertyValue("--edge-t").trim(), s.getPropertyValue("--edge-b").trim()]; })()`;

test("the fade follows the edges that have more to scroll", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/#chat");
	await waitFor(v, `${box}.classList.contains("fade-t") && !${box}.classList.contains("fade-b") && $("#chat-jump").hidden`);
	expect(await ev(v, edges)).toEqual(["12px", "0px"]);

	// Scrolled and checked on each frame: a late first-load redraw puts a timeline that still counts as stuck back at the bottom.
	await waitFor(v, `(() => { const t = $("#timeline"); t.scrollTop = t.scrollHeight / 2; t.dispatchEvent(new Event("scroll")); return JSON.stringify(${edges}) === '["12px","12px"]' && !$("#chat-jump").hidden; })()`);

	await v.evaluate(`$("#chat-jump").click(), 0`);
	await waitFor(v, `!${box}.classList.contains("fade-b")`);
	expect(await ev(v, edges)).toEqual(["12px", "0px"]);
});
