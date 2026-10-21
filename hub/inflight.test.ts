// A reply still in its output-language rewrite holds a gateway restart, and is never lost when shutdown comes first.
import { expect, test } from "bun:test";
import { createInflight } from "./inflight.ts";
import { createRestartGate } from "./restart.ts";
import { advance } from "./runtime/test-clock.ts";

type Job = { target: string; text: string };

function setup() {
	const outbox: string[] = [];
	const replies = createInflight<Job>(j => outbox.push(`${j.target}: ${j.text}`));
	const state = { exits: 0, busy: [] as string[] };
	const gate = createRestartGate({
		busy: () => [...(replies.size() ? ["reply"] : []), ...state.busy],
		collecting: () => false,
		startedAt: Date.now() - 3600_000,
		minGapMs: 5 * 60_000,
		noticeAfterMs: 20 * 60_000,
		notice: () => {},
		log: () => {},
		exit: () => state.exits++,
	});
	return { replies, outbox, gate, state };
}

test("a restart requested while a reply is in its rewrite waits for it, and the reply lands in the outbox", async () => {
	const { replies, outbox, gate, state } = setup();
	const job = { target: "web", text: "answer" };
	replies.begin(job);
	expect(gate.request()).toContain("waiting for: reply");
	await advance(60_000);
	expect(state.exits).toBe(0);
	// The rewrite finished: the post writes its own outbox entry and the gate may go.
	expect(replies.end(job)).toBe(true);
	outbox.push("web: answer");
	await advance(5000);
	expect(state.exits).toBe(1);
	expect(outbox).toEqual(["web: answer"]);
});

test("shutdown lands a reply whose rewrite did not finish by the deadline, once", async () => {
	const { replies, outbox } = setup();
	const job = { target: "web", text: "answer" };
	replies.begin(job);
	const flushed = replies.flush(31_000);
	await advance(31_000);
	expect(await flushed).toBe(1);
	expect(outbox).toEqual(["web: answer"]);
	// The late rewrite must not write it a second time.
	expect(replies.end(job)).toBe(false);
	expect(replies.size()).toBe(0);
});

test("shutdown does not wait when a reply finishes first", async () => {
	const { replies, outbox } = setup();
	const job = { target: "web", text: "answer" };
	replies.begin(job);
	const flushed = replies.flush(31_000);
	replies.end(job);
	expect(await flushed).toBe(0);
	expect(outbox).toEqual([]);
});
