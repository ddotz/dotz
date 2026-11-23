import { afterAll, afterEach, expect, test } from "bun:test";
import { fakeHub, idleState, inbox, json, on } from "./test-web.ts";

const ts = (i: number) => new Date(Date.UTC(2026, 10, 20, 1, 0, i)).toISOString();
const RES_AT = ts(3), OTHER_AT = ts(4);
const LANE = Array.from({ length: 40 }, (_, i) => ({ ts: ts(i), kind: "lane_report", lane: "b", source: "lane:b", text: i === 3 ? "[done] 빌드가 끝났어요" : `[done] ${i}단계를 마쳤어요` }));
const base = { read: false, tone: "done", text: "내용", cls: "result", kind: "result" };
const notices = [
	{ ...base, id: "res", title: "빌드 세션", open: "lane:b", src: "lane:b", key: "lane:b", ts: RES_AT, updated: RES_AT, at: RES_AT },
	{ ...base, id: "other", title: "다른 세션", open: "lane:c", src: "lane:c", key: "lane:c", ts: OTHER_AT, updated: OTHER_AT, at: OTHER_AT },
];
const seen = inbox<unknown>();
let hubReads = 1;
const hub = fakeHub({
	state: () => ({ ...idleState(), lanes: [{ name: "b", title: "빌드 세션", status: "idle", kind: "work" }], notices_unread: notices.length }),
	api: async (req, url) => {
		if (url.pathname === "/api/history") {
			const before = url.searchParams.get("before"), list = before ? LANE.filter(e => e.ts < before) : LANE;
			return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "lane:b" ? list.slice(-Number(url.searchParams.get("limit") ?? 60) || -60) : [] });
		}
		if (url.pathname === "/api/notices") return json({ unread: notices.length, items: notices });
		if (url.pathname === "/api/notices/seen" && req.method === "POST") {
			seen.push(await req.json());
			return json({ ok: true, read: hubReads, unread: notices.length - hubReads });
		}
	},
});
afterEach(() => hub.release());
afterAll(() => hub.stop());

test("opening the lane scrolled away from the result leaves it unread; scrolling its message into view reads it, and only it", async () => {
	const view = await hub.view({ width: 390, height: 844 }, "/#home");
	const { waitFor, ev, run } = on(view);
	await waitFor(`NT.loaded`);
	await run(`openTarget("lane:b", "chat")`);
	await waitFor(`CV.placed && [...tl.querySelectorAll("[data-ts]")].some(m => m.dataset.ts === ${JSON.stringify(RES_AT)})`);
	await waitFor(`timeline.scrollTop > 0`);
	await view.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))`);
	const away = await ev<{ shown: boolean; read: boolean }>(`(() => {
		const m = [...tl.querySelectorAll("[data-ts]")].find(x => x.dataset.ts === ${JSON.stringify(RES_AT)}), r = m.getBoundingClientRect(), a = timeline.getBoundingClientRect();
		return { shown: r.bottom > a.top && r.top < a.bottom, read: ntById("res").read };
	})()`);
	expect(away).toEqual({ shown: false, read: false });
	expect(seen).toEqual([]);
	await run(`[...tl.querySelectorAll("[data-ts]")].find(x => x.dataset.ts === ${JSON.stringify(RES_AT)}).scrollIntoView({ block: "center" })`);
	await waitFor(`ntById("res").read`);
	expect(seen).toEqual([{ target: "lane:b", ts: RES_AT }]);
	expect(await ev<boolean>(`ntById("other").read`)).toBe(false);
}, 30_000);

test("a seen message the hub does not read (its notice now waits on the owner) shows unread again, from the hub's own list", async () => {
	seen.length = 0;
	hubReads = 0;
	try {
		const view = await hub.view({ width: 390, height: 844 }, "/#home");
		const { waitFor, run } = on(view);
		await waitFor(`NT.loaded`);
		await run(`openTarget("lane:b", "chat")`);
		await waitFor(`CV.placed && [...tl.querySelectorAll("[data-ts]")].some(m => m.dataset.ts === ${JSON.stringify(RES_AT)})`);
		await run(`[...tl.querySelectorAll("[data-ts]")].find(x => x.dataset.ts === ${JSON.stringify(RES_AT)}).scrollIntoView({ block: "center" })`);
		await seen.until(s => s.length > 0, 5_000, "seen POST");
		expect(seen).toEqual([{ target: "lane:b", ts: RES_AT }]);
		await waitFor(`!ntById("res").read && NT.unread === ${notices.length}`, 5_000);
	} finally {
		hubReads = 1;
	}
}, 30_000);
