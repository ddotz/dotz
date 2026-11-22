import { closeSync, openSync, readSync, statSync } from "node:fs";

/** What an omp session file shows about its last turn once the process is gone: a turn cut off mid-run, a request nobody answered, or nothing owed. */
export type OmpTurn = "run" | "request";

const TAIL_START = 64 * 1024;
const TAIL_MAX = 4 * 1024 * 1024;
const OMP_HEADER = '{"type":"title"';
// why(vendor): omp@18.22.0 ends a finished or owner-stopped turn on an assistant message whose stopReason is not "toolUse"; a turn the process did not finish ends on a user message, a toolResult, an assistant message that called a tool, or a custom_message of type async-result no assistant has answered (hub/runtime/fixtures/omp-sessions/{killed,finished,torn})
const OPEN_ASSISTANT = "toolUse";
const RESULT = "async-result";

function tail(file: string, bytes: number): { text: string; whole: boolean } | undefined {
	const fd = openSync(file, "r");
	try {
		const size = statSync(file).size;
		const head = Buffer.alloc(Math.min(OMP_HEADER.length, size));
		readSync(fd, head, 0, head.length, 0);
		if (head.toString("utf8") !== OMP_HEADER) return undefined;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		return { text: buf.toString("utf8"), whole: start === 0 };
	} finally {
		closeSync(fd);
	}
}

function lastTurn(text: string, whole: boolean): OmpTurn | undefined | "more" {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= (whole ? 0 : 1); i--) {
		const line = lines[i]!;
		if (!line.includes('"message"') && !line.includes(RESULT)) continue;
		let e: { type?: string; customType?: string; message?: { role?: string; stopReason?: string } };
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "custom_message" && e.customType === RESULT) return "run";
		if (e.type !== "message") continue;
		const m = e.message;
		if (m?.role === "user") return "request";
		if (m?.role === "toolResult") return "run";
		return m?.role === "assistant" && m.stopReason === OPEN_ASSISTANT ? "run" : undefined;
	}
	return whole ? undefined : "more";
}

/**
 * Whether the turn in an omp session file was cut off: read for a session whose process is gone (a live one is only working). Only an omp
 * file says anything; another runtime's lifecycle records are read elsewhere (hub/todo.ts).
 */
export function ompTurnCut(file: string): OmpTurn | undefined {
	for (let bytes = TAIL_START; ; bytes *= 4) {
		const t = tail(file, Math.min(bytes, TAIL_MAX));
		if (!t) return undefined;
		const found = lastTurn(t.text, t.whole || bytes >= TAIL_MAX);
		if (found !== "more") return found;
	}
}
