import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const SHIPPED_FROM = "SHIPPED_FROM";
const SHIPPED_FILES = "SHIPPED_FILES";
const INSTALLING = "INSTALLING";
const PAYLOAD_DIR = "coding-harness";
const SETUP_VERSION = join("harness", ".setup-version");
const DEPS_STAMP = join("harness", ".deps-stamp");
const DEPS_FILES = [join("harness", "package.json"), join("harness", "bun.lock")];
const INSTALL_TIMEOUT_MS = 120_000;
const TAIL_CHARS = 400;

type Ran = { code: number; out: string };

/** Runs `bun install --frozen-lockfile` (or a stand-in) in `cwd`; `signal` aborts when the install outlasts its bound. */
export type RunInstall = (cwd: string, signal: AbortSignal) => Promise<Ran>;

export type CodingInstall = {
	/** The pinned payload that ships inside the dotz code (`vendor/coding-harness/`). */
	vendored: string;
	/** The folder dotz owns for it: `<data dir>/coding-harness`. */
	dest: string;
	runInstall?: RunInstall;
	/** How long `bun install` may run before it is stopped and counted as failed (default 120 s). */
	installTimeoutMs?: number;
};

const bunInstall: RunInstall = async (cwd, signal) => {
	const p = Bun.spawn([Bun.which("bun") ?? process.execPath, "install", "--frozen-lockfile"], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", signal });
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	return { code: await p.exited, out: `${out}\n${err}`.trim() };
};

async function runBounded(run: RunInstall, cwd: string, ms: number): Promise<Ran> {
	const stop = new AbortController();
	const { promise: expired, resolve } = Promise.withResolvers<Ran>();
	const timer = setTimeout(() => {
		stop.abort();
		resolve({ code: 124, out: `no result after ${ms / 1000} s, stopped` });
	}, ms);
	const ran = Promise.resolve()
		.then(() => run(cwd, stop.signal))
		.catch((e: unknown): Ran => ({ code: 1, out: String(e) }));
	try {
		return await Promise.race([ran, expired]);
	} finally {
		clearTimeout(timer);
	}
}

const readText = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8").trim() : undefined);

function listFiles(root: string, dir = ""): string[] {
	const out: string[] = [];
	for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
		const rel = join(dir, e.name);
		if (e.isDirectory()) out.push(...listFiles(root, rel));
		else if (e.isFile()) out.push(rel);
	}
	return out.sort();
}

function sameBytes(a: string, b: string): boolean {
	const st = lstatSync(b, { throwIfNoEntry: false });
	return Boolean(st?.isFile()) && statSync(a).size === st?.size && readFileSync(a).equals(readFileSync(b));
}

function writeFileAtomic(path: string, data: string | Uint8Array, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID().slice(0, 8)}.dotz-tmp`;
	try {
		writeFileSync(tmp, data);
		chmodSync(tmp, mode);
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}

function inside(dest: string, rel: string): string | undefined {
	if (!rel || isAbsolute(rel)) return undefined;
	const r = relative(dest, join(dest, rel));
	return r === "" || r === ".." || r.startsWith(`..${sep}`) ? undefined : r;
}

function linkAbove(dest: string, rel: string): string | undefined {
	let at = dest;
	for (const part of dirname(rel).split(sep)) {
		if (part === ".") return undefined;
		at = join(at, part);
		const st = lstatSync(at, { throwIfNoEntry: false });
		if (!st) return undefined;
		if (st.isSymbolicLink()) return at;
	}
	return undefined;
}

function dropFile(dest: string, rel: string): void {
	const r = inside(dest, rel);
	if (!r || linkAbove(dest, r)) return;
	const path = join(dest, r);
	const st = lstatSync(path, { throwIfNoEntry: false });
	if (st && !st.isDirectory()) rmSync(path);
	for (let dir = dirname(path); dir !== dest && dir.startsWith(dest + sep); dir = dirname(dir)) {
		const d = lstatSync(dir, { throwIfNoEntry: false });
		if (!d) continue;
		if (!d.isDirectory() || readdirSync(dir).length > 0) return;
		rmdirSync(dir);
	}
}

function copyFile(vendored: string, dest: string, rel: string): void {
	const link = linkAbove(dest, rel);
	if (link) throw new Error(`${link} is a symlink; a shipped file is never written through one`);
	const from = join(vendored, rel);
	const to = join(dest, rel);
	if (!sameBytes(from, to)) writeFileAtomic(to, readFileSync(from), statSync(from).mode & 0o777);
}

function copyPayload(vendored: string, dest: string, wanted: string): number {
	const files = listFiles(vendored).filter(f => f !== SHIPPED_FROM);
	const manifest = join(dest, SHIPPED_FILES);
	const previous = (readText(manifest) ?? "").split("\n").filter(Boolean);
	const kept = new Set(files);
	writeFileAtomic(manifest, `${[...new Set([...previous, ...files])].join("\n")}\n`, 0o644);
	for (const f of previous) if (!kept.has(f)) dropFile(dest, f);
	for (const f of files) copyFile(vendored, dest, f);
	writeFileAtomic(manifest, `${files.join("\n")}\n`, 0o644);
	writeFileAtomic(join(dest, SETUP_VERSION), `${wanted}\n`, 0o644);
	writeFileAtomic(join(dest, SHIPPED_FROM), `${wanted}\n`, 0o644);
	return files.length;
}

function depsHash(root: string): string {
	const h = createHash("sha256");
	for (const f of DEPS_FILES) h.update(f).update(existsSync(join(root, f)) ? readFileSync(join(root, f)) : "");
	return h.digest("hex");
}

function depsStale(dest: string): boolean {
	const harness = join(dest, "harness");
	return existsSync(join(harness, "package.json")) && (!existsSync(join(harness, "node_modules")) || readText(join(dest, DEPS_STAMP)) !== depsHash(dest));
}

/**
 * Makes `dest` hold the vendored payload and returns what to log. Idempotent: with SHIPPED_FROM and `harness/.setup-version` equal to the vendored
 * commit, no INSTALLING marker and the dependencies in place it changes nothing. Any other state starts with the INSTALLING marker and ends by removing
 * it, so `codingHarnessDir` is undefined while the install runs and after any step failed, until a later call succeeds.
 * Files: SHIPPED_FILES first lists every path the old and the new tree name; the files the old install listed and the new tree dropped are deleted
 * (one already gone is fine, one reached through a symlink is skipped), then the new tree's files are replaced (a path through a symlink refuses the
 * install, a file or folder that is not in SHIPPED_FILES and is in the way fails it); then SHIPPED_FILES holds the new list only and
 * `harness/.setup-version` and SHIPPED_FROM name the commit. Everything else under `dest` (gate-state, orchestrator-state, harness/logs: the harness's
 * own state) is left alone. `bun install --frozen-lockfile` runs in `<dest>/harness` when its package.json or bun.lock changed or node_modules is
 * missing, and is stopped after `installTimeoutMs`; a failed or stopped one counts as a failed install.
 */
export async function installCodingHarness(o: CodingInstall): Promise<string[]> {
	const wanted = readText(join(o.vendored, SHIPPED_FROM));
	if (!wanted) return [`coding harness: ${o.vendored} has no ${SHIPPED_FROM}; nothing installed`];
	const { dest } = o;
	const harness = join(dest, "harness");
	const label = wanted.slice(0, 12);
	const files = existsSync(join(dest, INSTALLING)) || [SHIPPED_FROM, SETUP_VERSION].some(f => readText(join(dest, f)) !== wanted);
	if (!files && !depsStale(dest)) return [];
	const unusable = `${dest} stays unusable until an install succeeds (the next gateway start tries again)`;
	const lines: string[] = [];
	try {
		writeFileAtomic(join(dest, INSTALLING), `${wanted}\n`, 0o644);
		if (files) lines.push(`coding harness: installed ${label} (${copyPayload(o.vendored, dest, wanted)} files) in ${dest}`);
		if (depsStale(dest)) {
			const ran = await runBounded(o.runInstall ?? bunInstall, harness, o.installTimeoutMs ?? INSTALL_TIMEOUT_MS);
			if (ran.code !== 0) return [`coding harness: bun install failed in ${harness} (exit ${ran.code}): ${ran.out.slice(-TAIL_CHARS)}; ${unusable}`];
			writeFileAtomic(join(dest, DEPS_STAMP), depsHash(dest), 0o644);
			lines.push(`coding harness: dependencies installed in ${harness}`);
		}
		rmSync(join(dest, INSTALLING));
	} catch (e) {
		return [`coding harness: installing ${label} failed (${e instanceof Error ? e.message : String(e)}); ${unusable}`];
	}
	return lines;
}

/**
 * Installs the payload vendored in this dotz copy into `<dataDir>/coding-harness`. The gateway awaits it before it starts the orchestrator and restores
 * lanes (hub/main.ts), because both read the folder when they spawn; it is bounded, and a failed install leaves the folder unusable instead of throwing.
 */
export const ensureCodingHarness = (dataDir: string, runInstall?: RunInstall): Promise<string[]> =>
	installCodingHarness({ vendored: join(import.meta.dir, "..", "vendor", "coding-harness"), dest: join(dataDir, PAYLOAD_DIR), runInstall });

/** `<dataDir>/coding-harness` when a finished install is there; undefined before the first install, while one runs and after one failed (the folder then holds the INSTALLING marker, so it is half written and never loaded). */
export function codingHarnessDir(dataDir: string): string | undefined {
	const dir = join(dataDir, PAYLOAD_DIR);
	return existsSync(join(dir, SHIPPED_FROM)) && !existsSync(join(dir, INSTALLING)) ? dir : undefined;
}
