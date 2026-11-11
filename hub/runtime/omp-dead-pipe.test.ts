import { expect, test } from "bun:test";
import { writeQuietly } from "./omp.ts";

// A Bun stdin whose worker closed it answers with EPIPE in two shapes: thrown for a small frame, a rejected promise for a
// large one. Neither may escape, or the gateway process dies with every lane on it.
const epipe = () => Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });

test("an EPIPE thrown by write or flush does not escape", () => {
	expect(() => writeQuietly({ write: () => { throw epipe(); }, flush: () => 0 }, "small\n")).not.toThrow();
	expect(() => writeQuietly({ write: () => 6, flush: () => { throw epipe(); } }, "small\n")).not.toThrow();
});

test("an EPIPE rejected by write or flush is not left unhandled", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (e: unknown) => unhandled.push(e);
	process.on("unhandledRejection", onUnhandled);
	try {
		writeQuietly({ write: () => Promise.reject(epipe()), flush: () => 0 }, "large\n");
		writeQuietly({ write: () => 6, flush: () => Promise.reject(epipe()) }, "large\n");
		await new Promise(resolve => setImmediate(resolve));
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
