import { expect, test } from "bun:test";
import { newCtx, noteEvent, requeueRefused } from "./context.ts";

const refused = { type: "compaction", state: "error", error: "Compaction rejected: session changed, retry compaction", requested: true } as const;
const port = { idle: () => true, compact: () => {}, refreshUsage: () => {} };

test("a compaction refused because the session changed is queued again once; the second refusal stays a failure", () => {
	const c = newCtx();
	c.compaction = { state: "compacting", at: "t" };
	noteEvent(c, refused, port);
	expect(requeueRefused(c, refused.error)).toBe(true);
	expect(c.compaction.state).toBe("queued");
	c.compaction = { state: "compacting", at: "t" };
	noteEvent(c, refused, port);
	expect(requeueRefused(c, refused.error)).toBe(false);
	expect(c.compaction.state).toBe("error");
});

test("any other failure, or one the runtime ran by itself, is not retried", () => {
	const c = newCtx();
	noteEvent(c, { ...refused, error: "Compaction failed: provider timeout" }, port);
	expect(requeueRefused(c, "Compaction failed: provider timeout")).toBe(false);
	const own = newCtx();
	noteEvent(own, { ...refused, requested: false }, port);
	expect(requeueRefused(own, refused.error)).toBe(false);
});

test("a finished compaction gives the next one its retry back", () => {
	const c = newCtx();
	c.compaction = { state: "compacting", at: "t" };
	noteEvent(c, refused, port);
	requeueRefused(c, refused.error);
	noteEvent(c, { type: "compaction", state: "done", tokensBefore: 1 }, port);
	noteEvent(c, refused, port);
	expect(requeueRefused(c, refused.error)).toBe(true);
});
