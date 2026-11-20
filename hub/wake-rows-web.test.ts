import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { ev, fakeHub, json, run, waitFor } from "./test-web.ts";

const SHOTS = process.env.WAKE_SHOTS;
const at = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 20, 1, m, s)).toISOString();
const history = [
	{ ts: at(0), kind: "message", source: "web", channel: "web", text: "오늘 일정 알려 줘" },
	{ ts: at(1), kind: "out", source: "orchestrator", target: "web", text: "오늘은 일정이 두 개예요." },
	{ ts: at(10), kind: "schedule", source: "schedule", channel: "web", id: "s1", every: 1440, text: "아침 브리핑\nRun `zele cal events --today` and summarize the day." },
	{ ts: at(11), kind: "out", source: "orchestrator", target: "web", text: "오늘 일정은 회의 두 개예요." },
	{ ts: at(20), kind: "handed", source: "session", channel: "web", from: "ch:7002", text: "알림 설정 확인\n설정 화면에서 알림이 켜져 있는지 봐 주세요." },
	{ ts: at(21), kind: "out", source: "orchestrator", target: "web", text: "알림은 켜져 있어요." },
	{ ts: at(30), kind: "schedule", source: "schedule", channel: "web", id: "s2", every: 60, text: "주간 정리\nCheck the weekly log." },
	{ ts: at(40), kind: "schedule", source: "zele", channel: "web", id: "zele", name: "아침 브리핑", text: "morning brief for 2026-10-20, in this shape: one opening sentence naming it" },
	{ ts: at(41), kind: "out", source: "orchestrator", target: "web", text: "오늘은 일정이 두 개예요." },
];
const step = (ts: string, type: string, extra: object = {}) => ({ ts, kind: "activity", source: "orchestrator", type, text: "", ...extra });
const activity = [10, 20, 30, 40].flatMap(m => [
	step(at(m, 1), "turn_start"),
	step(at(m, 2), "tool_call", { tool: "bash", call_id: `c${m}`, args: "{\"command\":\"ls\"}" }),
	step(at(m, 22), "tool_result", { tool: "bash", call_id: `c${m}`, text: "ok" }),
	step(at(m, 30), "turn_end"),
]);
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "dotz", orchestrator: { status: "idle" }, runs: {}, lanes: [], terminals: {}, channels: { work: { "7002": "데모 점검" } }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() }),
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

for (const [width, height] of [[390, 844], [1280, 900]] as const) {
	test(`a schedule and a handover lead their work rows, a quiet wake leaves none, the handed answer names its source at ${width}px`, async () => {
		const v = await hub.view({ width, height });
		await v.navigate(`${hub.origin}/#chat/main`);
		await waitFor(v, `typeof go === "function" && CV.loaded && current === "chat" && target === "main" && document.querySelectorAll("#tl .bm").length >= 3`);
		await run(v, `timeline.scrollTop = timeline.scrollHeight`);
		if (SHOTS) await Bun.write(join(SHOTS, `wake-rows-${width}.png`), await v.screenshot());
		expect(await ev<number>(v, `document.querySelectorAll("#tl .rc").length`)).toBe(0);
		expect(await ev<string[]>(v, `[...document.querySelectorAll("#tl > details.work:not([hidden]) .wsum")].map(s => s.textContent)`)).toEqual([
			"예약 · 아침 브리핑 → 20초 작업 · 명령 1",
			"데모 점검 · 알림 설정 확인 → 20초 작업 · 명령 1",
			"아침 브리핑 → 20초 작업 · 명령 1",
		]);
		expect(await ev<string>(v, `document.querySelector("#tl").innerText`)).not.toContain("주간 정리");
		await run(v, `document.querySelector("#tl > details.work summary").click()`);
		expect(await ev<string>(v, `document.querySelector("#tl > details.work .wbody .a-text").textContent`)).toContain("zele cal events --today");
		expect(await ev<{ text: string; answer: string }[]>(v, `[...document.querySelectorAll("#tl .bm > .mt .wl-sess")].map(m => ({ text: m.textContent, answer: m.closest(".bm").textContent }))`)).toEqual([
			{ text: "데모 점검에서", answer: expect.stringContaining("알림은 켜져 있어요.") },
		]);
		await run(v, `document.querySelector("#tl .bm > .mt .wl-sess").click()`);
		await waitFor(v, `target === "ch:7002"`);
	}, 60_000);
}
