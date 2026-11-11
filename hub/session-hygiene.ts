// Session files at rest (security review 2026-11, owner pick "입구 검사와 세션 비밀 가리기"). OmO writes every turn of every session to
// <agent dir>/sessions/<folder>/<stamp>_<id>.jsonl and has no retention or masking switch of its own (its `tools.bash.redactSecretsInOutput`
// covers bash output only; hub/runtime/omo.ts turns it on). Once a night, in a child process so the gateway's memory does not grow:
// - a session file past its retention (sessions.keep_days in config.json, default 90, 0 keeps them) is deleted with its -artifacts
//   folder, but only after the recall index holds the whole file (recall-index retireFile): its masked pairs stay searchable;
// - every other session file idle for IDLE_MS and not leased by a live OmO process (its pid alive and an agent's) has its secrets masked in place
//   (maskSecrets, the same rules the recall index uses), atomically, keeping mode 600, its mtime and one valid JSON value per line;
// - the sessions folder and its session folders are kept 700, session files 600.
// A file written to within the day, leased, or named as active by the gateway (the sessions its running processes hold) is never touched.
// `bun hub/session-hygiene.ts [--dry-run] [--keep-days N] [--active <file>]...` prints one JSON summary of counts, never a value.
import type { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { maskSecrets, secretFileValues } from "./public-scrub.ts";
import { openRecall, retireFile } from "./recall-index.ts";

export const IDLE_MS = 86_400_000;
export const KEEP_DAYS = 90;
const DAY = 86_400_000;

export interface HygieneOpts {
	readonly roots: readonly string[];
	readonly secrets: readonly string[];
	readonly keepDays: number;
	readonly dryRun: boolean;
	readonly now?: number;
	readonly active?: ReadonlySet<string>;
	readonly recall?: Database;
}
export interface HygieneResult {
	files: number;
	bytes: number;
	masked: { files: number; lines: number; hits: Record<string, number> };
	skipped: { recent: number; leased: number; active: number; changed: number; unparsable: number };
	retention: { deleted: number; bytes: number; notIndexed: number };
	modes: number;
	ms: number;
}

const alive = (pid: unknown): boolean => {
	if (typeof pid !== "number" || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};
// What a live OmO process shows as its command: bun or node running its cli.js, or its own name (process.title) where ps reports that.
const AGENT_COMMAND = /^(bun|node|senpi|omo|omp|pi)$/;
// Whether a live pid is an agent process. A pid the system gave to another program since the lease was written (iconservicesagent on
// the Mac mini, 2026-11-10) is not, so it no longer keeps a dead session's file uncleaned. Without ps nothing can tell: still an agent.
function agentProcess(pid: number): boolean {
	let r: ReturnType<typeof Bun.spawnSync>;
	try {
		r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
	} catch {
		return true;
	}
	return AGENT_COMMAND.test(basename(r.stdout.toString().trim()));
}
// <folder>/extensions/terminal/<session id>.lease holds {"pid": ...} while an OmO process has the session open.
function leased(dir: string, file: string): boolean {
	const id = /_([^_]+)\.jsonl$/.exec(basename(file))?.[1];
	const lease = id && join(dir, "extensions", "terminal", `${id}.lease`);
	if (!lease || !existsSync(lease)) return false;
	try {
		const pid = (JSON.parse(readFileSync(lease, "utf8")) as { pid?: unknown }).pid;
		return alive(pid) && agentProcess(pid as number);
	} catch {
		return true; // a lease being written right now
	}
}

function maskValue(v: unknown, secrets: readonly string[], hits: Record<string, number>): unknown {
	if (typeof v === "string") {
		const r = maskSecrets(v, secrets);
		for (const [k, n] of Object.entries(r.hits)) hits[k] = (hits[k] ?? 0) + n;
		return r.text;
	}
	if (Array.isArray(v)) return v.map(x => maskValue(x, secrets, hits));
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValue(x, secrets, hits)]));
	return v;
}

// One line: unchanged unless a rule matches its raw text, then masked string by string through the parsed value (a match never spans
// a JSON string boundary that way). A line that does not parse is left as it is and counted.
export function maskLine(line: string, secrets: readonly string[], hits: Record<string, number>): { line: string; changed: boolean; unparsable?: boolean } {
	if (!line || !Object.keys(maskSecrets(line, secrets).hits).length) return { line, changed: false };
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { line, changed: false, unparsable: true };
	}
	const mine: Record<string, number> = {};
	const out = JSON.stringify(maskValue(value, secrets, mine));
	if (!Object.keys(mine).length) return { line, changed: false };
	for (const [k, n] of Object.entries(mine)) hits[k] = (hits[k] ?? 0) + n;
	return { line: out, changed: true };
}

// The file's lines (split at \n, the text after the last one included) read in 1 MB chunks: memory stays at the longest line.
function* fileLines(file: string): Generator<string> {
	const fd = openSync(file, "r");
	const chunk = Buffer.alloc(1 << 20);
	let rest: Buffer[] = [];
	try {
		for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) {
			let start = 0;
			for (let i = chunk.indexOf(10, start); i !== -1 && i < n; i = chunk.indexOf(10, start)) {
				rest.push(chunk.subarray(start, i));
				yield Buffer.concat(rest).toString("utf8");
				rest = [];
				start = i + 1;
			}
			if (start < n) rest.push(Buffer.from(chunk.subarray(start, n)));
		}
		yield Buffer.concat(rest).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

// Two streaming passes: count, then (when something changed and this is no dry run) write the masked copy, renamed in only if the
// file did not move meanwhile.
function maskFile(file: string, opts: HygieneOpts, res: HygieneResult): void {
	const before = statSync(file);
	const hits: Record<string, number> = {};
	let changed = 0;
	for (const line of fileLines(file)) {
		const r = maskLine(line, opts.secrets, hits);
		if (r.unparsable) res.skipped.unparsable++;
		if (r.changed) changed++;
	}
	if (!changed) return;
	if (!opts.dryRun) {
		const now = statSync(file);
		if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
			res.skipped.changed++;
			return;
		}
		const tmp = `${file}.${process.pid}.mask.tmp`;
		const fd = openSync(tmp, "w", 0o600);
		try {
			let first = true;
			for (const line of fileLines(file)) {
				writeSync(fd, `${first ? "" : "\n"}${maskLine(line, opts.secrets, {}).line}`);
				first = false;
			}
		} finally {
			closeSync(fd);
		}
		chmodSync(tmp, 0o600);
		// The idle and retention clocks keep counting from the last real write, not from this one.
		utimesSync(tmp, before.atime, before.mtime);
		renameSync(tmp, file);
	}
	res.masked.files++;
	res.masked.lines += changed;
	for (const [k, n] of Object.entries(hits)) res.masked.hits[k] = (res.masked.hits[k] ?? 0) + n;
}

function setMode(path: string, mode: number, opts: HygieneOpts, res: HygieneResult): void {
	if ((statSync(path).mode & 0o777) === mode) return;
	res.modes++;
	if (!opts.dryRun) chmodSync(path, mode);
}

export function runSessionHygiene(opts: HygieneOpts): HygieneResult {
	const t0 = performance.now();
	const now = opts.now ?? Date.now();
	const res: HygieneResult = { files: 0, bytes: 0, masked: { files: 0, lines: 0, hits: {} }, skipped: { recent: 0, leased: 0, active: 0, changed: 0, unparsable: 0 }, retention: { deleted: 0, bytes: 0, notIndexed: 0 }, modes: 0, ms: 0 };
	for (const root of opts.roots) {
		if (!existsSync(root)) continue;
		setMode(root, 0o700, opts, res);
		for (const d of readdirSync(root, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			const dir = join(root, d.name);
			setMode(dir, 0o700, opts, res);
			for (const name of readdirSync(dir)) {
				if (!name.endsWith(".jsonl")) continue;
				const file = join(dir, name);
				const st = statSync(file);
				res.files++;
				res.bytes += st.size;
				if (opts.active?.has(file)) { res.skipped.active++; continue; }
				if (now - st.mtimeMs < IDLE_MS) { res.skipped.recent++; continue; }
				if (leased(dir, file)) { res.skipped.leased++; continue; }
				if (opts.keepDays > 0 && now - st.mtimeMs >= opts.keepDays * DAY) {
					const indexed = opts.recall ? (opts.dryRun ? isIndexed(opts.recall, file, st) : retireFile(opts.recall, file)) : false;
					if (!indexed) res.retention.notIndexed++;
					else {
						res.retention.deleted++;
						res.retention.bytes += st.size;
						if (!opts.dryRun) {
							rmSync(file, { force: true });
							rmSync(file.replace(/\.jsonl$/, "-artifacts"), { recursive: true, force: true });
						}
						continue;
					}
				}
				setMode(file, 0o600, opts, res);
				maskFile(file, opts, res);
			}
		}
	}
	res.ms = Math.round(performance.now() - t0);
	return res;
}

function isIndexed(db: Database, file: string, st: { size: number; mtimeMs: number }): boolean {
	const row = db.query<{ size: number; mtime: number; complete: number }, [string]>("SELECT size, mtime, complete FROM files WHERE path = ?").get(file);
	return !!row && row.complete === 1 && row.size === st.size && row.mtime === st.mtimeMs;
}

export const sessionRoots = (): string[] => [
	join(process.env.OMO_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".omo", "agent"), "sessions"),
	join(homedir(), ".omp", "agent", "sessions"),
	// Claude Code keeps <config>/projects/<cwd>/<id>.jsonl (hub/runtime/claude.ts): the same folder/file depth.
	join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
];

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const dataDir = process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
	const at = argv.indexOf("--keep-days");
	const keepDays = at >= 0 ? Number(argv[at + 1]) : KEEP_DAYS;
	if (!Number.isFinite(keepDays) || keepDays < 0) {
		console.error("session-hygiene: --keep-days must be a number >= 0");
		process.exit(1);
	}
	const active = new Set(argv.flatMap((a, i) => (a === "--active" && argv[i + 1] ? [argv[i + 1] as string] : [])));
	const dryRun = argv.includes("--dry-run");
	const recall = existsSync(join(dataDir, "recall", "index.db")) ? openRecall(dataDir, dryRun) : undefined;
	const res = runSessionHygiene({ roots: sessionRoots(), secrets: secretFileValues(dataDir), keepDays, dryRun, active, recall });
	recall?.close();
	console.log(JSON.stringify(res));
}
