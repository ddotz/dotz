import { afterAll, afterEach, expect, test } from "bun:test";
import { ev, fakeHub, inbox, json, run, waitFor } from "./test-web.ts";

// The open conversation against a history that moves under it (web/js/99-boot.js reset, web/js/13-data.js loadTarget): a message sent between the first
// history answer and the stream's opening is still read, and a resync whose newest page starts past the stored rows marks the gap between them.
const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString();
const row = (i: number) => ({ ts: at(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` });

let history: (url: URL) => object[] = () => [];
const asked = inbox<URL>();
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname !== "/api/history") return undefined;
		asked.push(url);
		return json({ events: url.searchParams.get("target") === "main" ? history(url) : [] });
	},
});
afterEach(() => { hub.release(); asked.length = 0; });
afterAll(() => hub.stop());

test("a message sent between the history answer and the stream's first reset is drawn", async () => {
	let late = false;
	history = () => (late ? [row(1), row(2)] : [row(1)]);
	const opened = hub.nextStream();
	const v = await hub.view({}, "/#chat");
	await waitFor(v, `typeof ts === "function" && ts("main").hLoaded && ts("main").msgs.length === 1`);
	await opened;
	late = true;
	for (const c of hub.streams) c.enqueue(new TextEncoder().encode("event: reset\nid: r1\ndata: {}\n\n"));
	await waitFor(v, `document.querySelectorAll("#tl [data-ts]").length === 2`);
	expect(await ev(v, `[ts("main").msgs.length, document.querySelectorAll("#tl [data-ts]").length]`)).toEqual([2, 2]);
});

test("a full newest page past the stored rows marks a gap that reads the messages after them", async () => {
	let full = false;
	history = url => (url.searchParams.has("before") || url.searchParams.has("after") ? [] : full ? Array.from({ length: 150 }, (_, i) => row(501 + i)) : Array.from({ length: 10 }, (_, i) => row(1 + i)));
	const v = await hub.view({}, "/#chat");
	await waitFor(v, `typeof ts === "function" && ts("main").hLoaded && ts("main").msgs.length === 10`);
	full = true;
	await v.evaluate(`loadTarget(target, true).then(() => 0)`);
	expect(await ev(v, `[ts("main").msgs.length, ts("main").gaps.has(${JSON.stringify(at(10))})]`)).toEqual([160, true]);
	await run(v, "chatWiden()");   // the drawn stretch is the newest 50 rows; reaching its top widens it to the stored rows, gap included
	expect(await ev(v, `document.querySelectorAll("#tl .msg-gap").length`)).toBe(1);
	await run(v, `document.querySelector("#tl .msg-gap button").click()`);
	const got = await asked.until(us => us.some(u => u.searchParams.has("after")), 10_000, "a gap read");
	expect(got.find(u => u.searchParams.has("after"))?.searchParams.get("after")).toBe(at(10));
});
