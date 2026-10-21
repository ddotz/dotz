// The send ledger: an answer is marked answered only after Discord accepted it, a network error is retried with backoff,
// a restart sends what was left unsent, and a part Discord already accepted is never posted again.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryable } from "./discord.ts";
import { replyRef } from "./threads.ts";
import { createSendLedger, type SendItem, type SendOpts } from "./sendlog.ts";

const netDown = () => new TypeError("fetch failed: Unable to connect");

function setup(file: string, send: (target: string, text: string, ref: string | undefined, opts: SendOpts) => Promise<{ delivered: boolean }>, stall = false) {
	const state = { delivered: [] as SendItem[], dropped: [] as string[], waits: [] as number[], saved: [] as SendItem[][] };
	const ledger = createSendLedger({
		file,
		send,
		retryable: isRetryable,
		onDelivered: item => state.delivered.push(item),
		onGiveUp: (_item, reason) => state.dropped.push(reason),
		persist: items => {
			state.saved.push(items);
			writeFileSync(file, JSON.stringify(items));
		},
		log: () => {},
		wait: ms => (state.waits.push(ms), stall ? new Promise<void>(() => {}) : Promise.resolve()),
	});
	return { ledger, state };
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "sendlog-")), "unsent.json");

test("a web reply_to (hex) goes out without a reference and still marks the prompt answered", async () => {
	const refs: (string | undefined)[] = [];
	const { ledger, state } = setup(tmpFile(), async (_t, _x, ref) => (refs.push(ref), { delivered: true }));
	const target = "ch:1561565203714408448";
	const r = await ledger.submit(target, "answer", replyRef(target, "5eeba27e", undefined), "5eeba27e");
	expect(r.delivered).toBe(true);
	expect(refs).toEqual([undefined]);
	expect(state.delivered.map(i => i.answers)).toEqual(["5eeba27e"]);
});

test("a network error is retried with backoff and the answer is marked answered only after the send succeeded", async () => {
	let calls = 0;
	const { ledger, state } = setup(tmpFile(), async () => {
		calls++;
		expect(state.delivered).toEqual([]);
		if (calls <= 2) throw netDown();
		return { delivered: true };
	});
	const r = await ledger.submit("chat", "the answer", "m1", "m1");
	expect(r.delivered).toBe(true);
	expect(calls).toBe(3);
	expect(state.waits).toEqual([1000, 2000]);
	expect(state.delivered.map(i => i.answers)).toEqual(["m1"]);
	expect(ledger.items()).toEqual([]);
});

test("while an answer is retried it counts as pending; a 4xx is final and not retried", async () => {
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const { ledger, state } = setup(tmpFile(), async (_t, text) => {
		if (text === "bad") throw new Error("discord POST /channels/1/messages: 403 Missing Access");
		await gate;
		return { delivered: true };
	});
	const slow = ledger.submit("chat", "slow", undefined, "m2");
	expect(ledger.pending("m2")).toBe(true);
	release();
	await slow;
	expect(ledger.pending("m2")).toBe(false);
	const bad = await ledger.submit("alert", "bad");
	expect(bad.delivered).toBe(false);
	expect(state.waits).toEqual([]);
	expect(state.dropped.length).toBe(1);
});

test("unsent messages survive a restart and are sent once, skipping parts Discord already accepted", async () => {
	const file = tmpFile();
	// The first process sends part 0, then the network goes down for good before it is restarted.
	const first = setup(file, async (_t, _x, _r, opts) => {
		if (opts.skip === 0) opts.onPart(0);
		throw netDown();
	}, true);
	void first.ledger.submit("lane:x", "two part report", undefined, "m3");
	await Bun.sleep(0);
	expect(first.state.waits).toEqual([1000]);
	const left = JSON.parse(await Bun.file(file).text()) as SendItem[];
	expect(left.map(i => [i.target, i.parts, i.answers])).toEqual([["lane:x", 1, "m3"]]);

	const posts: { skip: number; nonce: string }[] = [];
	const second = setup(file, async (_t, _x, _r, opts) => (posts.push({ skip: opts.skip, nonce: opts.nonce }), { delivered: true }));
	expect(second.ledger.resume()).toBe(1);
	expect(second.ledger.resume()).toBe(0);
	await Bun.sleep(0);
	expect(posts).toEqual([{ skip: 1, nonce: left[0]!.id }]);
	expect(second.state.delivered.map(i => i.answers)).toEqual(["m3"]);
	expect(JSON.parse(await Bun.file(file).text())).toEqual([]);
});

test("messages to one target keep their order while an earlier one is retried", async () => {
	const order: string[] = [];
	let failed = false;
	const { ledger } = setup(tmpFile(), async (_t, text) => {
		if (text === "first" && !failed) {
			failed = true;
			throw netDown();
		}
		order.push(text);
		return { delivered: true };
	});
	await Promise.all([ledger.submit("chat", "first"), ledger.submit("chat", "second")]);
	expect(order).toEqual(["first", "second"]);
});

test("isRetryable: network errors and 5xx retry, 4xx does not", () => {
	expect(isRetryable(netDown())).toBe(true);
	expect(isRetryable(new Error("discord POST /x: 502 Bad Gateway"))).toBe(true);
	expect(isRetryable(new Error("discord POST /x: 400 bad"))).toBe(false);
});
