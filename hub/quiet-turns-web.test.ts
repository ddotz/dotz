import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, waitFor } from "./test-web.ts";

const at = (m: number, s = 0) => new Date(Date.UTC(2026, 10, 19, 19, m) + s * 1000).toISOString();
const history = [{ ts: at(0), kind: "message", source: "web", channel: "web", text: "데모 점검해 줘" }];
const step = (ts: string, type: string, extra: object = {}) => ({ ts, kind: "activity", source: "orchestrator", type, text: "", ...extra });
const keepalive = (m: number) => [
	step(at(m), "turn_start"),
	step(at(m, 0.5), "status", { text: "> [keepalive] 게이트웨이의 캐시 유지 신호예요. ok 한 단어로만 답하세요." }),
	step(at(m, 2), "text", { text: "ok" }),
	step(at(m, 2.5), "turn_end"),
];
const activity = [
	step(at(0, 1), "turn_start"),
	step(at(0, 1.5), "status", { text: "> 데모 점검해 줘" }),
	step(at(0, 2), "tool_call", { tool: "bash", call_id: "c1", args: "{\"command\":\"ls\"}" }),
	step(at(0, 12), "tool_result", { tool: "bash", call_id: "c1", text: "ok" }),
	step(at(0, 22), "text", { text: "점검은 워커에게 맡겼어요." }),
	step(at(0, 23), "turn_end"),
	step(at(10), "turn_start"),
	step(at(10, 0.5), "status", { text: "> [dotz reflect] 지난 24시간의 야간 자기 점검이에요." }),
	step(at(10, 8), "tool_call", { tool: "bash", call_id: "c2", args: "{\"command\":\"ls\"}" }),
	step(at(10, 9), "tool_result", { tool: "bash", call_id: "c2", text: "LESSONS.md" }),
	step(at(10, 25), "tool_call", { tool: "dotz_send", call_id: "c3", args: "{\"target\":\"worklog\"}" }),
	step(at(10, 26), "tool_result", { tool: "dotz_send", call_id: "c3", text: "sent to worklog" }),
	step(at(10, 29), "text", { text: "작업내역에 한 줄만 올렸어요." }),
	step(at(10, 30), "turn_end"),
	...keepalive(51),
	...keepalive(102),
];
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "dotz", orchestrator: { status: "idle" }, runs: {}, lanes: [], terminals: {}, channels: { work: {} }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: "main", events: url.searchParams.get("before") ? [] : history });
		if (p === "/api/activity") return json({ items: activity, more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

test("the nightly reflect and keepalive turns leave no work row and never stretch the owner's", async () => {
	const v = await hub.view({ width: 390, height: 844 });
	await v.navigate(`${hub.origin}/#chat/main`);
	await waitFor(v, `typeof go === "function" && CV.loaded && current === "chat" && target === "main" && document.querySelectorAll("#tl details.work").length >= 1`);
	expect(await ev<string[]>(v, `[...document.querySelectorAll("#tl details.work:not([hidden]) .wsum")].map(s => s.textContent)`)).toEqual(["20초 작업 · 명령 1"]);
}, 60_000);
