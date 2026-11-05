// The run state derivation (hub/runstate.ts): every kind and every reason an idle conversation can give for leaving todos open.
import { expect, test } from "bun:test";
import { failureText, lastTurnActed, lastTurnEnd, lastTurnFailed, mailConversation, openTodos, promisesWork, runIntent, runState, STALL_MS, stallNudge, stallStep, waitsForOwner, workConversationRuns, type RunState, type StallMemo } from "./runstate.ts";

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

test("a session holding a prompt no turn started on yet is working, not resting with tasks left", () => {
	expect(runState({ ...base, queued: 1, todos: todos(2), lastTurnEnd: iso(600_000) }))
		.toEqual({ kind: "working", detail: "받은 메시지 시작하는 중", todos: 2 });
	expect(runState({ ...base, queued: 0, todos: todos(2), lastTurnEnd: iso(600_000) }).kind).toBe("idle");
	expect(runState({ ...base, status: "rate-limited", queued: 1 }).kind).toBe("limited");
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
	expect(runState({ ...base, ask: { text: "   " }, todos: todos(1) })).toEqual({ kind: "idle", reason: "interrupted", since: undefined, todos: 1 });
});

test("running background work, a child and a deferred answer are named waits", () => {
	expect(runState({ ...base, work: [{ description: "LiveStatusLine 구현", started_at: now - 300_000 }] }))
		.toEqual({ kind: "waiting", reason: "work", since: iso(300_000), detail: "LiveStatusLine 구현" });
	expect(runState({ ...base, children: [{ name: "w1", description: "리뷰 반영" }] })).toEqual({ kind: "waiting", reason: "child", detail: "리뷰 반영" });
	expect(runState({ ...base, later: 1, lastTurnEnd: iso(60_000) })).toEqual({ kind: "waiting", reason: "later", since: iso(60_000) });
	expect(runState({ ...base, capacity: "동시 세션 3개를 이미 쓰고 있어요" }).detail).toBe("동시 세션 3개를 이미 쓰고 있어요");
});

test("idle with open todos gives the reason: the turn ended with work left, or it was interrupted", () => {
	expect(runState({ ...base, todos: todos(2, "테스트"), lastTurnEnd: iso(400_000) }))
		.toEqual({ kind: "idle", reason: "unfinished", since: iso(400_000), detail: "테스트", todos: 2 });
	expect(runState({ ...base, todos: todos(1) })).toEqual({ kind: "idle", reason: "interrupted", todos: 1 });
});

// 2026-11-01 15:20Z: the final answer promised three things, then the session rested 25 minutes with no plan and nothing running.
// The owner asked "하고있어?" and got "미안, 아직 시작 안 했어. 말만 하고 멈췄어." — a promise-ending turn is unfinished work.
test("a turn that ended promising work and rests with nothing running is unfinished, and is told to go on", () => {
	const answer = "좋아, 세 가지 다 바로 할게. 1. 빈 채널 이름을 work로 바꿔. 2. 지금 상태를 기록해. 3. 로그를 가져와.";
	const r = runState({ ...base, lastTurnEnd: iso(1_500_000), lastAnswer: answer });
	expect(r).toEqual({ kind: "idle", reason: "unfinished", since: iso(1_500_000), detail: "말한 일을 아직 안 했어요" });
	expect(stallNudge(r, now, [])).toBe(true);
	// Nothing to wait for: a running worker or an open question wins over the promise, as always.
	expect(runState({ ...base, lastTurnEnd: iso(1_500_000), lastAnswer: answer, work: [{ description: "빌드", started_at: now - 300_000 }] }))
		.toMatchObject({ kind: "waiting", reason: "work" });
	expect(runState({ ...base, lastTurnEnd: iso(1_500_000), lastAnswer: answer, ask: { text: "어느 채널로 바꿀까요?", at: iso(1_400_000) } }))
		.toMatchObject({ kind: "waiting", reason: "ask" });
});

test("promisesWork reads a first-person future ending and spares reports, questions and owner-conditional promises", () => {
	expect(promisesWork("좋아, 세 가지 다 바로 할게.")).toBe(true);
	expect(promisesWork("빈 채널 이름을 바꿔 볼게요")).toBe(true);
	expect(promisesWork("이제 시작할게")).toBe(true);
	expect(promisesWork("정리해서 진행하겠습니다")).toBe(true);
	expect(promisesWork("[run] 확인해 볼게요")).toBe(true);            // a [run] report may still promise
	expect(promisesWork("[done] 세 가지 다 끝냈어요.")).toBe(false);  // a finished report
	expect(promisesWork("[ask] 어느 채널로 바꿀까요?")).toBe(false);
	expect(promisesWork("[fail] 채널 이름을 못 바꿨어요.")).toBe(false);
	expect(promisesWork("말해 주면 바로 할게.")).toBe(false);          // waits on the owner
	expect(promisesWork("채널 이름을 올리면 그때 할게요.")).toBe(false);
	expect(promisesWork("이렇게 하면 될까요?")).toBe(false);          // a question, not a promise
	expect(promisesWork("알겠습니다.")).toBe(false);                  // an acknowledgement
	expect(promisesWork("그렇게 되면 좋겠네요.")).toBe(false);        // a guess
	expect(promisesWork("세 가지 다 끝냈어요.")).toBe(false);
	expect(promisesWork(undefined)).toBe(false);
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
	// It names the worker, so the line's 중단 stops that one.
	expect(workConversationRuns([work], conv)).toEqual({ "mail:kdb-67010497": { kind: "working", since: iso(240_000), detail: "큐피드 연결 스크립트 흐름도 HTML", work: "st_01a17c04" } });
	expect(workConversationRuns([{ ...work, target: "mail:kdb-67010497" }], conv)).toEqual({ "mail:kdb-67010497": { kind: "working", since: iso(240_000), detail: "큐피드 연결 스크립트 흐름도 HTML", work: "st_01a17c04" } });
	expect(workConversationRuns([{ ...work, target: "web" }], conv)).toEqual({});
	// The model the worker runs on follows its description: the owner sees which model does the work he asked for there.
	expect(workConversationRuns([{ ...work, model: "Opus 5.5 medium" }], conv)["mail:kdb-67010497"]!.detail).toBe("큐피드 연결 스크립트 흐름도 HTML · Opus 5.5 medium");
	expect(runState({ status: "idle", work: [{ description: "흐름도", started_at: now, model: "Opus 5.5 medium" }], now }).detail).toBe("흐름도 · Opus 5.5 medium");
});

test("a worker that failed at spawn says why, and whether it was handed over again", () => {
	const conv = (t: string) => mailConversation(t, () => "kdb-67010497");
	const failed = { id: "st_01a17c03", description: "큐피드 연결 스크립트 흐름도 HTML", status: "failed" as const, started_at: now - 300_000, ended_at: now - 300_000, target: "th:1564523279849357364", error: "child turn produced no assistant output" };
	// <작업> · <이유> while the agent takes it up; once a turn took it up (handled) the conversation has no line for it.
	expect(workConversationRuns([failed], conv)["mail:kdb-67010497"]).toEqual({ kind: "waiting", reason: "recover", since: iso(300_000), detail: "큐피드 연결 스크립트 흐름도 HTML · child turn produced no assistant output", work: "st_01a17c03" });
	expect(workConversationRuns([{ ...failed, handled: true }], conv)["mail:kdb-67010497"]).toBeUndefined();
	const retry = { id: "st_01a17c04", description: "다시", status: "running" as const, started_at: now - 240_000, target: "th:1564523279849357364" };
	expect(workConversationRuns([failed, retry], conv)["mail:kdb-67010497"]).toMatchObject({ kind: "working", detail: "다시" });
	const failedAgain = { ...retry, status: "failed" as const, ended_at: now - 60_000 };
	expect(workConversationRuns([failed, failedAgain], conv)["mail:kdb-67010497"]).toMatchObject({ kind: "waiting", reason: "recover", detail: "다시 · 이유가 기록되지 않았어요 · 다시 맡긴 작업도 실패했어요", work: "st_01a17c04" });
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
	expect(workConversationRuns([failed], conv)["mail:k1"]).toMatchObject({ kind: "waiting", reason: "recover", detail: "백그라운드 작업 · 작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요" });
});

// Owner 2026-10-29: a failed worker is the agent's to finish, never a retry request: it reads as being taken up (waiting · recover).
test("a main-chat worker that failed after the last turn is being taken up, with its reason and id, until a turn answers after it", () => {
	const failed = { id: "st_f", description: "빌드 고치기", status: "failed" as const, started_at: now - 600_000, ended_at: now - 120_000, reason: "작업 폴더의 격리 사본을 만들지 못해 시작하지 못했어요" };
	expect(runState({ ...base, failed, lastTurnEnd: iso(300_000), todos: todos(1) }))
		.toEqual({ kind: "waiting", reason: "recover", since: iso(120_000), detail: "빌드 고치기 · 작업 폴더의 격리 사본을 만들지 못해 시작하지 못했어요", work: "st_f", todos: 1 });
	// A turn that ended after the failure answered it; a finished (done) worker is no failure; running work still comes first.
	expect(runState({ ...base, failed, lastTurnEnd: iso(60_000) })).toEqual({ kind: "done", since: iso(60_000) });
	expect(runState({ ...base, failed: { ...failed, status: "done" } }).kind).toBe("idle");
	expect(runState({ ...base, failed, work: [{ id: "st_r", description: "다시", started_at: now - 10_000 }] })).toMatchObject({ kind: "waiting", reason: "work", work: "st_r" });
	// One the owner stopped is said as stopped, not as a failure.
	expect(runState({ ...base, failed: { ...failed, cancelled: true, reason: "직접 중단했어요" } })).toMatchObject({ kind: "error", reason: "work", cancelled: true, detail: "빌드 고치기 · 직접 중단했어요" });
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

// Owner 2026-11-03: the running line showed "dotz_lane" — a call without an intent is texted as the tool's id there.
test("a tool call without an intent is said in the owner's language, never as its id", () => {
	expect(runIntent([{ type: "tool_call", text: "dotz_lane" }])).toBe("세션 준비");
	expect(runIntent([{ type: "tool_call", text: "dotz_lane: 세션 목록 확인" }])).toBe("세션 목록 확인");
	expect(runIntent([{ type: "tool_call", intent: "세션 목록 확인", text: "dotz_lane: 세션 목록 확인" }])).toBe("세션 목록 확인");
	expect(runIntent([{ type: "tool_call", text: "some_unknown_tool" }])).toBe("");
});

// Mac mini 2026-10-29 01:46: the orchestrator folded its context after a turn and the line said 쉬는 중 with tasks left until it went on.
test("a session folding its context is working (대화 정리 중), never resting with tasks left", () => {
	expect(runState({ ...base, compacting: true, todos: todos(2), lastTurnEnd: iso(30_000) })).toEqual({ kind: "working", detail: "대화 정리 중", todos: 2 });
	expect(runState({ ...base, todos: todos(2), lastTurnEnd: iso(30_000) }).kind).toBe("idle");
});

test("a session resting with tasks left is told to go on once per resting spell after the grace time, at most 3 times an hour", () => {
	const r = runState({ ...base, todos: todos(2), lastTurnEnd: iso(STALL_MS + 1_000) });
	expect(r).toMatchObject({ kind: "idle", reason: "unfinished" });
	expect(stallNudge(r, now, [])).toBe(true);
	expect(stallNudge(r, now, [], r.since)).toBe(false);
	expect(stallNudge(runState({ ...base, todos: todos(2), lastTurnEnd: iso(10_000) }), now, [])).toBe(false);
	expect(stallNudge(r, now, [now - 60_000, now - 120_000, now - 180_000])).toBe(false);
	expect(stallNudge(runState({ ...base, todos: todos(2), lastTurnEnd: iso(STALL_MS + 1_000), later: 1 }), now, [])).toBe(false);
});

test("a working session says what it is doing: its tool-call intent, else the plan task it is on", () => {
	expect(runState({ ...base, status: "working", intent: "T1 수식 훑기", todos: todos(3, "질문 1 분석") })).toMatchObject({ kind: "working", detail: "T1 수식 훑기", todos: 3 });
	expect(runState({ ...base, status: "working", todos: todos(3, "질문 1 분석") })).toMatchObject({ kind: "working", detail: "질문 1 분석" });
	expect(runState({ ...base, status: "idle", watching: "추출 워커 종료 대기", todos: todos(13), lastTurnEnd: iso(600_000) })).toMatchObject({ kind: "waiting", reason: "work", detail: "추출 워커 종료 대기", todos: 13 });
});

test("the limit lifting reads as work resuming until a turn starts, and a pause or a running turn still says so first", () => {
	expect(runState({ ...base, resuming: true, lastTurnEnd: iso(600_000) })).toEqual({ kind: "working", detail: "한도가 풀려서 작업을 이어가요" });
	expect(runState({ ...base, status: "rate-limited", resuming: true }).kind).toBe("limited");
});

test("a turn that stopped on an error is not 끝났어요; a failed step the agent answered after is", () => {
	const died = [{ type: "turn_start" }, { type: "tool_call", text: "bash" }, { type: "error", text: "429" }, { type: "turn_end" }];
	const answered = [{ type: "turn_start" }, { type: "tool_result", is_error: true }, { type: "text", text: "다른 방법으로 끝냈어요" }, { type: "turn_end" }];
	expect(lastTurnFailed(died)).toBe(true);
	expect(lastTurnFailed(answered)).toBe(false);
	expect(lastTurnFailed([...died, { type: "turn_start" }, { type: "text", text: "됐어요" }, { type: "turn_end" }])).toBe(false);
	expect(runState({ ...base, lastTurnEnd: iso(60_000), turnFailed: true })).toEqual({ kind: "error", since: iso(60_000), detail: "답을 끝내지 못했어요" });
	expect(runState({ ...base, lastTurnEnd: iso(60_000), turnFailed: false }).kind).toBe("done");
});

test("a session whose only worker is queued says so, and a running worker outranks a queued one", () => {
	const q = { id: "q", description: "기다리는 일", status: "running" as const, queued: true, started_at: now - 2000 };
	const r = { id: "r", description: "도는 일", status: "running" as const, started_at: now - 1000 };
	expect(runState({ ...base, work: [q] })).toMatchObject({ kind: "waiting", reason: "work", work: "q", queued: true });
	const both = runState({ ...base, work: [q, r] });
	expect([both.work, both.queued]).toEqual(["r", undefined]);
});

// lane stx-xhigh 2026-11-05: these reports rested with an empty plan, and the last was told to go on.
test("a session waiting for the owner with no open work is waiting, and gets no nudge", () => {
	for (const lastAnswer of ["[wait] 형 메시지만 남았어요", "[run] 준비됐고 형 메시지를 기다리는 중이에요.", "[run] 남은 일은 형 메시지가 와야 시작할 수 있어서 할 일 목록은 비워 뒀고, 메모 파일은 형이 끝내자고 할 때 쓸게요.", "[run] 지금 할 수 있는 일은 끝났고, 다음은 형 메시지가 와야 시작해요.", "오너 답을 기다릴게요."]) {
		const r = runState({ ...base, lastTurnEnd: iso(1_500_000), lastAnswer });
		expect(r).toEqual({ kind: "waiting", reason: "standby", since: iso(1_500_000) });
		expect(stallStep(r, now, { at: [] }).nudge).toBe(false);
	}
	expect(waitsForOwner("[done] 형 메시지를 기다려요")).toBe(false);
	expect(waitsForOwner("[run] 빌드가 끝나길 기다리는 중이에요.")).toBe(false);
});

test("a promise still stands beside a wait, and open plan tasks win over a wait", () => {
	const promised = runState({ ...base, lastTurnEnd: iso(1_500_000), lastAnswer: "[run] 형 메시지를 기다리는 동안 로그를 볼게요." });
	expect(promised).toMatchObject({ kind: "idle", reason: "unfinished" });
	expect(stallStep(promised, now, { at: [] }).nudge).toBe(true);
	expect(stallStep(runState({ ...base, lastTurnEnd: iso(1_500_000), lastAnswer: "[wait] 형 메시지 기다려요", todos: todos(2) }), now, { at: [] }).nudge).toBe(true);
	expect(stallStep(runState({ ...base, lastTurnEnd: iso(1_500_000), lastAnswer: "바로 고칠게요." }), now, { at: [] }).nudge).toBe(true);
});

test("a nudged turn with nothing new ends the nudging, until a turn of real work or a later spell", () => {
	const rest = (msAgo: number, over: object = {}): RunState => runState({ ...base, lastTurnEnd: iso(msAgo), lastAnswer: "곧 할게요.", acted: false, ...over });
	const first = stallStep(rest(500_000), now, { at: [] });
	expect(first.nudge).toBe(true);
	const working = stallStep({ kind: "working" }, now, first.memo);
	expect(working).toEqual({ nudge: false, memo: first.memo });
	// The nudged turn said words only: no second nudge, this sweep or any later one.
	const spent = stallStep(rest(400_000), now, first.memo);
	expect(spent.nudge).toBe(false);
	expect(stallStep(rest(400_000), now + 7_200_000, spent.memo).nudge).toBe(false);
	// A later turn (the owner wrote) that promises and rests is a new spell.
	expect(stallStep(rest(300_000), now, spent.memo).nudge).toBe(true);
	// The nudged turn did work: it may be told again, and a plan task closed counts the same.
	expect(stallStep(rest(400_000, { acted: true }), now, first.memo).nudge).toBe(true);
	const planned: StallMemo = { at: [now - 1_000], since: iso(500_000), answering: true, todos: 3 };
	expect(stallStep(rest(400_000, { todos: todos(2) }), now, planned).nudge).toBe(true);
	expect(stallStep(rest(400_000, { todos: todos(3) }), now, planned).nudge).toBe(false);
});

test("lastTurnActed reads the newest turn only", () => {
	expect(lastTurnActed([{ type: "turn_start" }, { type: "tool_call" }, { type: "text" }])).toBe(true);
	expect(lastTurnActed([{ type: "tool_call" }, { type: "turn_end" }, { type: "turn_start" }, { type: "text" }])).toBe(false);
});
