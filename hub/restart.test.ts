// The restart gate: a busy lane is never killed (the restart waits and says so once), requests are coalesced into one
// restart, and a restart never comes sooner than the minimum gap after the process started.
import { expect, test } from "bun:test";
import { createRestartGate } from "./restart.ts";
import { advance } from "./runtime/test-clock.ts";

function setup(opts: { busy?: string[]; startedAgoMs?: number } = {}) {
	const state = { busy: opts.busy ?? [], exits: 0, notices: [] as string[] };
	const gate = createRestartGate({
		busy: () => state.busy,
		collecting: () => false,
		startedAt: Date.now() - (opts.startedAgoMs ?? 3600_000),
		minGapMs: 5 * 60_000,
		noticeAfterMs: 20 * 60_000,
		notice: text => state.notices.push(text),
		log: () => {},
		exit: () => state.exits++,
	});
	return { gate, state };
}

test("a busy lane is waited for past 20 minutes, never killed; the owner is told once", async () => {
	const { gate, state } = setup({ busy: ["lane gateway-ui"] });
	gate.request();
	await advance(3 * 3600_000);
	expect(state.exits).toBe(0);
	expect(state.notices.length).toBe(1);
	state.busy = [];
	await advance(5000);
	expect(state.exits).toBe(1);
});

test("requests close together are one restart, no sooner than 5 min after start", async () => {
	const { gate, state } = setup({ startedAgoMs: 60_000 });
	expect(gate.request()).toContain("coalescing");
	await advance(60_000);
	gate.request();
	gate.request();
	await advance(2 * 60_000);
	expect(state.exits).toBe(0);
	await advance(2 * 60_000);
	expect(state.exits).toBe(1);
});

test("an idle gateway past the gap restarts at once", async () => {
	const { gate, state } = setup();
	expect(gate.request()).toBe("gateway restarting");
	await advance(2000);
	expect(state.exits).toBe(1);
});
