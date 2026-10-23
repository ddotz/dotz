import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOnce, type DispatchDeps, dispatchSend, type Lease, mergeMessages, messageId } from "./contract.ts";
import { createDraft, listDrafts } from "./send.ts";
import { kakaoPaths, type Runner } from "./types.ts";
import { fakeScreen } from "./ui.fixture.ts";

let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kakao-contract-"));
	paths = kakaoPaths(dir, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const key = (over: Partial<Parameters<typeof messageId>[0]> = {}) => ({ chatId: "101", logId: "9007199254740991", authorId: "2001", sentAt: 1_700_000_000, text: "hi", ...over });
const entry = (id: string, collector: string, sentAt: number, logId?: string) => ({ id, collector, sentAt, ...(logId ? { logId } : {}) });

describe("messageId", () => {
	test("is k:<chatId>:<logId> and does not depend on the machine, the sender name or the text", () => {
		expect(messageId(key())).toBe("k:101:9007199254740991");
		expect(messageId(key({ text: "edited", authorId: "9" }))).toBe("k:101:9007199254740991");
	});

	test("without a logId the fallback hash is stable, ignores the seconds/milliseconds unit and tells messages apart", () => {
		const a = messageId(key({ logId: undefined }));
		expect(a).toMatch(/^h:101:[0-9a-f]{16}$/);
		expect(messageId(key({ logId: "" }))).toBe(a);
		expect(messageId(key({ logId: undefined, sentAt: 1_700_000_000_000 }))).toBe(a);
		expect(messageId(key({ logId: undefined, text: "other" }))).not.toBe(a);
		expect(messageId(key({ logId: undefined, authorId: "2002" }))).not.toBe(a);
		expect(messageId(key({ logId: undefined, sentAt: 1_700_000_001 }))).not.toBe(a);
	});
});

describe("mergeMessages / addOnce", () => {
	test("the same message from two collectors is one message and the first collector is kept", () => {
		const fromA = [entry("k:101:1", "mac-a", 10, "1"), entry("k:101:2", "mac-a", 20, "2")];
		const fromB = [entry("k:101:2", "mac-b", 20, "2"), entry("k:101:3", "mac-b", 30, "3")];
		const merged = mergeMessages(fromA, fromB);
		expect(merged.map(m => [m.id, m.collector])).toEqual([["k:101:1", "mac-a"], ["k:101:2", "mac-a"], ["k:101:3", "mac-b"]]);
		expect(mergeMessages(merged, fromB, fromA)).toEqual(merged);
		expect(mergeMessages(fromB, fromA).find(m => m.id === "k:101:2")!.collector).toBe("mac-b");
	});

	test("sorted by time, then by logId as a number above 2^53", () => {
		const merged = mergeMessages([entry("b", "x", 50, "9007199254740992"), entry("c", "x", 60, "1")], [entry("a", "y", 50, "9007199254740991"), entry("d", "y", 5, "7")]);
		expect(merged.map(m => m.id)).toEqual(["d", "a", "b", "c"]);
	});

	test("a send record is added once per send id", () => {
		const one = addOnce([], { id: "S1", state: "sending" });
		expect(addOnce(one, { id: "S1", state: "sent" })).toEqual([{ id: "S1", state: "sending" }]);
		expect(addOnce(one, { id: "S2", state: "sending" })).toHaveLength(2);
	});
});

function rig() {
	const screen = fakeScreen([{ id: "chat_alex", title: "Alex", window: { title: "Alex" } }], { sendOut: () => ({ code: 0, stdout: "" }) });
	const runner: Runner = screen.runner;
	const calls = screen.sends;
	const deps = (lease?: Lease): DispatchDeps => ({ paths, runner, now: () => 1, kmsg: "/fake/kmsg", latestIncoming: async () => undefined, ...(lease ? { lease } : {}) });
	return { calls, deps };
}

const refuse: Lease = async () => ({ ok: false, reason: "다른 맥이 이 대화방을 맡고 있어요" });
const allow: Lease = async () => ({ ok: true });
const SEND = ["/fake/kmsg", "send", "--chat-id", "chat_alex", "--", "hello"];

describe("dispatchSend", () => {
	test("a typed send runs kmsg (dry run, then send) when there is no lease hook or the lease allows", async () => {
		for (const lease of [undefined, allow]) {
			const r = rig();
			expect(await dispatchSend({ kind: "text", chatId: "101", roomName: "Alex", text: "hello" }, r.deps(lease))).toEqual({ ok: true });
			expect(r.calls).toEqual([SEND]);
		}
	});

	test("a refused lease, or one that cannot be checked, is a failed send and kmsg never runs", async () => {
		const r = rig();
		expect(await dispatchSend({ kind: "text", chatId: "101", roomName: "Alex", text: "hello" }, r.deps(refuse))).toEqual({ ok: false, reason: "다른 맥이 이 대화방을 맡고 있어요" });
		const broken = await dispatchSend({ kind: "text", chatId: "101", roomName: "Alex", text: "hello" }, r.deps(async () => Promise.reject(new Error("net"))));
		expect(broken.ok).toBe(false);
		expect(typeof broken.reason).toBe("string");
		expect(r.calls).toEqual([]);
	});

	test("a confirmed draft takes the same door: the lease is asked with the draft's chat, a refusal leaves it pending", async () => {
		const r = rig();
		const d = await createDraft({ chatId: "101", roomName: "Alex", text: "hello", basisLogId: "5" }, { paths, runner: r.deps().runner });
		const asked: string[] = [];
		const result = await dispatchSend({ kind: "draft", code: d.code, ownerApproved: true }, r.deps(async chatId => (asked.push(chatId), { ok: false, reason: "막힘" })));
		expect(result).toEqual({ ok: false, reason: "막힘" });
		expect(asked).toEqual(["101"]);
		expect(r.calls).toEqual([]);
		expect((await listDrafts(r.deps()))[0]!.status).toBe("pending");

		expect(await dispatchSend({ kind: "draft", code: d.code, ownerApproved: true }, r.deps(allow))).toEqual({ ok: true });
		expect(r.calls.at(-1)).toEqual(SEND);
		expect((await listDrafts(r.deps()))[0]!.status).toBe("sent");
	});

	test("an unknown draft code is refused before the lease or kmsg", async () => {
		const r = rig();
		let asked = false;
		const result = await dispatchSend({ kind: "draft", code: "KNOPE", ownerApproved: true }, r.deps(async () => ((asked = true), { ok: true })));
		expect(result.ok).toBe(false);
		expect(asked).toBe(false);
		expect(r.calls).toEqual([]);
	});
});
