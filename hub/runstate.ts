// What one conversation's agent is doing right now, and — the point of this file — why nothing is running while its plan
// still has open tasks.
// /api/state carries it under `runs` for the main conversation and every lane; the web chat shows it as one line above the
// composer (web/js/41-runstate.js). The derivation is pure so every case is tested without a gateway.
export type RunKind = "working" | "waiting" | "idle" | "limited" | "error" | "stopped" | "done";
// waiting: ask | work | child | later | capacity · idle: unfinished | unknown · limited: rate | owner (a billing/auth block) · stopped: owner
export type RunReason = "ask" | "work" | "child" | "later" | "capacity" | "unfinished" | "unknown" | "rate" | "owner";
export type RunState = { kind: RunKind; reason?: RunReason; since?: string; detail?: string; todos?: number };

export type RunInput = {
	status: string;
	since?: string;
	intent?: string;
	rateLimitedUntil?: string;
	pauseKind?: "rate" | "owner";
	stoppedBy?: "owner";
	error?: { text?: string; since?: string };
	ask?: { text?: string; at?: string };
	work?: { description?: string; started_at?: number }[];
	children?: { name?: string; description?: string }[];
	later?: number;
	capacity?: string;
	lastTurnEnd?: string;
	todos?: { open: number; current?: string };
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
	if (i.status === "working" || i.status === "starting") return { kind: "working", since: i.since, ...(short(i.intent) ? { detail: short(i.intent) } : {}), ...todos };
	if (i.error) return { kind: "error", since: i.error.since, detail: short(i.error.text || "모델 오류"), ...todos };
	if (i.status === "stopped") return { kind: "stopped", ...(i.stoppedBy === "owner" ? { reason: "owner" as const } : {}), since: i.since, ...todos };
	if (i.status === "exited") return { kind: "done", since: i.since, ...todos };
	if (short(i.ask?.text)) return { kind: "waiting", reason: "ask", since: i.ask?.at, detail: short(i.ask?.text), ...todos };
	const w = (i.work || [])[0];
	if (w) return { kind: "waiting", reason: "work", since: iso(w.started_at), detail: short(w.description || "백그라운드 작업"), ...todos };
	const c = (i.children || [])[0];
	if (c) return { kind: "waiting", reason: "child", detail: short(c.description || c.name || "서브에이전트"), ...todos };
	if (i.later) return { kind: "waiting", reason: "later", since: i.lastTurnEnd, ...todos };
	if (i.capacity) return { kind: "waiting", reason: "capacity", detail: short(i.capacity), ...todos };
	if (open) return { kind: "idle", reason: i.lastTurnEnd ? "unfinished" : "unknown", since: i.lastTurnEnd, ...(short(i.todos?.current) ? { detail: short(i.todos?.current) } : {}), ...todos };
	if (i.lastTurnEnd) return { kind: "done", since: i.lastTurnEnd };
	return { kind: "idle" };
}

export type TodoLike = { phases?: { tasks?: { content?: string; status?: string }[] }[] };

/** Open = not completed and not abandoned; current = the in_progress task, else the first pending one. */
export function openTodos(t: TodoLike): { open: number; current?: string } {
	const all = (t.phases || []).flatMap(p => p.tasks || []);
	const live = all.filter(x => x.status !== "completed" && x.status !== "abandoned");
	const cur = all.find(x => x.status === "in_progress") || live[0];
	return { open: live.length, ...(cur?.content ? { current: cur.content } : {}) };
}

export type WorkLike = { id?: string; description?: string; status: "running" | "done" | "failed"; started_at?: number; ended_at?: number; target?: string; error?: string };

/** A mail's conversation: the web target `mail:<key>` itself, or the Discord thread (`th:<id>`) an owner message in it was delivered to. */
export function mailConversation(target: string, keyOfThread: (thread: string) => string | undefined): string | undefined {
	if (/^mail:[a-z0-9._-]+$/.test(target)) return target;
	const thread = /^th:(\d{15,22})$/.exec(target)?.[1];
	const key = thread ? keyOfThread(thread) : undefined;
	return key ? `mail:${key}` : undefined;
}

// Why a failed worker failed: the record's own message when OmO wrote one, else said plainly so the line never claims a cause it does not know.
const failureReason = (w: WorkLike) => short(w.error) || "이유가 기록되지 않았어요";

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
			out[conv] = { kind: "working", since: iso(running.started_at), detail: short(running.description || "백그라운드 작업") };
			continue;
		}
		const last = list.filter(w => w.status !== "running").sort((a, b) => (a.ended_at ?? 0) - (b.ended_at ?? 0)).at(-1);
		if (!last) continue;
		if (last.status === "failed") {
			// Whether this failing attempt was itself a retry (st_01a17c03 failed at spawn and st_01a17c04 took it over): an earlier
			// worker of the same conversation says so, while a retry that is still running is the line above it.
			const retried = list.some(w => w !== last && (w.started_at ?? 0) < (last.started_at ?? 0));
			out[conv] = { kind: "error", since: iso(last.ended_at), detail: `${failureReason(last)} · ${retried ? "다시 맡긴 작업도 실패했어요" : "다시 맡기지 않았어요"}` };
		} else {
			out[conv] = { kind: "done", since: iso(last.ended_at), detail: short(last.description) };
		}
	}
	return out;
}

type Act = { ts?: string; type?: string; intent?: string; text?: string };

/** The latest tool intent of the turn that is still running (after the last turn_start), if any. */
export function runIntent(items: Act[]): string | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const a = items[i]!;
		if (a.type === "turn_start") break;
		if (a.type !== "tool_call") continue;
		const t = String(a.intent || a.text || "").replace(/\s+/g, " ").trim();
		if (t) return t;
	}
	return undefined;
}

export function lastTurnEnd(items: Act[]): string | undefined {
	for (let i = items.length - 1; i >= 0; i--) if (items[i]!.type === "turn_end") return items[i]!.ts;
	return undefined;
}
