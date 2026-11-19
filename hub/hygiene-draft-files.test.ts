import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { DRAFT_FILES } from "./draft-files.ts";
import { clock } from "./runtime/test-clock.ts";
import { pruneDraftFiles, runDataCleanup } from "./hygiene.ts";

const DAY = 86_400_000;
const STORE_DIR = join(DATA_DIR, "custom", "reply-drafts");
const STORE = join(STORE_DIR, "drafts.json");
const stagedRoot = () => DRAFT_FILES;

const folder = (id: string, ageDays: number): string => {
	const dir = join(stagedRoot(), id, "0");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "a.pdf"), "pdf");
	const at = new Date(clock.now - ageDays * DAY);
	for (const d of [dir, join(stagedRoot(), id)]) utimesSync(d, at, at);
	return join(stagedRoot(), id);
};
const writeStore = (drafts: { id: string; status: string; sentAt?: string }[]) => {
	mkdirSync(STORE_DIR, { recursive: true });
	writeFileSync(STORE, JSON.stringify({ drafts, keys: [] }));
};

const clean = () => {
	for (const p of [DRAFT_FILES, STORE]) rmSync(p, { force: true, recursive: true });
};
beforeEach(clean);
afterEach(clean);

describe("pruneDraftFiles", () => {
	const now = clock.now;
	test("a draft closed over 7 days ago loses its folder; a recent one and a pending or held one keep it", () => {
		const gone = [folder("RAAAAAA", 8), folder("RBBBBBB", 9), folder("RCCCCCC", 30)];
		const kept = [folder("RDDDDDD", 3), folder("REEEEEE", 40), folder("RFFFFFF", 40)];
		const drafts = [
			{ id: "RAAAAAA", status: "dropped" },
			{ id: "RBBBBBB", status: "stale" },
			{ id: "RCCCCCC", status: "answered" },
			{ id: "RDDDDDD", status: "sent" },
			{ id: "REEEEEE", status: "pending" },
			{ id: "RFFFFFF", status: "held" },
		];
		expect(pruneDraftFiles(stagedRoot(), drafts, 7, now)).toEqual(["RAAAAAA", "RBBBBBB", "RCCCCCC"]);
		expect(gone.map(existsSync)).toEqual([false, false, false]);
		expect(kept.map(existsSync)).toEqual([true, true, true]);
	});

	test("a sent draft is dated by its sentAt, not by the folder", () => {
		const old = folder("RAAAAAA", 0), fresh = folder("RBBBBBB", 0);
		const sentAt = (days: number) => new Date(now - days * DAY).toISOString();
		expect(pruneDraftFiles(stagedRoot(), [{ id: "RAAAAAA", status: "sent", sentAt: sentAt(8) }, { id: "RBBBBBB", status: "sent", sentAt: sentAt(6) }], 7, now)).toEqual(["RAAAAAA"]);
		expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
	});

	test("an id the store does not know loses its folder, unless it is only minutes old", () => {
		const orphan = folder("RAAAAAA", 2), fresh = folder("RBBBBBB", 0);
		expect(pruneDraftFiles(stagedRoot(), [], 7, now)).toEqual(["RAAAAAA"]);
		expect([existsSync(orphan), existsSync(fresh)]).toEqual([false, true]);
	});

	test("a draft dropped yesterday keeps the files it staged a month ago, so 되돌리기 brings them back", () => {
		const old = folder("RAAAAAA", 30);
		const closedAt = new Date(now - DAY).toISOString();
		expect(pruneDraftFiles(stagedRoot(), [{ id: "RAAAAAA", status: "dropped", closedAt }], 7, now)).toEqual([]);
		expect(existsSync(old)).toBe(true);
	});

	test("a name that is not a draft id is left alone", () => {
		const other = folder("notes-1", 90);
		expect(pruneDraftFiles(stagedRoot(), [], 7, now)).toEqual([]);
		expect(existsSync(other)).toBe(true);
	});
});

describe("runDataCleanup: the draft files step", () => {
	test("existing folders of closed and unknown drafts go in the same pass; pending and held stay", () => {
		writeStore([{ id: "RAAAAAA", status: "sent" }, { id: "RBBBBBB", status: "pending" }, { id: "RCCCCCC", status: "held" }]);
		const dirs = ["RAAAAAA", "RBBBBBB", "RCCCCCC", "RDDDDDD"].map(id => folder(id, 10));
		const actions = runDataCleanup(clock.now);
		expect(dirs.map(existsSync)).toEqual([false, true, true, false]);
		expect(actions.some(a => a.includes("draft file folder"))).toBe(true);
	});

	test("a store that cannot be read removes nothing", () => {
		mkdirSync(STORE_DIR, { recursive: true });
		writeFileSync(STORE, "{ not json");
		const dir = folder("RAAAAAA", 10);
		runDataCleanup(clock.now);
		expect(existsSync(dir)).toBe(true);
	});

	test("a store with no draft in it removes nothing", () => {
		writeStore([]);
		const dir = folder("RAAAAAA", 10);
		runDataCleanup(clock.now);
		expect(existsSync(dir)).toBe(true);
	});

	test("no store file at all removes nothing", () => {
		const dir = folder("RAAAAAA", 10);
		runDataCleanup(clock.now);
		expect(existsSync(dir)).toBe(true);
	});
});
