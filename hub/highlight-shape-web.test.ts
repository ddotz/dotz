import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// A highlight is an overlay: lighting a card, bubble or plain message (web/css/09-notices.css) or changing its state in place (web/js/01-motion.js motionSwap)
// never touches the element's own box, in a headless browser against one fixture conversation at phone and desktop widths.
const ts = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, 0, i)).toISOString();
const EVENTS = [
	{ ts: ts(1), kind: "message", source: "owner", target: "main", text: "말풍선" },
	{ ts: ts(2), kind: "out", source: "orchestrator", target: "main", text: "평범한 답장" },
	{ ts: ts(3), kind: "out", system: true, source: "gateway", target: "main", worker: "st_a", text: "백그라운드 작업으로 맡겼어요: 시제품 제작" },
	{ ts: ts(4), kind: "out", live: true, source: "orchestrator", target: "main", text: "[run] 진행 상태" },
	{ ts: ts(5), kind: "lane_report", lane: "a", source: "lane:a", text: "[done] 세션 보고" },
	{ ts: ts(6), kind: "result", title: "빌드", text: "결과", source: "gateway", target: "main", open: "main" },
	{ ts: ts(7), kind: "watch", label: "가격", reason: "바뀜", source: "gateway", target: "main", text: "감시 결과" },
];
const hub = fakeHub({
	state: () => idleState({ work: [{ id: "st_a", description: "x", status: "running", started_at: Date.now() - 60_000 }], work_now: Date.now() }),
	api: (_req, url) => url.pathname === "/api/history" ? json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? EVENTS : [] }) : undefined,
});
afterAll(() => hub.stop());

const BOX = `const box = n => { const r = n.getBoundingClientRect(), c = getComputedStyle(n), kid = n.firstElementChild?.getBoundingClientRect(); return [r.x, r.width, r.height, kid?.x, c.borderTopLeftRadius, c.paddingLeft, c.paddingRight, c.marginLeft].join(" "); };`;

describe.each([390, 1280])("a highlight at %ipx", width => {
	test("leaves every message's box alone", async () => {
		const view = await hub.view({ width, height: 844 }, "/#chat/main");
		await on(view).waitFor(`tl.querySelector(".cv-task[data-ts]") && tl.querySelector(".bm.res[data-ts]")`);
		const moved = await on(view).ev<string[]>(`(() => { ${BOX} return [...tl.querySelectorAll("[data-ts]")].flatMap(n => {
			const { host } = ntHlHost(n), was = box(host); ntFlash(n);
			return box(host) === was ? [] : [\`\${host.className}: \${was} -> \${box(host)}\`];
		}); })()`);
		expect(moved).toEqual([]);
	});
	test("a work card keeps the ring on its own rounded shape", async () => {
		const view = await hub.view({ width, height: 844 }, "/#chat/main");
		await on(view).waitFor(`tl.querySelector(".cv-task[data-ts]")`);
		expect(await on(view).ev(`(() => { const n = tl.querySelector(".cv-task[data-ts]"); ntFlash(n); return [n.classList.contains("nt-bar"), getComputedStyle(n, "::after").borderTopLeftRadius === getComputedStyle(n).borderTopLeftRadius]; })()`)).toEqual([false, true]);
	});
	test("a KakaoTalk quote and an in-place state change keep the box too", async () => {
		const view = await hub.view({ width, height: 844 }, "/#chat/main");
		await on(view).waitFor(`tl.querySelector(".cv-task[data-ts]")`);
		expect(await on(view).ev(`(() => { ${BOX}
			const m = el("div", { class: "kk-m in" }, el("div", { class: "kk-bub", text: "말풍선" })), bub = m.firstChild; tl.append(m);
			const was = box(bub), fill = getComputedStyle(bub).backgroundColor; kkFlash(m);
			const task = tl.querySelector(".cv-task"); motionSwap(task, () => {});
			return [box(bub) === was, bub.getAnimations().length, getComputedStyle(bub).backgroundColor === fill, task.getAnimations().flatMap(a => a.effect.getKeyframes()).some(k => "transform" in k)];
		})()`)).toEqual([true, 0, true, false]);
	});
});
