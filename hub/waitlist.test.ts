// 할일 (hub/waitlist.ts): the list the gateway reads from its own state.
import { expect, test } from "bun:test";
import type { BgWork } from "./bgwork.ts";
import { buildWaitlist, waitlistSweep } from "./waitlist.ts";

const at = (n: number) => new Date(Date.UTC(2026, 10, 4, 3, n)).toISOString();
const worker = (id: string, n: number, more = {}): BgWork => ({ id, description: id, status: "running", queued: true, started_at: Date.parse(at(n)), ...more });
const none = { deferred: [], lanes: [], work: [] };

test("workers, held sessions and deferred work are one list, oldest first", () => {
	const list = buildWaitlist({
		deferred: [{ id: "d", what: "미룬 일", resume_at: at(50), since: at(2) }],
		lanes: [{ name: "s", title: "세션 일", waiting: "메모리 여유가 없어 대기 중", live: false, startedAt: at(1) }],
		work: [worker("w", 3), { ...worker("run", 0), queued: undefined }],
	});
	expect(list.map(i => [i.kind, i.title])).toEqual([["session", "세션 일"], ["limit", "미룬 일"], ["worker", "w"]]);
});

test("a session both held and deferred is one row, with the resume time", () => {
	const list = buildWaitlist({ ...none, deferred: [{ id: "s", lane: "s", what: "일", resume_at: at(50), since: at(1) }], lanes: [{ name: "s", waiting: "한도", startedAt: at(0) }] });
	expect(list.map(i => [i.kind, i.target])).toEqual([["limit", "lane:s"]]);
});

test("deferred work whose session started, running or finished since, has left the list; an ended session not yet resumed has not", () => {
	const deferred = [{ id: "s", lane: "s", what: "일", since: at(5) }];
	expect(buildWaitlist({ ...none, deferred, lanes: [{ name: "s", live: true, startedAt: at(1) }] })).toEqual([]);
	expect(buildWaitlist({ ...none, deferred, lanes: [{ name: "s", live: false, startedAt: at(9) }] })).toEqual([]);
	expect(buildWaitlist({ ...none, deferred, lanes: [{ name: "s", live: false, startedAt: at(1) }] })).toHaveLength(1);
});

test("the sweep pushes once per change and nothing while the list holds", () => {
	let list = buildWaitlist({ ...none, work: [worker("w", 1)] });
	const pushed: unknown[][] = [];
	const sweep = waitlistSweep(() => list, items => pushed.push(items));
	sweep();
	sweep();
	list = [];
	sweep();
	expect(pushed.map(p => p.length)).toEqual([1, 0]);
});
