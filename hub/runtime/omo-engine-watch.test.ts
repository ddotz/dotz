// #26: the gateway restarts (through the idle gate) once the OmO engine on disk differs on two checks in a row.
import { afterEach, expect, test } from "bun:test";
import { startOmoEngineWatch } from "./omo-engine-watch.ts";
import { advance } from "./test-clock.ts";

const EVERY = 60_000;
const OLD = "omo-ai@5.1.51 senpi@2026.10.27-1";
const NEW = "omo-ai@5.1.57 senpi@2026.10.31-2";

let stop = () => {};
afterEach(() => stop());

// Each check reads the next entry (an Error entry throws); the last entry repeats.
function watch(reads: (string | Error)[]) {
	let i = 0;
	let restarts = 0;
	const read = () => {
		const r = reads[Math.min(i++, reads.length - 1)]!;
		if (r instanceof Error) throw r;
		return r;
	};
	stop = startOmoEngineWatch(() => (++restarts, "restart requested"), { read, everyMs: EVERY });
	return { restarts: () => restarts, reads: () => i };
}

test("same version on every check: no restart", async () => {
	const w = watch([OLD]);
	await advance(EVERY * 5);
	expect(w.reads()).toBe(6);
	expect(w.restarts()).toBe(0);
});

test("one changed read, then back to the started version: no restart", async () => {
	const w = watch([OLD, NEW, OLD]);
	await advance(EVERY * 5);
	expect(w.restarts()).toBe(0);
});

test("two consecutive changed reads: exactly one restart, and the watch ends", async () => {
	const w = watch([OLD, NEW, NEW]);
	await advance(EVERY);
	expect(w.restarts()).toBe(0);
	await advance(EVERY);
	expect(w.restarts()).toBe(1);
	await advance(EVERY * 10);
	expect(w.restarts()).toBe(1);
	expect(w.reads()).toBe(3);
});

test("a read error is not a change and breaks the consecutive count", async () => {
	const w = watch([OLD, NEW, new Error("half-written package.json"), NEW]);
	await advance(EVERY * 3);
	expect(w.restarts()).toBe(0);
	await advance(EVERY);
	expect(w.restarts()).toBe(1);
});

test("a read error alone never restarts", async () => {
	const w = watch([OLD, new Error("ENOENT")]);
	await advance(EVERY * 5);
	expect(w.restarts()).toBe(0);
});

test("versions unreadable at start: nothing is watched", async () => {
	const w = watch([new Error("omo not on PATH")]);
	await advance(EVERY * 5);
	expect(w.reads()).toBe(1);
	expect(w.restarts()).toBe(0);
});
