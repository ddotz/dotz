// What one conversation's agent is doing right now, and — the point of this file — why nothing is running while its plan
// still has open tasks.
// /api/state carries it under `runs` for the main conversation and every lane; the web chat shows it as one line above the
// composer (web/js/41-runstate.js). The derivation is pure so every case is tested without a gateway.
import { parseTone } from "./tone.ts";
export type RunKind = "working" | "waiting" | "idle" | "limited" | "error" | "stopped" | "done";
// waiting: ask | work | recover (a failed worker the agent is taking up itself) | child | later | capacity · idle: unfinished | interrupted · limited: rate | owner (a billing/auth block) · stopped: owner
export type RunReason = "ask" | "work" | "recover" | "child" | "later" | "capacity" | "unfinished" | "interrupted" | "unknown" | "rate" | "owner";
// work: the background worker the line is about (중단 while it runs, 다시 맡기기 after it failed); cancelled: the owner stopped it.
export type RunState = { kind: RunKind; reason?: RunReason; since?: string; detail?: string; todos?: number; work?: string; cancelled?: boolean };

export type RunInput = {
	status: string;
	since?: string;
	intent?: string;
	rateLimitedUntil?: string;
	pauseKind?: "rate" | "owner";
	stoppedBy?: "owner";
	error?: { text?: string; since?: string };
	ask?: { text?: string; at?: string };
	work?: { id?: string; description?: string; started_at?: number; model?: string }[];
	/** The conversation's latest finished background worker when it failed (or was stopped): shown until a turn ends after it. */
	failed?: WorkLike;
	children?: { name?: string; description?: string }[];
	later?: number;
	capacity?: string;
	lastTurnEnd?: string;
	/** The last turn's final answer text: a promise in it ("바로 할게") that nothing is running for is unfinished work. */
	lastAnswer?: string;
	todos?: { open: number; current?: string };
	/** A watch the last turn started that has not come back (hub/todo.ts openMonitor): the session waits on its own background job. */
	watching?: string;
	/** The session is folding its context (queued or running): it is busy with its own housekeeping, not resting. */
	compacting?: boolean;
	/** Owner prompts handed to the session that no turn has started on yet (orchestrator heldCount): it is about to work, not resting. */
	queued?: number;
	/** The usage limit lifted and the held work was handed back; no turn has started on it yet. */
	resuming?: boolean;
	/** The last turn ended on an error with no answer after it (lastTurnFailed): it did not finish, whatever ended it. */
	turnFailed?: boolean;
	now: number;
};

const short = (s: unknown, n = 80): string => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const iso = (ms: number | undefined): string | undefined => (ms ? new Date(ms).toISOString() : undefined);

/** A pause or a failure explains everything, so it comes first; a running turn needs no reason; an idle one names what it waits for before it says the plan was left unfinished. */
export function runState(i: RunInput): RunState {
	const open = Math.max(0, Math.floor(i.todos?.open || 0)), todos = open ? { todos: open } : {};
	if (i.status === "rate-limited") return { kind: "limited", reason: i.pauseKind === "owner" ? "owner" : "rate", since: i.since, detail: i.rateLimitedUntil, ...todos };
	// what it is doing now: its latest tool-call intent, else the plan task it is on (owner 2026-10-29: "상태표시줄에서 지금 뭘 하고있는지")
	if (i.status === "working" || i.status === "starting") return { kind: "working", since: i.since, ...(short(i.intent) || short(i.todos?.current) ? { detail: short(i.intent) || short(i.todos?.current) } : {}), ...todos };
	if (i.error) return { kind: "error", since: i.error.since, detail: short(i.error.text || "모델 오류"), ...todos };
	if (i.status === "stopped") return { kind: "stopped", ...(i.stoppedBy === "owner" ? { reason: "owner" as const } : {}), since: i.since, ...todos };
	if (i.status === "exited") return { kind: "done", since: i.since, ...todos };
	// A compaction after a turn reads as work, not as 쉬는 중 with tasks left (Mac mini 2026-10-29 01:46: "어 뭐지?").
	if (i.compacting) return { kind: "working", detail: "대화 정리 중", ...todos };
	// A resumed session is idle from its session event until its first turn starts (미설 2026-11-03 08:30-08:33Z: 170 s under load,
	// the line said 쉬는 중 and she asked "왜 쉬는중이야?"); a message it holds is work about to start.
	if (i.resuming) return { kind: "working", detail: "한도가 풀려서 작업을 이어가요", ...todos };
	if (i.queued) return { kind: "working", detail: "받은 메시지 시작하는 중", ...todos };
	if (short(i.ask?.text)) return { kind: "waiting", reason: "ask", since: i.ask?.at, detail: short(i.ask?.text), ...todos };
	const w = (i.work || [])[0];
	if (w) return { kind: "waiting", reason: "work", since: iso(w.started_at), detail: workDetail(w), ...(w.id ? { work: w.id } : {}), ...todos };
	const c = (i.children || [])[0];
	if (c) return { kind: "waiting", reason: "child", detail: short(c.description || c.name || "서브에이전트"), ...todos };
	if (short(i.watching)) return { kind: "waiting", reason: "work", detail: short(i.watching), ...todos };
	// A worker that failed after the last turn ended is what this conversation is stuck on, until a turn answers after it.
	const f = i.failed;
	if (f && f.status === "failed" && (f.ended_at ?? 0) > (Date.parse(i.lastTurnEnd ?? "") || 0)) return { ...failedRun(f, false), ...todos };
	if (i.later) return { kind: "waiting", reason: "later", since: i.lastTurnEnd, ...todos };
	if (i.capacity) return { kind: "waiting", reason: "capacity", detail: short(i.capacity), ...todos };
	if (open) return { kind: "idle", reason: i.lastTurnEnd ? "unfinished" : "interrupted", since: i.lastTurnEnd, ...(short(i.todos?.current) ? { detail: short(i.todos?.current) } : {}), ...todos };
	// A turn that ended promising work it did not start (2026-11-01 15:20Z) is unfinished even with no plan: the session rested 25
	// minutes and answered "아직 시작 안 했어".
	if (i.lastTurnEnd && promisesWork(i.lastAnswer)) return { kind: "idle", reason: "unfinished", since: i.lastTurnEnd, detail: "말한 일을 아직 안 했어요" };
	// A turn that died on an error ended, but nothing was finished: 끝났어요 under "오류 4" told the owner the opposite (owner 2026-11-04).
	if (i.lastTurnEnd && i.turnFailed) return { kind: "error", since: i.lastTurnEnd, detail: "답을 끝내지 못했어요" };
	if (i.lastTurnEnd) return { kind: "done", since: i.lastTurnEnd };
	return { kind: "idle" };
}

export type TodoLike = { phases?: { tasks?: { content?: string; status?: string }[] }[] };

// The last answer promised to do the work itself ("바로 할게") and then the session rested with nothing running. Pure and
// conservative: the verdict decides one nudge, so a false positive costs a nudge while a miss costs a resting session day-long.
// Done/ask/fail reports, a closing question and a promise the owner must unlock first ("알려 주면 할게") are not promises.
export function promisesWork(text: string | undefined): boolean {
	if (!text) return false;
	const { tone, text: bare } = parseTone(String(text));
	if (tone === "done" || tone === "ask" || tone === "fail") return false;
	const body = bare.trim();
	if (!body) return false;
	// A closing question to the owner is a wait on him, not a promise to go on.
	if (/[?？]\s*$/u.test(body)) return false;
	return body.split(/\n+|(?<=[.!?！？。…])\s+/u).some(piece => {
		const sentence = piece.trim();
		const end = promiseEnd(sentence);
		if (!end) return false;
		const before = sentence.slice(0, sentence.length - end.length);
		// "말해 주면 할게", "올리면 그때 할게": a -면 clause before the promise makes it wait on the owner or outside work.
		return !/[가-힣]면(?=$|[\s,、.!?~…'"’”)\]}])/u.test(before);
	});
}

// A Hangul syllable whose final consonant is ㄹ (할, 볼, 시작할): the stem of the "-ㄹ게(요)" future ending. 에게 같은 말이 걸리지 않도록.
const finalRieul = (s: string | undefined): boolean => {
	const code = s ? s.codePointAt(s.length - 1) : undefined;
	return code !== undefined && code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 8;
};
// The sentence's own promise ending, with its trailing punctuation ignored: "-ㄹ게(요)" (할게, 볼게, 시작할게, 진행할게) or
// "-겠습니다/겠어요" (하겠습니다, 하겠어요). 알겠습니다 is "understood", and 좋겠네요/되겠지요/좋겠다 are guesses, not a promise to work.
function promiseEnd(sentence: string): string | undefined {
	const t = sentence.replace(/[\s.!?~…、,:;'"”’)\]}>·ㅋㅎㅠㅜ♥]+$/u, "");
	const future = /(?:겠습니다|겠어요|겠어)$/u.exec(t);
	if (future) return /(?:알|모르)겠(?:습니다|어요|어)$/u.test(t) ? undefined : future[0];
	const will = /(.)게(?:요)?$/u.exec(t);
	return will && finalRieul(will[1]) ? will[0] : undefined;
}

/** Open = not completed and not abandoned; current = the in_progress task, else the first pending one. */
export function openTodos(t: TodoLike): { open: number; current?: string } {
	const all = (t.phases || []).flatMap(p => p.tasks || []);
	const live = all.filter(x => x.status !== "completed" && x.status !== "abandoned");
	const cur = all.find(x => x.status === "in_progress") || live[0];
	return { open: live.length, ...(cur?.content ? { current: cur.content } : {}) };
}

export type WorkLike = { id?: string; description?: string; status: "running" | "done" | "failed"; started_at?: number; ended_at?: number; target?: string; error?: string; model?: string; reason?: string; cancelled?: boolean; handled?: boolean };
/** A running worker's line: what it does, then the model it runs on, so the owner sees which model works for him ("<설명> · Opus 5.5 medium"). */
export const workDetail = (w: { description?: string; model?: string }): string => [short(w.description || "백그라운드 작업"), short(w.model, 40)].filter(Boolean).join(" · ");

/** A mail's conversation: the web target `mail:<key>` itself, or the Discord thread (`th:<id>`) an owner message in it was delivered to. */
export function mailConversation(target: string, keyOfThread: (thread: string) => string | undefined): string | undefined {
	if (/^mail:[a-z0-9._-]+$/.test(target)) return target;
	const thread = /^th:(\d{15,22})$/.exec(target)?.[1];
	const key = thread ? keyOfThread(thread) : undefined;
	return key ? `mail:${key}` : undefined;
}

// Why a failed worker failed: the record's own message when OmO wrote one, else said plainly so the line never claims a cause it does not know.
// OmO's isolation refusals are raw git output ("isolation_unavailable: baseline capture failed: git ... failed (128): fatal: ..."),
// which says nothing to the owner, so they are said in Korean; the raw text stays in the hub log.
export function failureText(error: string | undefined): string {
	const e = String(error ?? "");
	if (/isolation_unavailable/.test(e)) {
		if (/not a git|저장소가 아닙니다|git checkout/i.test(e)) return "작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요";
		if (/snapshot budget|too ?large/i.test(e)) return "작업 폴더가 너무 커서 격리 사본을 만들지 못해 시작하지 못했어요";
		return "작업 폴더의 격리 사본을 만들지 못해 시작하지 못했어요";
	}
	return short(e) || "이유가 기록되지 않았어요";
}
const failureReason = (w: WorkLike) => w.reason || failureText(w.error);
// A failed worker is the agent's to fix and finish, never a request to the owner (owner 2026-10-29: "왜 재요청을 나에게 물어보지?
// 알아서 수정해서 목표 달성해야지"): until a turn takes it up the line says it is being taken up (blue, no button), and then it is gone.
// Only work the owner stopped himself (중단) stays as a neutral line with 다시 맡기기.
const failedRun = (w: WorkLike, retried: boolean): RunState => ({
	kind: w.cancelled ? "error" : "waiting", reason: w.cancelled ? "work" : "recover", since: iso(w.ended_at),
	detail: [short(w.description || "백그라운드 작업"), failureReason(w), retried ? "다시 맡긴 작업도 실패했어요" : ""].filter(Boolean).join(" · "),
	...(w.id ? { work: w.id } : {}), ...(w.cancelled ? { cancelled: true } : {}),
});

/**
 * The run state of every mail conversation a background worker serves, keyed by the conversation (`mail:<key>`). A worker's own
 * target is the thread (`th:<id>`) or the mail key; both name the one conversation the owner sees. Nothing is returned for a
 * conversation no worker of the last hour served, so the line stays absent instead of claiming it is idle.
 */
export function workConversationRuns(works: readonly WorkLike[], conversationOf: (target: string) => string | undefined): Record<string, RunState> {
	const byConv = new Map<string, WorkLike[]>();
	for (const w of works) {
		const conv = w.target ? conversationOf(w.target) : undefined;
		if (!conv) continue;
		const list = byConv.get(conv);
		if (list) list.push(w);
		else byConv.set(conv, [w]);
	}
	const out: Record<string, RunState> = {};
	for (const [conv, list] of byConv) {
		const running = list.filter(w => w.status === "running").sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0)).at(-1);
		if (running) {
			out[conv] = { kind: "working", since: iso(running.started_at), detail: workDetail(running), ...(running.id ? { work: running.id } : {}) };
			continue;
		}
		const last = list.filter(w => w.status !== "running").sort((a, b) => (a.ended_at ?? 0) - (b.ended_at ?? 0)).at(-1);
		if (!last || (last.status === "failed" && last.handled)) continue;
		if (last.status === "failed") {
			// Whether this failing attempt was itself a retry (st_01a17c03 failed at spawn and st_01a17c04 took it over): an earlier
			// worker of the same conversation says so, while a retry that is still running is the line above it.
			const retried = list.some(w => w !== last && (w.started_at ?? 0) < (last.started_at ?? 0));
			out[conv] = failedRun(last, retried);
		} else {
			out[conv] = { kind: "done", since: iso(last.ended_at), detail: short(last.description) };
		}
	}
	return out;
}

type Act = { ts?: string; type?: string; intent?: string; text?: string; is_error?: boolean };

// dotz's own tools said in the owner's language: a bare tool id never reaches a status line (owner 2026-11-03: the running line said
// "dotz_lane"). A tool without a word here gives no line at all, so no command name is shown.
const TOOL_KO: Record<string, string> = {
	dotz_lane: "세션 준비", dotz_send: "메시지 전달", dotz_watch: "감시 설정", dotz_schedule: "예약 설정",
	dotz_channel: "채널 설정", dotz_conv: "대화 살피기", dotz_peer: "다른 컴퓨터와 연결", dotz_auth: "인증 확인",
	dotz_verify: "완료 확인", dotz_merge: "변경 반영", dotz_todo: "할 일 정리",
};
const bareTool = (t: string) => /^[a-z][a-z0-9_.-]*$/i.test(t);
const toolWord = (t: string) => TOOL_KO[t.toLowerCase()] || "";

/** The latest tool intent of the turn that is still running (after the last turn_start), if any. */
export function runIntent(items: Act[]): string | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const a = items[i]!;
		if (a.type === "turn_start") break;
		if (a.type !== "tool_call") continue;
		const t = String(a.intent || a.text || "").replace(/\s+/g, " ").trim();
		if (!t) continue;
		// `items` come from the transcript, where a call without an intent is texted as the tool's id: say it in Korean, or drop it.
		if (bareTool(t)) return toolWord(t);
		// With a label the transcript texts it as "<tool id>: <label>": keep the label, never the tool's id.
		const pref = t.match(/^([a-z][a-z0-9_.-]*):\s*(.*)$/i);
		if (pref) return pref[2]!.trim() || toolWord(pref[1]!);
		return t;
	}
	return undefined;
}

/** Whether the newest turn stopped on an error: a failed step the agent answered after is an ordinary turn. */
export function lastTurnFailed(items: Act[]): boolean {
	for (let i = items.length - 1; i >= 0; i--) {
		const a = items[i]!;
		if (a.type === "turn_start") return false;
		if (a.type === "text" && String(a.text ?? "").trim()) return false;
		if (a.type === "error" || (a.type === "tool_result" && a.is_error)) return true;
	}
	return false;
}

export function lastTurnEnd(items: Act[]): string | undefined {
	for (let i = items.length - 1; i >= 0; i--) if (items[i]!.type === "turn_end") return items[i]!.ts;
	return undefined;
}

// The stall rule (owner 2026-10-29: "할일이 남아있는데 쉬는중 뜨다가 ... 바로 작업 진행되도록"): a session resting with plan tasks left and
// nothing to wait for is told to go on after STALL_MS, once per resting spell, and at most STALL_MAX times an hour so a plan it cannot
// finish does not loop. hub/routes.ts startStallSweep applies it to the main conversation and every conversation session.
export const STALL_MS = 90_000;
export const STALL_MAX = 3;
export function stallNudge(r: RunState, now: number, told: readonly number[], lastSince?: string): boolean {
	if (r.kind !== "idle" || r.reason !== "unfinished" || !r.since || r.since === lastSince) return false;
	if (now - Date.parse(r.since) < STALL_MS) return false;
	return told.filter(at => now - at < 3_600_000).length < STALL_MAX;
}
