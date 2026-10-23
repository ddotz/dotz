// Snapshots of the files a sent message points at ([file] lines): a /tmp shot or a lane's output may be gone tomorrow, the chip must
// still open. Each file is copied once into <data dir>/files/<sha256 prefix>/<name> (content-addressed, so the same bytes are
// stored once) and files/index.jsonl remembers original path -> copy. Copying runs in the background, one file at a time, off the send path;
// the file route (files.ts resolveAllowed) prefers the copy and falls back to the original while the copy is not there yet.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { cfg, DATA_DIR, log } from "./config.ts";

export const FILES = join(DATA_DIR, "files");
const INDEX = join(FILES, "index.jsonl");
export const SNAP_MAX_BYTES = Math.max(1, Number((cfg as any).web?.snapshot_max_mb ?? 200)) * 1024 * 1024;
// Retention (see sweepSnapshots): a copy's last use is the mtime of its file, refreshed when it is served or sent again.
const DAY_MS = 86_400_000;
const KEEP_DAYS = () => Math.max(1, Number((cfg as any).web?.snapshot_keep_days ?? 30));
const TOTAL_BYTES = () => Math.max(1, Number((cfg as any).web?.snapshot_max_total_mb ?? 1024)) * 1024 * 1024;
const TOUCH_AFTER_MS = 3600_000; // the last use is only rewritten when older than this, so a page full of chips costs no writes
const touch = (path: string, now = Date.now()) => {
	try {
		if (now - statSync(path).mtimeMs > TOUCH_AFTER_MS) utimesSync(path, now / 1000, now / 1000);
	} catch {
		// the copy is gone or read-only: nothing to refresh
	}
};

type Entry = { p: string; sha?: string; name?: string; size: number; over?: boolean };
let index: Map<string, Entry> | undefined;
const entries = (): Map<string, Entry> => {
	if (index) return index;
	index = new Map();
	try {
		for (const line of readFileSync(INDEX, "utf8").split("\n")) {
			try {
				const e = JSON.parse(line) as Entry;
				if (e && typeof e.p === "string") index.set(e.p, e);
			} catch {
				continue;
			}
		}
	} catch {
		// no index yet
	}
	return index;
};

const copyPath = (e: Entry) => join(FILES, e.sha!.slice(0, 24), e.name!);

// The stored copy of `original` (as written in the [file] line, `~/` expanded), or what is known about why there is none.
export function snapshotFor(original: string): { path?: string; tooBig?: number } {
	const e = entries().get(original);
	if (!e) return {};
	if (e.over) return { tooBig: e.size };
	const path = copyPath(e);
	if (!existsSync(path)) return {};
	touch(path);
	return { path };
}

const fileName = (real: string): string => {
	const base = basename(real).replace(/[\0/\\]/g, "_") || "file";
	if (base.length <= 150) return base;
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot).slice(0, 16) : "";
	return base.slice(0, 150 - ext.length) + ext;
};

const seen = new Map<string, string>(); // original -> "mtime:size" of the last copy, so a repeated [file] line costs one stat
let chain: Promise<void> = Promise.resolve();

async function snapOne(original: string, real: string): Promise<void> {
	const st = statSync(real);
	const stamp = `${st.mtimeMs}:${st.size}`;
	if (seen.get(original) === stamp) return;
	let entry: Entry;
	if (st.size > SNAP_MAX_BYTES) entry = { p: original, size: st.size, over: true };
	else {
		const hash = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(real).stream()) hash.update(chunk);
		entry = { p: original, sha: hash.digest("hex"), name: fileName(real), size: st.size };
		const dest = copyPath(entry);
		if (existsSync(dest)) touch(dest);
		else {
			mkdirSync(join(FILES, entry.sha!.slice(0, 24)), { recursive: true });
			const tmp = `${dest}.${process.pid}.part`;
			try {
				await Bun.write(tmp, Bun.file(real));
				if (statSync(tmp).size !== st.size) throw new Error("the file changed while it was copied");
				renameSync(tmp, dest);
				storeBytes += st.size;
				if (storeBytes > TOTAL_BYTES()) void sweepSnapshots();
			} catch (error) {
				rmSync(tmp, { force: true });
				throw error;
			}
		}
	}
	const known = entries().get(original);
	if (!known || known.sha !== entry.sha || known.over !== entry.over || known.size !== entry.size) {
		mkdirSync(FILES, { recursive: true });
		appendFileSync(INDEX, `${JSON.stringify(entry)}\n`);
		entries().set(original, entry);
	}
	seen.set(original, stamp);
}

let storeBytes = 0; // size of files/ as of the last sweep plus what was written since; the sweep after a write runs only once this passes the cap
let sweeping: Promise<number> | undefined;
const COPY_DIR = /^[0-9a-f]{24}$/;

// Retention: one async scan of files/<sha>/ (index.jsonl and anything else in files/ is left alone). A copy not used for snapshot_keep_days
// goes; then, while the rest is over snapshot_max_total_mb, the least recently used goes first (the newest copy is kept even if it alone is over).
// Resolves to the number of copies removed. Only directories directly under files/ named like a copy are ever deleted.
export function sweepSnapshots(now = Date.now(), opts: { keepDays?: number; maxBytes?: number } = {}): Promise<number> {
	if (sweeping) return sweeping;
	const run = async (): Promise<number> => {
		const keepMs = (opts.keepDays ?? KEEP_DAYS()) * DAY_MS, cap = opts.maxBytes ?? TOTAL_BYTES();
		const copies: { dir: string; used: number; size: number }[] = [];
		for (const d of await readdir(FILES, { withFileTypes: true }).catch(() => [])) {
			if (!d.isDirectory() || !COPY_DIR.test(d.name)) continue; // a symlink is not isDirectory(), so it is skipped too
			const dir = join(FILES, d.name);
			let used = 0, size = 0;
			for (const f of await readdir(dir).catch(() => [])) {
				const st = await stat(join(dir, f)).catch(() => undefined);
				if (!st?.isFile()) continue;
				size += st.size;
				used = Math.max(used, st.mtimeMs);
			}
			copies.push({ dir, used, size });
		}
		copies.sort((a, b) => a.used - b.used);
		let total = copies.reduce((n, c) => n + c.size, 0), removed = 0, freed = 0;
		for (const [i, c] of copies.entries()) {
			const old = now - c.used > keepMs;
			if (!old && (total <= cap || i === copies.length - 1)) continue;
			rmSync(c.dir, { recursive: true, force: true });
			total -= c.size;
			freed += c.size;
			removed++;
		}
		storeBytes = total;
		if (removed) {
			seen.clear(); // a repeated [file] line may copy again now
			log(`file snapshots: removed ${removed} unused copy(ies), ${(freed / 1048576).toFixed(1)} MB; ${(total / 1048576).toFixed(1)} MB kept`);
		}
		return removed;
	};
	sweeping = run().catch(error => {
		log(`file snapshot sweep failed: ${(error as Error).message}`);
		return 0;
	}).finally(() => {
		sweeping = undefined;
	});
	return sweeping;
}

// Queues the copy of each path; `check` returns the real path of a file that may be kept (a regular file, not a secret), else undefined.
export function queueSnapshots(paths: string[], check: (path: string) => string | undefined): void {
	for (const original of new Set(paths)) {
		chain = chain.then(async () => {
			try {
				const real = check(original);
				if (real) await snapOne(original, real);
			} catch (error) {
				log(`file snapshot failed for ${original}: ${(error as Error).message}`);
			}
		});
	}
}

// Resolves when every queued copy is done (tests, shutdown).
export const snapshotsIdle = (): Promise<void> => chain;
