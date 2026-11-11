// The usage screen's 적용 applies one listed fix on the owner's press only, through the guarded change route, and refuses a stale one.
import { expect, test } from "bun:test";
import type { changeTarget } from "./control.ts";
import { applyFix, type FixDeps } from "./usage-fix.ts";
import type { FixRow } from "./usage-share.ts";

const FIXES: FixRow[] = [
	{ id: "watch:site-up", fix: "watch", watch: "site-up", who: { kind: "other", name: "site-up" }, cost: 4, n: 30 },
	{ id: "compact:lane:site-fix", fix: "compact", target: "lane:site-fix", who: { kind: "lane", name: "site-fix" }, cost: 3 },
	{ id: "worker:workers:claude-fable-5-2", fix: "worker", target: "workers", model: "claude-fable-5-2", who: { kind: "orchestrator", name: "" }, cost: 9, n: 2 },
	{ id: "check:bust:/x.jsonl", fix: "check", who: { kind: "orchestrator", name: "" }, cost: 2, n: 4 },
];
const OWNER = new Request("http://localhost/api/usage/fix", { method: "POST" });

function rig(over: Partial<FixDeps> = {}) {
	const calls: unknown[][] = [];
	const applied: Record<string, number> = {};
	const deps: FixDeps = {
		isAgent: () => false,
		fixes: () => FIXES,
		applied: () => applied,
		markApplied: (id, at) => void (applied[id] = at),
		watches: () => [{ id: "w1", name: "site-up", every_minutes: 5 }],
		patchWatch: (id, input) => calls.push(["patch", id, input]),
		contextTokens: async () => 420_000,
		currentWorkerModel: () => "anthropic/claude-fable-5-2:high",
		change: (async (target: string, change: Record<string, unknown>) => (calls.push(["change", target, change]), { ok: true })) as unknown as typeof changeTarget,
		now: () => 1000,
		...over,
	};
	return { deps, calls, applied };
}

test("an agent's request applies nothing", async () => {
	const { deps, calls } = rig({ isAgent: () => true });
	expect((await applyFix(OWNER, { id: "watch:site-up" }, deps)).status).toBe(403);
	expect(calls).toEqual([]);
});

test("a watch fix doubles that watch's interval once; a second press is refused", async () => {
	const { deps, calls, applied } = rig();
	const r = await applyFix(OWNER, { id: "watch:site-up" }, deps);
	expect([r.status, r.body.every_minutes]).toEqual([200, 10]);
	expect(calls).toEqual([["patch", "w1", { every_minutes: 10 }]]);
	expect(applied["watch:site-up"]).toBe(1000);
	expect((await applyFix(OWNER, { id: "watch:site-up" }, deps)).status).toBe(409);
	expect(calls.length).toBe(1);
});

test("compact goes through the change route with the owner's request, and not when the context is already small", async () => {
	const { deps, calls } = rig();
	expect((await applyFix(OWNER, { id: "compact:lane:site-fix" }, deps)).status).toBe(200);
	expect(calls).toEqual([["change", "lane:site-fix", { compact: true, req: OWNER }]]);
	const small = rig({ contextTokens: async () => 40_000 });
	expect((await applyFix(OWNER, { id: "compact:lane:site-fix" }, small.deps)).status).toBe(409);
	expect(small.calls).toEqual([]);
});

test("a worker fix sets that target's worker model to the default through the guarded route, unless it was changed since", async () => {
	const { deps, calls } = rig();
	const r = await applyFix(OWNER, { id: "worker:workers:claude-fable-5-2" }, deps);
	expect(r.status).toBe(200);
	expect(calls).toEqual([["change", "workers", { workerModel: r.body.worker_model, req: OWNER, byLane: false }]]);
	const moved = rig({ currentWorkerModel: () => "anthropic/claude-sonnet-5-5:high" });
	expect((await applyFix(OWNER, { id: "worker:workers:claude-fable-5-2" }, moved.deps)).status).toBe(409);
	expect(moved.calls).toEqual([]);
});

test("a cause-unknown row and an unlisted id are refused without a change", async () => {
	const { deps, calls } = rig();
	expect((await applyFix(OWNER, { id: "check:bust:/x.jsonl" }, deps)).status).toBe(400);
	expect((await applyFix(OWNER, { id: "watch:other" }, deps)).status).toBe(404);
	expect((await applyFix(OWNER, {}, deps)).status).toBe(400);
	expect(calls).toEqual([]);
});
