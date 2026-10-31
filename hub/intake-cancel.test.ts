import { expect, test } from "bun:test";
import { bursts, dropPending, intake } from "./intake.ts";

test("the owner's 중단 drops a message still gathering in its conversation's burst, so it never starts a turn", () => {
	intake({ ts: new Date().toISOString(), kind: "message", source: "web", channel: "t-cancel", author: "local", text: "also count the commits" }, "t-cancel", "m2");
	expect(bursts.has("t-cancel")).toBe(true);
	expect(dropPending("t-cancel")).toBe(1);
	expect(bursts.has("t-cancel")).toBe(false);
	expect(dropPending("t-cancel")).toBe(0);
});
