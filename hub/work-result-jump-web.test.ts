import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on, type View } from "./test-web.ts";

// A row of 최근 끝난 작업 (홈) or of a project's 작업 · 결과 · 최근 세션 ends on the message holding that work's result (web/js/18-lanes.js workGo, laneResultGo),
// through the notice jump, in a headless browser against fixture conversations at phone and desktop widths.
const ts = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, 0, i)).toISOString();
const says = (i: number) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` });
const RESULT_AT = ts(5), LOST_END = Date.parse(ts(200)) + 500, REPORT_AT = ts(301);
const MAIN = Array.from({ length: 300 }, (_, i) => says(i));
const LANE = [
	{ ts: ts(300), kind: "lane_report", lane: "a", source: "lane:a", text: "[run] 하는 중" },
	{ ts: REPORT_AT, kind: "lane_report", lane: "a", source: "lane:a", text: "[done] 빌드 끝났어요" },
	{ ts: ts(302), kind: "out", source: "gateway", target: "lane:a", text: "게이트웨이 메모" },
];
const WORK = [
	{ id: "st_ok", description: "요약 쓰기", status: "done", started_at: Date.now() - 600_000, ended_at: Date.now() - 300_000, result_at: RESULT_AT, result_conv: "main" },
	{ id: "st_lost", description: "정리하기", status: "done", started_at: Date.now() - 600_000, ended_at: LOST_END },
];
const lanes = [{ name: "a", title: "빌드 세션", status: "exited", kind: "work", startedAt: ts(0) }, { name: "b", title: "보고 없는 세션", status: "exited", kind: "work", startedAt: ts(0) }];
const project = {
	record: { title: "빌드" }, git: null,
	lanes: [{ name: "a", title: "빌드 세션", status: "exited", live: false, finishedAt: "2026-10-20T01:05:01.003Z" }, { name: "b", title: "보고 없는 세션", status: "exited", live: false }],
	work: [WORK[0]],
	// The lane's lastReportAt is stamped a moment before the report event.
	results: [{ kind: "report", at: "2026-10-20T01:05:01.003Z", lane: "a", tone: "done", title: "빌드 끝났어요" }],
};

const hub = fakeHub({
	state: () => ({ ...idleState(), lanes, work: WORK, work_now: Date.now() }),
	api: (_req, url) => {
		if (url.pathname === "/api/custom/project") return json(project);
		if (url.pathname !== "/api/history") return undefined;
		const t = url.searchParams.get("target"), before = url.searchParams.get("before") ?? "\uffff", limit = Number(url.searchParams.get("limit") ?? 150);
		const all = t === "main" ? MAIN : t === "lane:a" ? LANE : [];
		return json({ target: t, events: all.filter(e => e.ts < before).slice(-limit) });
	},
});
afterAll(() => hub.stop());

const landed = async (view: View) => {
	const { waitFor, ev } = on(view);
	await waitFor(`current === "chat" && tl.querySelector(".nt-hl") && timeline.clientHeight && !document.querySelector(".fs-bd")`);
	return ev<{ t: string; at: string; seen: boolean }>(`(() => {
		const m = tl.querySelector(".nt-hl").closest("[data-ts]"), r = m.getBoundingClientRect(), a = timeline.getBoundingClientRect();
		return { t: target, at: m.dataset.ts, seen: r.bottom > a.top && r.top < a.bottom };
	})()`);
};
const toast = (view: View, text: string) => on(view).waitFor(`$(".snack") && $(".snack").textContent.includes(${JSON.stringify(text)})`);
const home = async (width: number) => {
	const view = await hub.view({ width, height: 844 }, "/#home");
	await on(view).waitFor(`$('#v-home .hn[data-k="ended-work"] .hrx-m')`);
	return view;
};
const tapWork = (view: View, id: string) => on(view).run(`$('#v-home [data-work="${id}"] .hrx-m').click();`);
const projectSheet = async (width: number, kind: string) => {
	const view = await hub.view({ width, height: 844 }, "/#project/ch%3A1");
	const { waitFor, run } = on(view);
	await waitFor(`$('#v-project .pm-sec [data-k="${kind}"]')`);
	await run(`$('#v-project .pm-sec [data-k="${kind}"]').click();`);
	await waitFor(`$(".pdv .pdv-body .list")`);
	return view;
};

describe.each([["phone", 390], ["desktop", 1280]] as const)("%s", (_name, width) => {
	test("a finished work on 홈 lands on its result message, loading older history to reach it", async () => {
		const view = await home(width);
		await tapWork(view, "st_ok");
		expect(await landed(view)).toEqual({ t: "main", at: RESULT_AT, seen: true });
	});

	test("a finished work with no result message opens the closest place with the jump's toast", async () => {
		const view = await home(width);
		await tapWork(view, "st_lost");
		await on(view).waitFor(`current === "chat" && tl.querySelector("[data-ts]")`);
		await toast(view, "그 메시지가 없어서 가까운 곳을 열었어요");
		expect(await on(view).ev(`!!tl.querySelector(".nt-hl")`)).toBe(false);
	});

	test("a project's report row lands on the session's report, closing the page over it", async () => {
		const view = await projectSheet(width, "results");
		await on(view).run(`$(".pdv .pdv-body .list .li.tap").click();`);
		expect(await landed(view)).toEqual({ t: "lane:a", at: REPORT_AT, seen: true });
	});

	test("a project's recent session lands on its report; one without a report says so", async () => {
		const view = await projectSheet(width, "sessions");
		const { run, waitFor } = on(view);
		await run(`[...document.querySelectorAll(".pdv .srow")].find(r => r.dataset.t === "lane:a").click();`);
		expect(await landed(view)).toEqual({ t: "lane:a", at: REPORT_AT, seen: true });
		await run(`go("project", "ch:1"); pmSheet("sessions");`);
		await waitFor(`$(".pdv .srow[data-t='lane:b']")`);
		await run(`$(".pdv .srow[data-t='lane:b']").click();`);
		await waitFor(`current === "chat" && target === "lane:b"`);
		await toast(view, "그 메시지를 찾을 수 없어요");
		await waitFor(`!document.querySelector(".fs-bd")`);
	});
});
