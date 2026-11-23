import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeHub, json, run, waitFor, type View } from "./test-web.ts";

const SHOTS = process.env.SCHEDULE_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const NOW = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
const NEXT = iso(NOW + 3 * 3600_000);
const monitors = [
	{ name: "sample-2 일일 보고", schedule: "s1", kind: "schedule", sk: "task", scope: "plain", last_run: iso(NOW - 3600_000), last_result: "ok", run_state: "answered", next_run: NEXT, every: "매일 오전 7:00" },
	{ name: "sample-3 회의 알림", schedule: "s2", kind: "schedule", sk: "owner", scope: "plain", next_run: "2027-12-12T03:00:00Z" },
	{ name: "sample-4 점검", schedule: "s3", kind: "schedule", sk: "check", scope: "plain", last_run: iso(NOW - 600_000), last_result: "ok", run_state: "held", next_run: iso(NOW + 3600_000), every: "매시간" },
];
const schedules = [
	{ id: "s1", name: "sample-2 일일 보고", kind: "task", text: "ch:7 Run the daily report.", at: NEXT, every_minutes: 1440, created: iso(NOW - 86_400_000) },
	{ id: "s2", name: "sample-3 회의 알림", kind: "owner", text: "3시 회의를 알려 줘", at: "2027-12-12T03:00:00Z", created: iso(NOW - 86_400_000) },
	{ id: "s3", name: "sample-4 점검", kind: "check", text: "sample-4 상태 점검", at: iso(NOW + 3600_000), every_minutes: 60, created: iso(NOW - 86_400_000) },
];
const PAST_AT = "2026-11-18T05:30:00Z";
const runs = [
	{ run: "r0", scheduleId: "s9", name: "sample-5 서류 알림", kind: "owner", text: "서류 내라고 알려 줘", firedAt: PAST_AT, state: "answered", conv: "ch:7" },
	{ run: "r1", scheduleId: "s8", name: "sample-6 정리 점검", kind: "check", text: "정리 점검", firedAt: PAST_AT, state: "silent" },
	{ run: "r2", scheduleId: "s1", name: "sample-2 일일 보고", kind: "task", text: "ch:7 Run the daily report.", firedAt: iso(NOW - 3600_000), state: "answered" },
];
const at = (m: number) => iso(NOW - 2 * 3600_000 + m * 60_000);
const history = [
	{ ts: at(10), kind: "schedule", source: "schedule", channel: "web", id: "s1", run: "r2", name: "sample-2 일일 보고", sk: "task", every: 1440, text: "Run the daily report for sample@example.com and post it." },
	{ ts: at(11), kind: "out", source: "orchestrator", target: "web", text: "어제는 요청이 없었어요." },
	{ ts: at(30), kind: "schedule", source: "schedule", channel: "web", id: "gone", text: "예전 예약" },
	{ ts: at(31), kind: "out", source: "orchestrator", target: "web", text: "예전 예약을 마쳤어요." },
];
const step = (ts: string, type: string, extra: object = {}) => ({ ts, kind: "activity", source: "orchestrator", type, text: "", ...extra });
const activity = [10, 30].flatMap(m => [step(at(m), "turn_start"), step(at(m), "tool_call", { tool: "bash", call_id: `c${m}`, args: "{\"command\":\"ls\"}" }), step(at(m), "turn_end")]);
const posts: { path: string; body: unknown }[] = [];
afterEach(() => { posts.length = 0; });
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "dotz", orchestrator: { status: "idle" }, runs: {}, lanes: [], terminals: {}, channels: { work: {} }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() }),
	api: async (req, url) => {
		const p = url.pathname;
		if (req.method === "POST" && p.startsWith("/api/schedules")) { posts.push({ path: p, body: await req.json() }); return json(p.endsWith("/run") ? { run: "r9" } : { ok: true }); }
		if (p === "/api/schedules") return json({ items: schedules, runs });
		if (/^\/api\/schedules\/s\d\/settings$/.test(p)) return json({ key: `s:${p.split("/")[3]}`, fields: [{ key: "name", label: "이름", type: "text", help: "", value: "sample-2 일일 보고" }] });
		if (p === "/api/harness") return json({ nodes: [{ id: "mail", kind: "channel", group: "flow", label: "메일", status: "ok", summary: "", desc: "", facts: [], settings: [{ key: "zele.brief_hour", label: "아침 브리핑 시각", value: 8 }] }], edges: [] });
		if (p === "/api/history") return json({ target: "main", events: url.searchParams.get("before") ? [] : history });
		if (p === "/api/activity") return json({ items: activity, more: false, history: false });
		if (p === "/api/monitors") return json({ items: monitors });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const shot = async (v: View, name: string) => { if (!SHOTS) return; await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`); await Bun.write(join(SHOTS, name), await v.screenshot()); };
const row = (name: string) => `[data-k="m:${name}"]`;
const boot = async (width: number, height: number) => {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await run(v, `Date.now = () => ${NOW}`);
	await waitFor(v, `typeof go === "function" && S && NM.loaded && NM.items.length === 3`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	return v;
};

describe("schedules say facts, are listed in settings and open to their result", () => {
	for (const [width, height] of [[390, 844], [1280, 900]] as const) {
		test(`the monitoring rows say the latest run, wait in grey, repeat in words and run now at ${width}px, once the fine ones are unfolded (S8)`, async () => {
			const v = await boot(width, height);
			await run(v, `go("monitoring")`);
			await waitFor(v, `document.querySelector('#mon-side .cv-row.mon-fold')`);
			await run(v, `document.querySelector('#mon-side .cv-row.mon-fold').click()`);
			await waitFor(v, `document.querySelector('${row("sample-3 회의 알림")} .cv-p')`);
			const line = (name: string) => q<{ tag: string; tone: string; hint: string }>(v, `const r = document.querySelector('${row(name)}'), t = r.querySelector(".cv-m .tag"); return { tag: t.textContent, tone: t.className, hint: r.querySelector(".cv-p").textContent }`);
			const done = await line("sample-2 일일 보고");
			expect(done.hint).toMatch(/^마지막 실행 .+ · 결과를 올렸어요$/);
			expect(done.tag).toBe("정상");
			const wait = await line("sample-3 회의 알림");
			expect([wait.tag, wait.hint]).toEqual(["대기 중", "12월 12일에 시작해요"]);
			expect(wait.tone).toContain("off");
			expect(wait.tone).not.toContain("warn");
			const held = await line("sample-4 점검");
			expect(held.hint).toMatch(/^마지막 실행 .+ · 한도로 못 했어요$/);
			expect(held.tag).toBe("늦어짐");
			await shot(v, `schedule-rows-${width}.png`);
			await run(v, `go("monitoring", "m:sample-2 일일 보고")`);
			await waitFor(v, `[...document.querySelectorAll(".mon-run")].some(b => b.offsetParent)`);
			expect(await q(v, `return [...document.querySelectorAll(".mon-desc")].find(d => d.offsetParent).textContent`)).toContain("매일 오전 7:00");
			const btn = `[...document.querySelectorAll(".mon-run")].find(b => b.offsetParent)`;
			expect(await q(v, `return ${btn}.textContent`)).toBe("지금 실행");
			await run(v, `${btn}.click()`);
			await waitFor(v, `[...document.querySelectorAll(".snack")].some(s => s.textContent.includes("지금 실행했어요"))`);
			expect(posts).toEqual([{ path: "/api/schedules/s1/run", body: {} }]);
			await shot(v, `schedule-detail-${width}.png`);
		}, 60_000);

		test(`the monitoring overview folds a waiting schedule with the fine ones, only the late one stands out at ${width}px`, async () => {
			const v = await boot(width, height);
			await run(v, `go("monitoring", "notice")`);
			await waitFor(v, `document.querySelector(".mon-ov-h")`);
			expect(await q(v, `return [...document.querySelectorAll(".mon-ov-row")].map(r => r.querySelector(".mon-ov-n").textContent)`)).toEqual(["sample-4 점검"]);
			expect(await q(v, `return document.querySelector(".mon-ov-ht").textContent`)).toBe("나머지 2개");
		}, 60_000);

		test(`settings 예약한 일 lists each schedule by name and kind, the morning brief and the past ones to book again at ${width}px`, async () => {
			const v = await boot(width, height);
			await run(v, `go("settings")`);
			await waitFor(v, `[...document.querySelectorAll("#settings .li .hd")].some(h => h.textContent === "예약한 일")`);
			await run(v, `[...document.querySelectorAll("#settings .li")].find(b => b.querySelector(".hd").textContent === "예약한 일").click()`);
			await waitFor(v, `current === "schedules" && document.querySelector('#schedules [data-sched="brief"]') && document.querySelector("#schedules [data-past]")`);
			const rows = await q<string[][]>(v, `return [...document.querySelectorAll("#schedules [data-sched]")].map(r => [r.querySelector(".hd").textContent, r.querySelector(".tag").textContent, r.querySelector(".sup").textContent])`);
			expect(rows.map(r => r.slice(0, 2))).toEqual([["sample-4 점검", "조용한 점검"], ["sample-2 일일 보고", "작업"], ["sample-3 회의 알림", "알림"], ["아침 브리핑", "작업"]]);
			expect(rows[1]![2]).toContain("매일 오전 7:00");
			expect(rows[3]![2]).toBe("매일 8시 · 시각은 시스템의 메일에서 바꿔요");
			const past = await q<string[][]>(v, `return [...document.querySelectorAll("#schedules [data-past]")].map(r => [r.querySelector(".hd").textContent, r.querySelector("button").textContent])`);
			expect(past).toEqual([["sample-5 서류 알림", "같은 걸 다시 예약"]]);
			expect(await q(v, `return [...document.querySelectorAll("#schedules .sec")].map(s => s.textContent)`)).toEqual(["예약", "지난 예약"]);
			await shot(v, `schedule-settings-list-${width}.png`);
			await run(v, `document.querySelector("#schedules [data-past] button").click()`);
			await waitFor(v, `[...document.querySelectorAll(".snack")].some(s => s.textContent.includes("다시 예약했어요"))`);
			const sent = posts.find(x => x.path === "/api/schedules")!.body as { name: string; text: string; kind: string; at: string; conv?: string };
			expect({ name: sent.name, text: sent.text, kind: sent.kind, conv: sent.conv }).toEqual({ name: "sample-5 서류 알림", text: "서류 내라고 알려 줘", kind: "owner", conv: "ch:7" });
			expect(Date.parse(sent.at)).toBeGreaterThan(NOW);
			expect((Date.parse(sent.at) - Date.parse(PAST_AT)) % 86_400_000).toBe(0);
			await run(v, `document.querySelector('#schedules [data-sched="s1"]').click()`);
			await waitFor(v, `ASC.app === "s:s1" && document.querySelector("#app-sw .as-row")`);
			await run(v, `ASC.h.close()`);
			await waitFor(v, `!ASC.h`);
			await run(v, `document.querySelector('#schedules [data-sched="brief"]').click()`);
			await waitFor(v, `current === "harness" && hSel === "mail"`);
		}, 60_000);

		test(`a schedule's chat row leads with its name and opens to its next run and result, the instruction folded with the address masked at ${width}px`, async () => {
			const v = await boot(width, height);
			await run(v, `go("chat", "main")`);
			await waitFor(v, `CV.loaded && current === "chat" && document.querySelectorAll("#tl > details.work:not([hidden])").length === 2`);
			expect(await q<string[]>(v, `return [...document.querySelectorAll("#tl > details.work:not([hidden]) .wsum")].map(s => s.textContent.split(" → ")[0])`)).toEqual(["sample-2 일일 보고", "예약"]);
			await run(v, `document.querySelector("#tl > details.work summary").click()`);
			const first = `document.querySelector("#tl > details.work")`;
			await waitFor(v, `${first}.querySelector('[data-k="wake-next"]:not([hidden])')`);
			expect(await q(v, `return ${first}.querySelector('[data-k="wake-next"]').textContent`)).toMatch(/^다음 실행 /);
			const body = await q<string>(v, `return ${first}.querySelector(".wbody").innerText`);
			expect(body).toContain("결과 보기");
			expect(body).toContain("지시 내용 보기");
			expect(body).not.toContain("Run the daily report");
			await run(v, `${first}.querySelector('[data-k="wake-raw"] summary').click()`);
			const raw = await q<string>(v, `return ${first}.querySelector('[data-k="wake-raw"]').innerText`);
			expect(raw).toContain("s***@example.com");
			expect(raw).not.toContain("sample@example.com");
			await shot(v, `schedule-wake-${width}.png`);
			await run(v, `${first}.querySelector('[data-k="wake-result"]').click()`);
			await waitFor(v, `[...document.querySelectorAll(".nt-hl")].some(n => n.closest("[data-ts]") && n.closest("[data-ts]").dataset.ts === ${JSON.stringify(history[1]!.ts)})`);
			const second = `document.querySelectorAll("#tl > details.work")[1]`;
			await run(v, `${second}.querySelector("summary").click()`);
			await waitFor(v, `${second}.querySelector('[data-k="wake-next"]')`);
			expect(await q(v, `return ${second}.querySelector('[data-k="wake-next"]').hidden`)).toBe(true);
		}, 60_000);
	}
});
