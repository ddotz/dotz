// The run state derivation (hub/runstate.ts): every kind and every reason an idle conversation can give for leaving todos open.
import { expect, test } from "bun:test";
import { failureText, lastTurnEnd, mailConversation, openTodos, runIntent, runState, workConversationRuns } from "./runstate.ts";

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

test("a mail conversation's run state is the worker its request was deferred to, whichever target names it", () => {
	const threads: Record<string, string> = { "1564523279849357364": "kdb-67010497" };
	const conv = (t: string) => mailConversation(t, id => threads[id]);
	expect(conv("th:1564523279849357364")).toBe("mail:kdb-67010497");
	expect(conv("mail:kdb-67010497")).toBe("mail:kdb-67010497");
	expect(conv("web")).toBeUndefined();
	const work = { id: "st_01a17c04", description: "큐피드 연결 스크립트 흐름도 HTML", status: "running" as const, started_at: now - 240_000, target: "th:1564523279849357364" };
	// The thread target and the mail key name the one conversation the owner sees, so either yields its line.
	expect(workConversationRuns([work], conv)).toEqual({ "mail:kdb-67010497": { kind: "working", since: iso(240_000), detail: "큐피드 연결 스크립트 흐름도 HTML" } });
	expect(workConversationRuns([{ ...work, target: "mail:kdb-67010497" }], conv)).toEqual({ "mail:kdb-67010497": { kind: "working", since: iso(240_000), detail: "큐피드 연결 스크립트 흐름도 HTML" } });
	expect(workConversationRuns([{ ...work, target: "web" }], conv)).toEqual({});
});

test("a worker that failed at spawn says why, and whether it was handed over again", () => {
	const conv = (t: string) => mailConversation(t, () => "kdb-67010497");
	const failed = { id: "st_01a17c03", description: "큐피드 연결 스크립트 흐름도 HTML", status: "failed" as const, started_at: now - 300_000, ended_at: now - 300_000, target: "th:1564523279849357364", error: "child turn produced no assistant output" };
	expect(workConversationRuns([failed], conv)["mail:kdb-67010497"]).toEqual({ kind: "error", since: iso(300_000), detail: "child turn produced no assistant output · 다시 맡기지 않았어요" });
	const retry = { id: "st_01a17c04", description: "다시", status: "running" as const, started_at: now - 240_000, target: "th:1564523279849357364" };
	expect(workConversationRuns([failed, retry], conv)["mail:kdb-67010497"]).toMatchObject({ kind: "working", detail: "다시" });
	const failedAgain = { ...retry, status: "failed" as const, ended_at: now - 60_000 };
	expect(workConversationRuns([failed, failedAgain], conv)["mail:kdb-67010497"]).toMatchObject({ kind: "error", detail: "이유가 기록되지 않았어요 · 다시 맡긴 작업도 실패했어요" });
});

test("an isolation refusal is said in Korean instead of raw git output", () => {
	const raw = "isolation_unavailable: baseline capture failed: git -c core.fsmonitor=false -c core.untrackedCache=false rev-parse --verify --quiet HEAD failed (128): fatal: 깃 저장소가 아닙니다: (null)";
	expect(failureText(raw)).toBe("작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요");
	expect(failureText("isolation_unavailable: not a git checkout")).toBe("작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요");
	expect(failureText("isolation_unavailable: Working tree at /r exceeds the 1073741824-byte isolation snapshot budget.")).toBe("작업 폴더가 너무 커서 격리 사본을 만들지 못해 시작하지 못했어요");
	expect(failureText("isolation_unavailable: no isolation runtime is wired into this session")).toBe("작업 폴더의 격리 사본을 만들지 못해 시작하지 못했어요");
	expect(failureText("child turn produced no assistant output")).toBe("child turn produced no assistant output");
	expect(failureText(undefined)).toBe("이유가 기록되지 않았어요");
	const conv = (t: string) => mailConversation(t, () => "k1");
	const failed = { id: "st_01a17c1a", status: "failed" as const, started_at: now - 60_000, ended_at: now - 60_000, target: "mail:k1", error: raw };
	expect(workConversationRuns([failed], conv)["mail:k1"]).toMatchObject({ kind: "error", detail: "작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요 · 다시 맡기지 않았어요" });
});

test("a finished worker leaves the conversation done with what it was", () => {
	const conv = (t: string) => mailConversation(t, () => "k1");
	const done = { id: "st_1", description: "흐름도 그리기", status: "done" as const, started_at: now - 600_000, ended_at: now - 120_000, target: "mail:k1" };
	expect(workConversationRuns([done], conv)).toEqual({ "mail:k1": { kind: "done", since: iso(120_000), detail: "흐름도 그리기" } });
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
