import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// A finished job's result sits far back in a long conversation, beyond what the jump pages through (web/js/30-notices.js ntReach): the tap
// must still land on that message, and only a message the gateway no longer holds gets the toast.
const ts = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, 0, i)).toISOString();
const says = (i: number) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` });
const MAIN = Array.from({ length: 1800 }, (_, i) => says(i));   // 1800 events: 150 first, then four pages of 300, reach back to index 450
const DEEP_AT = ts(100), GONE_AT = "2026-10-20T01:01:40.500Z";
const work = [{ id: "w1", description: "정리", status: "done", started_at: 1, ended_at: 2, result_at: DEEP_AT, result_conv: "main" }, { id: "w2", description: "지운 것", status: "done", started_at: 1, ended_at: 2, result_at: GONE_AT, result_conv: "main" }];

const hub = fakeHub({
	state: () => idleState({ work, work_now: Date.now() }),
	api: (_req, url) => {
		if (url.pathname === "/api/history") {
			const before = url.searchParams.get("before"), around = url.searchParams.get("around"), limit = Number(url.searchParams.get("limit") ?? 60) || 60;
			if (around) {
				const hit = MAIN.findIndex(e => e.ts === around);
				if (hit < 0) return json({ target: "main", events: [] });
				const lo = Math.max(0, hit - (limit >> 1));
				return json({ target: "main", events: MAIN.slice(lo, lo + limit), at: MAIN[hit]!.ts, prev: MAIN[lo - 1]?.ts, next: MAIN[lo + limit]?.ts });
			}
			const list = before ? MAIN.filter(e => e.ts < before) : MAIN;
			return json({ target: "main", events: list.slice(-limit) });
		}
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
afterAll(() => hub.stop());

// Both page back through 1800 messages: 20s, not the default 5s, so a busy machine running other work does not fail them.
describe.each([["phone", 390], ["desktop", 1280]] as const)("%s", (_name, width) => {
	test("a finished job's result far back in the conversation is landed on", async () => {
		const view = await hub.view({ width, height: 844 }, "/#home");
		const { run, waitFor, ev } = on(view);
		await waitFor(`S && S.work && S.work.length === 2`);
		await run(`workGo({ id: "w1" });`);
		await waitFor(`tl.querySelector(".nt-hl")`);
		expect(await ev(`[target, tl.querySelector(".nt-hl").closest("[data-ts]").dataset.ts, !!$(".snack")]`)).toEqual(["main", DEEP_AT, false]);
	}, 20_000);

	test("a result message that is gone keeps the toast", async () => {
		const view = await hub.view({ width, height: 844 }, "/#home");
		const { run, waitFor, ev } = on(view);
		await waitFor(`S && S.work && S.work.length === 2`);
		await run(`workGo({ id: "w2" });`);
		await waitFor(`$(".snack")`);
		expect(await ev(`[target, !!$(".snack"), !!tl.querySelector(".nt-hl")]`)).toEqual(["main", true, false]);
	}, 20_000);
});
