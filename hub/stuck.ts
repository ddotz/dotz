// Stuck-turn detection for an agent process (an orchestrator session or a lane): an open turn that shows no progress for
// stuckTurnMs() is aborted, and restarted when the abort does not end the turn within ABORT_GRACE_MS. Progress is any event
// from the process, growth of its session file, or >= 2 s of CPU time used by its process tree between two samples (a long test
// run emits no event but burns CPU). Nothing is done while the caller says a wait is legitimate (workers, compaction, an open
// owner question) or the turn is not open. At most STUCK_CAP recoveries per hour; past that the caller is alerted once.
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, stuckTurnMs, writeAtomic } from "./config.ts";
import type { AgentEvent } from "./runtime/types.ts";

export const ABORT_GRACE_MS = 60_000;
export const STUCK_CAP = 3;
export const STUCK_WINDOW_MS = 60 * 60_000;
const CPU_GROWTH_S = 2;
// Two samples further apart than this many sampling periods mean the machine slept (a loaded or briefly blocked tick is late by one period, rarely two).
export const SLEEP_GAP_FACTOR = 3;

export type StuckState = { lastAt: number; abortedAt?: number; sampledAt?: number; recoveries: number[]; capped: boolean };
export type StuckStep = "none" | "abort" | "restart" | "cap";

export function stuckDecision(s: StuckState, now: number, stuckMs: number): StuckStep {
	if (s.abortedAt !== undefined) return now - s.abortedAt >= ABORT_GRACE_MS ? "restart" : "none";
	if (now - s.lastAt < stuckMs) return "none";
	if (s.recoveries.filter(at => now - at < STUCK_WINDOW_MS).length >= STUCK_CAP) return s.capped ? "none" : "cap";
	return "abort";
}

/**
 * Time that passed while the machine slept is not silence: when `now` is more than SLEEP_GAP_FACTOR periods after the previous sample, the
 * last-progress and abort times move forward by the gap, so the awake silence is what it was before the sleep. Returns the skipped ms (0: none).
 */
export function skipSleepGap(s: StuckState, now: number, every: number): number {
	const gap = s.sampledAt === undefined ? 0 : now - s.sampledAt;
	if (gap <= SLEEP_GAP_FACTOR * every) return 0;
	s.lastAt = Math.min(now, s.lastAt + gap);
	if (s.abortedAt !== undefined) s.abortedAt = Math.min(now, s.abortedAt + gap);
	return gap;
}

// `ps` TIME: [dd-][hh:]mm:ss[.cc]
export function parseCpuTime(t: string): number {
	const [days, rest] = t.includes("-") ? t.split("-") : ["0", t];
	const parts = rest!.split(":").map(Number).reverse();
	return Number(days) * 86400 + (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
}

/** Cumulative CPU seconds of `pid` and all its descendants from `ps -A -o pid=,ppid=,time=` output; undefined when `pid` is not listed. */
export function treeCpuSeconds(ps: string, pid: number): number | undefined {
	const cpu = new Map<number, number>();
	const kids = new Map<number, number[]>();
	for (const line of ps.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
		if (!m) continue;
		const [id, parent] = [Number(m[1]), Number(m[2])];
		cpu.set(id, parseCpuTime(m[3]!));
		kids.set(parent, [...(kids.get(parent) ?? []), id]);
	}
	if (!cpu.has(pid)) return undefined;
	let total = 0;
	const seen = new Set<number>();
	for (const stack = [pid]; stack.length; ) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		total += cpu.get(id) ?? 0;
		stack.push(...(kids.get(id) ?? []));
	}
	return total;
}

export type CpuSampler = (pid: number) => Promise<number | undefined>;
let sampler: CpuSampler = async pid => {
	try {
		const p = Bun.spawn(["/bin/ps", "-A", "-o", "pid=,ppid=,time="], { stdout: "pipe", stderr: "ignore", timeout: 5000, killSignal: "SIGKILL" });
		const out = await new Response(p.stdout).text();
		await p.exited;
		return treeCpuSeconds(out, pid);
	} catch {
		return undefined;
	}
};
/** Tests replace the CPU sampling. */
export const setCpuSampler = (fn: CpuSampler): void => void (sampler = fn);

const NAME_RE = /^[\w.:-]{1,40}$/;
const stringsOf = (v: unknown, out: string[] = []): string[] => {
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
	else if (v && typeof v === "object") for (const x of Object.values(v)) stringsOf(x, out);
	return out;
};

/**
 * The shape of a tool call, never its arguments: the tool name; for `eval` also the cell's language and how many `tool.<name>(` calls it
 * makes, counted by name ("eval js 셀 안의 tool.bash x4"). `args` is the JSON text of the tool_call row; no code, command or path is copied.
 */
export function callShape(tool: string | undefined, args: string | undefined): string {
	const name = tool && NAME_RE.test(tool) ? tool : "도구";
	if (name.toLowerCase() !== "eval" || !args) return name;
	let parsed: unknown = args;
	try {
		parsed = JSON.parse(args);
	} catch {
		// Not JSON: the raw text is scanned for tool.<name>( calls as it is.
	}
	const lang = parsed && typeof parsed === "object" ? ((parsed as Record<string, unknown>).language ?? (parsed as Record<string, unknown>).lang) : undefined;
	const counts = new Map<string, number>();
	for (const text of stringsOf(parsed)) for (const m of text.matchAll(/\btool\.([A-Za-z_]\w{0,39})\(/g)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
	const calls = [...counts].slice(0, 5).map(([n, c]) => `tool.${n} x${c}`);
	return `eval ${typeof lang === "string" && /^[A-Za-z]{1,12}$/.test(lang) ? `${lang.toLowerCase()} ` : ""}셀${calls.length ? ` 안의 ${calls.join(", ")}` : ""}`;
}

export type StuckInfo = { shape?: string; minutes: number };
/** The line that opens the redelivered request after a stuck recovery. */
export const stuckLine = (i: StuckInfo): string =>
	i.shape ? `앞 턴이 ${i.shape}에서 ${i.minutes}분 멈춰서 끊었어요. 같은 호출 모양을 되풀이하지 마세요.` : `앞 턴이 도구 호출 없이 ${i.minutes}분 멈춰서 끊었어요.`;
/** `wrap` with `line` in front of the first text only (one session reads them all). */
export function leadWith(wrap: (text: string) => string, line: string | undefined): (text: string) => string {
	let pending = line;
	return text => {
		const out = wrap(text);
		if (!pending) return out;
		const lead = pending;
		pending = undefined;
		return `${lead}\n${out}`;
	};
}

const SECRET_WORD = "(token|key|secret|password|auth|cookie)";
const SECRET_FLAG = new RegExp(SECRET_WORD, "i");
const SECRET_HEADER = new RegExp(`^[\\w-]*${SECRET_WORD}[\\w-]*:$`, "i");
/** A command line for a diagnostic file: the binary stays, argument values that look secret (or are long) become ***. */
export function maskCommand(cmd: string): string {
	let maskNext = false;
	return cmd
		.trim()
		.split(/\s+/)
		.map((a, i) => {
			if (i === 0) return a;
			if (maskNext && !a.startsWith("-")) {
				// "Authorization: Bearer <token>": the scheme word is followed by the secret
				maskNext = /^(bearer|basic)$/i.test(a);
				return maskNext ? a : "***";
			}
			maskNext = false;
			if (/^(bearer|basic)$/i.test(a) || SECRET_HEADER.test(a)) {
				maskNext = true;
				return a;
			}
			if (a.startsWith("-")) {
				const eq = a.indexOf("=");
				const flag = eq < 0 ? a : a.slice(0, eq);
				if (SECRET_FLAG.test(flag)) {
					if (eq >= 0) return `${flag}=***`;
					maskNext = true;
					return a;
				}
				return a.length > 40 ? (eq >= 0 ? `${flag}=***` : "***") : a;
			}
			const env = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(a);
			if (env) return `${env[1]}=***`;
			return a.length > 40 ? "***" : a;
		})
		.join(" ");
}

/** Descendants of `pid` (itself first) from `ps -A -o pid=,ppid=,etime=,time=,command=` output, one masked line each. */
export function treeLines(ps: string, pid: number): string[] {
	const rows = new Map<number, string>();
	const kids = new Map<number, number[]>();
	for (const line of ps.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const [id, parent] = [Number(m[1]), Number(m[2])];
		rows.set(id, `${id} ${parent} etime=${m[3]} cpu=${m[4]} ${maskCommand(m[5]!).slice(0, 120)}`);
		kids.set(parent, [...(kids.get(parent) ?? []), id]);
	}
	if (!rows.has(pid)) return [];
	const out: string[] = [];
	const seen = new Set<number>();
	for (const stack = [pid]; stack.length; ) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(rows.get(id) ?? String(id));
		stack.push(...[...(kids.get(id) ?? [])].reverse());
	}
	return out;
}

/** The type and timestamp of the session file's last line; its content is never read into the snapshot. */
function lastLineInfo(file: string | undefined): string {
	if (!file) return "no session file";
	try {
		const fd = openSync(file, "r");
		try {
			const size = fstatSync(fd).size;
			const len = Math.min(size, SNAPSHOT_MAX_BYTES);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			const line = buf.toString("utf8").split("\n").filter(l => l.trim()).at(-1);
			if (!line) return "session file is empty";
			const o = JSON.parse(line) as Record<string, unknown>;
			const clean = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).replace(/[^\w:.+\- ]/g, "").slice(0, 40) : "-");
			return `session file last line: type=${clean(o.type)} timestamp=${clean(o.timestamp ?? o.ts ?? o.time)}`;
		} finally {
			closeSync(fd);
		}
	} catch {
		return "session file last line: unreadable";
	}
}

export const SNAPSHOT_MS = 7000;
export const SAMPLE_MS = 5000;
export const SNAPSHOT_KEEP = 20;
export const SNAPSHOT_MAX_BYTES = 256 * 1024;

/** Runs a command and returns its stdout, or undefined when it fails or outlives `timeoutMs`. */
export type SnapshotRunner = (cmd: string[], timeoutMs: number) => Promise<string | undefined>;
let snapshotRunner: SnapshotRunner = async (cmd, timeoutMs) => {
	try {
		const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
		return await new Response(p.stdout).text();
	} catch {
		return undefined;
	}
};
/** Tests replace the commands a snapshot runs (ps, sample). */
export const setSnapshotRunner = (fn: SnapshotRunner): void => void (snapshotRunner = fn);

/**
 * Writes a diagnostic file about a process about to be killed: `<DATA_DIR>/stuck/<ISO time>-<key>.txt` with its masked process tree, the
 * type and timestamp of its session file's last line and, on macOS, the head of `sample <pid> 3`. Bounded to SNAPSHOT_MS in all; a failure
 * is logged and ignored, so the caller always goes on to kill. Resolves with the path, or undefined when nothing was written.
 */
export async function takeSnapshot(key: string, pid: number | undefined, sessionFile: string | undefined): Promise<string | undefined> {
	try {
		const started = Date.now();
		const sections = [`key: ${key}`, `pid: ${pid ?? "-"}`, lastLineInfo(sessionFile)];
		let finished = false;
		const work = (async () => {
			if (pid !== undefined) {
				const ps = await snapshotRunner(["/bin/ps", "-A", "-o", "pid=,ppid=,etime=,time=,command="], 2000);
				const tree = ps ? treeLines(ps, pid) : [];
				sections.push(`process tree (pid ppid etime cpu command):\n${tree.length ? tree.join("\n") : "unavailable"}`);
				const room = Math.min(SAMPLE_MS, SNAPSHOT_MS - (Date.now() - started) - 300);
				if (process.platform === "darwin" && room > 500) {
					const sample = await snapshotRunner(["/usr/bin/sample", String(pid), "3", "-file", "/dev/stdout"], room);
					sections.push(`sample ${pid} 3 (first 200 lines):\n${sample ? sample.split("\n").slice(0, 200).join("\n") : "unavailable"}`);
				}
			}
			finished = true;
		})();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([work.catch(e => void log(`stuck: snapshot of ${key} failed: ${e}`)), new Promise<void>(r => (timer = setTimeout(r, SNAPSHOT_MS)))]);
		clearTimeout(timer);
		if (!finished) sections.push("(snapshot cut short at its time limit)");
		const dir = join(DATA_DIR, "stuck");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${new Date().toISOString()}-${key.replace(/[^\w.-]+/g, "_").slice(0, 60)}.txt`);
		writeAtomic(path, Buffer.from(sections.join("\n\n") + "\n").subarray(0, SNAPSHOT_MAX_BYTES).toString());
		const old = readdirSync(dir).filter(f => f.endsWith(".txt")).sort();
		for (const f of old.slice(0, Math.max(0, old.length - SNAPSHOT_KEEP))) unlinkSync(join(dir, f));
		log(`stuck: snapshot ${path}`);
		return path;
	} catch (e) {
		log(`stuck: snapshot of ${key} failed: ${e}`);
		return undefined;
	}
}

const sizeOf = (file: string | undefined): number | undefined => {
	try {
		return file ? statSync(file).size : undefined;
	} catch {
		return undefined;
	}
};

export type StuckWatchOpts = {
	key: string;
	pid: () => number | undefined;
	sessionFile: () => string | undefined;
	/** A wait that is not a stall is going on (workers, compaction, an open owner question) or the turn is not open: nothing is done. */
	exempt: () => boolean;
	/** Mark the turn failed (its request stays open) and abort the process. */
	abort: () => void;
	restart: (why: string) => void;
	/** The abort was just sent after `minutes` of no progress. */
	stuck: (minutes: number) => void;
	/** The hourly recovery cap is reached: told once until a turn ends normally. */
	capped: (minutes: number) => void;
};

export function createStuckWatch(o: StuckWatchOpts) {
	const s: StuckState = { lastAt: Date.now(), recoveries: [], capped: false };
	let timer: ReturnType<typeof setInterval> | undefined;
	let every = 60_000;
	let last = "turn start";
	let size: number | undefined;
	let cpu: number | undefined;
	let busy = false;
	let abortedAfter = 0;
	// Tool calls started and not yet answered, in start order: the last one is what a stuck turn was inside.
	const open = new Map<string, { tool?: string; shape: string }>();
	let openSeq = 0;
	let info: StuckInfo | undefined;

	function progress(signal: string, ev?: AgentEvent): void {
		s.lastAt = Date.now();
		last = signal;
		if (ev?.type === "turn_start") open.clear();
		else if (ev?.type === "activity" && ev.row.type === "tool_call") open.set(ev.row.call_id ?? `#${++openSeq}`, { tool: ev.row.tool, shape: callShape(ev.row.tool, ev.row.args) });
		else if (ev?.type === "activity" && ev.row.type === "tool_result") {
			const id = ev.row.call_id ?? [...open].reverse().find(([, c]) => c.tool === ev.row.tool)?.[0];
			if (id !== undefined) open.delete(id);
		}
	}
	function stop(): void {
		clearInterval(timer);
		timer = undefined;
		s.abortedAt = undefined;
		size = cpu = undefined;
	}
	/** A turn opens: sampling starts. */
	function begin(): void {
		stop();
		info = undefined;
		progress("turn start");
		s.sampledAt = s.lastAt;
		size = sizeOf(o.sessionFile());
		every = Math.min(60_000, Math.max(250, stuckTurnMs() / 4));
		timer = setInterval(() => void tick(), every);
		(timer as { unref?: () => void }).unref?.();
	}
	/** The turn ended. True when it ended because of this watch's abort: the caller restarts right now, before its idle handling. */
	function end(): boolean {
		const aborted = s.abortedAt !== undefined;
		stop();
		if (!aborted) s.capped = false;
		return aborted;
	}
	async function tick(): Promise<void> {
		if (!timer || busy) return;
		busy = true;
		try {
			let now = Date.now();
			const skipped = skipSleepGap(s, now, every);
			if (skipped) log(`stuck: ${o.key} sleep gap of ${Math.round(skipped / 60_000)} min skipped`);
			if (o.exempt()) {
				s.lastAt = now;
				if (s.abortedAt !== undefined) s.abortedAt = now;
				return;
			}
			// Capped and told: the turn is left alone until it ends normally, also after the hourly window slides past the old recoveries.
			if (s.capped) return;
			const grown = sizeOf(o.sessionFile());
			if (grown !== undefined) {
				if (size !== undefined && grown > size) progress("session file");
				size = grown;
			}
			const pid = o.pid();
			if (pid !== undefined && now - s.lastAt >= every) {
				const c = await sampler(pid);
				if (!timer) return;
				if (c !== undefined) {
					if (cpu !== undefined && c - cpu >= CPU_GROWTH_S) progress("cpu");
					cpu = c;
				}
				now = Date.now();
			}
			const minutes = Math.max(1, Math.round((now - s.lastAt) / 60_000));
			switch (stuckDecision(s, now, stuckTurnMs())) {
				case "abort":
					log(`stuck: ${o.key} no progress for ${minutes} min (${last}); aborting`);
					s.recoveries = s.recoveries.filter(at => now - at < STUCK_WINDOW_MS);
					s.recoveries.push(now);
					s.abortedAt = now;
					abortedAfter = minutes;
					info = { shape: [...open.values()].at(-1)?.shape, minutes };
					o.stuck(minutes);
					o.abort();
					break;
				case "restart":
					log(`stuck: ${o.key} no progress for ${abortedAfter} min (${last}); restarting`);
					s.abortedAt = undefined;
					s.lastAt = now;
					o.restart(`no progress for ${abortedAfter} min`);
					break;
				case "cap":
					log(`stuck: ${o.key} no progress for ${minutes} min (${last}); recovery cap reached`);
					s.capped = true;
					o.capped(minutes);
					break;
			}
		} catch (e) {
			log(`stuck: ${o.key} check failed: ${e}`);
		} finally {
			busy = false;
			s.sampledAt = Date.now(); // after a slow sampler, so its own time is not taken for a sleep
		}
	}
	/** What the last abort found: the open tool call's shape and the minutes of silence; kept until the next turn starts. */
	return { progress, begin, end, reset: stop, tick, info: (): StuckInfo | undefined => info };
}

export type OrchStuckHost = {
	key: string;
	pid: () => number | undefined;
	sessionFile: () => string | undefined;
	working: () => boolean;
	/** Workers running or a compaction: a wait, not a stall. */
	busy: () => boolean;
	/** Mark the turn failed (its request stays open) and abort the process. */
	abort: () => void;
	/** Restart the process, a diagnostic snapshot first (orchestrator.ts restart). */
	restart: (why: string) => void;
	alert: (text: string) => void;
};

/**
 * The stuck watch of one orchestrator session (main or a conversation), kept out of createOrchestrator: the stuck abort and restart, the
 * restart of an owner abort the process ignored, the line opening the replay after a stuck recovery, and the handler that tells the
 * conversation and the guard that names a legitimate wait (an open owner question), both set by hub/outbound.ts.
 */
export function orchStuck(h: OrchStuckHost) {
	let onStuck: (minutes: number) => void = () => {};
	let guard: () => boolean = () => false;
	let ownerTimer: ReturnType<typeof setTimeout> | undefined;
	let lead: string | undefined;
	const stuckRestart = (why: string): void => {
		const info = watch.info();
		lead = info ? stuckLine(info) : undefined;
		h.restart(why);
	};
	const watch = createStuckWatch({
		key: h.key,
		pid: h.pid,
		sessionFile: h.sessionFile,
		exempt: () => !h.working() || h.busy() || guard(),
		abort: h.abort,
		restart: why => stuckRestart(`stuck turn: ${why}`),
		stuck: minutes => onStuck(minutes),
		capped: minutes => h.alert(`작업이 ${minutes}분 동안 멈춰 있어요. 한 시간 안에 이미 세 번 끊고 다시 이어갔기 때문에 이번에는 그대로 두었어요.`),
	});
	const disarm = (): void => {
		clearTimeout(ownerTimer);
		ownerTimer = undefined;
	};
	return {
		setHandler: (fn: (minutes: number) => void): void => void (onStuck = fn),
		setGuard: (fn: () => boolean): void => void (guard = fn),
		event: (ev: AgentEvent): void => watch.progress(ev.type, ev),
		begin: (): void => watch.begin(),
		/** At turn_end. True when the stuck abort ended the turn: the restart is under way and the caller replays the open requests. */
		ended(): boolean {
			disarm();
			if (!watch.end()) return false;
			stuckRestart("stuck turn: aborted after no progress");
			return true;
		},
		reset(): void {
			watch.reset();
			disarm();
		},
		/** The owner aborted the running turn: a process that ignores it stays working for good, so it is restarted after the grace. The
		 * cancelled request is not replayed (prompts.ts reopen) and nothing more is posted; the owner already heard "중단했어요". */
		ownerAbort(abort: () => void): void {
			const pid = h.pid();
			abort();
			disarm();
			ownerTimer = setTimeout(() => {
				ownerTimer = undefined;
				if (h.pid() === pid && h.working()) h.restart("owner abort did not stop the turn");
			}, ABORT_GRACE_MS);
		},
		/** The line opening the replay after a stuck recovery, once. */
		takeLead(): string | undefined {
			const l = lead;
			lead = undefined;
			return l;
		},
	};
}
