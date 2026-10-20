// Data cleanup (eval 2026-10-20 L3/C1). Pure pieces the hourly sweep in hygiene.ts runs:
// - rotateFile: an append-only log past its limit keeps its recent whole lines live (readers tail it: history, answered
//   ids, the nightly reflection) and moves the older part to <dir>/archive/<name>.<utc stamp>.gz; nothing is dropped.
// - pruneArchives / pruneUploads: archives and upload day folders past their retention.
// - pruneTempSessions: OmO/omp session folders of throwaway folders nothing touched for a while: a mkdtemp folder under
//   /var/folders (gateway checks, probes, tests; only programs make those), or a /tmp folder that no longer exists (owner
//   work can live in /tmp, so an existing one is kept). A real project's sessions are never looked at.
// - removeSessionsFor: the session folders of one throwaway cwd, for a probe that is done with it.
// - closeDeadLaneTasks: state.json open tasks waiting on an ended lane are moved to a history file with the reason.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeAtomic } from "./config.ts";

const DAY = 86_400_000;
const TEMP_CWD = /^\/(private\/)?(tmp|var\/folders)\//;
const MKDTEMP_CWD = /^\/(private\/)?var\/folders\//;

export const sessionDirs = (): string[] => [
	join(process.env.OMO_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".omo", "agent"), "sessions"),
	join(homedir(), ".omp", "agent", "sessions"),
];

const stamp = (now: number) => new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export function rotateFile(file: string, maxBytes: number, keepBytes: number, now = Date.now()): { before: number; after: number; archive: string } | undefined {
	if (!existsSync(file) || statSync(file).size <= maxBytes) return undefined;
	const buf = readFileSync(file);
	const nl = buf.indexOf(10, Math.max(0, buf.length - keepBytes) - 1);
	const cut = nl < 0 ? buf.length : nl + 1;
	const dir = join(dirname(file), "archive");
	mkdirSync(dir, { recursive: true });
	let archive = join(dir, `${basename(file)}.${stamp(now)}.gz`);
	for (let n = 1; existsSync(archive); n++) archive = join(dir, `${basename(file)}.${stamp(now)}-${n}.gz`);
	writeFileSync(archive, gzipSync(buf.subarray(0, cut)));
	writeAtomic(file, buf.subarray(cut).toString("utf8"));
	return { before: buf.length, after: buf.length - cut, archive };
}

export function pruneArchives(dir: string, prefix: string, keepDays: number, now = Date.now()): string[] {
	if (!existsSync(dir)) return [];
	const gone: string[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(`${prefix}.`) || !name.endsWith(".gz")) continue;
		if (now - statSync(join(dir, name)).mtimeMs < keepDays * DAY) continue;
		rmSync(join(dir, name), { force: true });
		gone.push(name);
	}
	return gone;
}

// Upload folders are named by their KST day (files.ts).
export function pruneUploads(dir: string, keepDays: number, now = Date.now()): string[] {
	if (!existsSync(dir)) return [];
	const gone: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
		if (Date.parse(`${name}T00:00:00+09:00`) + DAY > now - keepDays * DAY) continue;
		rmSync(join(dir, name), { recursive: true, force: true });
		gone.push(name);
	}
	return gone;
}

function sessionCwd(dir: string): string | undefined {
	const first = readdirSync(dir).find(n => n.endsWith(".jsonl"));
	if (!first) return undefined;
	const fd = openSync(join(dir, first), "r");
	try {
		const buf = Buffer.alloc(4096);
		const line = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8").split("\n")[0];
		const cwd = JSON.parse(line ?? "").cwd;
		return typeof cwd === "string" ? cwd : undefined;
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

function newestMtime(dir: string): number {
	let t = statSync(dir).mtimeMs;
	for (const name of readdirSync(dir)) t = Math.max(t, statSync(join(dir, name)).mtimeMs);
	return t;
}

function sizeKb(path: string): number {
	const r = Bun.spawnSync(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
	return Number(r.stdout.toString().split("\t")[0]) || 0;
}

export function pruneTempSessions(sessionsDir: string, minIdleMs: number, now = Date.now()): { removed: string[]; kb: number } {
	const removed: string[] = [];
	let kb = 0;
	if (!existsSync(sessionsDir)) return { removed, kb };
	for (const name of readdirSync(sessionsDir).sort()) {
		const dir = join(sessionsDir, name);
		if (!statSync(dir).isDirectory()) continue;
		const cwd = sessionCwd(dir);
		if (!cwd || !TEMP_CWD.test(cwd) || (!MKDTEMP_CWD.test(cwd) && existsSync(cwd))) continue;
		if (now - newestMtime(dir) < minIdleMs) continue;
		const size = sizeKb(dir);
		rmSync(dir, { recursive: true, force: true });
		removed.push(name);
		kb += size;
	}
	return { removed, kb };
}

// Session folders record the resolved path (/private/var/...), mkdtemp returns /var/...: both spellings match.
export function removeSessionsFor(cwd: string, dirs = sessionDirs()): string[] {
	const want = new Set([cwd, cwd.replace(/^\/private\//, "/"), `/private${cwd}`]);
	const removed: string[] = [];
	for (const sd of dirs) {
		if (!existsSync(sd)) continue;
		for (const name of readdirSync(sd)) {
			const dir = join(sd, name);
			if (!statSync(dir).isDirectory() || !want.has(sessionCwd(dir) ?? "")) continue;
			rmSync(dir, { recursive: true, force: true });
			removed.push(name);
		}
	}
	return removed;
}

export type OpenTask = { id?: string; lane?: unknown; [key: string]: unknown };

// A task that waits for the owner (an answer, a choice, an approval, a needs-you question) stays open when its lane ends:
// only the owner closes it (2026-10-20 18:57: the hourly cleanup closed gateway-ui-m3, whose next step was the owner's
// pick of 5 ideas). Read from its words; a false match only keeps a task open.
const OWNER_WAIT_RE = /needs[- ]?you|\[ask\]|\bquestion\b|\bapprov|owner'?s? (?:answer|reply|choice|pick|decision|ok)|(?:wait|waiting|waits) (?:for|on) (?:the )?owner|형\s*(?:의\s*)?(?:답|대답|선택|결정|승인|확인|오케이|ok)|형이\s*(?:고르|정하|답하|승인|선택|확인)|(?:승인|답|선택|결정)\s*(?:대기|기다)/i;
export function waitsForOwner(task: OpenTask): boolean {
	return [task.next, task.what].some(v => typeof v === "string" && OWNER_WAIT_RE.test(v));
}

// isDead returns the reason a lane counts as ended, or undefined while it may still come back.
export function closeDeadLaneTasks(stateFile: string, historyFile: string, isDead: (lane: string) => string | undefined, now = Date.now()): OpenTask[] {
	if (!existsSync(stateFile)) return [];
	const state = JSON.parse(readFileSync(stateFile, "utf8"));
	if (!Array.isArray(state?.open_tasks)) return [];
	const keep: OpenTask[] = [];
	const closed: OpenTask[] = [];
	for (const task of state.open_tasks as OpenTask[]) {
		const reason = typeof task?.lane === "string" ? isDead(task.lane) : undefined;
		if (!reason || waitsForOwner(task)) {
			keep.push(task);
			continue;
		}
		closed.push(task);
		appendFileSync(historyFile, `${JSON.stringify({ ...task, closed_at: new Date(now).toISOString(), closed_reason: reason })}\n`);
	}
	if (closed.length) writeAtomic(stateFile, `${JSON.stringify({ ...state, open_tasks: keep }, null, 2)}\n`);
	return closed;
}
