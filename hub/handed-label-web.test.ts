import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor } from "./test-web.ts";

const FIN = "ch:7001", PR = "ch:7003";
const at = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 10, 23, h, m, s)).toISOString();
const handed = (ts: string, from: string, id: string, text: string, extra: object = {}) => ({ ts, kind: "handed", source: "session", channel: "web", from, handed_id: id, text, ...extra });
const out = (ts: string, text: string, extra: object = {}) => ({ ts, kind: "out", source: "orchestrator", target: "web", session: "main", auto: true, text, ...extra });
const LESSONS = "LESSONS.md에 교훈 두 번째 줄을 넣으면 3000바이트 상한을 넘어서 gate가 지웠어요.";
const RELEASE = "v261120.3.2가 나갔어요. 수기 메일 카드에서 초안이 깨지던 것을 고친 버전이에요.";
const ASK1 = "형 지적(#예산-점검 msg f7340e5d): 메일 쪽은 제가 고쳤어요. 웹 쪽을 봐 주세요.";
const ASK2 = "형 지시(#예산-점검 msg 925a9491): 초안 깨짐 원인 분석 세션 하나 띄워 주세요.";
const ASK3 = "142398d0 받았어요. 남은 두 가지를 그 세션에 맡겨 주세요.";
const step = (ts: string, type: string, extra: object = {}) => ({ ts, kind: "activity", source: "orchestrator", type, text: "", ...extra });
const call = (ts: string, id: string) => [step(ts, "tool_call", { tool: "bash", call_id: id, text: "bash: 확인" }), step(ts, "tool_result", { tool: "bash", call_id: id, text: "ok" })];

const CASES: Record<string, { history: object[]; activity: object[] }> = {
	lost: {
		history: [handed(at(13, 35, 33), FIN, "h1", ASK1), handed(at(13, 38, 34), FIN, "h2", ASK2), handed(at(13, 39, 52), FIN, "h3", ASK3), out(at(15, 19, 21), LESSONS), out(at(15, 32, 51), RELEASE)],
		activity: [],
	},
	overlap: {
		history: [handed(at(13, 0), PR, "b1", "PR #25 기록 확인했어요.", { handback: true }), handed(at(13, 0, 20), FIN, "a1", ASK1), out(at(13, 0, 40), "PR 기록은 작업내역에 남겼어요.", { handed_id: "b1", hushed: true }), out(at(13, 30), LESSONS)],
		activity: [],
	},
	transcript: {
		history: [handed(at(13, 35, 33), FIN, "h1", ASK1), out(at(15, 19, 21), LESSONS)],
		activity: [
			step(at(13, 35, 34), "status", { text: `> [conversation ${FIN}] ${ASK1}` }),
			...call(at(13, 35, 40), "c1"),
			step(at(13, 39, 40), "text", { text: "웹 답장 확인 창을 고쳤어요." }),
			...call(at(15, 18, 0), "c2"),
			step(at(15, 19, 20), "text", { text: LESSONS }),
		],
	},
};
let shape = "lost";
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "dotz", orchestrator: { status: "idle" }, runs: {}, lanes: [], terminals: {}, channels: { work: { "7001": "예산-점검", "7003": "pr-이슈-처리" } }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: "main", events: url.searchParams.get("before") ? [] : CASES[shape]!.history });
		if (p === "/api/activity") return json({ items: CASES[shape]!.activity, more: false, history: shape === "transcript" });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

const labels = `[...document.querySelectorAll("#tl .bm > .mt .wl-sess")].map(m => ({ text: m.textContent, answer: m.closest(".bm").textContent }))`;
for (const [name, want] of [
	["lost", []],
	["overlap", [{ text: "pr-이슈-처리에서", answer: expect.stringContaining("PR 기록은 작업내역에") }]],
	["transcript", []],
] as const) {
	test(`the handed-work label marks only the answer bound to that handed text (${name})`, async () => {
		shape = name;
		const v = await hub.view({ width: 1280, height: 900 });
		await v.navigate(`${hub.origin}/#chat/main`);
		await waitFor(v, `typeof go === "function" && CV.loaded && current === "chat" && target === "main" && [...document.querySelectorAll("#tl .bm")].some(n => n.textContent.includes("LESSONS.md"))`);
		await run(v, `timeline.scrollTop = timeline.scrollHeight`);
		expect(await ev<unknown[]>(v, labels)).toEqual([...want]);
	}, 60_000);
}
