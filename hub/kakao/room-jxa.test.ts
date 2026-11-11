// The send decisions of room.jxa.js itself (not a mock of its answer): the script is loaded with a stubbed ObjC bridge and a fake clock
// (jxa.fixture.ts) and its send step runs against a fake window, so what it types, presses and reports is observable.
import { expect, test } from "bun:test";
import { type AxRow, axList, fakeWindow, loadJxa } from "./jxa.fixture.ts";
import { normalizeTitle } from "./room.ts";

const jxa = loadJxa();
const sendWith = (w: ReturnType<typeof fakeWindow>, text: string, ours: string[] = [], priorPressed: string[] = []) => {
	jxa.setWindowNamed(() => w.win);
	return jxa.sendInto("가족방", text, ours, priorPressed);
};

test("inputVerdict: a prior press counts as pressed only for this very text; another pressed text is reported, never pressed", () => {
	expect(jxa.inputVerdict("", "메시지를 입력하세요", "B", [], [])).toBe("free");
	expect(jxa.inputVerdict("메시지를 입력하세요", "메시지를 입력하세요", "B", [], [])).toBe("free");
	expect(jxa.inputVerdict("A", "", "A", [], ["A"])).toBe("same_pressed");
	expect(jxa.inputVerdict("A".normalize("NFD"), "", "A", [], ["A"])).toBe("same_pressed");
	expect(jxa.inputVerdict("A", "", "B", ["A"], ["A"])).toBe("prior_left");
	expect(jxa.inputVerdict("B", "", "B", [], [])).toBe("ours");
	expect(jxa.inputVerdict("이전 글", "", "B", ["이전 글"], [])).toBe("ours");
	expect(jxa.inputVerdict("내가 쓰던 글", "", "B", ["이전 글"], ["A"])).toBe("owner");
});

test("a new text is not consumed by a different text pressed earlier: nothing is typed or pressed and the answer is not pressed", () => {
	const w = fakeWindow({ value: "A" });
	const r = sendWith(w, "B", [], ["A"]);
	expect(r).toMatchObject({ ok: false, why: "prior_left", left: "A" });
	expect(r.pressed).toBeUndefined();
	expect(w.presses()).toBe(0);
	expect(w.typed).toEqual([]);
	expect(w.value()).toBe("A");
});

test("the same text pressed earlier is never typed or pressed again", () => {
	const w = fakeWindow({ value: "A" });
	expect(sendWith(w, "A", [], ["A"])).toMatchObject({ ok: false, why: "prior_pressed", pressed: true });
	expect(w.presses()).toBe(0);
	expect(w.typed).toEqual([]);
});

test("a press that throws (an AppleEvent error after a delivered press) counts as pressed, so it is never retried as unsent", () => {
	const w = fakeWindow({
		press: () => {
			throw new Error("AppleEvent timed out (-1712)");
		},
	});
	const r = sendWith(w, "안녕");
	expect(r).toMatchObject({ ok: false, why: "press_error", pressed: true });
	expect(w.presses()).toBe(1);
	expect(w.typed).toEqual(["안녕"]);
});

test("a free input is typed once and pressed once; our own leftover is cleared and replaced", () => {
	const free = fakeWindow();
	expect(sendWith(free, "안녕")).toEqual({ ok: true });
	expect([free.typed, free.presses()]).toEqual([["안녕"], 1]);
	const leftover = fakeWindow({ value: "지난 글" });
	expect(sendWith(leftover, "새 글", ["지난 글"])).toEqual({ ok: true });
	expect([leftover.typed, leftover.presses()]).toEqual([["새 글"], 1]);
	const owner = fakeWindow({ value: "내가 쓰던 글" });
	expect(sendWith(owner, "새 글")).toMatchObject({ ok: false, why: "owner_text" });
	expect([owner.typed, owner.presses(), owner.value()]).toEqual([[], 0, "내가 쓰던 글"]);
});

test("rowStillIs: the row at open time must still show the title and whatever told it apart (member count, preview)", () => {
	const row = ["스터디", "4", "오후 4:58", "내일 봐요"];
	expect(jxa.rowStillIs(row, "스터디", undefined)).toBe(true);
	expect(jxa.rowStillIs(row, "스터디", { members: 4, preview: "내일 봐요" })).toBe(true);
	expect(jxa.rowStillIs(["스터디", "4", "오후 4:59", "어제 봐요"], "스터디", { members: 4, preview: "내일 봐요" })).toBe(false);
	expect(jxa.rowStillIs(["스터디", "5", "오후 4:58", "내일 봐요"], "스터디", { members: 4 })).toBe(false);
	expect(jxa.rowStillIs(row, "스터디", { noCount: true })).toBe(false);
	expect(jxa.rowStillIs(["스터디", "오후 4:58", "안녕"], "스터디", { noCount: true })).toBe(true);
	expect(jxa.rowStillIs(["다른방", "4"], "스터디", { members: 4 })).toBe(false);
});

// "도미솔❣️" in the database is U+2763 U+FE0F; KakaoTalk's AX title may carry U+2763 alone (or the other way round), and names differ in
// zero-width marks, spacing and a trailing member count. room.jxa.js filters the list rows and finds the window by its own rule, so that
// rule must be room.ts normalizeTitle exactly, or the row room.ts would accept is never even read.
test("the script's title rule is room.ts normalizeTitle: emoji variation selectors, zero-width marks, spacing and a member count", () => {
	const names = ["도미솔❣️", "도미솔\u2763", "도미솔❣️ ", "\u200b도미솔❣️", "스터디방 (5)", "스터디  방", "가족방\ufe0f", "한우🐮", "한우🐮\ufe0f", "Ａ방", "e\u0301방"];
	for (const n of names) expect(jxa.norm(n)).toBe(normalizeTitle(n));
	expect(jxa.norm("도미솔\u2763")).toBe(jxa.norm("도미솔\u2763\ufe0f"));
});

test("an emoji room is found in the list whether or not its title carries the variation selector the database name has", () => {
	const rows: AxRow[] = [{ title: "에르메스단" }, { title: "도미솔\u2763", preview: "고생띠이" }, { title: "나샤닥" }];
	const scan = loadJxa({ app: axList(rows) }).axScan("도미솔\u2763\ufe0f", true, 3_500, 1);
	expect(scan).toMatchObject({ stopped: "found", hits: [{ index: 1 }] });
	expect(scan!.hits[0]!.texts[0]).toBe("도미솔\u2763");
	const reverse = loadJxa({ app: axList([{ title: "한우" }, { title: "도미솔\u2763\ufe0f" }]) }).axScan("도미솔\u2763", true, 3_500);
	expect(reverse).toMatchObject({ stopped: "found", hits: [{ index: 1 }] });
});

// Measured 2026-11-11: AXShowMenu opens no menu for a row outside the window's visible rows (rows 0-7 of 299), and every row past them failed
// with no_menu. The row cell scrolls itself into view when AXScrollToVisible is set to the number 1 (a boolean is refused).
test("a row below the visible rows is scrolled into view before its menu is asked for, and the list is scrolled back after", () => {
	const rows: AxRow[] = Array.from({ length: 299 }, (_, i) => ({ title: `방 ${i}` }));
	const jxa = loadJxa({ app: axList(rows, { visible: 8 }) });
	const list = jxa.axListNative()!;
	expect(jxa.axVisibleRows(list.table)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	expect(jxa.axReveal(list, 3)).toEqual({ moved: false });
	const rev = jxa.axReveal(list, 287);
	expect(rev).toEqual({ moved: true, first: 0 });
	expect(jxa.axVisibleRows(list.table)).toContain(287);
	jxa.axRestore(list, rev);
	expect(jxa.axVisibleRows(list.table)[0]).toBe(0);
});

// The database lists more rooms than KakaoTalk's list shows, so the hint (the room's database index) overshoots and the row sits above it,
// usually at the very top (the room being answered got the newest message). Reading outward from the hint read the top rows last, after
// ~250 of 290, and a budget that covers ~175 rows ran out first: "시간 안에 방을 찾지 못했어요" on every rung.
test("a hint far below the row still finds a room at the top of a long list within the budget", () => {
	const rows: AxRow[] = Array.from({ length: 290 }, (_, i) => ({ title: i === 1 ? "도미솔❣️" : `방 ${i}` }));
	// ~5 AX reads a row at 4 ms: 20 ms a row, so 3.5 s covers ~175 rows.
	const scan = loadJxa({ app: axList(rows), msPerRead: 4 }).axScan("도미솔❣️", true, 3_500, 250);
	expect(scan).toMatchObject({ stopped: "found", hits: [{ index: 1 }] });
	expect(scan!.scanned).toBeLessThan(70);
	// The right hint still costs one row.
	expect(loadJxa({ app: axList(rows), msPerRead: 4 }).axScan("도미솔❣️", true, 3_500, 1)!.scanned).toBe(1);
	// A room that is not in the list is reported as the list end, every row read once.
	expect(loadJxa({ app: axList(rows) }).axScan("없는 방", true, 3_500, 250)).toMatchObject({ stopped: "end", scanned: 290, hits: [] });
});

// Measured on the real list: 299 rows, 358 database rooms; rows 281-298 had database indexes 345-357. A hint past the list end means the oldest
// rooms, which are the last rows: they are read from the bottom up, not after ~175 rows of a top-down read that the budget cuts off.
test("a hint past the list end finds a room at the very bottom of a 299-row list within the budget", () => {
	const rows: AxRow[] = Array.from({ length: 299 }, (_, i) => ({ title: i === 292 ? "도미솔❣️" : `방 ${i}` }));
	const scan = loadJxa({ app: axList(rows), msPerRead: 4 }).axScan("도미솔❣️", true, 3_500, 357);
	expect(scan).toMatchObject({ stopped: "found", hits: [{ index: 292 }] });
	expect(scan!.scanned).toBe(7);
	const last = loadJxa({ app: axList(rows), msPerRead: 4 }).axScan("방 298", true, 3_500, 357);
	expect(last).toMatchObject({ stopped: "found", hits: [{ index: 298 }], scanned: 1 });
});

// The list is a subset of the database rooms in the same order, so a row is not below its database index (pinned rooms: up to 9 rows above).
// A hint that overshoots by more than the scan radius is read downward from the hint, not from the top after 200 rows.
test("a hint that overshoots a lower-middle row by more than the scan radius finds it within the budget", () => {
	const rows: AxRow[] = Array.from({ length: 299 }, (_, i) => ({ title: i === 200 ? "도미솔❣️" : `방 ${i}` }));
	const scan = loadJxa({ app: axList(rows), msPerRead: 4 }).axScan("도미솔❣️", true, 3_500, 240);
	expect(scan).toMatchObject({ stopped: "found", hits: [{ index: 200 }] });
	expect(scan!.scanned).toBeLessThan(100);
	// A pinned room sits below its database index: still inside the neighbour window.
	const pinned = loadJxa({ app: axList(rows), msPerRead: 4 }).axScan("도미솔❣️", true, 3_500, 191);
	expect(pinned!.scanned).toBeLessThan(30);
});

test("the row opened last time is read first; a stale one costs one read and a room at the top is still found at once", () => {
	const rows: AxRow[] = Array.from({ length: 299 }, (_, i) => ({ title: i === 0 ? "도미솔❣️" : `방 ${i}` }));
	const scan = loadJxa({ app: axList(rows), msPerRead: 4 }).axScan("도미솔❣️", true, 3_500, 1, 0, 250);
	expect(scan).toMatchObject({ stopped: "found", hits: [{ index: 0 }] });
	expect(scan!.scanned).toBeLessThan(6);
	expect(loadJxa({ app: axList(rows), msPerRead: 4 }).axScan("방 250", true, 3_500, 3, 0, 250)).toMatchObject({ stopped: "found", scanned: 1 });
});

// 299 rows at 20 ms a row take 6 s, more than the 3.5 s the caller asks for: a room in the list is read anyway (the budget grows to the
// time the whole list needs), and a room that is not there ends at the list end instead of the clock.
test("a wrong hint cannot make a room that is in the list run out of time", () => {
	const rows: AxRow[] = Array.from({ length: 299 }, (_, i) => ({ title: i === 298 ? "도미솔❣️" : `방 ${i}` }));
	const scan = loadJxa({ app: axList(rows), msPerRead: 5 }).axScan("도미솔❣️", true, 3_500, 0);
	expect(scan).toMatchObject({ stopped: "found", hits: [{ index: 298 }], scanned: 299 });
	expect(loadJxa({ app: axList(rows), msPerRead: 5 }).axScan("없는 방", true, 3_500, 0)).toMatchObject({ stopped: "end", scanned: 299 });
});

// The main window stays open on the friends or more tab and shows no list table: that read as no_list. The chat tab button is pressed once.
test("a main window on another tab gets its chat tab pressed and the list is read", () => {
	const app = axList([{ title: "방 0" }, { title: "도미솔❣️" }]);
	const win = app.AXWindows[0] as { AXChildren: unknown[] };
	const lists = win.AXChildren;
	const tabs = { AXChildren: [] as unknown[] };
	let pressed = 0;
	win.AXChildren = tabs.AXChildren;
	tabs.AXChildren.push({ AXRole: "AXButton", AXIdentifier: "friends" }, { AXRole: "AXButton", AXIdentifier: "chatrooms", onPress: () => (pressed++, tabs.AXChildren.push(...lists)) });
	expect(loadJxa({ app }).axScan("도미솔❣️", true, 3_500, 1)).toMatchObject({ stopped: "found", hits: [{ index: 1 }] });
	expect(pressed).toBe(1);
	// No chat tab button and no list: still no_list.
	const bare = axList([{ title: "방 0" }]);
	(bare.AXWindows[0] as { AXChildren: unknown[] }).AXChildren = [];
	expect(loadJxa({ app: bare }).axScan("방 0", true, 3_500, 0)).toBeNull();
});
