import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { ev, fakeHub, json, waitFor } from "./test-web.ts";

const SHOTS = process.env.QUEUED_SHOTS;

const PR = "ch:7003";
const FEEDBACK = "팀 피드백 데일리 보고: 지난 24시간 팀 메시지에서 불편과 재요청만 묶어 보고해요.";
const brief = (day: number) => `morning brief for 2026-11-${day}, in this shape: one opening sentence naming it 아침 브리핑`;
const handed = (pr: number) => `작업로그 한 줄 부탁해요: 새 PR ddotz/dotz#${pr}는 이미 머지돼서 기록만 했어요.`;
const OWNER = "아 저기 왜 갑자기 opus max로 처리하냐";
const sched = (ts: string, extra: object) => ({ ts, kind: "schedule", channel: "chat", ...extra });
const feedback = (ts: string, run: string) => sched(ts, { source: "schedule", id: "e401a7", run, name: "팀 피드백 데일리 보고", sk: "task", text: FEEDBACK });
const morning = (ts: string, day: number) => sched(ts, { source: "zele", channel: "brief", id: "zele", name: "아침 브리핑", text: brief(day) });
const out = (ts: string, run: string, text: string) => ({ ts, kind: "out", source: "orchestrator", target: "chat", run, sk: "task", auto: true, session: "main", text });
const history = [
	sched("2026-11-20T09:17:01.017Z", { source: "gateway", id: "schedule-naming", text: "[dotz gateway] 이름 없는 예약에 이름을 한 번 붙여요." }),
	morning("2026-11-20T23:01:59.471Z", 21),
	feedback("2026-11-20T23:29:59.901Z", "4984764b"),
	morning("2026-11-21T23:01:38.853Z", 22),
	feedback("2026-11-21T23:30:00.621Z", "7ceff529"),
	morning("2026-11-22T23:00:29.035Z", 23),
	feedback("2026-11-22T23:30:00.369Z", "cb4e15de"),
	{ ts: "2026-11-23T01:01:31.823Z", kind: "handed", source: "session", channel: "web", from: PR, text: handed(25) },
	{ ts: "2026-11-23T01:01:49.692Z", kind: "handed", source: "session", channel: "web", from: PR, text: handed(26) },
	out("2026-11-23T01:01:54.661Z", "4984764b", "어제 팀 메시지는 20건이고, 불편이나 재요청은 6가지예요."),
	out("2026-11-23T01:01:59.917Z", "7ceff529", "오늘 보고는 바로 앞에 올린 걸로 갈음할게요."),
	out("2026-11-23T01:02:04.448Z", "cb4e15de", "이번 보고도 앞에서 이미 다뤘어요."),
	{ ts: "2026-11-23T01:20:00.497Z", kind: "message", source: "web", channel: "web", text: OWNER },
	{ ts: "2026-11-23T01:20:46.090Z", kind: "out", source: "orchestrator", target: "chat", text: "예약이 큰 모델로 잡혀 있었어요." },
];
const at = (s: string) => `2026-11-23T01:${s}Z`;
const step = (s: string, type: string, extra: object = {}) => ({ ts: at(s), kind: "activity", source: "orchestrator", type, text: "", ...extra });
const call = (s: string, tool: string, id: string, text = "ok") => [step(s, "tool_call", { tool, call_id: id, text: `${tool}: 확인` }), step(s, "tool_result", { tool, call_id: id, text })];
const say = (s: string, text: string) => step(s, "text", { text });
const prompt = (s: string, text: string) => step(s, "status", { text: `> ${text}` });
const live = [
	step("01:01.399", "status", { text: "한도가 풀려서 작업을 이어가요" }),
	step("01:01.426", "turn_start"),
	step("01:05.068", "thinking", { text: "keepalive" }), say("01:05.068", "ok"),
	step("01:05.075", "turn_end"),
	step("01:05.097", "turn_start"),
	...call("01:09.132", "dotz_schedule", "n1"), ...call("01:09.133", "dotz_schedule", "n2"), ...call("01:09.134", "dotz_schedule", "n3"),
	say("01:10.345", "-"),
	prompt("01:10.363", "[dotz reflect] 지난 24시간의 야간 자기 점검이에요."),
	...call("01:14.469", "bash", "r1"), ...call("01:23.820", "bash", "r2"), ...call("01:27.191", "dotz_send", "r3", "sent to worklog"),
	say("01:33.230", "야간 점검 끝났어요."),
	prompt("01:33.245", "[dotz reflect] 지난 24시간의 야간 자기 점검이에요."),
	say("01:37.282", "같은 야간 점검이 한 번 더 왔어요."),
	prompt("01:37.302", brief(21)),
	...call("01:40.068", "bash", "b1"), say("01:43.651", "-"),
	prompt("01:43.667", FEEDBACK),
	...call("01:46.033", "bash", "f1"), step("01:54.658", "thinking", { text: "정리" }), say("01:54.658", "어제 팀 메시지는 20건이고, 불편이나 재요청은 6가지예요."),
	prompt("01:54.668", brief(22)),
	step("01:57.191", "thinking", { text: "같은 조회" }), say("01:57.191", "-"),
	prompt("01:57.221", FEEDBACK),
	say("01:59.912", "오늘 보고는 바로 앞에 올린 걸로 갈음할게요."),
	prompt("01:59.933", brief(23)),
	step("02:02.162", "thinking", { text: "건너뛰기" }), say("02:02.162", "-"),
	prompt("02:02.185", FEEDBACK),
	say("02:04.445", "이번 보고도 앞에서 이미 다뤘어요."),
	prompt("02:04.460", `[conversation ${PR}] ${handed(25)}`),
	...call("02:06.854", "dotz_send", "h1", "sent to worklog"), say("02:08.666", "작업내역에 PR #25 기록 한 줄 올렸어요."),
	prompt("02:08.684", `[conversation ${PR}] ${handed(26)}`),
	...call("02:10.918", "dotz_send", "h2", "sent to worklog"), say("02:12.740", "작업내역에 PR #26 기록을 한 줄 올렸어요."),
	step("02:12.756", "turn_end"),
	step("20:00.503", "turn_start"),
	prompt("20:00.511", OWNER),
	...call("20:10.000", "bash", "o1"), say("20:46.080", "예약이 큰 모델로 잡혀 있었어요."),
	step("20:46.100", "turn_end"),
];
const NOT_IN_TRANSCRIPT = new Set([at("01:01.399"), at("01:33.245"), at("01:57.221"), at("02:02.185")]);
const transcript = live.filter(a => a.type !== "turn_start" && a.type !== "turn_end" && !NOT_IN_TRANSCRIPT.has(a.ts));
let items = live;
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "dotz", orchestrator: { status: "idle" }, runs: {}, lanes: [], terminals: {}, channels: { work: { "7003": "pr-이슈-처리" } }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: "main", events: url.searchParams.get("before") ? [] : history });
		if (p === "/api/activity") return json({ items, more: false, history: items === transcript });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

const rows = `[...document.querySelectorAll("#tl details.work:not([hidden]) .wsum")].map(s => s.textContent)`;
for (const [name, list, want] of [
	["live buffer", live, ["팀 피드백 데일리 보고 → 9초 작업 · 명령 1", "팀 피드백 데일리 보고 → 작업", "팀 피드백 데일리 보고 → 작업", "36초 작업 · 명령 1"]],
	["session transcript", transcript, ["팀 피드백 데일리 보고 → 9초 작업 · 명령 1", "작업", "작업", "36초 작업 · 명령 1"]],
] as const) {
	for (const [width, height] of [[390, 844], [1280, 900]] as const) {
		test(`queued prompts after a usage limit: quiet ones leave no row and no prompt takes another's work or source (${name}, ${width}px)`, async () => {
			items = list as typeof live;
			const v = await hub.view({ width, height });
			await v.navigate(`${hub.origin}/#chat/main`);
			await waitFor(v, `typeof go === "function" && CV.loaded && current === "chat" && target === "main" && document.querySelectorAll("#tl .bm").length >= 4`);
			if (SHOTS) await Bun.write(join(SHOTS, `queued-prompts-${name.replace(" ", "-")}-${width}.png`), await v.screenshot());
			expect(await ev<string[]>(v, rows)).toEqual([...want]);
			expect(await ev<number>(v, `document.querySelectorAll("#tl .wl-sess").length`)).toBe(0);
			expect(await ev<string[]>(v, `[...document.querySelectorAll("#tl details.work:not([hidden])")].map(n => { let m = n.nextElementSibling; while (m && m.hidden) m = m.nextElementSibling; return m ? m.textContent : ""; })`)).toEqual([
				expect.stringContaining("어제 팀 메시지"), expect.stringContaining("오늘 보고는"), expect.stringContaining("이번 보고도"), expect.stringContaining("예약이 큰"),
			]);
		}, 60_000);
	}
}
