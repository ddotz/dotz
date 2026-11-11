import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";
import { watchChoice } from "./watch.ts";
import { watchLine } from "./watchtext.ts";

// The 알림 conversation in a headless browser: the gateway's posts of a day are the rows of ONE list card, drawn by the 작업내역 row builder
// (web/js/11-worklog.js wlIs / wlNode), with no kind label; the owner's message, the answer to it, and a post that waits on a choice stay bubbles.
const iso = (h: number, m = 0) => `2026-11-08T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const alert = (ts: string, text: string, extra: object = {}) => ({ ts, kind: "out", source: "gateway", target: "alert", text, ...extra });
const CHOICE = `${watchLine("가격 확인", "failed 2 times in a row (exit 1)", "DOTZ_FAIL fetch")}\n${watchChoice("가격 확인", "failed 2 times in a row (exit 1)")}`;

const EVENTS = [
	alert(iso(1), "게이트웨이가 다시 켜졌어요."),
	alert(iso(2), "[fail] 게이트웨이 오류"),
	alert(iso(3), "백업이 끝났어요. 파일 열두 개를 옮겼어요."),
	alert(iso(4), CHOICE),
	alert(iso(5), "[done] 정리를 마쳤어요."),
	{ ts: iso(6), kind: "message", source: "web", target: "alert", mid: "m1", text: "방금 건 뭐였어?" },
	{ ts: iso(6, 1), kind: "out", source: "orchestrator", target: "alert", reply_to: "m1", text: "백업 알림이었어요." },
	alert(iso(7), "디스크가 거의 찼어요."),
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

type Row = { ts: string; wk: string; wst: string | null; role: string | null; tags: string[]; src: number; title: string; cls: string };
const rowsOf = `[...document.querySelectorAll("#tl .wl-row")].map(r => ({ ts: r.dataset.ts, wk: r.dataset.wk, wst: r.dataset.wst || null, role: r.getAttribute("role"),
	tags: [...r.querySelectorAll(".rc-hd > .tag")].map(t => t.textContent), src: r.querySelectorAll(".rc-src").length, title: (r.querySelector(".fr-sum") || {}).textContent || "", cls: r.className }))`;
const shapeOf = `[...document.querySelector("#tl").children].filter(n => !n.hidden && n.id !== "tl-top").map(n => n.classList.contains("wl-list") ? "list:" + n.querySelectorAll(":scope > .wl-row").length : n.classList.contains("a-div") ? "day" : n.classList.contains("um") ? "owner" : n.classList.contains("bm") ? "bubble" : n.className)`;

for (const width of [390, 1280]) {
	const view = await hub.view({ width, height: 900 });
	const { waitFor } = on(view);
	const page = async <T>(expr: string) => (await view.evaluate(`JSON.stringify(${expr})`).then(s => JSON.parse(s as string))) as T;

	test(`${width}px: the posts of a day are rows of one list card; the owner's message, its answer and a post with a choice stay bubbles`, async () => {
		await view.navigate(`${hub.origin}/`);
		await waitFor(`typeof openTarget === "function" && S`);
		await view.evaluate(`(openTarget("alert", "chat"), 0)`);
		await waitFor(`document.querySelectorAll("#tl .wl-row").length === 5`);
		expect(await page<string[]>(shapeOf)).toEqual(["day", "list:3", "bubble", "list:1", "owner", "bubble", "list:1"]);
		expect(await page<number>(`document.querySelectorAll("#tl .wl-row .um, #tl .wl-row .mn").length`)).toBe(0);
		// the post with a choice block is drawn whole as an alert bubble, never folded into a row
		expect(await page<string[]>(`[...document.querySelectorAll("#tl > .bm[data-ts='${iso(4)}']")].map(n => n.className)`)).toEqual(["bm alert"]);
	});

	test(`${width}px: no kind label; a post with no state is a plain row, a failed one carries its tag`, async () => {
		const rows = await page<Row[]>(rowsOf);
		const by = (ts: string) => rows.find(r => r.ts === ts)!;
		expect(rows.every(r => r.wk === "alert" && r.src === 0)).toBe(true);
		const plain = by(iso(1));
		expect([plain.wst, plain.tags, plain.role, plain.cls.includes("wl-plain"), plain.title]).toEqual([null, [], null, true, "게이트웨이가 다시 켜졌어요"]);
		const fail = by(iso(2));
		expect([fail.wst, fail.tags]).toEqual(["fail", ["실패"]]);
		expect(by(iso(5)).tags).toEqual(["완료"]);
	});

	test(`${width}px: a post that says more unfolds in place; a plain row still opens its notice`, async () => {
		await view.evaluate(`document.querySelector("#tl .wl-row[data-ts='${iso(3)}']").click()`);
		await waitFor(`document.querySelector("#tl .wl-row[data-ts='${iso(3)}']").classList.contains("fr-open")`);
		expect(await page<number>(`document.querySelectorAll("#tl .wl-row[data-ts='${iso(3)}'] .cc-act .btn").length`)).toBe(1);
		await view.evaluate(`(() => { window.__opened = []; noticeOpen = (...a) => { window.__opened.push(a[1]); }; document.querySelector("#tl .wl-row[data-ts='${iso(7)}']").click(); })()`);
		await waitFor(`window.__opened.length === 1`);
		expect(await page<boolean>(`document.querySelector("#tl .wl-row[data-ts='${iso(7)}']").classList.contains("fr-open")`)).toBe(false);
	});
}
