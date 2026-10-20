// A requested gateway restart waits for the orchestrator's turn and for a compaction queued or running: a restart right
// after "compacting in place" lost the compaction (2026-10-20 19:47 KST, the session came back at 244K tokens).
import { expect, test } from "bun:test";
import { newCtx } from "./context.ts";
import { orchBusy } from "./orchestrator.ts";

test("a turn or a queued/running compaction keeps the restart waiting; idle with a finished compaction does not", () => {
	const ctx = newCtx();
	expect(orchBusy({ status: "working", ctx })).toBe("orchestrator");
	expect(orchBusy({ status: "idle", ctx })).toBeUndefined();
	ctx.compaction = { state: "queued", at: "x" } as any;
	expect(orchBusy({ status: "idle", ctx })).toBe("orchestrator compaction");
	ctx.compaction = { state: "compacting", at: "x" } as any;
	expect(orchBusy({ status: "idle", ctx })).toBe("orchestrator compaction");
	ctx.compaction = { state: "done", at: "x", tokensBefore: 244_000 } as any;
	expect(orchBusy({ status: "idle", ctx })).toBeUndefined();
});
