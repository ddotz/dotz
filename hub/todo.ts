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

export function readTodo(file: string | undefined): Todo {
	if (!file || !existsSync(file)) return { phases: [] };
	const fd = openSync(file, "r");
	try {
		let end = fstatSync(fd).size;
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
	} finally {
		closeSync(fd);
	}
	return { phases: [] };
}

// What a session's harness says it waits on (owner 2026-10-29: kdb-loss-review showed 쉬는 중 · 할 일 13개 남음 while it waited on its own
// "HTML 워커 종료" monitor, and the stall rule then told it to go on). OmO writes a `session-lifecycle` record at every change: its state
// ("waiting_background" when a turn ended on purpose to wait) and `waitingOn` (subagents, background shells, monitors). The latest record
// is the truth; only the file's tail is read, cached by size, time and last bytes.
const TAIL = 1024 * 1024;
const waitCache = new Map<string, { stamp: string; desc?: string }>();
export function openMonitor(file: string | undefined): string | undefined {
	if (!file || !existsSync(file)) return undefined;
	const st = statSync(file), size = st.size;
	const fd = openSync(file, "r");
	let text = "", stamp = "";
	try {
		const end = Buffer.alloc(Math.min(64, size));
		readSync(fd, end, 0, end.length, size - end.length);
		stamp = `${size}:${st.mtimeMs}:${end.toString("hex")}`;
		const hit = waitCache.get(file);
		if (hit && hit.stamp === stamp) return hit.desc;
		const start = Math.max(0, size - TAIL);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		text = buf.toString("utf8");
	} finally {
		closeSync(fd);
	}
	let desc: string | undefined;
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
		if (String(d.state ?? "").startsWith("waiting")) {
			const bg: any[] = Array.isArray(d.waitingOn?.background) ? d.waitingOn.background : [];
			const items = (src: string) => bg.filter(b => b?.source === src && b.activeCount > 0).flatMap(b => (Array.isArray(b.items) ? b.items : []));
			const mon = items("terminal-monitors").map(x => str(x?.description)).find(Boolean);
			const shells = items("terminal-background-sessions").length;
			const kids = Number(d.waitingOn?.children) || 0;
			desc = mon || (shells ? `백그라운드 작업 ${shells}개` : kids ? `서브에이전트 ${kids}개` : undefined);
		}
		break;
	}
	waitCache.set(file, { stamp, desc });
	return desc;
}
