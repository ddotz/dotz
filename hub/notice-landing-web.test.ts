import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, inbox, json, on, type View } from "./test-web.ts";

const ts = (i: number) => new Date(Date.UTC(2026, 10, 20, 1, 0, i)).toISOString();
const MAIN = Array.from({ length: 60 }, (_, i) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` }));
const SCHED_AT = ts(30), UPD_AT = ts(70), ALERT_AT = ts(80), WORK_AT = ts(90);
const ALERTS = [
	{ ts: ts(79), kind: "out", source: "gateway", target: "alert", text: "게이트웨이가 다시 켜졌어요." },
	{ ts: ALERT_AT, kind: "out", source: "gateway", target: "alert", text: "백업이 끝났어요. 파일 열두 개를 옮겼어요." },
];
const WORKLOG = [{ ts: WORK_AT, kind: "out", source: "gateway", target: "worklog", text: "정리를 마쳤어요. 파일 열두 개를 옮겼어요." }];
const base = { read: false, tone: "" };
const notice = (id: string, at: string, o: object) => ({ ...base, id, ts: at, updated: at, at, ...o });
const notices = [
	notice("sched", SCHED_AT, { kind: "watch", cls: "news", title: "예약", text: "예약한 일이 시작됐어요", open: "main", src: "main" }),
	notice("sched2", ts(31), { kind: "watch", cls: "news", title: "예약", text: "예약 점검이 끝났어요", open: "main", src: "main" }),
	notice("watch", ts(32), { kind: "watch", cls: "news", title: "디스크 감시", text: "사용량이 늘었어요", open: "alert", src: "alert", watch: "disk" }),
	notice("upd", UPD_AT, { kind: "alert", cls: "news", title: "새 버전", text: "새 버전이 있어요. 설정 → 업데이트에서 적용해요", open: "settings", src: "settings", key: "self-update" }),
	notice("al", ALERT_AT, { kind: "alert", cls: "alert", title: "알림", text: "백업이 끝났어요. 파일 열두 개를 옮겼어요.", open: "alert", src: "alert" }),
	notice("wl", WORK_AT, { kind: "worklog", cls: "news", title: "작업내역", text: "정리를 마쳤어요. 파일 열두 개를 옮겼어요.", open: "worklog", src: "worklog" }),
];
const monitor = { name: "디스크 감시", watch: "disk", kind: "watch", every: "1시간마다", last_result: "ok", last_run: ts(300), next_run: ts(900) };

const reads = inbox<string>();
const hub = fakeHub({
	state: () => ({ ...idleState(), notices_unread: notices.length }),
	api: async (req, url) => {
		if (url.pathname === "/api/history") {
			const t = url.searchParams.get("target"), before = url.searchParams.get("before");
			const all = t === "main" ? MAIN : t === "alert" ? ALERTS : t === "worklog" ? WORKLOG : [];
			return json({ target: t, events: (before ? all.filter(e => e.ts < before) : all).slice(-60) });
		}
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices" && req.method === "GET") return json({ unread: notices.length, items: notices });
		if (url.pathname === "/api/notices/read") {
			const { ids } = (await req.json()) as { ids: string[] };
			reads.push(...ids);
			return json({ unread: 0 });
		}
		if (url.pathname === "/api/update") return json({ settings: { auto_apply: false } });
		if (url.pathname === "/api/monitors") return json({ items: [monitor] });
	},
});
afterAll(() => hub.stop());

const open = async (width: number): Promise<View> => {
	reads.length = 0;
	const view = await hub.view({ width, height: 844 }, "/#notices");
	await on(view).waitFor(`NT.loaded && current === "notices" && $('#v-notices .nsc-r[data-nid="sched"]')`);
	return view;
};
const tap = async (view: View, id: string) => {
	await on(view).run(`const was = noticeOpen; noticeOpen = (...a) => (window.__landed = was(...a)); $('#v-notices .nsc-r[data-nid="${id}"] .nsc-tx').click();`);
	await view.evaluate(`window.__landed.then(() => 0)`);
};

describe("the row of a schedule's notice", () => {
	test("keeps the first word of its text when the title is only the start of that word", async () => {
		const view = await open(390);
		expect(await on(view).ev(`$('#v-notices .nsc-r[data-nid="sched"] .nsc-s').textContent`)).toBe("예약한 일이 시작됐어요");
	});
	test("drops the title when the text says it as a word of its own", async () => {
		const view = await open(390);
		expect(await on(view).ev(`$('#v-notices .nsc-r[data-nid="sched2"] .nsc-s').textContent`)).toBe("점검이 끝났어요");
	});
});

describe("a tapped notice", () => {
	test("of a schedule opens the conversation on the message of its run, and reads it", async () => {
		const view = await open(390);
		await tap(view, "sched");
		const { ev } = on(view);
		expect(await ev(`[current, target, tl.querySelector(".nt-hl").closest("[data-ts]").dataset.ts]`)).toEqual(["chat", "main", SCHED_AT]);
		await reads.until(r => r.includes("sched"), 10_000, "the notice read");
	});
	test("of a watch still opens 모니터링 on its row", async () => {
		const view = await open(390);
		await tap(view, "watch");
		const { ev } = on(view);
		expect(await ev(`[current, $("#mon-tl .nt-hl").closest("[data-nid]").dataset.nid]`)).toEqual(["monitoring", "watch"]);
	});
	test("of the new version opens 설정 → 업데이트", async () => {
		const view = await open(390);
		await tap(view, "upd");
		expect(await on(view).ev(`current`)).toBe("update");
	});
	test("of the new version's push opens 설정 → 업데이트 with the page open", async () => {
		const view = await open(390);
		await view.evaluate(`pushOpen("#settings", ${JSON.stringify(UPD_AT)}, "upd").then(() => 0)`);
		expect(await on(view).ev(`current`)).toBe("update");
	});
	test.each([["알림", "al", "alert", ALERT_AT], ["작업내역", "wl", "worklog", WORK_AT]])("of the %s conversation lands on the post unfolded", async (_name, id, conv, at) => {
		const view = await open(390);
		await tap(view, id);
		const { ev } = on(view);
		expect(await ev(`(() => { const r = tl.querySelector(".nt-hl").closest(".wl-row"); return [current, target, r.dataset.ts, r.classList.contains("fr-open"), !!r.querySelector(".wl-full")]; })()`)).toEqual(["chat", conv, at, true, true]);
	});
});
