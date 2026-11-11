import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, on } from "./test-web.ts";

// The gateway's status in a chat, drawn from the same text Discord gets: head line with the status tag, one row per fact, muted
// recent steps. An update replaces it where it stands, and no row wraps or overflows at a phone's width.
const ts = "2026-11-05T00:54:00.000Z";
const text = "[run] 5분째 작업 중이에요.\n지금: 판례와 기준서 원문을 함께 대조해서 평가액을 다시 확인하는 중이에요 정말 긴 문장\n최근 작업:\n- 환율 확인\n- 집계 확인\n- 그 밖에 5건 더";
const note = { ts, kind: "out", source: "gateway", target: "main", update_key: "progress", live: true, text };
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? [note] : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 412, height: 800 });
afterAll(() => hub.stop());
const { waitFor } = on(view);

test("a live status draws as rows, stays on one line each and fits a phone", async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await view.evaluate(`(openTarget("main", "chat"), 0)`);
	await waitFor(`!!document.querySelector(".lv .lv-s")`);
	const seen = await ev<{ tag: string; lead: string; now: string; head: string; steps: string[]; wide: boolean; rows: number }>(view, `(() => {
		const lv = document.querySelector(".lv"), row = lv.querySelector(".lv-r"), steps = [...lv.querySelectorAll(".lv-s")];
		return { tag: lv.querySelector(".st-tag").textContent, lead: lv.querySelector("p").textContent, now: row.textContent, head: lv.querySelector(".lv-h").textContent, steps: steps.map(s => s.textContent),
			wide: lv.getBoundingClientRect().right > innerWidth, rows: Math.round(row.getBoundingClientRect().height / parseFloat(getComputedStyle(row).lineHeight)) };
	})()`);
	expect(seen.tag).toBe("진행 중");
	expect(seen.lead).toContain("5분째 작업 중이에요.");
	expect(seen.now.startsWith("지금: ")).toBe(true);
	expect(seen.head).toBe("최근 작업");
	expect(seen.steps).toEqual(["최근 작업", "환율 확인", "집계 확인", "그 밖에 5건 더"]);
	expect(seen.wide).toBe(false);
	expect(seen.rows).toBe(1);
});
