import { expect, test } from "bun:test";
import { mergeMessages, stableMsgId, type SyncMsg } from "./app-sync.ts";

const base = { app: "kakao", room: "r1", sender: "민수", text: "안녕하세요" };

test("stableMsgId uses the app id when there is one", () => {
	expect(stableMsgId({ ...base, appId: 4242, sentAt: 1_700_000_000 })).toBe("kakao:r1:4242");
	expect(stableMsgId({ ...base, appId: "x9", sentAt: 1 })).toBe("kakao:r1:x9");
});

test("stableMsgId hashes sender, time and text without an app id, seconds or ms alike", () => {
	const sec = stableMsgId({ ...base, sentAt: 1_700_000_000 });
	const ms = stableMsgId({ ...base, sentAt: 1_700_000_000_000 });
	expect(sec).toMatch(/^kakao:r1:h[0-9a-f]{16}$/);
	expect(ms).toBe(sec);
	expect(stableMsgId({ ...base, sentAt: 1_700_000_001 })).not.toBe(sec);
});

test("stableMsgId trims and NFC-normalizes text", () => {
	const nfd = "안녕하세요".normalize("NFD");
	expect(nfd).not.toBe("안녕하세요");
	const a = stableMsgId({ ...base, sentAt: 5, text: `  ${nfd}\n` });
	expect(a).toBe(stableMsgId({ ...base, sentAt: 5 }));
});

type M = SyncMsg & { text: string };
const collect = (collector: string, sentAt: number, extra: Partial<M> = {}): M => ({
	id: stableMsgId({ ...base, sentAt }), collector, updatedAt: 1, sentAt, text: base.text, ...extra,
});

test("the same message collected in seconds and in ms dedupes to one row", () => {
	const merged = mergeMessages([[collect("mac-a", 1_700_000_000)], [collect("mac-b", 1_700_000_000_000)]]);
	expect(merged).toHaveLength(1);
});

test("state converges by the higher updatedAt, whatever the list order", () => {
	const a = collect("mac-a", 100, { updatedAt: 5, read: true, status: "draft" });
	const b = collect("mac-b", 100, { updatedAt: 9, read: false, status: "sent" });
	for (const lists of [[[a], [b]], [[b], [a]]]) {
		const [m] = mergeMessages(lists);
		expect(m).toMatchObject({ collector: "mac-b", read: false, status: "sent" });
	}
});

test("a tie goes to the lease holder, else the smaller collector", () => {
	const a = collect("mac-a", 100, { status: "draft" });
	const b = collect("mac-b", 100, { status: "sent" });
	expect(mergeMessages([[a], [b]], "mac-b")[0]!.collector).toBe("mac-b");
	expect(mergeMessages([[b], [a]], "mac-b")[0]!.collector).toBe("mac-b");
	expect(mergeMessages([[b], [a]])[0]!.collector).toBe("mac-a");
	expect(mergeMessages([[a], [b]], "mac-z")[0]!.collector).toBe("mac-a");
});

test("output is newest first by sentAt, seconds and ms compared alike", () => {
	const old = collect("mac-a", 1_700_000_000);
	const mid = collect("mac-a", 1_700_000_500_000);
	const fresh = collect("mac-b", 1_700_001_000);
	expect(mergeMessages([[old, fresh], [mid]]).map(m => m.id)).toEqual([fresh.id, mid.id, old.id]);
});
