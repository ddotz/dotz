// The send decisions of room.jxa.js itself (not a mock of its answer): the script is loaded with a stubbed ObjC bridge and a fake clock
// (jxa.fixture.ts) and its send step runs against a fake window, so what it types, presses and reports is observable.
import { expect, test } from "bun:test";
import { fakeWindow, loadJxa } from "./jxa.fixture.ts";

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
