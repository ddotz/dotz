// A failed keepalive ping is dropped (no retry, failover or alert); a usage limit or an owner-fixable error during it still
// takes the normal path, which pauses the orchestrator and holds messages.
import { expect, test } from "bun:test";
import { keepaliveErrorDropped } from "./orchestrator.ts";

test("a transient or other error in a keepalive is dropped; rate and owner errors are not", () => {
	expect(keepaliveErrorDropped("transient")).toBe(true);
	expect(keepaliveErrorDropped("rate")).toBe(false);
	expect(keepaliveErrorDropped("owner")).toBe(false);
});
