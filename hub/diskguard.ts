// Free disk space guard (dori host-guard.ts, proposal #3 of out/dori-superagent-review.md). Every lane adds a worktree (with
// node_modules when needed), session jsonl, receipts and attachments, and a full disk breaks session writes and git half-way.
// So a new lane waits while the data dir or its working volume has less than lanes.min_free_disk_gb (default 10, 0 = off) free,
// and the owner hears it once - again at most every 12 h while it stays short - and once more when the space is back.
// One statfs per volume per minute (no shell call), on the lane queue's timer (laneops.ts startLaneQueue).
import { readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, lanesMinFreeDiskGb, log, writeAtomic } from "./config.ts";

export type DiskFree = { freeBytes: number; totalBytes: number };
export type DiskReader = (path: string) => DiskFree | undefined;
export const DISK_CACHE_MS = 60_000;
export const DISK_ALERT_EVERY_MS = 12 * 3600_000;
const GB = 2 ** 30;

export function readDiskFree(path: string): DiskFree | undefined {
	try {
		const s = statfsSync(path);
		return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
	} catch {
		return undefined;
	}
}

let reader: DiskReader = readDiskFree;
const cache = new Map<string, { at: number; free?: DiskFree }>();
// Tests pin the reader (runtime/test-setup.ts) so a launch never depends on the disk of the box running them.
export function setDiskReader(fn: DiskReader | undefined): void {
	reader = fn ?? readDiskFree;
	cache.clear();
}

const freeOf = (path: string, at: number): DiskFree | undefined => {
	const hit = cache.get(path);
	if (hit && at - hit.at < DISK_CACHE_MS) return hit.free;
	const free = reader(path);
	cache.set(path, { at, free });
	return free;
};

export type DiskShort = { path: string; freeGb: number; minGb: number };
/** The checked volume with the least free space when it is under the threshold; undefined while all have room (or the guard is off). */
export function diskShort(paths: readonly string[], at = Date.now()): DiskShort | undefined {
	const minGb = lanesMinFreeDiskGb();
	if (minGb <= 0) return undefined;
	let worst: DiskShort | undefined;
	for (const path of new Set(paths)) {
		const free = freeOf(path, at);
		if (!free) continue;
		const freeGb = free.freeBytes / GB;
		if (freeGb < minGb && (!worst || freeGb < worst.freeGb)) worst = { path, freeGb, minGb };
	}
	return worst;
}

const gb = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.floor(n)));
export const diskWaitText = (s: DiskShort): string => `디스크 여유 공간이 부족해 대기 중(${gb(s.freeGb)}GB 남음, 기준 ${s.minGb}GB)`;
export const diskAlertText = (s: DiskShort): string =>
	`디스크 여유 공간이 ${gb(s.freeGb)}GB밖에 남지 않았어요(${s.path}, 기준 ${s.minGb}GB). 공간이 생길 때까지 새 세션은 시작하지 않고 기다려요. 안 쓰는 파일이나 끝난 세션의 작업 폴더를 정리해 주세요.`;
export const DISK_RECOVERED_TEXT = "디스크 여유 공간이 다시 충분해요. 기다리던 세션은 이제 차례로 시작해요.";

// When the owner was last told the disk is short (unset = not short as far as the owner knows). Kept on disk so a restart does
// not tell again; kept in memory too, since a write can fail on a full disk.
const stateFile = () => join(DATA_DIR, "disk-guard.json");
let alertedAt: number | undefined;
let loaded = false;
const loadState = () => {
	if (loaded) return;
	loaded = true;
	try {
		const v = JSON.parse(readFileSync(stateFile(), "utf8")).alertedAt;
		alertedAt = typeof v === "number" ? v : undefined;
	} catch {}
};
const saveState = () => {
	try {
		writeAtomic(stateFile(), `${JSON.stringify(alertedAt === undefined ? {} : { alertedAt })}\n`);
	} catch (e) {
		log(`disk guard state not saved: ${(e as Error).message}`);
	}
};
export function resetDiskGuard(): void {
	alertedAt = undefined;
	loaded = true;
	cache.clear();
	saveState();
}

/** One guard check: tells the owner when the disk turns short (again every 12 h while short) and once when it recovers. */
export function diskTick(paths: readonly string[], notify: (text: string) => void, at = Date.now()): DiskShort | undefined {
	loadState();
	const short = diskShort(paths, at);
	if (short && (alertedAt === undefined || at - alertedAt >= DISK_ALERT_EVERY_MS)) {
		log(`disk guard: ${short.path} has ${gb(short.freeGb)} GB free (< ${short.minGb} GB), new lanes wait`);
		alertedAt = at;
		saveState();
		notify(diskAlertText(short));
	} else if (!short && alertedAt !== undefined) {
		log("disk guard: free space is back");
		alertedAt = undefined;
		saveState();
		notify(DISK_RECOVERED_TEXT);
	}
	return short;
}

let notifier: (text: string) => void = () => {};
export function setDiskNotify(fn: (text: string) => void): void {
	notifier = fn;
}
export const diskGuardTick = (paths: readonly string[], at = Date.now()) => diskTick(paths, notifier, at);
