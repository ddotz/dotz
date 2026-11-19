import { afterAll, expect, test } from "bun:test";
import { advanceSettled, ev, fakeHub, json, run, waitFor } from "./test-web.ts";

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;
const sentItem = (ref: string, to: string, at: number, today?: boolean) => ({
	item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at,
	can: { send: false, revise: false, edit: false, drop: false, restore: false },
	draft: { state: "sent", toLabel: "받는이", to, text: `보낸 답장 ${ref}` },
	original: { who: to, text: "자료 되나요?" },
	send: { state: "sent", at, how: "owner", actions: [], ...(today === undefined ? {} : { today }) },
});
let gatewayMidnightPassed = false;
let reads = 0;
const hub = fakeHub({
	slowTimers: true,
	headScript: `const R = Date; window.__off = ${NOW} - R.now(); window.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + window.__off); } static now() { return R.now() + window.__off; } };`,
	api: (req, url) => {
		if (url.pathname !== "/api/reply/queue" || req.method !== "GET") return undefined;
		reads++;
		return json({
			items: [
				sentItem("RNOFLAGNOW", "now-noflag@example.com", NOW),
				sentItem("RNOFLAGOLD", "old-noflag@example.com", NOW - 2 * DAY),
				sentItem("RFLAGYES", "flag-yes@example.com", NOW - 2 * DAY, !gatewayMidnightPassed),
				sentItem("RFLAGNO", "flag-no@example.com", NOW - 1000, false),
			],
			counts: {}, triageMin: 1, undoSec: 10,
		});
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());

const sentRows = () => ev<string[]>(view, `[...document.querySelectorAll("#mon-timeline .rq-r.sent .tx")].map(n => n.textContent).sort()`);

await view.navigate(`${hub.origin}/`);
await waitFor(view, `typeof rqRows === "function" && RA.loaded && RQ.loaded`);
await run(view, `go("monitoring", "replies")`);
await waitFor(view, `document.querySelectorAll("#mon-timeline .rq-r.sent").length > 0`);

test("a sent row is today by the gateway's own flag when it sends one, by the browser's midnight when it does not (an older peer)", async () => {
	expect((await sentRows()).map(r => /(now-noflag|old-noflag|flag-yes|flag-no)@/.exec(r)?.[1])).toEqual(["flag-yes", "now-noflag"]);
});

test("a page left open past local midnight reads the queue again and drops the sent rows that are no longer today", async () => {
	const toMidnight = await ev<number>(view, `new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1).getTime() - Date.now() + 1000`);
	await advanceSettled(view, toMidnight - 30_000);
	expect((await sentRows()).length).toBe(2);
	const before = reads;
	gatewayMidnightPassed = true;
	await run(view, `window.__off += ${toMidnight}`);
	for (let step = 0; step < 5; step++) await advanceSettled(view, 10_000);
	await waitFor(view, `document.querySelectorAll("#mon-timeline .rq-r.sent").length === 0`);
	expect(reads).toBeGreaterThan(before);
	expect(await sentRows()).toEqual([]);
});
