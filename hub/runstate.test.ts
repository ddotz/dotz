// The run state derivation (hub/runstate.ts): every kind and every reason an idle conversation can give for leaving todos open.
import { expect, test } from "bun:test";
import { lastTurnEnd, openTodos, runIntent, runState } from "./runstate.ts";

const now = Date.UTC(2026, 9, 26, 3, 0);
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const base = { status: "idle", now };
const todos = (open: number, current?: string) => ({ open, ...(current ? { current } : {}) });

test("working carries the current intent and since when the turn started", () => {
	expect(runState({ ...base, status: "working", since: iso(600_000), intent: "테스트 실행하는 중" }))
		.toEqual({ kind: "working", since: iso(600_000), detail: "테스트 실행하는 중" });
	expect(runState({ ...base, status: "starting", since: iso(2_000) })).toEqual({ kind: "working", since: iso(2_000) });
	expect(runState({ ...base, status: "working", since: iso(1_000), intent: "  여러\n줄   의도 " }).detail).toBe("여러 줄 의도");
});

test("a usage limit says until when; an owner block is its own reason", () => {
	expect(runState({ ...base, status: "rate-limited", rateLimitedUntil: iso(-3_600_000), pauseKind: "rate", since: iso(5_000) }))
		.toEqual({ kind: "limited", reason: "rate", since: iso(5_000), detail: iso(-3_600_000) });
	expect(runState({ ...base, status: "rate-limited", pauseKind: "owner" }).reason).toBe("owner");
});

test("an error episode names the plain reason; the state carries the plan's open tasks", () => {
	expect(runState({ ...base, error: { text: "네트워크 연결이 계속 끊겨요", since: iso(30_000) }, todos: todos(2) }))
		.toEqual({ kind: "error", since: iso(30_000), detail: "네트워크 연결이 계속 끊겨요", todos: 2 });
});

test("stopped by the owner and an exited session", () => {
	expect(runState({ ...base, status: "stopped", stoppedBy: "owner", since: iso(9_000) })).toEqual({ kind: "stopped", reason: "owner", since: iso(9_000) });
	expect(runState({ ...base, status: "stopped" })).toEqual({ kind: "stopped" });
	expect(runState({ ...base, status: "exited", since: iso(9_000) })).toEqual({ kind: "done", since: iso(9_000) });
});

test("a question waiting on the owner wins over background work and the plan", () => {
	const ask = { text: "어느 쪽으로 할까요?", at: iso(120_000) };
	expect(runState({ ...base, ask, work: [{ description: "빌드", started_at: now - 60_000 }], todos: todos(3, "테스트") }))
		.toEqual({ kind: "waiting", reason: "ask", since: ask.at, detail: "어느 쪽으로 할까요?", todos: 3 });
	expect(runState({ ...base, ask: { text: "   " }, todos: todos(1) })).toEqual({ kind: "idle", reason: "unknown", since: undefined, todos: 1 });
});

test("running background work, a child and a deferred answer are named waits", () => {
	expect(runState({ ...base, work: [{ description: "LiveStatusLine 구현", started_at: now - 300_000 }] }))
		.toEqual({ kind: "waiting", reason: "work", since: iso(300_000), detail: "LiveStatusLine 구현" });
	expect(runState({ ...base, children: [{ name: "w1", description: "리뷰 반영" }] })).toEqual({ kind: "waiting", reason: "child", detail: "리뷰 반영" });
	expect(runState({ ...base, later: 1, lastTurnEnd: iso(60_000) })).toEqual({ kind: "waiting", reason: "later", since: iso(60_000) });
	expect(runState({ ...base, capacity: "동시 세션 3개를 이미 쓰고 있어요" }).detail).toBe("동시 세션 3개를 이미 쓰고 있어요");
});

test("idle with open todos gives the reason: the turn ended with work left, or it is unknown", () => {
	expect(runState({ ...base, todos: todos(2, "테스트"), lastTurnEnd: iso(400_000) }))
		.toEqual({ kind: "idle", reason: "unfinished", since: iso(400_000), detail: "테스트", todos: 2 });
	expect(runState({ ...base, todos: todos(1) })).toEqual({ kind: "idle", reason: "unknown", todos: 1 });
});

test("idle with nothing left is done after a turn, and idle before any turn", () => {
	expect(runState({ ...base, lastTurnEnd: iso(60_000) })).toEqual({ kind: "done", since: iso(60_000) });
	expect(runState(base)).toEqual({ kind: "idle" });
});

test("openTodos counts tasks that are neither completed nor abandoned and picks the current one", () => {
	const plan = { phases: [{ name: "구현", tasks: [
		{ content: "API 만들기", status: "completed" },
		{ content: "테스트", status: "in_progress" },
		{ content: "정리", status: "pending" },
		{ content: "버린 일", status: "abandoned" },
	] }] };
	expect(openTodos(plan)).toEqual({ open: 2, current: "테스트" });
	expect(openTodos({ phases: [] })).toEqual({ open: 0 });
});

test("runIntent reads only the current turn; lastTurnEnd is the newest turn's end", () => {
	const items = [
		{ ts: iso(900_000), type: "turn_start" },
		{ ts: iso(800_000), type: "tool_call", intent: "옛날 일" },
		{ ts: iso(700_000), type: "turn_end" },
		{ ts: iso(60_000), type: "turn_start" },
		{ ts: iso(50_000), type: "tool_call", intent: "설정 파일 읽는 중" },
		{ ts: iso(40_000), type: "tool_result", text: "ok" },
	];
	expect(runIntent(items)).toBe("설정 파일 읽는 중");
	expect(runIntent([{ ts: iso(10), type: "turn_start" }])).toBeUndefined();
	expect(lastTurnEnd(items)).toBe(iso(700_000));
});
