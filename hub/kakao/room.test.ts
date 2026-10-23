import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openListRow, REFUSE, type RoomFact } from "./room.ts";
import { sendText } from "./send.ts";
import { KAKAO_BUNDLE, kakaoPaths, type Runner } from "./types.ts";
import { type FakeRow, fakeScreen } from "./ui.fixture.ts";

let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kk-room-"));
	paths = kakaoPaths(dir, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const send = (rows: FakeRow[], room: RoomFact, all: RoomFact[]) => {
	const screen = fakeScreen(rows);
	const result = sendText({ chatId: room.chatId, roomName: room.name, text: "안녕" }, { paths, runner: screen.runner, kmsg: "/fake/kmsg", roomNames: async () => all });
	return result.then(r => ({ r, screen }));
};

const direct: RoomFact = { chatId: "1", name: "민수", kind: "direct", members: 2 };
const groupA: RoomFact = { chatId: "2", name: "민수", kind: "group", members: 5 };
const groupB: RoomFact = { chatId: "3", name: "민수", kind: "group", members: 7 };

test("a person name that also names two groups sends only to the 1:1", async () => {
	const rows: FakeRow[] = [
		{ id: "chat_g1", title: "민수", window: { title: "민수", members: 5 } },
		{ id: "chat_dm", title: "민수", window: { title: "민수" } },
		{ id: "chat_g2", title: "민수", window: { title: "민수", members: 7 } },
		{ id: "chat_other", title: "민수, 영희", window: { title: "민수, 영희", members: 3 } },
	];
	const { r, screen } = await send(rows, direct, [direct, groupA, groupB]);
	expect(r).toMatchObject({ ok: true });
	expect(screen.opened).toEqual(["chat_g1", "chat_dm", "chat_g2"]);
	expect(screen.sends).toEqual([["/fake/kmsg", "send", "--chat-id", "chat_dm", "--", "안녕"]]);
	expect(screen.closes()).toBe(3);
	const group = await send(rows, groupB, [direct, groupA, groupB]);
	expect(group.r).toMatchObject({ ok: true });
	expect(group.screen.sends[0]).toContain("chat_g2");
});

test("the memo chat and a 1:1 with the same nickname are told apart by the self marker", async () => {
	const self: RoomFact = { chatId: "10", name: "철수", kind: "self" };
	const friend: RoomFact = { chatId: "11", name: "철수", kind: "direct", members: 2 };
	const rows: FakeRow[] = [
		{ id: "chat_friend", title: "철수", window: { title: "철수" } },
		{ id: "chat_self", title: "철수", window: { title: "철수", self: true } },
	];
	const toSelf = await send(rows, self, [self, friend]);
	expect(toSelf.r).toMatchObject({ ok: true });
	expect(toSelf.screen.sends[0]).toContain("chat_self");
	const toFriend = await send(rows, friend, [self, friend]);
	expect(toFriend.r).toMatchObject({ ok: true });
	expect(toFriend.screen.sends[0]).toContain("chat_friend");
	const unmarked = await send([{ id: "chat_a", title: "철수", window: { title: "철수" } }, { id: "chat_b", title: "철수", window: { title: "철수" } }], self, [self, friend]);
	expect(unmarked.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(unmarked.screen.sends).toHaveLength(0);
});

test("two groups with the same name and size are never guessed between", async () => {
	const a: RoomFact = { chatId: "20", name: "스터디", kind: "group", members: 4 };
	const b: RoomFact = { chatId: "21", name: "스터디", kind: "group", members: 4 };
	const rows: FakeRow[] = [
		{ id: "chat_a", title: "스터디", window: { title: "스터디", members: 4 } },
		{ id: "chat_b", title: "스터디", window: { title: "스터디", members: 4 } },
	];
	const { r, screen } = await send(rows, a, [a, b]);
	expect(r).toMatchObject({ ok: false, reason: REFUSE.same });
	expect(r.reason).toContain("같은 이름의 방이 여러 개라 보내지 않았어요");
	expect(screen.sends).toHaveLength(0);
	const missing = await send([], a, [a, b]);
	expect(missing.r).toMatchObject({ ok: false, reason: REFUSE.notListed });
	expect(missing.screen.opened).toHaveLength(0);
});

test("a window that is not the chosen room refuses, closes the window and presses no Enter", async () => {
	const room: RoomFact = { chatId: "30", name: "가족방", kind: "group", members: 4 };
	const wrongTitle = await send([{ id: "chat_x", title: "가족방", window: { title: "다른 방", members: 4 } }], room, [room]);
	expect(wrongTitle.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(wrongTitle.screen.sends).toHaveLength(0);
	expect(wrongTitle.screen.closes()).toBe(1);
	const wrongCount = await send([{ id: "chat_x", title: "가족방", window: { title: "가족방", members: 9 } }], room, [room]);
	expect(wrongCount.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(wrongCount.screen.sends).toHaveLength(0);
	const unreadable = await send([{ id: "chat_x", title: "가족방", window: "unreadable" }], room, [room]);
	expect(unreadable.r).toMatchObject({ ok: false, reason: REFUSE.unreadable });
	expect(unreadable.screen.sends).toHaveLength(0);
	const sameTitleLongerName = await send([{ id: "chat_x", title: "가족방 2기", window: { title: "가족방 2기", members: 4 } }], room, [room]);
	expect(sameTitleLongerName.r).toMatchObject({ ok: false, reason: REFUSE.notListed });
});

// Background path: the room's one list row opened by Accessibility (room.jxa.js open), its window checked, the text put in and 전송
// pressed by Accessibility (room.jxa.js send): no kmsg, no key event, no refocus of the owner's app.
const axSendRoom = (rows: FakeRow[], room: RoomFact, all: RoomFact[], opts: { axSend?: () => object; front?: string } = {}) => {
	const screen = fakeScreen(rows, { axOpen: true, ...opts });
	return sendText({ chatId: room.chatId, roomName: room.name, text: "안녕" }, { paths, runner: screen.runner, kmsg: "/fake/kmsg", roomNames: async () => all }).then(r => ({ r, screen }));
};
const family: RoomFact = { chatId: "40", name: "가족방", kind: "group", members: 4 };
const familyRow: FakeRow = { id: "chat_f", title: "가족방", window: { title: "가족방", members: 4 } };

test("background path: a name only one database room has is opened and sent by Accessibility, with no kmsg and no refocus", async () => {
	const { r, screen } = await axSendRoom([familyRow], family, [family]);
	expect(r).toMatchObject({ ok: true });
	expect(screen.opened).toEqual(["ax:chat_f"]);
	expect(screen.limits).toEqual([]);
	expect(screen.sends).toEqual([["ax-send", "가족방", "안녕"]]);
	expect(screen.focus.filter(a => a[0] === "open")).toEqual([]);
	expect(screen.closes()).toBe(1);
	expect(r.ms!.pick).toBeGreaterThanOrEqual(0);
});

test("background path: a window that is not the room is closed and the checked path decides; a shared name never takes it", async () => {
	const wrong = await axSendRoom([{ ...familyRow, window: { title: "가족방", members: 9 } }], family, [family]);
	expect(wrong.r).toMatchObject({ ok: false, reason: REFUSE.mismatch });
	expect(wrong.screen.sends).toHaveLength(0);
	const rows: FakeRow[] = [
		{ id: "chat_g1", title: "민수", window: { title: "민수", members: 5 } },
		{ id: "chat_dm", title: "민수", window: { title: "민수" } },
	];
	const shared = await axSendRoom(rows, direct, [direct, groupA]);
	expect(shared.r).toMatchObject({ ok: true });
	expect(shared.screen.opened.some(id => id.startsWith("ax:"))).toBe(false);
	expect(shared.screen.sends).toEqual([["/fake/kmsg", "send", "--chat-id", "chat_dm", "--", "안녕"]]);
});

test("background path: nothing pressed goes on to the checked kmsg path; a press without a confirmed send stops and is never sent again", async () => {
	for (const why of ["busy", "not_set", "no_button", "no_input"]) {
		const off = await axSendRoom([familyRow], family, [family], { axSend: () => ({ ok: false, why }) });
		expect(off.r).toMatchObject({ ok: true });
		expect(off.screen.sends.map(a => a[0] === "ax-send" ? "ax" : a[2])).toEqual(["ax", "--chat-id"]);
	}
	const unclear = await axSendRoom([familyRow], family, [family], { axSend: () => ({ ok: false, why: "unclear", pressed: true }) });
	expect(unclear.r.ok).toBe(false);
	expect(unclear.r.reason).toContain("다시 보내지 않았으니");
	expect(unclear.screen.sends).toEqual([["ax-send", "가족방", "안녕"]]);
});
test("openListRow brings the list window up in the background (open -g) only when it is not shown, and never activates KakaoTalk", async () => {
	const calls: string[][] = [];
	let shown = false;
	const runner: Runner = async (argv, o) => {
		calls.push(argv[0] === "osascript" ? ["osascript", JSON.parse(o!.stdin!).action] : argv);
		if (argv[0] === "open") shown = true;
		return { code: 0, stdout: shown ? '{"ok":true}\n' : '{"ok":false,"why":"no_list"}\n', stderr: "" };
	};
	expect(await openListRow("가족방", runner)).toBe("ok");
	expect(calls).toEqual([["osascript", "open"], ["open", "-g", "-b", KAKAO_BUNDLE], ["osascript", "open"]]);
	calls.length = 0;
	expect(await openListRow("가족방", runner)).toBe("ok");
	expect(calls).toEqual([["osascript", "open"]]);
});
