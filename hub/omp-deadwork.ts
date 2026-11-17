import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";

/** One background task worker of an omp session, as the session file and its transcript show it. */
export type OmpWorker = {
	/** One run of the worker, `<name>~<start>`: omp hands a name out again for a revived or later worker, and the hub keeps state per id. */
	id: string;
	/** The name omp knows it by: `write agent://<name>` messages or revives it. */
	name: string;
	description: string;
	started_at: number;
	/** Its last sign of life: the last write of its transcript, else its start. */
	ended_at: number;
	/** The provider error its transcript ends on (ompFailedWork only). */
	error?: string;
};

type Run = { name: string; at: number; what: string };
type Seen = { omp: boolean; size: number; mtimeMs: number; offset: number; anchor: string; open: Map<string, Run>; known: Map<string, Run> };
type Job = { id?: string; jobId?: string; agentId?: string; agentUrlId?: string; type?: string; status?: string };
type Entry = {
	type?: string;
	customType?: string;
	timestamp?: string;
	details?: { jobs?: Job[] };
	message?: {
		role?: string;
		toolName?: string;
		stopReason?: string;
		errorMessage?: string;
		details?: {
			async?: { type?: string };
			progress?: { id?: string; assignment?: string; task?: string }[];
			op?: string;
			jobs?: Job[];
			message?: { op?: string; receipts?: { to?: string; outcome?: string }[] };
		};
	};
};

const CHUNK = 1 << 20;
const ANCHOR_BYTES = 64;
const CACHE_MAX = 64;
const TAIL_START = 64 * 1024;
const TAIL_MAX = 4 * 1024 * 1024;
const SUMMARY_CHARS = 100;
const ERROR_CHARS = 300;
const SETTLED = new Set(["completed", "failed", "cancelled"]);
const NEWLINE = 10;

// why(vendor): omp@18.22.0 starts every session file it writes with a `title` entry padded for rewriting in place; OmO's and Claude's start with `session` or another entry (hub/runtime/fixtures/omp-sessions/killed)
const OMP_HEADER = '{"type":"title"';
// why(vendor): omp@18.22.0 appends this assistant entry to a worker's transcript when its process ended mid-turn; it is no answer of the model (hub/runtime/fixtures/omp-sessions/torn)
const EXIT_MARK = /^Previous OMP process exited/;

const seen = new Map<string, Seen>();
const tails = new Map<string, { stamp: string; error?: string }>();

const safeName = (name: unknown): name is string => typeof name === "string" && name !== "" && name !== "." && name !== ".." && !/[\\/]/.test(name);
const transcriptOf = (file: string, name: string): string => (file.endsWith(".jsonl") ? `${file.slice(0, -".jsonl".length)}/${name}.jsonl` : "");

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function summary(text: string | undefined): string {
	const lines = (text ?? "").split("\n").map(l => l.trim()).filter(Boolean);
	const heading = lines.findIndex(l => /^#+\s*(?:change|goal|task)\b/i.test(l));
	const line = lines.slice(heading + 1).find(l => !l.startsWith("#")) ?? lines.find(l => !l.startsWith("#")) ?? "";
	const plain = line.replace(/^(?:[-*]|\d+[.)])\s+/, "");
	return plain.length > SUMMARY_CHARS ? `${plain.slice(0, SUMMARY_CHARS)}…` : plain;
}

const nameOf = (j: Job): string | undefined => j.agentUrlId ?? j.agentId ?? j.jobId ?? j.id;

// why(vendor): omp@18.22.0 persists a background task as a `task` tool result whose details.async.type is "task" and details.progress lists the agents it spawned; its result comes back as a `custom_message` of type `async-result` (details.jobs[].agentId), or is consumed by the `wait` tool (details.jobs[].agentUrlId, status settled) and then has no async-result; `write agent://<name>` wakes a finished agent again (receipt outcome "woken") and its next result is another async-result for the same agent (hub/runtime/fixtures/omp-sessions/{killed,finished,waited,revived})
function apply(s: Seen, line: string): void {
	const delivered = line.includes('"customType":"async-result"');
	if (!delivered && !(line.includes('"role":"toolResult"') && (line.includes('"toolName":"task"') || line.includes('"toolName":"wait"') || line.includes('"outcome":"woken"')))) return;
	let e: Entry;
	try {
		e = JSON.parse(line) as Entry;
	} catch {
		return;
	}
	const at = Date.parse(e.timestamp ?? "");
	if (!(at > 0)) return;
	const settle = (jobs: Job[] | undefined): void => {
		for (const j of jobs ?? []) {
			const name = nameOf(j);
			if ((j.type ?? "task") === "task" && (j.status === undefined || SETTLED.has(j.status)) && name) s.open.delete(name);
		}
	};
	const start = (run: Run): void => {
		s.open.set(run.name, run);
		s.known.set(run.name, run);
	};
	if (e.type === "custom_message" && e.customType === "async-result") return settle(e.details?.jobs);
	const m = e.message;
	const d = m?.details;
	if (m?.role !== "toolResult" || !d) return;
	if (m.toolName === "task" && d.async?.type === "task") {
		for (const p of d.progress ?? []) if (safeName(p.id)) start({ name: p.id, at, what: summary(p.assignment ?? p.task) });
	} else if (m.toolName === "wait" && d.op === "wait") settle(d.jobs);
	else if (m.toolName === "write" && d.message?.op === "send") {
		for (const r of d.message.receipts ?? []) {
			const was = r.outcome === "woken" && safeName(r.to) ? s.known.get(r.to) : undefined;
			if (was) start({ ...was, at });
		}
	}
}

function anchorAt(fd: number, offset: number): string {
	const len = Math.min(ANCHOR_BYTES, offset);
	const buf = Buffer.alloc(len);
	readSync(fd, buf, 0, len, offset - len);
	return buf.toString("latin1");
}

function isOmp(fd: number): boolean {
	const buf = Buffer.alloc(OMP_HEADER.length);
	return readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.toString("utf8") === OMP_HEADER;
}

function readNew(fd: number, s: Seen, size: number): void {
	let carry = Buffer.alloc(0);
	for (let at = s.offset; at < size; ) {
		const chunk = Buffer.alloc(Math.min(CHUNK, size - at));
		const n = readSync(fd, chunk, 0, chunk.length, at);
		if (n <= 0) break;
		at += n;
		const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
		let from = 0;
		for (let nl = data.indexOf(NEWLINE, from); nl >= 0; nl = data.indexOf(NEWLINE, from)) {
			apply(s, data.toString("utf8", from, nl));
			from = nl + 1;
		}
		carry = data.subarray(from);
		s.offset = at - carry.length;
	}
	s.anchor = anchorAt(fd, s.offset);
}

function scan(file: string): Seen | undefined {
	let st: Stats;
	try {
		st = statSync(file);
	} catch {
		return undefined;
	}
	let s = seen.get(file);
	if (!s || s.size !== st.size || s.mtimeMs !== st.mtimeMs) {
		try {
			const fd = openSync(file, "r");
			try {
				if (s && (st.size < s.offset || anchorAt(fd, s.offset) !== s.anchor)) s = undefined;
				s ??= { omp: isOmp(fd), size: 0, mtimeMs: 0, offset: 0, anchor: "", open: new Map(), known: new Map() };
				if (s.omp) readNew(fd, s, st.size);
				s.size = st.size;
				s.mtimeMs = st.mtimeMs;
			} finally {
				closeSync(fd);
			}
		} catch {
			return undefined;
		}
	}
	seen.delete(file);
	seen.set(file, s);
	if (seen.size > CACHE_MAX) seen.delete(seen.keys().next().value!);
	return s;
}

function lastError(path: string): string | undefined {
	let st: Stats;
	try {
		st = statSync(path);
	} catch {
		return undefined;
	}
	const stamp = `${st.mtimeMs}:${st.size}`;
	const hit = tails.get(path);
	if (hit?.stamp === stamp) return hit.error;
	let error: string | undefined;
	try {
		const fd = openSync(path, "r");
		try {
			error = failedAnswer(fd, st.size);
		} finally {
			closeSync(fd);
		}
	} catch {
		error = undefined;
	}
	tails.delete(path);
	tails.set(path, { stamp, error });
	if (tails.size > CACHE_MAX * 4) tails.delete(tails.keys().next().value!);
	return error;
}

function failedAnswer(fd: number, size: number): string | undefined {
	for (let window = TAIL_START; ; window *= 4) {
		const len = Math.min(size, window);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		const lines = buf.toString("utf8").split("\n");
		if (len < size) lines.shift();
		for (const line of lines.reverse()) {
			if (!line.includes('"role":"assistant"')) continue;
			let m: Entry["message"];
			try {
				m = (JSON.parse(line) as Entry).message;
			} catch {
				continue;
			}
			if (m?.role !== "assistant" || EXIT_MARK.test(m.errorMessage ?? "")) continue;
			return m.stopReason === "error" && m.errorMessage ? m.errorMessage.replace(/\s+/g, " ").trim().slice(0, ERROR_CHARS) : undefined;
		}
		if (len >= size || window >= TAIL_MAX) return undefined;
	}
}

const workerOf = (run: Run, ended: number): OmpWorker => ({
	id: `${run.name}~${run.at.toString(36)}`,
	name: run.name,
	description: run.what ? `${run.name}: ${run.what}` : run.name,
	started_at: run.at,
	ended_at: ended,
});

/**
 * The workers an omp session file shows spawned (or woken again) with no result after them, whose process is gone: omp keeps its job table in
 * memory, so a kill, a crash or a restart leaves them out of every later turn. `live` is when the process now running the session started
 * (ms), undefined with none: a worker spawned since then is that process's own and still runs. Only workers younger than `maxAgeMs` count.
 * A file that is not omp's has none.
 */
export function ompDeadWork(file: string, live: number | undefined, w: { now: number; maxAgeMs: number }): OmpWorker[] {
	const out: OmpWorker[] = [];
	for (const run of scan(file)?.open.values() ?? []) {
		if (live !== undefined && run.at >= live) continue;
		const ended = Math.max(run.at, mtimeOf(transcriptOf(file, run.name)));
		if (w.now - ended < w.maxAgeMs) out.push(workerOf(run, ended));
	}
	return out;
}

/**
 * The workers of an omp session whose transcript ends on a failed model request, silent for `quietMs` since (a retry or a fallback that followed
 * it would have written), whatever became of their result: what a lane waits on after a provider outage (hub/lanereconnect.ts), the way OmO's
 * task log ends on its error event. `error` is the provider's own text.
 */
export function ompFailedWork(file: string, w: { now: number; maxAgeMs: number; quietMs: number }): OmpWorker[] {
	const out: OmpWorker[] = [];
	for (const run of scan(file)?.known.values() ?? []) {
		if (w.now - run.at >= w.maxAgeMs) continue;
		const path = transcriptOf(file, run.name);
		const wrote = mtimeOf(path);
		const quiet = w.now - wrote;
		if (!wrote || quiet < w.quietMs || quiet >= w.maxAgeMs) continue;
		const error = lastError(path);
		if (error) out.push({ ...workerOf(run, wrote), error });
	}
	return out;
}
