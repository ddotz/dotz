import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseRow, normalizeTitle, REFUSE, type RoomFact } from "./room.ts";
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
	expect(same.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(same.screen.menus()).toBe(0);
	expect(same.screen.sends).toHaveLength(0);
	const odd = await send([{ id: "chat_a", title: "스터디", count: 9 }], a, [a, b]);
	expect(odd.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(odd.screen.menus()).toBe(0);
	const missing = await send([], a, [a, b]);
	expect(missing.r).toMatchObject({ ok: false, reason: REFUSE.notListed });
	expect(missing.screen.menus()).toBe(0);
});

test("chooseRow: shared names need exactly one row of the database member count; a 1:1 or the memo chat shows no count", () => {
	const rows = [["민수", "5", "오후 1:00"], ["민수", "오후 1:00", "2"], ["민수", "7", "오후 1:00", "1"]];
	expect(chooseRow(rows, groupA, true)).toEqual({ ok: true, index: 0 });
	expect(chooseRow(rows, groupB, true)).toEqual({ ok: true, index: 2 });
	expect(chooseRow(rows, direct, true)).toEqual({ ok: true, index: 1 });
	expect(chooseRow(rows, { ...groupA, members: 6 }, true)).toEqual({ ok: false, why: "mismatch" });
	expect(chooseRow(rows, { chatId: "9", name: "없음" }, false)).toEqual({ ok: false, why: "none" });
	expect(chooseRow(rows, { chatId: "9", name: "민수" }, true)).toEqual({ ok: false, why: "mismatch" });
});

test("a window that is not the chosen room refuses, closes that window and types nothing", async () => {
	const wrongTitle = await send([{ ...familyRow, window: { title: "다른 방", members: 4 } }], family, [family]);
	expect(wrongTitle.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(wrongTitle.screen.sends).toHaveLength(0);
	expect(wrongTitle.screen.closes()).toBe(1);
	const wrongCount = await send([{ ...familyRow, window: { title: "가족방", members: 9 } }], family, [family]);
	expect(wrongCount.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(wrongCount.screen.sends).toHaveLength(0);
	expect(wrongCount.screen.closes()).toBe(1);
	expect(wrongCount.r.ax!.at(-1)).toMatchObject({ step: "verify", ok: false, why: "mismatch" });
	const unreadable = await send([{ ...familyRow, window: "unreadable" }], family, [family]);
	expect(unreadable.r).toMatchObject({ ok: false, reason: REFUSE.openFailed });
	expect(unreadable.screen.sends).toHaveLength(0);
	expect(unreadable.screen.closes()).toBe(1);
	const longer = await send([{ id: "chat_x", title: "가족방 2기", count: 4, window: { title: "가족방 2기", members: 4 } }], family, [family]);
	expect(longer.r).toMatchObject({ ok: false, reason: REFUSE.notListed });
});

test("the memo chat and a 1:1 with the same nickname cannot be told apart by a row: refused, never guessed", async () => {
	const self: RoomFact = { chatId: "10", name: "철수", kind: "self" };
	const friend: RoomFact = { chatId: "11", name: "철수", kind: "direct", members: 2 };
	const rows: FakeRow[] = [
		{ id: "chat_friend", title: "철수", window: { title: "철수" } },
		{ id: "chat_self", title: "철수", window: { title: "철수", self: true } },
	];
	const r = await send(rows, self, [self, friend]);
	expect(r.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(r.screen.menus()).toBe(0);
	const alone = await send([rows[1]!], self, [self]);
	expect(alone.r).toMatchObject({ ok: true });
});

test("at most one context menu per send, and a failing open is not retried: the failing step is named on the result", async () => {
	for (const fail of [{ step: "menu", why: "no_menu" }, { step: "press", why: "press_error" }, { step: "window", why: "no_window" }]) {
		const { r, screen } = await send([familyRow], family, [family], { openFail: fail });
		expect(r).toMatchObject({ ok: false, reason: REFUSE.openFailed });
		expect(screen.menus()).toBe(1);
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

test("every AX phase is on the result with its time: rows read, row open, verify, input; the open phase is capped at 5 s", async () => {
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
	expect(r.ax![0]!.why).toBe("1:found:row0");
	expect(timeouts.slice(0, 2).every(t => t <= 5_000)).toBe(true);
	expect(screen.rowCalls[0]).toMatchObject({ action: "rows", name: "가족방", first: true });
});

test("a press without a confirmed send stops and is never sent again; nothing pressed fails with the reason and closes the window", async () => {
	for (const why of ["busy", "not_set", "no_button", "no_input"]) {
		const { r, screen } = await send([familyRow], family, [family], { axSend: () => ({ ok: false, why }) });
		expect(r.ok).toBe(false);
		expect(screen.sends).toHaveLength(1);
		expect(screen.closes()).toBe(1);
		expect(r.ax!.at(-1)).toMatchObject({ step: "input", ok: false, why });
	}
	const unclear = await send([familyRow], family, [family], { axSend: () => ({ ok: false, why: "unclear", pressed: true }) });
	expect(unclear.r.ok).toBe(false);
	expect(unclear.r.reason).toContain("다시 보내지 않았으니");
	expect(unclear.screen.sends).toHaveLength(1);
});
