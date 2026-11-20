import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { paths } from "./config.ts";
import { msg } from "./i18n.ts";
import { advance, clock } from "./runtime/test-clock.ts";
import { hardTask, type Schedule, type ScheduleNaming } from "./schedule.ts";
import type * as ScheduleModule from "./schedule.ts";

type Store = typeof ScheduleModule;
const at = new Date(clock.now + 86_400_000).toISOString();
const old = (id: string, text: string, extra: object = {}) => ({ id, text, at, created: "2026-11-01T00:00:00.000Z", ...extra });
const LEGACY = [
	old("a00001", "매일 sample-2 상태를 `bun run check` 로 확인"),
	old("b00002", "sample-2 소식 알려줘", { conv: "ch:100" }),
	old("c00003", "3시에 회의 알려줘"),
	old("d00004", "sample-2 점검", { kind: "check" }),
	old("e00005", "[routine:r1:abcdef] sample-3\np"),
	old("f00006", "~/example/notes 정리", { kind: "owner", keep: { by: "a newer version" } }),
];
const stores: Store[] = [];
let loads = 0;
const load = async (entries: object[]): Promise<Store> => {
	writeFileSync(paths.schedules, `${JSON.stringify(entries, null, 2)}\n`);
	const store: Store = await import(`./schedule.ts?naming-${++loads}`);
	stores.push(store);
	return store;
};
const deps = () => {
	const woke: string[] = [], posted: string[] = [];
	const naming: ScheduleNaming = { wake: text => void woke.push(text), post: line => void posted.push(line) };
	return { woke, posted, naming };
};
const byId = (store: Store, id: string): Schedule => store.listSchedules().find(s => s.id === id)!;
const onDisk = (id: string) => JSON.parse(readFileSync(paths.schedules, "utf8")).find((s: { id: string }) => s.id === id);
afterEach(() => {
	for (const s of stores.splice(0)) s.stopSchedules();
	rmSync(paths.scheduleNaming, { force: true });
});

test("an old file loads as it is; hard signs make a task at once, the assistant names the rest in one quiet wake, and it never runs again", async () => {
	const store = await load(LEGACY);
	expect(store.listSchedules()).toEqual(LEGACY);
	const { woke, posted, naming } = deps();
	store.startSchedules(() => {}, naming);
	expect(woke).toHaveLength(1);
	for (const id of ["a00001", "b00002", "c00003", "d00004", "f00006"]) expect(woke[0]).toContain(id);
	expect(woke[0]).not.toContain("e00005");
	expect(byId(store, "a00001").kind).toBe("task");
	expect(byId(store, "b00002").kind).toBe("task");
	expect(byId(store, "f00006").kind).toBe("task");
	expect(byId(store, "c00003").kind).toBeUndefined();
	expect(byId(store, "d00004").kind).toBe("check");
	expect(posted).toEqual([]);

	store.patchSchedule("a00001", { name: "sample-2 확인" }, true);
	store.patchSchedule("b00002", { name: "sample-2 소식", kind: "owner" }, true);
	store.patchSchedule("c00003", { name: "회의", kind: "task" }, true);
	store.patchSchedule("d00004", { name: "sample-2 점검" }, true);
	expect(posted).toEqual([]);
	store.patchSchedule("f00006", { name: "sample-3 정리" }, true);
	expect(byId(store, "c00003").kind).toBe("task");
	expect(byId(store, "b00002").kind).toBe("task");
	expect(onDisk("f00006")).toMatchObject({ name: "sample-3 정리", kind: "task", keep: { by: "a newer version" } });
	expect(byId(store, "e00005").name).toBeUndefined();
	expect(posted).toEqual([msg().scheduleNamed([{ name: "sample-2 확인", kind: "task" }, { name: "sample-2 소식", kind: "task" }, { name: "회의", kind: "task" }, { name: "sample-2 점검", kind: "check" }, { name: "sample-3 정리", kind: "task" }])]);

	const again = deps();
	const next = await load(LEGACY);
	next.startSchedules(() => {}, again.naming);
	await advance(60 * 60_000);
	expect(again.woke).toEqual([]);
	expect(again.posted).toEqual([]);
	expect(next.listSchedules()).toEqual(LEGACY);
	rmSync(paths.scheduleNaming);
});

test("with no answer in time a reminder stays a reminder and is named from its text; the line still goes out once", async () => {
	const store = await load([old("c00003", "3시에 회의 알려줘")]);
	const { woke, posted, naming } = deps();
	store.startSchedules(() => {}, naming);
	expect(woke).toHaveLength(1);
	await advance(store.NAMING_WAIT_MS - 1000);
	expect(posted).toEqual([]);
	await advance(1000);
	const c = byId(store, "c00003");
	expect(store.scheduleKind(c)).toBe("owner");
	expect(c.name).toBe("3시에 회의 알려줘");
	expect(posted).toEqual([msg().scheduleNamed([{ name: "3시에 회의 알려줘", kind: "owner" }])]);
	expect(posted[0]).toMatch(/모니터링|Monitoring/);
});

test("an edit that lands after the deadline keeps a hard id a task and is told once more, in one line; a second edit is not told again", async () => {
	const store = await load([old("a00001", "sample-2 `bun run check`"), old("c00003", "3시에 회의 알려줘")]);
	const { posted, naming } = deps();
	store.startSchedules(() => {}, naming);
	await advance(store.NAMING_WAIT_MS);
	expect(posted).toHaveLength(1);
	store.patchSchedule("a00001", { name: "sample-2 확인", kind: "owner" }, true);
	store.patchSchedule("c00003", { name: "회의", kind: "task" }, true);
	expect(byId(store, "a00001").kind).toBe("task");
	expect(posted).toHaveLength(1);
	await advance(store.LATE_POST_MS);
	expect(posted[1]).toBe(msg().scheduleNamed([{ name: "sample-2 확인", kind: "task" }, { name: "회의", kind: "task" }]));
	store.patchSchedule("c00003", { name: "주간 회의", kind: "owner" }, true);
	await advance(store.LATE_POST_MS);
	expect(posted).toHaveLength(2);
	expect(byId(store, "c00003").kind).toBe("owner");
});

test("the owner's own kind edit in settings during the late window stays as he set it and is not told as a naming edit", async () => {
	const store = await load([old("a00001", "sample-2 `bun run check`")]);
	const { posted, naming } = deps();
	store.startSchedules(() => {}, naming);
	await advance(store.NAMING_WAIT_MS);
	expect(posted).toHaveLength(1);
	store.patchSchedule("a00001", { name: "sample-2 알림", kind: "owner" });
	await advance(store.LATE_POST_MS);
	expect(store.scheduleKind(byId(store, "a00001"))).toBe("owner");
	expect(posted).toHaveLength(1);
	store.patchSchedule("a00001", { name: "sample-2 확인", kind: "owner" }, true);
	expect(store.scheduleKind(byId(store, "a00001"))).toBe("owner");
});

test("a restart while the assistant is naming does not wake it again and keeps the deadline", async () => {
	const first = await load([old("c00003", "3시에 회의 알려줘")]);
	const one = deps();
	first.startSchedules(() => {}, one.naming);
	first.stopSchedules();
	await advance(10 * 60_000);
	const second = await load(JSON.parse(readFileSync(paths.schedules, "utf8")));
	const two = deps();
	second.startSchedules(() => {}, two.naming);
	expect(two.woke).toEqual([]);
	await advance(second.NAMING_WAIT_MS - 10 * 60_000);
	expect(two.posted).toHaveLength(1);
	expect(one.posted).toEqual([]);
});

test("a wake that fails leaves every unjudged entry a reminder at once", async () => {
	const store = await load([old("c00003", "3시에 회의 알려줘"), old("a00001", "sample-2 `bun run check`")]);
	const posted: string[] = [];
	store.startSchedules(() => {}, { wake: () => { throw new Error("model down"); }, post: line => void posted.push(line) });
	expect(store.scheduleKind(byId(store, "c00003"))).toBe("owner");
	expect(byId(store, "a00001").kind).toBe("task");
	expect(posted).toHaveLength(1);
});

test("an install with nothing to name marks the naming done without a wake or a line", async () => {
	const store = await load([]);
	const { woke, posted, naming } = deps();
	store.startSchedules(() => {}, naming);
	expect([woke, posted]).toEqual([[], []]);
	expect(JSON.parse(readFileSync(paths.scheduleNaming, "utf8")).state).toBe("done");
});

test("an entry of a kind this version does not know loads, acts as a reminder and is written back with its kind and fields", async () => {
	const later = old("g00007", "sample-2", { name: "sample-2", kind: "later-kind", extra: [1, 2] });
	const store = await load([later]);
	expect(store.listSchedules()).toEqual([later]);
	expect(store.scheduleKind(byId(store, "g00007"))).toBe("owner");
	store.patchSchedule("g00007", { paused: true });
	expect(onDisk("g00007")).toEqual({ ...later, paused: true });
});

test("the hard signs: a backtick command, a file path, a ch:/lane: target or an instruction verb, never the language", async () => {
	for (const text of ["`ls`", "/Users/example/a 봐 줘", "./bin/run 결과", "notes.md 읽기", "lane:sample-2 상황", "ch:1 상황", "매일 결과 보고해", "PR 올려", "테스트 돌려", "run the report"]) expect(hardTask({ text })).toBe(true);
	for (const text of ["3시에 회의 알려줘", "remind me of the 3 pm meeting", "약 먹을 시간", "sample-2 생일", "책상 정리해", "https://example.com/a/b.html 다시 알려줘"]) expect(hardTask({ text })).toBe(false);
	expect(hardTask({ text: "3시에 회의 알려줘", conv: "ch:5" })).toBe(true);
	expect(hardTask({ text: "3시에 회의 알려줘", conv: "th:5" })).toBe(false);
});
