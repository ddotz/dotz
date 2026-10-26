import { expect, test } from "bun:test";
import { CONFIRM_MS, pollConfirm, type ConfirmMsg } from "./confirm.ts";

const msg = (text: string, sentAt: number, fromMe = true): ConfirmMsg => ({ text, fromMe, sentAt });

function clocked(list: ConfirmMsg[][]) {
	let t = 1_000_000;
	let reads = 0;
	return {
		opts: { now: () => t, sleep: async (ms: number) => void (t += ms), intervalMs: 500 },
		read: async () => list[Math.min(reads++, list.length - 1)]!,
		reads: () => reads,
		now: () => t,
	};
}

test("the pressed text is confirmed when the owner's message of that text shows up while polling", async () => {
	const c = clocked([[], [], [msg("안녕", 1_000_000)]]);
	expect(await pollConfirm(c.read, { chatId: "1", text: "안녕", since: 1_000_000 }, c.opts)).toBe(true);
	expect(c.reads()).toBe(3);
});

test("without the message the poll gives up at the deadline and never hands back a success", async () => {
	const c = clocked([[]]);
	expect(await pollConfirm(c.read, { chatId: "1", text: "안녕", since: 1_000_000 }, c.opts)).toBe(false);
	expect(c.now()).toBeGreaterThanOrEqual(1_000_000 + CONFIRM_MS);
});

test("the same text written by someone else, or text from before this send, does not confirm it", async () => {
	const since = 1_800_000_000_000;
	const c = clocked([[msg("안녕", since, false), msg("안녕", since / 1000 - 60)]]);
	expect(await pollConfirm(c.read, { chatId: "1", text: "안녕", since }, { ...c.opts, timeoutMs: 1_000 })).toBe(false);
});

test("a message typed just before the press (database time a few seconds behind) still confirms, with KakaoTalk's normalization", async () => {
	const c = clocked([[msg("안녕\u200b  세상".normalize("NFD"), 1_000_000 - 4_000)]]);
	expect(await pollConfirm(c.read, { chatId: "1", text: "안녕 세상", since: 1_000_000 }, { ...c.opts, timeoutMs: 0 })).toBe(true);
});

test("an unreadable database is not a confirmation", async () => {
	expect(await pollConfirm(async () => Promise.reject(new Error("locked")), { chatId: "1", text: "안녕", since: 1_000_000 }, { now: () => 0, sleep: async () => {}, timeoutMs: 0 })).toBe(false);
});
