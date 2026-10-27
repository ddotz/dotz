import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseRow, inputFree, normalizeInput, normalizeTitle, REFUSE, rowPreview, sameText, type RoomFact } from "./room.ts";
import { sendText } from "./send.ts";
import { kakaoPaths, type Runner } from "./types.ts";
import { type FakeRow, fakeScreen } from "./ui.fixture.ts";

let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kk-room-"));
	paths = kakaoPaths(dir, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const send = (rows: FakeRow[], room: RoomFact, all: RoomFact[], opts: Parameters<typeof fakeScreen>[1] = {}) => {
	const screen = fakeScreen(rows, opts);
	return sendText({ chatId: room.chatId, roomName: room.name, text: "안녕" }, { paths, runner: screen.runner, roomNames: async () => all }).then(r => ({ r, screen }));
};

const direct: RoomFact = { chatId: "1", name: "민수", kind: "direct", members: 2 };
const groupA: RoomFact = { chatId: "2", name: "민수", kind: "group", members: 5 };
const groupB: RoomFact = { chatId: "3", name: "민수", kind: "group", members: 7 };
const family: RoomFact = { chatId: "40", name: "가족방", kind: "group", members: 4 };
const familyRow: FakeRow = { id: "chat_f", title: "가족방", count: 4, window: { title: "가족방", members: 4 } };

test("the exact room is found among rows with badge noise, unicode forms and zero-width marks, and only it is opened", async () => {
	const rows: FakeRow[] = [
		{ id: "chat_a", title: "가족방 2기", count: 4, noise: ["3"] },
		{ id: "chat_b", title: "가족", noise: ["12", "999+"] },
		{ id: "chat_f", title: "\u200b가족방 ".normalize("NFD"), count: 4, noise: ["7"], window: { title: "가족방", members: 4 } },
		{ id: "chat_c", title: "가족방 " },
	];
	expect(normalizeTitle(rows[2]!.title)).toBe("가족방");
	const { r, screen } = await send(rows, family, [family]);
	expect(r).toMatchObject({ ok: true });
	expect(screen.opened).toEqual(["ax:chat_f"]);
	expect(screen.menus()).toBe(1);
	expect(screen.sends).toEqual([["ax-send", "가족방", "안녕"]]);
});

test("a person name that also names two groups is told apart by member count: only the 1:1 row is opened", async () => {
	const rows: FakeRow[] = [
		{ id: "chat_g1", title: "민수", count: 5 },
		{ id: "chat_dm", title: "민수", window: { title: "민수" } },
		{ id: "chat_g2", title: "민수", count: 7, window: { title: "민수", members: 7 } },
		{ id: "chat_other", title: "민수, 영희", count: 3 },
	];
	const all = [direct, groupA, groupB];
	const toDirect = await send(rows, direct, all);
	expect(toDirect.r).toMatchObject({ ok: true });
	expect(toDirect.screen.opened).toEqual(["ax:chat_dm"]);
	expect(toDirect.screen.menus()).toBe(1);
	const toGroup = await send(rows, groupB, all);
	expect(toGroup.r).toMatchObject({ ok: true });
	expect(toGroup.screen.opened).toEqual(["ax:chat_g2"]);
	expect(toGroup.screen.menus()).toBe(1);
	expect(toGroup.screen.rowCalls[0]).toMatchObject({ first: false });
});

test("same name and same member count, or a count no row shows: refused before any menu is opened", async () => {
	const a: RoomFact = { chatId: "20", name: "스터디", kind: "group", members: 4 };
	const b: RoomFact = { chatId: "21", name: "스터디", kind: "group", members: 4 };
	const twins: FakeRow[] = [
		{ id: "chat_a", title: "스터디", count: 4 },
		{ id: "chat_b", title: "스터디", count: 4 },
	];
	const same = await send(twins, a, [a, b]);
	expect(same.r.ok).toBe(false);
	expect(same.r.reason).toContain(REFUSE.mismatch);
	expect(same.screen.menus()).toBe(0);
	expect(same.screen.sends).toHaveLength(0);
	const odd = await send([{ id: "chat_a", title: "스터디", count: 9 }], a, [a, b]);
	expect(odd.r.ok).toBe(false);
	expect(odd.r.reason).toContain(REFUSE.mismatch);
	expect(odd.screen.menus()).toBe(0);
	const missing = await send([], a, [a, b]);
	expect(missing.r.ok).toBe(false);
	expect(missing.r.reason).toContain(REFUSE.notFoundEnd);
	expect(missing.screen.menus()).toBe(0);
});

test("chooseRow: shared names need exactly one row of the database member count; a 1:1 or the memo chat shows no count", () => {
	const rows = [["민수", "5", "오후 1:00"], ["민수", "오후 1:00", "2"], ["민수", "7", "오후 1:00", "1"]];
	expect(chooseRow(rows, groupA, true)).toMatchObject({ ok: true, index: 0 });
	expect(chooseRow(rows, groupB, true)).toMatchObject({ ok: true, index: 2, via: "members" });
	expect(chooseRow(rows, direct, true)).toMatchObject({ ok: true, index: 1 });
	expect(chooseRow(rows, { ...groupA, members: 6 }, true)).toEqual({ ok: false, why: "mismatch" });
	expect(chooseRow(rows, { chatId: "9", name: "없음" }, false)).toEqual({ ok: false, why: "none" });
	expect(chooseRow(rows, { chatId: "9", name: "민수" }, true)).toEqual({ ok: false, why: "mismatch" });
});

test("KakaoTalk's normalization of the input is not a different text: NFC/NFD, line breaks, invisible marks, ends", () => {
	expect(sameText("안녕 세상", "안녕 세상".normalize("NFD"))).toBe(true);
	expect(sameText("가\n나", "가\r\n나")).toBe(true);
	expect(sameText("가\u2028나", "가\n나")).toBe(true);
	expect(sameText("  안녕 \u200b", "안녕")).toBe(true);
	expect(sameText("안녕\ufe0f", "안녕")).toBe(true);
	expect(normalizeInput("가\t나")).toBe("가 나");
	expect(sameText("안녕", "안녕하세요")).toBe(false);
	expect(inputFree("", "메시지를 입력하세요")).toBe(true);
	expect(inputFree("메시지를 입력하세요", "메시지를 입력하세요")).toBe(true);
	expect(inputFree(" \u200b ", undefined)).toBe(true);
	expect(inputFree("내가 쓰던 글", "메시지를 입력하세요")).toBe(false);
});

test("a row's title with a trailing member count and the newest-message preview tell same-name rooms apart", () => {
	const a: RoomFact = { chatId: "30", name: "스터디", kind: "direct", members: 2, preview: "내일 봐요" };
	const rows = [
		["스터디 (2)", "오후 3:00", "어제 봐요"],
		["스터디", "오후 4:00", "내일 봐요"],
	];
	expect(rowPreview(rows[1]!)).toBe("내일 봐요");
	expect(chooseRow(rows, a, true)).toMatchObject({ ok: true, index: 1, via: "preview" });
	const noPreview = [
		["스터디", "오후 3:00", "어제 봐요"],
		["스터디", "오후 4:00", "오늘 봐요"],
	];
	expect(chooseRow(noPreview, a, true)).toEqual({ ok: false, why: "mismatch" });
});

function farRows(n = 290, at = 200): FakeRow[] {
	const rows: FakeRow[] = Array.from({ length: n }, (_, i) => ({ id: `chat_${i}`, title: `방${i}` }));
	rows[at] = { id: "chat_far", title: "먼방", window: { title: "먼방" } };
	return rows;
}

const farFacts: RoomFact[] = [{ chatId: "far", name: "먼방", kind: "direct", members: 2 }];

// The real list has ~290 rooms; the measured read is ~26 ms a row, so the old 60/120-row cap never reached the bottom. The scan now reads to
// the bottom in one call (all AX rows at once) and stops at the first name hit.
test("a room 200 rows down the 290-room list is found on the first try, one row scan, and only its row is opened", async () => {
	const screen = fakeScreen(farRows());
	const r = await sendText({ chatId: "far", roomName: "먼방", text: "안녕" }, { paths, runner: screen.runner, roomNames: async () => farFacts });
	expect(r).toMatchObject({ ok: true });
	expect(r.attempts).toHaveLength(1);
	expect(r.ax![0]).toMatchObject({ step: "rows", ok: true });
	expect(r.ax![0]!.why).toBe("201:found:row200:name");
	expect(screen.sends).toEqual([["ax-send", "먼방", "안녕"]]);
	expect(screen.menus()).toBe(1);
});

test("a paged list is scrolled page by page until the room is found (290 rows, 30 a page)", async () => {
	const screen = fakeScreen(farRows(290, 275), { pageSize: 30 });
	const r = await sendText({ chatId: "far", roomName: "먼방", text: "안녕" }, { paths, runner: screen.runner, roomNames: async () => farFacts });
	expect(r).toMatchObject({ ok: true });
	expect(screen.sends).toHaveLength(1);
	expect(r.ax![0]!.why).toBe("276:found:p9:row275:name");
});

test("the database order is the hint: the room's own row is the first one read", async () => {
	const rows = farRows(290, 120);
	const all: RoomFact[] = [...Array.from({ length: 120 }, (_, i) => ({ chatId: `c${i}`, name: `방${i}` })), farFacts[0]!, ...Array.from({ length: 169 }, (_, i) => ({ chatId: `d${i}`, name: `다른${i}` }))];
	const screen = fakeScreen(rows);
	const r = await sendText({ chatId: "far", roomName: "먼방", text: "안녕" }, { paths, runner: screen.runner, roomNames: async () => all });
	expect(r).toMatchObject({ ok: true });
	expect((screen.rowCalls[0] as { hint?: number }).hint).toBe(120);
	expect(r.ax![0]!.why).toBe("1:found:row120:name");
});

test("a scan whose time runs out says so; a scan that reached the list end says that instead", async () => {
	const slowed = fakeScreen(farRows(), { scanLimit: 50 });
	const r = await sendText({ chatId: "far", roomName: "먼방", text: "안녕" }, { paths, runner: slowed.runner, roomNames: async () => farFacts });
	expect(r.ok).toBe(false);
	expect(r.reason).toContain(REFUSE.notFoundTime);
	expect(r.attempts!.every(a => a.reason?.includes(REFUSE.notFoundTime))).toBe(true);
	// The owner reads which room and how far the read got, in Korean.
	expect(r.attempts![0]!.reason).toBe("카카오톡 대화 목록에서 '먼방' 방을 시간 안에 찾지 못했어요(목록 290개 중 50개 확인)");
	expect(slowed.sends).toHaveLength(0);
	const ended = fakeScreen(Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, title: `다른방${i}` })));
	const e = await sendText({ chatId: "far", roomName: "먼방", text: "안녕" }, { paths, runner: ended.runner, roomNames: async () => farFacts });
	expect(e.reason).toContain(REFUSE.notFoundEnd);
	expect(e.reason).toContain("'먼방' 방을 목록 끝까지 찾지 못했어요(목록 20개 중 20개 확인)");
});

test("a kept window on the wrong room is caught by its check and the room is reopened instead of typed into", async () => {
	const screen = fakeScreen([familyRow], { kakaoShown: true, currentAtStart: "chat_f", windowAt: n => (n === 0 ? { title: "다른 방", members: 4 } : { title: "가족방", members: 4 }) });
	const first = fakeScreen([familyRow], { kakaoShown: true });
	expect(await sendText({ chatId: "40", roomName: "가족방", text: "먼저" }, { paths, runner: first.runner, roomNames: async () => [family] })).toMatchObject({ ok: true });
	// The warm window now shows another room: the cheap window check refuses to type into it, and the reopen rung fixes it.
	const r = await sendText({ chatId: "40", roomName: "가족방", text: "안녕" }, { paths, runner: screen.runner, roomNames: async () => [family] });
	expect(r).toMatchObject({ ok: true });
	expect(screen.sends).toEqual([["ax-send", "가족방", "안녕"]]);
	expect(screen.closes()).toBeGreaterThanOrEqual(1);
	expect(r.attempts![0]).toMatchObject({ state: "failed", reason: REFUSE.mismatch });
});

test("a window that is not the chosen room refuses, closes that window and types nothing", async () => {
	const wrongTitle = await send([{ ...familyRow, window: { title: "다른 방", members: 4 } }], family, [family]);
	expect(wrongTitle.r.ok).toBe(false);
	expect(wrongTitle.r.reason).toContain(REFUSE.mismatch);
	expect(wrongTitle.screen.sends).toHaveLength(0);
	expect(wrongTitle.screen.closes()).toBeGreaterThanOrEqual(1);
	const wrongCount = await send([{ ...familyRow, window: { title: "가족방", members: 9 } }], family, [family]);
	expect(wrongCount.r.ok).toBe(false);
	expect(wrongCount.r.reason).toContain(REFUSE.mismatch);
	expect(wrongCount.screen.sends).toHaveLength(0);
	expect(wrongCount.screen.closes()).toBeGreaterThanOrEqual(1);
	expect(wrongCount.r.ax!.at(-1)).toMatchObject({ step: "verify", ok: false, why: "mismatch" });
	const unreadable = await send([{ ...familyRow, window: "unreadable" }], family, [family]);
	expect(unreadable.r.ok).toBe(false);
	expect(unreadable.r.reason).toContain(REFUSE.openFailed);
	expect(unreadable.screen.sends).toHaveLength(0);
	expect(unreadable.screen.closes()).toBeGreaterThanOrEqual(1);
	const longer = await send([{ id: "chat_x", title: "가족방 2기", count: 4, window: { title: "가족방 2기", members: 4 } }], family, [family]);
	expect(longer.r.ok).toBe(false);
	expect(longer.r.reason).toContain(REFUSE.notFoundEnd);
});

test("the memo chat and a 1:1 with the same nickname cannot be told apart by a row: refused, never guessed", async () => {
	const self: RoomFact = { chatId: "10", name: "철수", kind: "self" };
	const friend: RoomFact = { chatId: "11", name: "철수", kind: "direct", members: 2 };
	const rows: FakeRow[] = [
		{ id: "chat_friend", title: "철수", window: { title: "철수" } },
		{ id: "chat_self", title: "철수", window: { title: "철수", self: true } },
	];
	const r = await send(rows, self, [self, friend]);
	expect(r.r.ok).toBe(false);
	expect(r.r.reason).toContain(REFUSE.mismatch);
	expect(r.screen.menus()).toBe(0);
	const alone = await send([rows[1]!], self, [self]);
	expect(alone.r).toMatchObject({ ok: true });
});

test("a failing open is retried through the ladder, one context menu per attempt, and the failing step stays on the result", async () => {
	for (const fail of [{ step: "menu", why: "no_menu" }, { step: "press", why: "press_error" }, { step: "window", why: "no_window" }]) {
		const { r, screen } = await send([familyRow], family, [family], { openFail: fail });
		expect(r.ok).toBe(false);
		expect(r.reason).toContain(REFUSE.openFailed);
		expect(screen.menus()).toBe(r.attempts!.length); // one menu per attempt, never two at once
		expect(screen.sends).toHaveLength(0);
		expect(r.ax!.at(-1)).toMatchObject({ step: fail.step, ok: false });
		expect(r.ax!.at(-1)!.why).toContain(fail.why);
	}
	const ok = await send([familyRow], family, [family]);
	expect(ok.screen.menus()).toBe(1);
});

test("there is no other path: no kmsg, no open or activate of KakaoTalk, also when the list window is not shown", async () => {
	const { r, screen } = await send([familyRow], family, [family], { listShown: false });
	expect(r).toMatchObject({ ok: false, reason: REFUSE.noList });
	expect(r.ax).toEqual([
		{ step: "rows", ms: expect.any(Number), ok: false, why: "no_list" },
		{ step: "openlist", ms: expect.any(Number), ok: false, why: "no_item" },
	]);
	expect(r.focus).toBeUndefined();
	expect(screen.other).toEqual([]);
	expect(screen.focus.filter(a => a[0] === "open")).toEqual([]);
	expect(screen.menus()).toBe(0);
	const good = await send([familyRow], family, [family]);
	expect(good.r).toMatchObject({ ok: true });
	expect(good.screen.other).toEqual([]);
	expect(good.screen.focus.filter(a => a[0] === "open")).toEqual([]);
});

test("no KakaoTalk window: the list is opened once by its menu, the previous front app is put back, and the focus change is on the result", async () => {
	const { r, screen } = await send([familyRow], family, [family], { listShown: false, openlist: "ok", front: "com.example.Editor" });
	expect(r).toMatchObject({ ok: true, focus: { from: "com.example.Editor", took: true, restored: true } });
	expect(r.ax!.map(s => s.step)).toEqual(["rows", "openlist", "rows", "open", "verify", "input"]);
	expect(r.ax![0]).toMatchObject({ step: "rows", ok: false, why: "no_list" });
	expect(r.ax![1]).toMatchObject({ step: "openlist", ok: true, why: "press=2,window=3,restore=1" });
	expect(screen.order.filter(o => o === "openlist" || o === "ax-open")).toEqual(["openlist", "ax-open"]);
	expect(screen.listCalls).toHaveLength(1);
	expect(screen.menus()).toBe(1);
	expect(screen.sends).toEqual([["ax-send", "가족방", "안녕"]]);
	expect(screen.other).toEqual([]);
	expect(screen.focus.filter(a => a[0] === "open")).toEqual([]);
	// A list that is shown never opens the menu and leaves no focus record.
	const shown = await send([familyRow], family, [family], { openlist: "ok" });
	expect(shown.r.focus).toBeUndefined();
	expect(shown.screen.listCalls).toHaveLength(0);
});

test("no KakaoTalk window and the list does not show after the menu: the send is refused with the Korean reason and nothing is typed", async () => {
	const { r, screen } = await send([familyRow], family, [family], { listShown: false });
	expect(r.ok).toBe(false);
	expect(r.reason).toBe("카톡 창이 닫혀 있어요. 카카오톡 창을 열어 주세요");
	expect(screen.sends).toHaveLength(0);
	expect(screen.menus()).toBe(0);
});

test("every AX phase is on the result with its time: rows read, row open, verify, input; the open phase is capped", async () => {
	const timeouts: number[] = [];
	const screen = fakeScreen([familyRow]);
	const runner: Runner = async (argv, o) => {
		if (argv[0] === "osascript" && argv[1] === "-l") timeouts.push(o!.timeoutMs!);
		return screen.runner(argv, o);
	};
	const r = await sendText({ chatId: "40", roomName: "가족방", text: "안녕" }, { paths, runner, roomNames: async () => [family] });
	expect(r).toMatchObject({ ok: true });
	expect(r.ax!.map(s => s.step)).toEqual(["rows", "open", "verify", "input"]);
	expect(r.ax!.every(s => s.ok && s.ms >= 0)).toBe(true);
	expect(r.ax![0]!.why).toBe("1:found:row0:name");
	expect(timeouts.slice(0, 2).every(t => t <= 8_000)).toBe(true);
	expect(screen.rowCalls[0]).toMatchObject({ action: "rows", name: "가족방", first: true });
});

test("the last rung brings KakaoTalk to the front for one try and puts the owner's app back after it", async () => {
	const screen = fakeScreen([familyRow], { front: "com.example.Editor", openFail: n => (n < 5 ? { step: "menu", why: "no_menu" } : undefined) });
	const r = await sendText({ chatId: "40", roomName: "가족방", text: "안녕" }, { paths, runner: screen.runner, roomNames: async () => [family] });
	expect(r).toMatchObject({ ok: true });
	expect(r.attempts!.map(a => a.recovery)).toEqual(["none", "retry", "reopen", "deep", "front"]);
	expect(screen.sends).toEqual([["ax-send", "가족방", "안녕"]]);
	const cmds = screen.focus.map(a => a.join(" "));
	expect(cmds.some(c => c.includes("to activate"))).toBe(true);
	expect(cmds.some(c => c.includes("frontmost of"))).toBe(true);
});

test("a press without a confirmed send stops and is never sent again; an owner's own text is not retried; other input failures retry", async () => {
	const unclear = await send([familyRow], family, [family], { axSend: () => ({ ok: false, why: "unclear", pressed: true }) });
	expect(unclear.r.ok).toBe(false);
	expect(unclear.r.reason).toContain("다시 보내지 않았으니");
	expect(unclear.screen.sends).toHaveLength(1);
	const owner = await send([familyRow], family, [family], { axSend: () => ({ ok: false, why: "owner_text", preview: "내가 쓰던 글" }) });
	expect(owner.r.ok).toBe(false);
	expect(owner.r.reason).toContain("내가 쓰던 글");
	expect(owner.r.reason).not.toContain("owner_text");
	expect(owner.screen.sends).toHaveLength(1);
	expect(owner.screen.closes()).toBe(0); // the owner's own draft stays in its window, never closed away
	for (const why of ["not_set", "no_button", "no_input"]) {
		const { r, screen } = await send([familyRow], family, [family], { axSend: () => ({ ok: false, why }) });
		expect(r.ok).toBe(false);
		expect(screen.sends).toHaveLength(5);
		expect(r.attempts).toHaveLength(5);
		expect(screen.closes()).toBeGreaterThanOrEqual(1);
		expect(r.ax!.at(-1)).toMatchObject({ step: "input", ok: false });
		expect(r.ax!.at(-1)!.why).toContain(why);
	}
});

test("same name and size told apart by preview: a twin that moved into the chosen row before the open is refused, never opened", async () => {
	const a: RoomFact = { chatId: "20", name: "스터디", kind: "group", members: 4, preview: "내일 봐요" };
	const b: RoomFact = { chatId: "21", name: "스터디", kind: "group", members: 4, preview: "어제 봐요" };
	const rows: FakeRow[] = [
		{ id: "chat_b", title: "스터디", count: 4, preview: "어제 봐요", window: { title: "스터디", members: 4 } },
		{ id: "chat_a", title: "스터디", count: 4, preview: "내일 봐요", window: { title: "스터디", members: 4 } },
	];
	const screen = fakeScreen(rows);
	let moved = false;
	const runner: Runner = async (argv, o) => {
		// A new message in the other room moves it to row 1 between the list read and the open.
		if (!moved && argv[1] === "-l" && JSON.parse(o!.stdin!.trim()).action === "open") {
			moved = true;
			rows.reverse();
		}
		return screen.runner(argv, o);
	};
	const r = await sendText({ chatId: "20", roomName: "스터디", text: "안녕" }, { paths, runner, roomNames: async () => [a, b] });
	expect(r.attempts![0]).toMatchObject({ state: "failed", reason: "카카오톡 목록에서 '스터디' 방을 찾았지만 방을 열지 못했어요(그사이 목록 순서가 바뀜)" });
	expect(r.attempts![0]!.ax.find(s => s.step === "recheck")).toMatchObject({ ok: false });
	expect(screen.opened).not.toContain("ax:chat_b");
	expect(screen.opened).toEqual(["ax:chat_a"]);
	expect(r).toMatchObject({ ok: true });
});

test("a shared name is not chosen from a partial list read; the read stops as soon as every row of the name was seen", async () => {
	const rows: FakeRow[] = [
		{ id: "chat_g1", title: "민수", count: 5, window: { title: "민수", members: 5 } },
		...Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, title: `방${i}` })),
		{ id: "chat_dm", title: "민수", window: { title: "민수" } },
		...Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, title: `끝${i}` })),
	];
	const partial = await send(rows, groupA, [groupA, direct], { scanLimit: 10 });
	expect(partial.r.ok).toBe(false);
	expect(partial.r.reason).toContain(REFUSE.partial);
	expect(partial.screen.menus()).toBe(0);
	const whole = await send(rows, groupA, [groupA, direct]);
	expect(whole.r).toMatchObject({ ok: true });
	expect(whole.screen.opened).toEqual(["ax:chat_g1"]);
	expect(whole.screen.rowCalls[0]).toMatchObject({ first: false, need: 2 });
	expect(whole.r.ax![0]!.why).toBe("42:found:row0:members");
});
