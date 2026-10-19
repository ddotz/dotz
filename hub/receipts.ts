// Verification receipts: a command that already passed on exactly this checkout is not run again. The key binds the
// command to the working directory, HEAD, the uncommitted state and the env vars that matter, so any edit or commit is
// a new key. Only node builtins: extension/index.ts imports this and must not load hub/config.ts. CLI:
//   bun hub/receipts.ts --cwd <dir> [--env A,B] -- <command>
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const TAIL_BYTES = 4096;
// A pass is reused only this long: long enough for a lane's check and the orchestrator's re-run of it, short enough that
// state outside the checkout (a service, a remote) cannot hide behind an old receipt for days.
const REUSE_MS = 6 * 3600_000;
const KEEP_MS = 24 * 3600_000;
const RUN_TIMEOUT_MS = 15 * 60_000;

export type Receipt = { key: string; command: string; cwd: string; head: string; exitCode: number; stdout: string; stderr: string; ranAt: number; durationMs: number };
export type ReceiptResult = Receipt & { reused: boolean };
export type ReceiptRequest = { command: string; cwd: string; env?: string[]; dir?: string };

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// undefined = the git call failed: the checkout state is unknown.
function git(cwd: string, args: string[], input?: string): string | undefined {
	const r = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : undefined;
}

// Untracked files show up in `git status` by name only, so their content is hashed too: editing one must change the key.
// Outside git, or when any git call fails, the content is unknown and nothing is reused (cacheable false).
function worktreeState(cwd: string): { head: string; tree: string; cacheable: boolean } {
	const head = git(cwd, ["rev-parse", "HEAD"])?.trim();
	if (!head) return { head: "no-git", tree: "", cacheable: false };
	const untracked = git(cwd, ["ls-files", "-o", "--exclude-standard", "-z"])?.split("\0").filter(Boolean);
	const hashes = untracked?.length ? git(cwd, ["hash-object", "--stdin-paths"], untracked.join("\n") + "\n") : "";
	const status = git(cwd, ["status", "--porcelain"]);
	const diff = git(cwd, ["diff", "HEAD"]);
	const parts = [status, diff, hashes];
	return { head, tree: sha256(parts.join("\0")), cacheable: untracked !== undefined && parts.every(p => p !== undefined) };
}

export function receiptKey(command: string, cwd: string, env: string[] = []): { key: string; cwd: string; head: string; cacheable: boolean } {
	const real = realpathSync(resolve(cwd));
	const { head, tree, cacheable } = worktreeState(real);
	const vars = Object.fromEntries([...env].sort().map(name => [name, process.env[name] ?? null]));
	return { key: sha256(JSON.stringify({ command, cwd: real, head, tree, env: vars })), cwd: real, head, cacheable };
}

function load(file: string, key: string): Receipt | undefined {
	try {
		const r = JSON.parse(readFileSync(file, "utf8")) as Receipt;
		return r.key === key && Number.isInteger(r.exitCode) && Date.now() - r.ranAt < REUSE_MS ? r : undefined;
	} catch {
		return undefined;
	}
}

// ranAt, not file mtime: it is what the receipt itself claims, and it follows the same clock the caller sees.
function prune(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const file = join(dir, name);
		let ranAt = 0;
		try {
			ranAt = JSON.parse(readFileSync(file, "utf8")).ranAt;
		} catch {}
		if (!(Date.now() - ranAt < KEEP_MS)) rmSync(file, { force: true });
	}
}

function run(command: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const { promise, resolve: done } = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
	// Own process group, so a hung check is killed with everything it started.
	const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
	const timer = setTimeout(() => {
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {}
	}, RUN_TIMEOUT_MS);
	// Only the tail is kept while streaming: a chatty test run must not grow memory.
	const tails = [Buffer.alloc(0), Buffer.alloc(0)];
	const keep = (i: number) => (chunk: Buffer) => {
		tails[i] = Buffer.concat([tails[i]!, chunk]).subarray(-TAIL_BYTES);
	};
	child.stdout.on("data", keep(0));
	child.stderr.on("data", keep(1));
	const finish = (exitCode: number, extra = "") => {
		clearTimeout(timer);
		done({ exitCode, stdout: tails[0]!.toString(), stderr: tails[1]!.toString() + extra });
	};
	child.on("error", e => finish(127, String(e)));
	child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1), signal ? `killed by ${signal}` : ""));
	return promise;
}

export async function runWithReceipt(req: ReceiptRequest): Promise<ReceiptResult> {
	const { key, cwd, head, cacheable } = receiptKey(req.command, req.cwd, req.env);
	const dir = join(req.dir ?? process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "receipts");
	const file = join(dir, `${key}.json`);
	// A failure is never cached as truth: only a recent stored pass on a known checkout state is reused.
	const stored = cacheable ? load(file, key) : undefined;
	if (stored?.exitCode === 0) return { ...stored, reused: true };
	const started = performance.now();
	const out = await run(req.command, cwd);
	const receipt: Receipt = { key, command: req.command, cwd, head, ...out, ranAt: Date.now(), durationMs: Math.round(performance.now() - started) };
	if (!cacheable) return { ...receipt, reused: false };
	mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(receipt));
	renameSync(tmp, file);
	prune(dir);
	return { ...receipt, reused: false };
}

export function summarize(r: ReceiptResult): string {
	const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
	return `receipt ${r.key.slice(0, 12)} ${r.reused ? "reused" : "ran"} exit=${r.exitCode} head=${r.head.slice(0, 7)}${out ? `\n${out}` : ""}`;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const sep = argv.indexOf("--");
	const flags = sep < 0 ? argv : argv.slice(0, sep);
	const command = sep < 0 ? "" : argv.slice(sep + 1).join(" ");
	const at = (name: string) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
	const cwd = at("--cwd");
	if (!command || !cwd) {
		console.error("usage: bun hub/receipts.ts --cwd <dir> [--env A,B] -- <command>");
		process.exit(2);
	}
	const r = await runWithReceipt({ command, cwd, env: at("--env")?.split(",").filter(Boolean) });
	console.log(summarize(r));
	process.exit(r.exitCode);
}
