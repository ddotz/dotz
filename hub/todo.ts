// The todo strip of the web chat (docs/layers.md §4): the phased list of the LAST `todo` tool result in a target's OmO
// session file. Session files grow to tens of MB, so the file is read from its end in growing chunks and only the lines
// not seen yet are decoded; a file without a todo result is read once, never twice.
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";

type TodoTask = { content: string; status: string };
type TodoPhase = { name: string; tasks: TodoTask[] };
type Todo = { phases: TodoPhase[]; at?: string };

const FIRST_CHUNK = 256 * 1024;
const MAX_CHUNK = 8 * 1024 * 1024;

const str = (v: unknown) => (typeof v === "string" ? v : "");

// One jsonl line -> the todo result it holds, or undefined for any other line.
function todoOf(line: string): Todo | undefined {
	if (!line.includes('"todo"')) return undefined;
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	const m = entry?.message;
	if (m?.role !== "toolResult" || m?.toolName !== "todo" || !Array.isArray(m?.details?.phases)) return undefined;
	const phases: TodoPhase[] = m.details.phases
		.filter((p: any) => p && typeof p === "object")
		.map((p: any) => ({ name: str(p.name), tasks: (Array.isArray(p.tasks) ? p.tasks : []).filter((t: any) => t && typeof t === "object").map((t: any) => ({ content: str(t.content), status: str(t.status) })) }));
	const at = str(entry.timestamp) || (typeof m.timestamp === "number" ? new Date(m.timestamp).toISOString() : "");
	return { phases, ...(at ? { at } : {}) };
}

// GET /api/state asks for every session's list on each call and the page calls it often, while most session files did not change between two calls:
// the result is kept per file, valid while the size, the time and the last bytes are the same (as `lifecycle` below). Callers only read it.
const todoCache = new Map<string, { stamp: string; todo: Todo }>();
const TODO_CACHE_MAX = 64;

export function readTodo(file: string | undefined): Todo {
	if (!file || !existsSync(file)) return { phases: [] };
	const fd = openSync(file, "r");
	try {
		const st = fstatSync(fd);
		const tail = Buffer.alloc(Math.min(64, st.size));
		readSync(fd, tail, 0, tail.length, st.size - tail.length);
		const stamp = `${st.size}:${st.mtimeMs}:${tail.toString("hex")}`;
		const hit = todoCache.get(file);
		if (hit?.stamp === stamp) return hit.todo;
		const todo = scanTodo(fd, st.size);
		todoCache.delete(file);
		if (todoCache.size >= TODO_CACHE_MAX) todoCache.delete(todoCache.keys().next().value!);
		todoCache.set(file, { stamp, todo });
		return todo;
	} finally {
		closeSync(fd);
	}
}

// A lane that reported [done] and has not heard from the owner since owes nothing (hub/laneunfinished.ts laneClosed). Tasks its plan still shows
// open from before that report are finished work nobody ticked off (2026-11-11, two lanes in one evening): they were closed only in the extra turn
// OmO's turn-end reminder started after the report, and the web showed "할 일 N개 남음" for a lane that had landed its work. A plan the session
// wrote after the report is its own word and stands. The open tasks read as dropped; nothing is written to the session file.
type Closing = { sessionFile?: string; claim?: { at: string; reopened?: boolean } };
export function laneTodo(lane: Closing): Todo {
	const todo = readTodo(lane.sessionFile);
	const closedAt = lane.claim && !lane.claim.reopened ? Date.parse(lane.claim.at) : NaN;
	if (!(Date.parse(todo.at ?? "") < closedAt)) return todo;
	const open = (x: TodoTask) => x.status !== "completed" && x.status !== "abandoned";
	if (!todo.phases.some(p => p.tasks.some(open))) return todo;
	return { ...todo, phases: todo.phases.map(p => ({ ...p, tasks: p.tasks.map(x => (open(x) ? { ...x, status: "abandoned" } : x)) })) };
}

function scanTodo(fd: number, size: number): Todo {
	let end = size;
	let chunk = FIRST_CHUNK;
	// bytes of the line that straddles the boundary to the chunk read after this one
	let carry = Buffer.alloc(0);
	while (end > 0) {
		const start = Math.max(0, end - chunk);
		const buf = Buffer.alloc(end - start);
		readSync(fd, buf, 0, buf.length, start);
		const data = Buffer.concat([buf, carry]);
		// the first line is cut unless the chunk starts the file
		const cut = start === 0 ? -1 : data.indexOf(0x0a);
		carry = cut < 0 ? Buffer.alloc(0) : data.subarray(0, cut);
		const lines = data.subarray(cut + 1).toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const found = todoOf(lines[i]!);
			if (found) return found;
		}
		end = start;
		chunk = Math.min(chunk * 2, MAX_CHUNK);
	}
	return { phases: [] };
}

// What a session's harness says it waits on (owner 2026-10-29: acme-loss-review showed 쉬는 중 · 할 일 13개 남음 while it waited on its own
// "HTML 워커 종료" monitor, and the stall rule then told it to go on). OmO writes a `session-lifecycle` record at every change: its state
// ("waiting_background" when a turn ended on purpose to wait) and `waitingOn` (subagents, background shells, monitors). The latest record
// is the truth; only the file's tail is read, cached by size, time and last bytes.
const TAIL = 1024 * 1024;
// What ends with the process and comes back to nobody: background shells and detached eval cells. OmO restores a monitor by itself
// (terminal/durable-command.js) and leaves delivery:* receipts listed for hours, so neither is work a restart cuts off.
const DIES_WITH_PROCESS = new Set(["terminal-background-sessions", "senpi-codemode"]);
type Lifecycle = { desc?: string; dying: number; cut: boolean; turnCut: boolean; interrupted: boolean; asked: boolean };
const waitCache = new Map<string, { stamp: string; life: Lifecycle }>();
function lifecycle(file: string | undefined): Lifecycle | undefined {
	if (!file || !existsSync(file)) return undefined;
	const st = statSync(file), size = st.size;
	const fd = openSync(file, "r");
	let text = "", stamp = "";
	try {
		const end = Buffer.alloc(Math.min(64, size));
		readSync(fd, end, 0, end.length, size - end.length);
		stamp = `${size}:${st.mtimeMs}:${end.toString("hex")}`;
		const hit = waitCache.get(file);
		if (hit && hit.stamp === stamp) return hit.life;
		const start = Math.max(0, size - TAIL);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		text = buf.toString("utf8");
	} finally {
		closeSync(fd);
	}
	const life: Lifecycle = { dying: 0, cut: false, turnCut: false, interrupted: false, asked: false };
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i]!.includes('"session-lifecycle"')) continue;
		let e: any;
		try {
			e = JSON.parse(lines[i]!);
		} catch {
			continue;
		}
		const d = e?.data;
		if (e?.customType !== "session-lifecycle" || !d) continue;
		const bg: any[] = Array.isArray(d.waitingOn?.background) ? d.waitingOn.background : [];
		const kids = Number(d.waitingOn?.children) || 0;
		life.dying = bg.filter(b => DIES_WITH_PROCESS.has(b?.source)).reduce((n, b) => n + (Number(b.activeCount) || 0), 0);
		// no_wake: OmO saw the turn's last wake source go (site-demo-proto 01:11:37, its shell killed) with nothing left to wake it.
		// stalled / interrupted_run on the owner's side: OmO's own word that a run ended unanswered (reply-voice 2026-11-05 23:25 KST: the last
		// record after the kill read waiting_human, 0 children, a stalled item, cause no_wake).
		const human: any[] = Array.isArray(d.waitingOn?.human) ? d.waitingOn.human : [];
		life.interrupted = human.some(h => h?.kind === "interrupted_run");
		life.asked = human.some(h => h?.kind === "question");
		// The last word of a killed turn is "running": nothing closed it. The owner's 중단 leaves the same state with cause "aborted".
		const killed = d.state === "running" && d.lastStop?.cause !== "aborted";
		life.turnCut = life.dying > 0 || kids > 0 || life.interrupted || killed;
		// no_wake and stalled also mean a clean turn that ended with todos open: a plan left over for a lane, no interruption for a session.
		life.cut = life.turnCut || d.lastStop?.cause === "no_wake" || human.some(h => h?.kind === "stalled");
		if (String(d.state ?? "").startsWith("waiting")) {
			const items = (src: string) => bg.filter(b => b?.source === src && b.activeCount > 0).flatMap(b => (Array.isArray(b.items) ? b.items : []));
			const mon = items("terminal-monitors").map(x => str(x?.description)).find(Boolean);
			const shells = items("terminal-background-sessions").length;
			life.desc = mon || (shells ? `백그라운드 작업 ${shells}개` : kids ? `서브에이전트 ${kids}개` : undefined);
		}
		break;
	}
	waitCache.set(file, { stamp, life });
	return life;
}
export const openMonitor = (file: string | undefined): string | undefined => lifecycle(file)?.desc;
/** Shells and eval cells the session's live process still runs: a restart now would kill them, and no result would ever come back. */
export const backgroundWork = (file: string | undefined): number => lifecycle(file)?.dying ?? 0;
/** Read after the process ended: it stopped with work it was waiting on cut off. */
export const workCutOff = (file: string | undefined): boolean => lifecycle(file)?.cut ?? false;
/** workCutOff without the clean turn that merely left todos open. */
export const turnCutOff = (file: string | undefined): boolean => lifecycle(file)?.turnCut ?? false;
/** OmO's own word that a run was interrupted: true with a live process too, where waiting on children or shells is only waiting. */
export const runCutOff = (file: string | undefined): boolean => lifecycle(file)?.interrupted ?? false;
/** OmO holds an open question to the owner (its `question` wait, from the ask tool). */
export const ownerAsked = (file: string | undefined): boolean => lifecycle(file)?.asked ?? false;
/** The text of the session's last assistant message; "" when that message was only tool calls. Reads the tail: a once-a-minute sweep with work in sight, never /api/state. */
export function lastAnswerText(file: string): string {
	const size = statSync(file).size, start = Math.max(0, size - TAIL), buf = Buffer.alloc(size - start), fd = openSync(file, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	const lines = buf.toString("utf8").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i]!.includes('"assistant"')) continue;
		let e: any;
		try {
			e = JSON.parse(lines[i]!);
		} catch {
			continue;
		}
		if (e?.type !== "message" || e.message?.role !== "assistant") continue;
		const parts: any[] = Array.isArray(e.message.content) ? e.message.content : [];
		return parts.some(p => p?.type === "toolCall") ? "" : parts.filter(p => p?.type === "text").map(p => str(p.text)).join("\n");
	}
	return "";
}
