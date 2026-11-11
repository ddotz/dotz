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
