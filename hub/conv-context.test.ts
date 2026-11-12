// Each conversation with its own session reads and compacts that session's context (the composer's chip, /context, /compact), never main's.
import { afterAll, expect, test } from "bun:test";
import { setContextLimits } from "./config.ts";
import { changeTarget, compactTarget, contextView, runCommand, targetView } from "./control.ts";
import { convs, type Conv } from "./convsessions.ts";
import "./outbound.ts";
import { orch } from "./orchestrator.ts";

const P = "ch:7001", MAIL = "mail:k1", PARKED = "ch:7002", NEVER = "ch:7003", SONNET = "anthropic/claude-sonnet-5-5";
const ctxFor = (key: string, tokens: number, window: number) => {
	const c = convs.get(key) ?? convs.ensure(key);
	c.o.orch.ctx = { tokens, window, compaction: {} };
	return c;
};
// A running session without a process: live, idle, and its compaction counted.
const stubbed = new Map<Conv, Conv["o"]["orchestratorPid"]>();
const running = (c: Conv) => {
	let calls = 0;
	stubbed.set(c, stubbed.get(c) ?? c.o.orchestratorPid);
	c.o.orchestratorPid = () => 1;
	c.o.compact = () => (calls++, (c.o.orch.ctx.compaction = { state: "compacting" }));
	return () => calls;
};
const row = (key: string) => contextView().conversations.find(c => c.key === key);
const mainCtx = { ...orch.ctx };
orch.ctx = { tokens: 900_000, window: 1_000_000, compaction: {} };
afterAll(() => {
	orch.ctx = mainCtx;
	for (const [c, pid] of stubbed) c.o.orchestratorPid = pid;
	for (const key of [P, PARKED]) convs.setOwnModel(key, undefined);
	setContextLimits(SONNET, { window: null, compact_at: null }, 0);
});

test("a project's numbers are its own session's, and its percent uses its own model's window", async () => {
	const c = ctxFor(P, 100_000, 1_000_000);
	running(c);
	expect(row(P)).toMatchObject({ kind: "conversation", running: true, tokens: 100_000, window: 1_000_000, percent: 10 });
	await changeTarget(P, { model: SONNET, thinking: "low", force: true });
	c.o.orch.activeModel = `${SONNET}:low`;
	setContextLimits(SONNET, { window: 200_000, compact_at: null }, 0);
	expect(row(P)).toMatchObject({ model: `${SONNET}:low`, window: 200_000, percent: 50 });
	expect((await targetView(P)) as object).toMatchObject({ running: true, context: { tokens: 100_000, window: 200_000, percent: 50 } });
	expect(contextView().conversation_kinds).toContain("ch");
});

test("a parked session keeps its last figure and a session that never reported has none", async () => {
	ctxFor(PARKED, 50_000, 1_000_000);
	ctxFor(NEVER, 0, 0);
	expect(row(PARKED)).toMatchObject({ running: false, tokens: 50_000, percent: 5 });
	expect(row(NEVER)).toBeUndefined();
	expect((await targetView(PARKED)) as object).toMatchObject({ running: false, context: { tokens: 50_000 } });
});

test("the percent of a parked session whose model changed uses the model it will run on, not the old window", async () => {
	const c = ctxFor(PARKED, 50_000, 1_000_000);
	c.o.orch.activeModel = "anthropic/claude-opus-5-5:medium";
	await changeTarget(PARKED, { model: SONNET, thinking: "low" });
	setContextLimits(SONNET, { window: 200_000, compact_at: null }, 0);
	expect(row(PARKED)).toMatchObject({ model: `${SONNET}:low`, window: 200_000, percent: 25 });
});

test("compacting from a project or a mail thread compacts that session, not main's", async () => {
	const p = running(ctxFor(P, 100_000, 1_000_000)), m = running(ctxFor(MAIL, 80_000, 1_000_000));
	expect(await changeTarget(P, { compact: true })).toMatchObject({ ok: true, target: P, compaction: "compacting" });
	expect(p()).toBe(1);
	expect(await changeTarget(MAIL, { compact: true })).toMatchObject({ ok: true, compaction: "compacting" });
	expect(m()).toBe(1);
	expect(orch.ctx.compaction.state).toBeUndefined();
	convs.get(P)!.o.orch.ctx.compaction = {};
	expect(compactTarget(P).target).toBe(P);
	expect(p()).toBe(2);
});

test("a parked session cannot compact: a clear refusal, and main is left alone", async () => {
	await expect(changeTarget(PARKED, { compact: true })).rejects.toThrow("no running session");
	expect(orch.ctx.compaction.state).toBeUndefined();
});

test("/compact and /context written in a conversation act on its session; a named target is still main's", async () => {
	const c = ctxFor(P, 100_000, 1_000_000), calls = running(c), before = calls();
	const ctx = await runCommand("/context", P);
	expect(ctx.facts).toHaveLength(1);
	expect(ctx.facts![0]!.value).toContain("100k");
	expect(ctx.facts![0]!.value).not.toContain("900k");
	expect((await runCommand("/compact", P)).tone).not.toBe("err");
	expect(calls()).toBe(before + 1);
	expect((await runCommand("/compact", PARKED)).tone).toBe("err");
	expect((await runCommand("/context", PARKED)).facts![0]!.value).toContain("50k");
	expect((await runCommand("/context")).facts!.length).toBeGreaterThan(0);
	expect((await runCommand("/compact")).tone).toBe("err");
	const status = orch.status;
	orch.status = "idle";
	expect((await runCommand("/context", "lane:x")).facts![0]!.value).toContain("900k");
	orch.status = status;
});
