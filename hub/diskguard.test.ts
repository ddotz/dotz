import { afterEach, expect, test } from "bun:test";
import { cfg } from "./config.ts";
import { DISK_ALERT_EVERY_MS, DISK_CACHE_MS, DISK_RECOVERED_TEXT, type DiskFree, diskShort, diskTick, resetDiskGuard, setDiskReader } from "./diskguard.ts";

const GB = 2 ** 30;
const disk = (freeGb: number): DiskFree => ({ freeBytes: freeGb * GB, totalBytes: 1000 * GB });
const plenty = () => disk(500);
const savedLanes = cfg.lanes;
afterEach(() => {
	cfg.lanes = savedLanes;
	setDiskReader(plenty);
	resetDiskGuard();
});

test("one alert when the disk turns short, none again within 12 h, one more after, and one recovery note", () => {
	resetDiskGuard();
	let free = 4;
	setDiskReader(() => disk(free));
	const told: string[] = [];
	const t0 = 1_900_000_000_000;
	expect(diskTick(["/data"], t => told.push(t), t0)).toMatchObject({ path: "/data", minGb: 10 });
	expect(told).toHaveLength(1);
	expect(told[0]).toContain("디스크 여유 공간이 4.0GB밖에 남지 않았어요(/data, 기준 10GB)");
	for (let i = 1; i <= 10; i++) diskTick(["/data"], t => told.push(t), t0 + i * DISK_CACHE_MS);
	expect(diskTick(["/data"], t => told.push(t), t0 + DISK_ALERT_EVERY_MS - 1)).toBeDefined();
	expect(told).toHaveLength(1);
	diskTick(["/data"], t => told.push(t), t0 + DISK_ALERT_EVERY_MS);
	expect(told).toHaveLength(2);
	free = 50;
	expect(diskTick(["/data"], t => told.push(t), t0 + DISK_ALERT_EVERY_MS + DISK_CACHE_MS)).toBeUndefined();
	expect(told.at(-1)).toBe(DISK_RECOVERED_TEXT);
	diskTick(["/data"], t => told.push(t), t0 + DISK_ALERT_EVERY_MS + 2 * DISK_CACHE_MS);
	expect(told).toHaveLength(3);
});

test("the worst of the checked volumes counts, each is read at most once a minute, and 0 turns the guard off", () => {
	const reads: string[] = [];
	setDiskReader(p => {
		reads.push(p);
		return p === "/work" ? disk(2) : plenty();
	});
	const t0 = 1_900_000_000_000;
	expect(diskShort(["/data", "/work", "/data"], t0)).toMatchObject({ path: "/work" });
	expect(diskShort(["/data", "/work"], t0 + DISK_CACHE_MS - 1)).toMatchObject({ path: "/work" });
	expect(reads).toEqual(["/data", "/work"]);
	diskShort(["/data"], t0 + DISK_CACHE_MS);
	expect(reads).toEqual(["/data", "/work", "/data"]);
	cfg.lanes = { ...cfg.lanes, min_free_disk_gb: 0 };
	expect(diskShort(["/work"], t0 + 2 * DISK_CACHE_MS)).toBeUndefined();
});
