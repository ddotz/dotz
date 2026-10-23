import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFUSE, type RoomFact } from "./room.ts";
import { sendText } from "./send.ts";
import { kakaoPaths } from "./types.ts";
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
	expect(r).toEqual({ ok: true });
	expect(screen.opened).toEqual(["chat_g1", "chat_dm", "chat_g2"]);
	expect(screen.sends).toEqual([["/fake/kmsg", "send", "--chat-id", "chat_dm", "--", "안녕"]]);
	expect(screen.closes()).toBe(3);
	const group = await send(rows, groupB, [direct, groupA, groupB]);
	expect(group.r).toEqual({ ok: true });
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
	expect(toSelf.r).toEqual({ ok: true });
	expect(toSelf.screen.sends[0]).toContain("chat_self");
	const toFriend = await send(rows, friend, [self, friend]);
	expect(toFriend.r).toEqual({ ok: true });
	expect(toFriend.screen.sends[0]).toContain("chat_friend");
	const unmarked = await send([{ id: "chat_a", title: "철수", window: { title: "철수" } }, { id: "chat_b", title: "철수", window: { title: "철수" } }], self, [self, friend]);
	expect(unmarked.r).toEqual({ ok: false, reason: REFUSE.mismatch });
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
	expect(r).toEqual({ ok: false, reason: REFUSE.same });
	expect(r.reason).toContain("같은 이름의 방이 여러 개라 보내지 않았어요");
	expect(screen.sends).toHaveLength(0);
	const missing = await send([], a, [a, b]);
	expect(missing.r).toEqual({ ok: false, reason: REFUSE.notListed });
	expect(missing.screen.opened).toHaveLength(0);
});

test("a window that is not the chosen room refuses, closes the window and presses no Enter", async () => {
	const room: RoomFact = { chatId: "30", name: "가족방", kind: "group", members: 4 };
	const wrongTitle = await send([{ id: "chat_x", title: "가족방", window: { title: "다른 방", members: 4 } }], room, [room]);
	expect(wrongTitle.r).toEqual({ ok: false, reason: REFUSE.mismatch });
	expect(wrongTitle.screen.sends).toHaveLength(0);
	expect(wrongTitle.screen.closes()).toBe(1);
	const wrongCount = await send([{ id: "chat_x", title: "가족방", window: { title: "가족방", members: 9 } }], room, [room]);
	expect(wrongCount.r).toEqual({ ok: false, reason: REFUSE.mismatch });
	expect(wrongCount.screen.sends).toHaveLength(0);
	const unreadable = await send([{ id: "chat_x", title: "가족방", window: "unreadable" }], room, [room]);
	expect(unreadable.r).toEqual({ ok: false, reason: REFUSE.unreadable });
	expect(unreadable.screen.sends).toHaveLength(0);
	const sameTitleLongerName = await send([{ id: "chat_x", title: "가족방 2기", window: { title: "가족방 2기", members: 4 } }], room, [room]);
	expect(sameTitleLongerName.r).toEqual({ ok: false, reason: REFUSE.notListed });
});
