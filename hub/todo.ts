// The todo strip of the web chat (docs/layers.md §4): the phased list of the LAST `todo` tool result in a target's OmO
// session file. Session files grow to tens of MB, so the file is read from its end in growing chunks and only the lines
// not seen yet are decoded; a file without a todo result is read once, never twice.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

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
