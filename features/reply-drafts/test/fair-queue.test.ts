import { describe, expect, test } from "bun:test";
import { FairQueue } from "../lib/fair-queue.ts";

const drain = <T>(q: FairQueue<T>): T[] => {
	const out: T[] = [];
	for (let x = q.shift(); x !== undefined; x = q.shift()) out.push(x);
	return out;
};

describe("FairQueue", () => {
	test("lanes take turns, each lane stays in order, and a lane that arrives later joins the rotation", () => {
		const q = new FairQueue<string>();
		for (const x of ["a1", "a2", "a3"]) q.push("a", x);
		expect(q.shift()).toBe("a1");
		q.push("b", "b1");
		q.push("c", "c1");
		q.push("b", "b2");
		expect(drain(q)).toEqual(["a2", "b1", "c1", "a3", "b2"]);
		expect(q.size).toBe(0);
	});

	test("first(n) shows the next n in pop order and removes nothing", () => {
		const q = new FairQueue<string>();
		for (const x of ["a1", "a2", "a3"]) q.push("a", x);
		q.push("b", "b1");
		expect(q.first(3)).toEqual(["a1", "b1", "a2"]);
		expect(q.first(0)).toEqual([]);
		expect(q.size).toBe(4);
		expect(drain(q)).toEqual(["a1", "b1", "a2", "a3"]);
	});
});
