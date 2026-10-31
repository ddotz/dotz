// How many conversation sessions may run at once follows the computer's free memory and load (owner 2026-10-28), never below 1.
import { expect, test } from "bun:test";
import { availableBytes, capacityFrom, settleMax, treeRss } from "./convcapacity.ts";

const GB = 1024 ** 3, MB = 1024 ** 2;
const base = { totalBytes: 16 * GB, cpus: 10, load1: 2, live: 0, perSessionBytes: 600 * MB };

test("free memory above the reserve decides how many more sessions fit", () => {
	// 16 GB machine: reserve 2.4 GB; 4.45 GB free (the Mac mini at 13:5x) leaves room for 3 sessions of 600 MB
	expect(capacityFrom({ ...base, availBytes: 4.45 * GB }).max).toBe(3);
	expect(capacityFrom({ ...base, availBytes: 12 * GB }).max).toBe(7);
	// already running sessions count toward the cap
	expect(capacityFrom({ ...base, availBytes: 4.45 * GB, live: 2 }).max).toBe(5);
});

test("a full or overloaded computer still allows one, and never starts more than it runs when every core is busy", () => {
	expect(capacityFrom({ ...base, availBytes: 1 * GB }).max).toBe(1);
	expect(capacityFrom({ ...base, availBytes: 12 * GB, load1: 14, live: 2 }).max).toBe(2);
	expect(capacityFrom({ ...base, availBytes: 64 * GB, totalBytes: 128 * GB, cpus: 32, perSessionBytes: 300 * MB }).max).toBe(12);
});

test("available memory reads free plus reclaimable pages from vm_stat, MemAvailable on Linux", () => {
	const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  8795.\nPages active:  256413.\nPages inactive:  252421.\nPages speculative:  4389.\nPages purgeable:  6309.\n";
	expect(availableBytes(vm)).toBe((8795 + 252421 + 4389 + 6309) * 16384);
	expect(availableBytes(undefined, "MemTotal: 100 kB\nMemAvailable:    2048 kB\n")).toBe(2048 * 1024);
});

test("a session's memory is its process together with every child", () => {
	const ps = " 10 1 1000\n 11 10 500\n 12 11 250\n 20 1 300\n";
	expect(treeRss(ps, [10, 20, 99])).toEqual([1750 * 1024, 300 * 1024, 0]);
});

// Mac mini 2026-10-29: the cap was logged anew every 30 s, 2 -> 7 -> 6 -> 2 ...; one reading alone no longer moves it.
test("the cap moves only when two samples in a row point the same way, by the smaller step", () => {
	let cur = settleMax(undefined, undefined, 3);
	expect(cur).toEqual({ max: 3 });
	const seq = [7, 2, 6, 3];
	for (const n of seq) cur = settleMax(cur.max, cur.pending, n);
	expect(cur.max).toBe(3);
	cur = settleMax(cur.max, cur.pending, 5);
	expect(cur).toEqual({ max: 3, pending: 5 });
	cur = settleMax(cur.max, cur.pending, 6);
	expect(cur.max).toBe(5);
	cur = settleMax(cur.max, cur.pending, 2);
	cur = settleMax(cur.max, cur.pending, 1);
	expect(cur.max).toBe(2);
});
