import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// The home screen always shows its very top first, in a headless browser at 344 / 390 / 1100px against a fixture with many lanes and notices
// (a page far taller than the screen): on load, after a shell reload that remembers a scroll (23-installable-app-web.js SHELL_RESTORE),
// on returning to the home tab, and when the installed app comes back to the front (visibilitychange / pageshow).
const lanes = Array.from({ length: 14 }, (_, i) => ({ name: `lane${i}`, status: i % 2 ? "working" : "idle", live: true, alive: true }));
const notices = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, kind: "message", tone: "ask", src: "main", open: "main", at: new Date(Date.UTC(2026, 9, 20, 1, i)).toISOString(), title: `질문 ${i}`, text: `질문 ${i}번이에요`, read: false }));

const hub = fakeHub({
	state: idleState({ orchestrator: { status: "working" }, lanes, notices_unread: notices.length }),
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: notices.length, items: notices });
	},
});

const errors: string[] = [];
const view = await hub.view({ console: (type, ...args) => { if (type === "error") errors.push(args.map(String).join(" ")); } });
afterAll(() => hub.stop());
const { waitFor } = on(view);
// Frames until the scroller has held one value for 20 frames in a row (late data and timers have landed), then that value.
const settled = () => view.evaluate(`new Promise(res => { let last = -1, same = 0; const tick = () => { const st = $("#views").scrollTop; same = st === last ? same + 1 : 0; last = st; if (same >= 20) res(st); else requestAnimationFrame(tick); }; tick(); })`) as Promise<number>;
const boot = async (pre = "") => {
	await view.navigate(`${hub.origin}/`);
	if (pre) await view.evaluate(pre);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && S && current === "home" && $("#home-now").children.length`);
};
const tall = () => view.evaluate(`$("#views").scrollHeight - $("#views").clientHeight`) as Promise<number>;

for (const [w, h] of [[344, 740], [390, 844], [1100, 800]] as const) {
	describe(`home at ${w}px`, () => {
		test("opens at the top, also after a shell reload that remembered a scroll", async () => {
			await view.resize?.(w, h);
			errors.length = 0;
			await boot();
			expect(await tall()).toBeGreaterThan(200);
			await view.evaluate(`console.error("probe")`);
			await waitFor(`true`);
			expect(errors.pop()).toContain("probe");
			expect(await settled()).toBe(0);
			// the same page after an automatic shell reload: the saved scroll must not bring the home screen back down
			await view.navigate(`${hub.origin}/#home`);
			await view.evaluate(`sessionStorage.setItem("dotz-shell-reload", JSON.stringify({ at: Date.now(), hash: "#home", views: 400 }))`);
			await view.navigate(`${hub.origin}/`);
			await waitFor(`typeof NT !== "undefined" && NT.loaded && S && current === "home" && $("#home-now").children.length`);
			expect(await settled()).toBe(0);
			expect(errors).toEqual([]);
		});

		test("returns to the top on the home tab and when the app comes back to the front", async () => {
			await boot();
			await view.evaluate(`($("#views").scrollTop = 300, go("projects"), go("home"), 0)`);
			expect(await settled()).toBe(0);
			await view.evaluate(`($("#views").scrollTop = 300, document.dispatchEvent(new Event("visibilitychange")), 0)`);
			expect(await settled()).toBe(0);
			await view.evaluate(`($("#views").scrollTop = 300, dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })), 0)`);
			expect(await settled()).toBe(0);
			expect(errors).toEqual([]);
		});
	});
}
