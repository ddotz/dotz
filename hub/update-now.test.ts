// The top update bar's tap (hub/update-now.ts): one tap downloads and tests (the update gate), then the idle restart applies it; new turns
// that arrive after the tap are held on disk and go in right after the restart, in arrival order. Lanes keep the restart rule.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance } from "./runtime/test-clock.ts";
import { createUpdateNow, type Reply, type UpdateNowDeps } from "./update-now.ts";

let dataDir: string;
beforeEach(() => void (dataDir = mkdtempSync(join(tmpdir(), "dotz-update-now-"))));
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

type Job = { status: string; message: string; from?: string };
// A controllable apply, and a recorder for everything the flow does.
function rig(over: Partial<UpdateNowDeps> = {}) {
	let finish!: (j: Job) => void;
	const applied = new Promise<Job>(r => (finish = r));
	const calls = { apply: 0, restart: 0, delivered: [] as { text: string; reply?: Reply }[], states: [] as string[], logs: [] as string[] };
	const logged = (pattern: RegExp) => new Promise<void>(res => {
		const check = () => (calls.logs.some(l => pattern.test(l)) ? res() : void waiters.push(check));
		check();
	});
	const waiters: (() => void)[] = [];
	const deps: UpdateNowDeps = {
		dataDir,
		apply: () => (calls.apply++, applied),
		restartIdle: () => (calls.restart++, "gateway restarts when idle"),
		busy: () => [],
		deliver: (text, reply) => (calls.delivered.push({ text, ...(reply ? { reply } : {}) }), false),
		delivered: (target, ref) => void calls.states.push(`${target}:${ref}`),
		log: line => {
			calls.logs.push(line);
			for (const w of waiters.splice(0)) w();
		},
		tickMs: 1,
		...over,
	};
	return { u: createUpdateNow(deps), deps, calls, finish, logged };
}

test("a tap downloads through the gate, then asks the idle restart once; a second tap joins the same update", async () => {
	const { u, calls, finish, logged } = rig();
	expect(u.start().phase).toBe("download");
	expect(u.start().phase).toBe("download");
	expect(calls.apply).toBe(1);
	expect(u.holding()).toBe(true);
	finish({ status: "updated", message: "aaaaaaa → bbbbbbb 받았어요. 재시작하면 적용돼요.", from: "a".repeat(40) });
	await logged(/gateway restarts when idle/);
	expect(u.flow()).toMatchObject({ phase: "waiting", text: "진행 중인 작업이 끝나면 바로 적용해요" });
	expect(calls.restart).toBe(1);
	u.restarting();
	expect(u.flow()!.phase).toBe("restarting");
});

test("messages after the tap are held, not started, and go in after the restart in arrival order with their delivery states", async () => {
	const first = rig();
	first.u.start();
	expect(first.u.hold("[dotz inbox] web 첫째", { target: "web", replyTo: "m1", owner: true }, ["m1"])).toBe(true);
	expect(first.u.hold("[dotz watch] 감시 소식")).toBe(true);
	first.finish({ status: "updated", message: "받았어요", from: "a".repeat(40) });
	await first.logged(/gateway restarts when idle/);
	expect(first.u.hold("[dotz inbox] ch:1 둘째", { target: "ch:1", replyTo: "d2", owner: true }, ["d2"])).toBe(true);
	expect(first.calls.delivered).toEqual([]);
	first.u.restarting();

	// the next process: same data dir, a new checkout commit
	const next = rig({ current: async () => "b".repeat(40) });
	expect(next.u.heldCount()).toBe(3);
	expect(await next.u.boot()).toBe(3);
	expect(next.calls.delivered.map(d => d.text)).toEqual(["[dotz inbox] web 첫째", "[dotz watch] 감시 소식", "[dotz inbox] ch:1 둘째"]);
	expect(next.calls.delivered[0]!.reply).toEqual({ target: "web", replyTo: "m1", owner: true });
	expect(next.calls.states).toEqual(["web:m1", "ch:1:d2"]);
	expect(next.u.flow()).toMatchObject({ phase: "done", text: "업데이트를 마쳤어요" });
	expect(next.u.holding()).toBe(false);
	expect(next.u.hold("after", { target: "web" })).toBe(false);
	expect(existsSync(join(dataDir, "self-update", "held.json"))).toBe(false);
	expect(rig().u.heldCount()).toBe(0);
});

test("a failed download says why and lets the held messages go in at once, in order", async () => {
	const { u, calls, finish, logged } = rig();
	u.start();
	u.hold("one", { target: "web", owner: true });
	u.hold("two", { target: "web", owner: true });
	finish({ status: "failed", message: "테스트 실패: the broken one. 이전 버전(aaaaaaa)에 그대로 있어요." });
	await logged(/held message\(s\) delivered/);
	expect(u.flow()).toMatchObject({ phase: "failed", text: "테스트 실패: the broken one. 이전 버전(aaaaaaa)에 그대로 있어요." });
	expect(calls.delivered.map(d => d.text)).toEqual(["one", "two"]);
	expect(calls.restart).toBe(0);
	expect(u.holding()).toBe(false);
});

test("an already current checkout ends as done without a restart", async () => {
	const { u, calls, finish, logged } = rig();
	u.start();
	finish({ status: "current", message: "이미 최신이에요 (aaaaaaa)." });
	await logged(/update now: done/);
	expect(u.flow()).toMatchObject({ phase: "done", text: "이미 최신 버전이에요" });
	expect(calls.restart).toBe(0);
});

// Lanes keep the existing rule (a busy lane is never killed, the restart waits for it); only the hold is lifted so a long lane does not
// keep the owner's messages for hours. The restart request stays (restart.ts applies the update when the lanes are done).
test("when only lanes keep the restart waiting past the limit, held messages go in and the restart still waits", async () => {
	let busy = ["orchestrator turn", "lane fix-auth"];
	const { u, calls, finish, logged } = rig({ busy: () => busy, lanesOnlyMs: 0 });
	u.start();
	u.hold("held while a lane runs", { target: "web", owner: true });
	finish({ status: "updated", message: "받았어요", from: "a".repeat(40) });
	await logged(/gateway restarts when idle/);
	expect(calls.delivered).toEqual([]);
	busy = ["lane fix-auth"];
	// The wait ticks on the preload's fake clock (hub/runtime/test-clock.ts): move it past the next tick.
	await advance(5);
	await logged(/only lanes still busy: lane fix-auth/);
	expect(calls.delivered.map(d => d.text)).toEqual(["held while a lane runs"]);
	expect(u.flow()).toMatchObject({ phase: "waiting", released: true });
	expect(u.hold("later", { target: "web" })).toBe(false);
	expect(calls.restart).toBe(1);
});

test("at boot: a rolled-back update and a download cut by a restart both end as failed with the reason", async () => {
	const a = rig();
	a.u.start();
	a.finish({ status: "updated", message: "받았어요", from: "a".repeat(40) });
	await a.logged(/gateway restarts when idle/);
	a.u.restarting();
	const rolled = rig({ current: async () => "a".repeat(40) });
	await rolled.u.boot();
	expect(rolled.u.flow()).toMatchObject({ phase: "failed", text: "새 버전이 제대로 켜지지 않아 이전 버전으로 되돌렸어요" });

	rmSync(join(dataDir, "self-update"), { recursive: true, force: true });
	rig().u.start();
	const cut = rig();
	await cut.u.boot();
	expect(cut.u.flow()!.phase).toBe("failed");
	expect(cut.u.flow()!.text).toContain("다시 눌러 주세요");
});

test("no owner-facing flow text carries test counts", async () => {
	const { u, finish, logged } = rig();
	u.start();
	finish({ status: "updated", message: "받았어요", from: "a".repeat(40) });
	await logged(/gateway restarts when idle/);
	u.restarting();
	expect(JSON.stringify(u.flow())).not.toMatch(/\d+ (pass|fail)/);
});
