// OmO's file lock, as proper-lockfile writes it: the lock is the directory `<file>.lock`; one older than 30 s (mtime) is stale and
// taken over, and a caller waits at most 1 s (synchronously) before giving up. Used where dotz edits OmO's auth.json
// (omo-pin.ts, accounts-providers.ts). Only node:fs, so any layer can load it.
import { mkdirSync, rmdirSync, statSync } from "node:fs";

const LOCK_STALE_MS = 30_000;
const LOCK_BUDGET_MS = 1_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Takes the lock on `file` and returns the function that releases it.
export function lock(file: string): () => void {
	const dir = `${file}.lock`;
	const started = Date.now();
	for (let attempt = 0; ; attempt++) {
		try {
			mkdirSync(dir);
			return () => {
				try {
					rmdirSync(dir);
				} catch {}
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		try {
			if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
				rmdirSync(dir);
				continue;
			}
		} catch {
			continue; // released between the two calls
		}
		const waited = Date.now() - started;
		if (waited >= LOCK_BUDGET_MS) throw new Error(`OmO의 계정 파일이 ${waited}ms 동안 잠겨 있어요 (${dir})`);
		sleep(Math.min(100 * 2 ** attempt, 1000, LOCK_BUDGET_MS - waited));
	}
}
