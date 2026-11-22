import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { paths } from "./config.ts";
import { emit, eventTarget, historyEvents, tailEvents, type HubEvent } from "./events.ts";
import { shownEvent } from "./owner-text.ts";
import { withWorklogKind } from "./worklog-kind.ts";

afterEach(() => {
	rmSync(paths.inbox, { force: true });
	rmSync(paths.outbox, { force: true });
});

const sortedAfterSelecting = (target: string, before?: string): HubEvent[] => {
	let all = [...tailEvents(paths.inbox), ...tailEvents(paths.outbox)].filter(e => typeof e.ts === "string" && eventTarget(e) === target && (!before || e.ts < before));
	all.sort((a, b) => a.ts.localeCompare(b.ts));
	if (target === "alert" || target === "worklog") {
		const last = new Map<string, HubEvent>();
		for (const e of all) if (e.kind === "out" && typeof e.update_key === "string" && e.update_key) last.set(e.update_key, e);
		all = all.filter(e => !(e.kind === "out" && typeof e.update_key === "string" && e.update_key) || last.get(e.update_key) === e);
	}
	return all;
};
const expected = (target: string, before?: string) => sortedAfterSelecting(target, before).map(e => withWorklogKind(shownEvent(e)));
const TARGETS = ["main", "alert", "worklog", "lane:a", "lane:b", "ch:1500000000000000001", "mail:zele-x", "quick"];

let seed = 20261119;
const rnd = (n: number) => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed % n;
};
const stamp = () => `2026-11-19T0${rnd(3)}:${String(rnd(4) * 15).padStart(2, "0")}:${String(rnd(4)).padStart(2, "0")}.${rnd(2) ? "000" : "500"}Z`;
const randomEvent = (n: number): { box: "inbox" | "outbox"; event: HubEvent } => {
	const target = TARGETS[rnd(TARGETS.length)]!;
	const fixed = target === "alert" || target === "worklog";
	if (rnd(3) === 0) return { box: "inbox", event: { ts: stamp(), kind: "message", source: "web", channel: target === "main" ? "web" : target, text: `m${n}` } };
	const kind = rnd(8) === 0 ? "watch" : "out";
	return { box: "outbox", event: { ts: stamp(), kind, source: "orchestrator", target: fixed ? `web:${target}` : target, text: `o${n}`, ...(fixed && rnd(2) ? { update_key: `k${rnd(3)}` } : {}) } };
};
const pageOf = (target: string, before?: string) => historyEvents(target, 100_000, before);
const sameEverywhere = (note: string) => {
	for (const target of TARGETS) {
		expect(pageOf(target), `${note}: ${target}`).toEqual(expected(target));
		const before = stamp();
		expect(pageOf(target, before), `${note}: ${target} before ${before}`).toEqual(expected(target, before));
	}
};

test("a conversation's history is what sorting every event of both logs gives, as the logs grow, hold a half-written line, and are rewritten", () => {
	for (let round = 0, n = 0; round < 40; round++) {
		for (let i = rnd(12) + 1; i > 0; i--) {
			const { box, event } = randomEvent(n++);
			emit(box, event);
		}
		sameEverywhere(`round ${round}`);
	}
	appendFileSync(paths.outbox, `${JSON.stringify({ ts: "2026-11-19T01:00:00.250Z", kind: "out", source: "orchestrator", target: "lane:a", text: "half" }).slice(0, 40)}`);
	sameEverywhere("half-written line");
	writeFileSync(paths.outbox, `${JSON.stringify({ ts: "2026-11-19T00:00:01.000Z", kind: "out", source: "orchestrator", target: "lane:a", text: "after rewrite" })}\n`);
	sameEverywhere("rewritten log");
});

test("lines pushed out of the 4 MB window leave the history exactly as a fresh read of the window does", () => {
	const pad = "x".repeat(200_000);
	const row = (n: number) => `${JSON.stringify({ ts: `2026-11-19T00:00:${String(10 + (n % 40)).padStart(2, "0")}.000Z`, kind: "out", source: "orchestrator", target: n % 2 ? "lane:a" : "main", text: `w${n}${pad}` })}\n`;
	for (let n = 0; n < 12; n++) appendFileSync(paths.outbox, row(n));
	for (const target of ["lane:a", "main"]) expect(pageOf(target)).toEqual(expected(target));
	for (let n = 12; n < 40; n++) {
		appendFileSync(paths.outbox, row(n));
		for (const target of ["lane:a", "main"]) expect(pageOf(target).map(e => e.text)).toEqual(expected(target).map(e => e.text));
	}
	expect(pageOf("lane:a").length).toBeLessThan(20);
});

test("a history call sorts nothing once the logs are read: an appended event costs a few comparisons, not a sort of the conversation", () => {
	for (let n = 0; n < 2000; n++) emit("outbox", { ts: `2026-11-19T00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`, kind: "out", source: "orchestrator", target: "lane:a", text: `s${n}` });
	expect(pageOf("lane:a")).toHaveLength(2000);
	const sorts = spyOn(Array.prototype, "sort");
	const compares = spyOn(String.prototype, "localeCompare");
	try {
		pageOf("lane:a");
		emit("outbox", { ts: "2026-11-19T01:00:00.000Z", kind: "out", source: "orchestrator", target: "lane:a", text: "newest" });
		const page = pageOf("lane:a");
		expect(page.at(-1)?.text).toBe("newest");
		expect(sorts).not.toHaveBeenCalled();
		expect(compares.mock.calls.length).toBeLessThan(2 * 2001 + 10);
	} finally {
		sorts.mockRestore();
		compares.mockRestore();
	}
});
