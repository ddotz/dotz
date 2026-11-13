import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// An unfolded row of the 알림 conversation is the only fold of its message: no `details` inside it, no monospace block for a plain Korean alert,
// and the head line is on screen once. The doctor's post is a kind of its own (`wk: "doctor"`): the kind is the row's label, not a word of the title or the body.
const iso = (h: number, m = 0) => `2026-11-08T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const alert = (ts: string, text: string, extra: object = {}) => ({ ts, kind: "out", source: "gateway", target: "alert", text, ...extra });
const LIST = ["- 디스크가 차고 있어요. 남은 공간 12GB (9%).", "- 반복·실패 작업이 늘었어요: 정리 작업 (+38%)", "- 로그인이 풀린 채예요 (6시간째)."].join("\n");
const DOCTOR = `닥터 점검: 살펴볼 것이 3가지 있어요\n${LIST}`;
const PROVIDER = "정리 담당: 모델 제공자 오류(fetch failed: ECONNRESET)가 3번 재시도해도 계속돼서 멈췄어요";

const T = { doctor: iso(1), old: iso(2), plain: iso(3), raw: iso(4), bubblePlain: iso(5, 1), bubbleRaw: iso(5, 2) };
const EVENTS = [
	alert(T.doctor, DOCTOR, { wk: "doctor" }),
	alert(T.old, DOCTOR),
	alert(T.plain, `백업이 끝났어요\n${LIST}`),
	alert(T.raw, PROVIDER),
	{ ts: iso(5), kind: "message", source: "web", target: "alert", mid: "m1", text: "방금 건 뭐였어?" },
	alert(T.bubblePlain, `백업이 끝났어요\n${LIST}`, { reply_to: "m1" }),
	alert(T.bubbleRaw, PROVIDER, { reply_to: "m1" }),
];

const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "alert" ? EVENTS : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
afterAll(() => hub.stop());

type Open = { fold: number; pre: number; li: number; head: number; label: string; labelText: string; bodyHasLabel: boolean; btn: number; wk: string };
const row = (ts: string) => `document.querySelector('#tl .wl-row[data-ts="${ts}"]')`;

for (const width of [390, 1280]) {
	const view = await hub.view({ width, height: 900 });
	const { waitFor } = on(view);
	const page = async <T>(expr: string) => (await view.evaluate(`JSON.stringify(${expr})`).then(s => JSON.parse(s as string))) as T;
	const unfold = async (ts: string) => {
		await view.evaluate(`${row(ts)}.click()`);
		await waitFor(`${row(ts)}.classList.contains("fr-open")`);
	};
	const openOf = (ts: string) =>
		page<Open>(`(() => { const r = ${row(ts)}, full = r.querySelector(".wl-full"), src = r.querySelector(".rc-hd .rc-src");
			return { fold: r.querySelectorAll("details").length, pre: r.querySelectorAll("pre").length, li: r.querySelectorAll("li").length,
				head: (r.textContent.match(/살펴볼 것이 3가지|백업이 끝났어요/g) || []).length, label: src ? "yes" : "", labelText: src ? src.textContent : "",
				bodyHasLabel: full.textContent.includes(TX("home.worklog.doctor") + ":"), btn: r.querySelectorAll(".cc-act .btn").length, wk: r.dataset.wk }; })()`);

	test(`${width}px: the doctor's post carries its kind as the row's label; the title does not say it again`, async () => {
		await view.navigate(`${hub.origin}/`);
		await waitFor(`typeof openTarget === "function" && S`);
		await view.evaluate(`(openTarget("alert", "chat"), 0)`);
		await waitFor(`document.querySelectorAll("#tl .wl-row").length === 4`);
		const r = await page<{ wk: string; src: string[]; want: string; title: string }>(`({ wk: ${row(T.doctor)}.dataset.wk, src: [...${row(T.doctor)}.querySelectorAll(".rc-hd > .rc-src")].map(n => n.textContent),
			want: TX("home.worklog.doctor"), title: ${row(T.doctor)}.querySelector(".fr-sum").textContent })`);
		expect(r.wk).toBe("doctor");
		expect(r.src).toEqual([r.want]);
		expect(r.title.includes(`${r.want}:`)).toBe(false);
	});

	test(`${width}px: the unfolded doctor row is its head line once, the list as a list, and 접기 — no second fold`, async () => {
		await unfold(T.doctor);
		const o = await openOf(T.doctor);
		expect(o).toMatchObject({ fold: 0, pre: 0, li: 3, head: 1, label: "yes", bodyHasLabel: false, btn: 1, wk: "doctor" });
		expect(o.labelText).not.toBe("");
	});

	test(`${width}px: a plain alert, and an older doctor post with no kind, unfold to the whole text once as markdown`, async () => {
		for (const ts of [T.old, T.plain]) {
			await unfold(ts);
			expect(await openOf(ts)).toMatchObject({ fold: 0, pre: 0, li: 3, head: 1, btn: 1 });
		}
	});

	test(`${width}px: a rewritten alert shows its raw text directly in the unfolded row, and folds it in a bubble`, async () => {
		await unfold(T.raw);
		const o = await page<{ fold: number; pre: number; raw: string; said: number }>(`(() => { const r = ${row(T.raw)}; return { fold: r.querySelectorAll("details").length, pre: r.querySelectorAll("pre").length,
			raw: (r.querySelector("pre") || {}).textContent || "", said: r.querySelectorAll(".md").length }; })()`);
		expect(o.fold).toBe(0);
		expect(o.pre).toBe(1);
		expect(o.raw).toContain("ECONNRESET");
		expect(o.said).toBe(1);
		const b = await page<{ fold: number; pre: number; li: number }>(`(() => { const n = document.querySelector('#tl > .bm[data-ts="${T.bubbleRaw}"]'); return { fold: n.querySelectorAll("details.more").length, pre: n.querySelectorAll("pre").length, li: n.querySelectorAll("li").length }; })()`);
		expect(b).toEqual({ fold: 1, pre: 1, li: 0 });
		const p = await page<{ fold: number; pre: number; li: number }>(`(() => { const n = document.querySelector('#tl > .bm[data-ts="${T.bubblePlain}"]'); return { fold: n.querySelectorAll("details").length, pre: n.querySelectorAll("pre").length, li: n.querySelectorAll("li").length }; })()`);
		expect(p).toEqual({ fold: 0, pre: 0, li: 3 });
	});

	test(`${width}px: 홈's card line and the bell list still say what a doctor item is`, async () => {
		const n = await page<{ alertLine: string; worklogLine: string }>(`({
			alertLine: hcLine({ kind: "alert", title: "닥터 점검", text: ${JSON.stringify(DOCTOR)}, ts: "${T.doctor}" }),
			worklogLine: hcLine({ kind: "worklog", wk: "doctor", title: "작업 기록", text: ${JSON.stringify("스스로 고친 것: 모니터링 가격 확인.")}, ts: "${T.doctor}" }) })`);
		expect(n.alertLine).toContain("닥터 점검");
		expect(n.worklogLine).toContain("스스로 고친 것");
	});
}
