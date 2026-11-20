import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on, type View } from "./test-web.ts";

const iso = (m: number) => new Date(Date.UTC(2026, 10, 20, 0, 0) + m * 60_000).toISOString();
const row = (id: string, m: number, o: Record<string, unknown>) => ({ id, cls: "news", kind: "watch", tone: "", text: "", open: "main", src: "main", at: iso(m), ts: iso(m), updated: iso(m), read: false, ...o });
const DOCTOR = "실패한 도구 호출이 어제 12번에서 38번으로 늘었고 비싼 모델을 쓴 세션도 2개 있어요 · 원인을 찾아볼까요?";
const notices = [
	row("doc", 50, { cls: "ask", kind: "decision", tone: "ask", title: DOCTOR, text: "닥터", open: "alert", src: "alert", decision: { options: [{ n: 1, label: "찾아봐요", desc: "" }, { n: 2, label: "이번엔 둬요", desc: "" }], to: "alert", group: 1, state: "open" } }),
	row("task", 40, { cls: "result", title: "sample-2 피드백 일일 보고", text: "어제는 불편·재요청이 없었어요", key: "schedule:r1", nk: "schedule", at: iso(45) }),
	row("remind", 30, { title: "회의 알림", text: "예약한 일이 시작됐어요", key: "schedule:r2" }),
	row("legacy", 20, { title: "예약", text: "예약한 일이 시작됐어요" }),
];
const hub = fakeHub({
	slowTimers: true,
	state: () => idleState({ notices_unread: notices.filter(n => !n.read).length }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/update") return json({ settings: { auto_apply: false } });
		if (p === "/api/notices" && req.method === "GET") return json({ items: notices, unread: notices.filter(n => !n.read).length, gone: [] });
		if (p === "/api/notices/read" || p === "/api/read") return json({ ok: true, unread: 0 });
		return undefined;
	},
});
afterAll(() => hub.stop());

async function open(width: number): Promise<View> {
	const v = await hub.view({ width, height: 844 });
	await v.navigate(`${hub.origin}/#notices`);
	await on(v).waitFor(`typeof NT !== "undefined" && NT.loaded && current === "notices" && document.querySelector('#v-notices .nsc-r[data-nid="legacy"]')`);
	return v;
}
const hd = (id: string) => `document.querySelector('#v-notices .nsc-r[data-nid="${id}"] .hd')`;

describe("the 알림 screen's schedule and question rows", () => {
	test("at 390 a doctor card's title keeps its question whole and shortens the matter before it", async () => {
		const v = await open(390);
		const box = await on(v).ev<{ text: string; q: string; qFits: boolean; qInside: boolean; cut: boolean }>(`(() => { const h = ${hd("doc")}, q = h.querySelector(".q"), w = h.querySelector(".w"), hr = h.getBoundingClientRect(), qr = q.getBoundingClientRect(); return { text: h.textContent, q: q.textContent, qFits: q.scrollWidth <= q.clientWidth + 1, qInside: qr.right <= hr.right + 1 && qr.left >= hr.left, cut: w.scrollWidth > w.clientWidth }; })()`);
		expect(box).toEqual({ text: DOCTOR, q: " · 원인을 찾아볼까요?", qFits: true, qInside: true, cut: true });
		expect(await on(v).ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
	}, 30_000);

	test("a title with no question tail stays one plain title", async () => {
		const v = await open(1280);
		expect(await on(v).ev(`[${hd("task")}.querySelector(".q"), ${hd("task")}.textContent]`)).toEqual([null, "sample-2 피드백 일일 보고"]);
	}, 30_000);

	test("a task run, a reminder and a stored 예약 row are tagged as schedules, the run under its own name", async () => {
		const v = await open(390);
		const tags = await on(v).ev<string[]>(`["task", "remind", "legacy"].map(id => document.querySelector('#v-notices .nsc-r[data-nid="' + id + '"] .tag').textContent)`);
		expect(new Set(tags).size).toBe(1);
		expect(tags[0]).toBe(await on(v).ev(`TX("misc.nsc.tag_sched")`));
		expect(await on(v).ev(`${hd("task")}.textContent`)).toBe("sample-2 피드백 일일 보고");
	}, 30_000);

	test("a tap on a task run's row lands on its conversation at the answer", async () => {
		const v = await open(390);
		const { run, waitFor, ev } = on(v);
		await run(`window.__jumps = []; const jump = ntJump; ntJump = (n, ...a) => (window.__jumps.push([ntWhere(n), n.at]), jump(n, ...a));`);
		await run(`document.querySelector('#v-notices .nsc-r[data-nid="task"] .nsc-tx').click()`);
		await waitFor(`current === "chat" && target === MAIN`);
		expect(await ev(`window.__jumps`)).toEqual([["main", iso(45)]]);
	}, 30_000);
});
