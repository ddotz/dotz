import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on, type View } from "./test-web.ts";

// A tapped quote ends on its original (web/js/39-reply.js rpJump), also when the original is far outside what the page has loaded: the page around it
// comes in one request and lands at once, the stretch between it and the rest is a gap, and a gone original is a short toast. Headless browser, fixture
// conversations of 1,000 messages, at phone and desktop widths.
const ts = (i: number) => new Date(Date.UTC(2026, 9, 1, 1, 0, i)).toISOString();
const owner = (conv: object, i: number) => ({ ts: ts(i), kind: "message", source: "web", ...conv, mid: `m${i}`, author: "나", text: `질문 ${i}번이에요.` });
const says = (conv: object, i: number) => ({ ts: ts(i), kind: "out", source: "orchestrator", ...conv, text: `답 ${i}번이에요.` });
const talk = (conv: object) => [
	...Array.from({ length: 1000 }, (_, i) => (i % 2 ? says(conv, i) : owner(conv, i))),
	{ ...says(conv, 1000), reply: { id: "m100", author: "나", content: "질문 100번이에요." } },
	{ ...says(conv, 1001), reply: { id: "m1001", author: "나", content: "지워진 질문이에요." } },
	{ ...says(conv, 1002), reply: { id: "m860", author: "나", content: "질문 860번이에요." } },
];
const LOGS: Record<string, ReturnType<typeof talk>> = { main: talk({ channel: "web", target: "main" }), "ch:7": talk({ channel: "ch:7", target: "ch:7" }) };
let reads: string[] = [];
let hold: Promise<void> | undefined;

const hub = fakeHub({
	slowTimers: true,   // the page's own polls and prefetches (a worklog read) run only when a test says so, never between two reads of the test
	state: () => ({ ...idleState(), channels: { work: [{ id: "7", name: "공사", project: "공사" }] } }),
	api: async (_req, url) => {
		if (url.pathname === "/api/history") {
			const all = LOGS[url.searchParams.get("target") ?? ""] ?? [], limit = Number(url.searchParams.get("limit") ?? 150);
			const [before, around, after] = ["before", "around", "after"].map(k => url.searchParams.get(k));
			reads.push(url.search);
			if (around || after) await hold;
			if (around) {
				const i = all.findIndex(e => e.ts === around || ("mid" in e && e.mid === around));
				if (i < 0) return json({ target: "main", events: [] });
				const lo = Math.max(0, i - limit / 2);
				return json({ target: "main", events: all.slice(lo, lo + limit), at: all[i]!.ts, prev: all[lo - 1]?.ts, next: all[lo + limit]?.ts });
			}
			if (after) {
				const lo = all.findIndex(e => e.ts > after);
				return json({ target: "main", events: all.slice(lo, lo + limit), prev: all[lo - 1]?.ts, next: all[lo + limit]?.ts });
			}
			const list = before ? all.filter(e => e.ts < before) : all;
			return json({ target: url.searchParams.get("target"), events: list.slice(-limit) });
		}
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
	},
});
afterAll(() => hub.stop());

const open = async (width: number, t = "main") => {
	const view = await hub.view({ width, height: 844 }, `/#chat/${encodeURIComponent(t)}`);
	const { waitFor, run } = on(view);
	await waitFor(`typeof go === "function"`);
	await run(`go("chat", ${JSON.stringify(t)})`);
	await waitFor(`target === ${JSON.stringify(t)} && ts(target).hLoaded && CV.placed && tl.querySelectorAll(".rpq").length === 3`);
	reads = [];
	return view;
};
// The quote of the answer that names `id` (fixture: index among the three quotes at the bottom).
const press = (view: View, n: number) => on(view).run(`tl.querySelectorAll(".rpq")[${n}].click()`);
const landed = async (view: View) => {
	const { waitFor, ev } = on(view);
	await waitFor(`tl.querySelector(".nt-hl") && CV.pin === "at"`);
	return ev<{ rid: string; seen: boolean }>(`(() => {
		const m = tl.querySelector(".nt-hl").closest("[data-rid]"), r = m.getBoundingClientRect(), a = timeline.getBoundingClientRect();
		return { rid: m.dataset.rid, seen: r.bottom > a.top && r.top < a.bottom };
	})()`);
};

describe("a quote whose original is not loaded", () => {
	for (const [name, width] of [["phone", 390], ["desktop", 1280]] as const) test(`lands on the original in one request on a ${name}`, async () => {
		const view = await open(width);
		const { ev, run } = on(view);
		expect(await ev(`!!tl.querySelector('[data-rid="m100"]')`)).toBe(false);
		await run(`window.__shown = []; new MutationObserver(() => __shown.push(tl.querySelectorAll("[data-rid]").length)).observe(tl, { childList: true })`);
		await press(view, 0);
		expect(await landed(view)).toEqual({ rid: "m100", seen: true });
		expect(reads).toEqual([expect.stringContaining("around=m100")]);
		expect(await ev(`ts(target).msgs.length < 400`)).toBe(true);
		// one redraw: the view never shows the pages in between
		expect(await ev(`__shown.filter((n, i) => i && n < __shown[i - 1] && n > 0).length`)).toBe(0);
	});

	test("the conversation of a project jumps the same way", async () => {
		const view = await open(390, "ch:7");
		await press(view, 0);
		expect(await landed(view)).toEqual({ rid: "m100", seen: true });
		expect(reads).toEqual([expect.stringMatching(/target=ch%3A7.*around=m100/)]);
	});

	test("only the pressed quote shows the loading mark, and it goes with the jump", async () => {
		const view = await open(390);
		const { ev, waitFor } = on(view);
		let go = () => {};
		hold = new Promise(r => { go = r; });
		await press(view, 0);
		await waitFor(`tl.querySelector(".rpq.busy")`);
		expect(await ev(`tl.querySelectorAll(".busy").length`)).toBe(1);
		expect(await ev(`tl.querySelectorAll(".rpq")[0].classList.contains("busy")`)).toBe(true);
		go(); hold = undefined;
		await landed(view);
		expect(await ev(`tl.querySelectorAll(".busy").length`)).toBe(0);
	});

	test("the stretch between the page and the rest is a gap that fills in place", async () => {
		const view = await open(1280);
		const { ev, run, waitFor } = on(view);
		await press(view, 0);
		await landed(view);
		expect(await ev(`tl.querySelectorAll(".msg-gap").length`)).toBe(1);
		const above = () => ev<number>(`Math.round(tl.querySelector('[data-rid="m100"]').getBoundingClientRect().top)`);
		const top = await above();
		await run(`chatUnpin(); tl.querySelector(".msg-gap button").click()`);
		await waitFor(`ts(target).msgs.some(e => e.mid === "m300")`);
		expect(await above()).toBe(top);
		expect(reads.at(-1)).toContain("after=");
		expect(await ev(`tl.querySelectorAll(".msg-gap").length`)).toBe(1);
		// the pages meet the stored rest: no gap stays
		for (let i = 0; i < 6 && await ev(`!!tl.querySelector(".msg-gap")`); i++) {
			const n = await ev<number>(`ts(target).msgs.length`);
			await run(`tl.querySelector(".msg-gap button").click()`);
			await waitFor(`ts(target).msgs.length > ${n}`);
		}
		expect(await ev(`!!tl.querySelector(".msg-gap")`)).toBe(false);
		const rows = await ev<number[]>(`ts(target).msgs.map(e => Date.parse(e.ts))`);
		expect(new Set(rows).size).toBe(rows.length);
	});

	test("an original that is stored but not drawn needs no request", async () => {
		const view = await open(390);
		const { ev } = on(view);
		expect(await ev(`!tl.querySelector('[data-rid="m860"]') && ts(target).msgs.some(e => e.mid === "m860")`)).toBe(true);
		await press(view, 2);
		expect((await landed(view)).rid).toBe("m860");
		expect(reads).toEqual([]);
		expect(await ev(`tl.querySelectorAll(".msg-gap").length`)).toBe(0);
	});
});

test("an original that no longer exists is a short toast and the view stays", async () => {
	const view = await open(390);
	const { ev, waitFor } = on(view);
	const before = await ev<number>(`timeline.scrollTop`);
	await press(view, 1);
	await waitFor(`[...document.querySelectorAll(".snack")].some(n => n.textContent.includes("원래 메시지"))`);
	expect(await ev(`tl.querySelectorAll(".busy, .nt-hl").length`)).toBe(0);
	expect(await ev(`timeline.scrollTop`)).toBe(before);
});

test("a jump to a drawn original scrolls smoothly, and at once under reduced motion", async () => {
	const view = await open(390);
	const { ev } = on(view);
	await press(view, 2);
	expect((await landed(view)).rid).toBe("m860");
	const asked = (reduced: boolean) => ev<string>(`(() => {
		const mm = window.matchMedia, was = Element.prototype.scrollIntoView; let got = "";
		window.matchMedia = q => q.includes("prefers-reduced-motion") ? { matches: ${reduced}, addEventListener() {}, removeEventListener() {} } : mm.call(window, q);
		Element.prototype.scrollIntoView = function (o) { got = o && o.behavior; };
		try { rpJump("m860"); } finally { window.matchMedia = mm; Element.prototype.scrollIntoView = was; }
		return got;
	})()`);
	expect(await asked(false)).toBe("smooth");
	expect(await asked(true)).toBe("auto");
});
