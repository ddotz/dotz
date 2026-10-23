// Snapshots of the files a sent message points at ([file] lines): a /tmp shot or a lane's output may be gone tomorrow, the chip must
// still open. Each file is copied once into <data dir>/files/<sha256 prefix>/<name> (content-addressed, so the same bytes are
// stored once) and files/index.jsonl remembers original path -> copy. Copying runs in the background, one file at a time, off the send path;
// the file route (files.ts resolveAllowed) prefers the copy and falls back to the original while the copy is not there yet.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { cfg, DATA_DIR, log } from "./config.ts";

export const FILES = join(DATA_DIR, "files");
const INDEX = join(FILES, "index.jsonl");
export const SNAP_MAX_BYTES = Math.max(1, Number((cfg as any).web?.snapshot_max_mb ?? 200)) * 1024 * 1024;

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
	return existsSync(path) ? { path } : {};
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
		if (!existsSync(dest)) {
			mkdirSync(join(FILES, entry.sha!.slice(0, 24)), { recursive: true });
			const tmp = `${dest}.${process.pid}.part`;
			try {
				await Bun.write(tmp, Bun.file(real));
				if (statSync(tmp).size !== st.size) throw new Error("the file changed while it was copied");
				renameSync(tmp, dest);
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
