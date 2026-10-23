import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type KakaoDb, sqliteDb } from "./db.ts";
import { addMessage, BASE_LOG, BASE_TIME, makeFixtureDb, OWNER, ROOM } from "./fixture.ts";
import { createLive } from "./live.ts";
import { type KakaoConfig, kakaoPaths } from "./types.ts";

const id = (n: number) => String(BASE_LOG + BigInt(n));
const DIRECT = String(ROOM.direct);
const GROUP = String(ROOM.group);
const BODY = "secret-body-text";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kakao-live-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const drain = async () => {
	for (let i = 0; i < 100; i++) await Promise.resolve();
};

function setup(over: Partial<KakaoConfig> = {}) {
	const paths = kakaoPaths(dir, dir);
	const dbPath = join(dir, "k.sqlite");
	const w = makeFixtureDb(dbPath);
	const inner = sqliteDb(dbPath);
	let config: KakaoConfig | undefined = { enabled: true, dbPath, userId: OWNER, watch_chats: [DIRECT], ...over };
	const events: Record<string, unknown>[] = [];
	const stats = { queries: 0, active: 0, maxActive: 0, gate: undefined as Promise<void> | undefined };
	const db: KakaoDb = {
		async query(sql, params) {
			stats.queries++;
			stats.active++;
			stats.maxActive = Math.max(stats.maxActive, stats.active);
			try {
				if (stats.gate) await stats.gate;
				return await inner.query(sql, params);
			} finally {
				stats.active--;
			}
		},
	};
	const watchers: { dir: string; cb: (name: string | null) => void; closed: boolean }[] = [];
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let handle = 0;
	const sub = { n: 1 };
	const live = createLive({
		paths,
		readConfig: () => config,
		openDb: async () => db,
		subscribers: () => sub.n,
		broadcast: e => events.push(e),
		watchDir: (d, cb) => {
			const entry = { dir: d, cb, closed: false };
			watchers.push(entry);
			return { close: () => void (entry.closed = true) };
		},
		timers: { set: (fn, ms) => (timers.set(++handle, { fn, ms }), handle), clear: h => void timers.delete(h as number) },
	});
	return {
		paths,
		dbPath,
		live,
		events,
		stats,
		sub,
		watchers,
		timers,
		setConfig: (c: KakaoConfig | undefined) => void (config = c),
		add: (n: number, chat: number, author = 2001) => addMessage(w, { logId: BASE_LOG + BigInt(n), chatId: chat, authorId: author, message: BODY, sentAt: BASE_TIME + n * 10 }),
		fire: async () => {
			const due = [...timers.values()];
			timers.clear();
			for (const t of due) t.fn();
			await drain();
		},
		open: () => watchers.filter(x => !x.closed),
	};
}

describe("live watcher", () => {
	test("idle: watching the database folder and drafts folder costs no timer and no query beyond the baseline", async () => {
		const t = setup();
		await t.live.sync();
		expect(t.open().map(x => x.dir)).toEqual([dir, join(dir, "kakao")]);
		expect(t.timers.size).toBe(0);
		expect(t.stats.queries).toBe(1);
		t.live.stop();
		expect(t.open()).toEqual([]);
	});

	test("a new message in a watched room is announced once, ids only, after the debounce; other rooms and files are ignored", async () => {
		const t = setup({ watch_chats: [DIRECT] });
		await t.live.sync();
		const dbWatch = t.watchers[0]!;
		t.add(9, ROOM.direct);
		t.add(10, ROOM.direct);
		t.add(11, ROOM.group, 2002);
		dbWatch.cb("unrelated.txt");
		expect(t.timers.size).toBe(0);
		dbWatch.cb(basename(t.dbPath));
		dbWatch.cb(`${basename(t.dbPath)}-wal`);
		expect([...t.timers.values()].map(x => x.ms)).toEqual([250]);
		await t.fire();
		expect(t.events).toEqual([{ kind: "kakao", chatId: DIRECT, logId: id(10) }]);
		expect(JSON.stringify(t.events)).not.toContain(BODY);

		t.add(12, ROOM.direct);
		await t.live.poll();
		expect(t.events.at(-1)).toEqual({ kind: "kakao", chatId: DIRECT, logId: id(12) });
		const count = t.events.length;
		await t.live.poll();
		expect(t.events).toHaveLength(count);
	});

	test("with no page connected nothing is queried, and the next query catches up from the same baseline", async () => {
		const t = setup();
		await t.live.sync();
		const baseline = t.stats.queries;
		t.sub.n = 0;
		t.add(9, ROOM.direct);
		await t.live.poll();
		expect(t.stats.queries).toBe(baseline);
		expect(t.events).toEqual([]);
		t.add(10, ROOM.direct);
		t.sub.n = 1;
		await t.live.poll();
		expect(t.events).toEqual([{ kind: "kakao", chatId: DIRECT, logId: id(10) }]);
	});

	test("at most one query is in flight; a trigger during a query runs one more pass", async () => {
		const t = setup();
		await t.live.sync();
		let release!: () => void;
		t.stats.gate = new Promise<void>(resolve => (release = resolve));
		t.add(9, ROOM.direct);
		const first = t.live.poll();
		await drain();
		t.add(10, ROOM.direct);
		await t.live.poll();
		expect(t.stats.maxActive).toBe(1);
		const during = t.stats.queries;
		t.stats.gate = undefined;
		release();
		await first;
		expect(t.stats.maxActive).toBe(1);
		expect(t.stats.queries).toBeGreaterThan(during - 1);
		expect(t.events.at(-1)).toEqual({ kind: "kakao", chatId: DIRECT, logId: id(10) });
	});

	test("a config change restarts the watchers and re-baselines; disabling or an empty list stops everything", async () => {
		const t = setup();
		await t.live.sync();
		const first = t.open();
		t.add(9, ROOM.group, 2002);
		t.setConfig({ enabled: true, dbPath: t.dbPath, userId: OWNER, watch_chats: [DIRECT, GROUP] });
		await t.live.sync();
		expect(first.every(x => x.closed)).toBe(true);
		expect(t.open()).toHaveLength(2);
		await t.live.poll();
		expect(t.events).toEqual([]);
		t.add(10, ROOM.group, 2002);
		await t.live.poll();
		expect(t.events).toEqual([{ kind: "kakao", chatId: GROUP, logId: id(10) }]);

		const unchanged = t.open();
		await t.live.sync();
		expect(t.open()).toEqual(unchanged);

		t.setConfig({ enabled: true, dbPath: t.dbPath, userId: OWNER, watch_chats: [] });
		await t.live.sync();
		expect(t.open()).toEqual([]);
		t.setConfig({ enabled: false, dbPath: t.dbPath, userId: OWNER, watch_chats: [DIRECT] });
		await t.live.sync();
		expect(t.open()).toEqual([]);
		const before = t.stats.queries;
		t.add(11, ROOM.direct);
		await t.live.poll();
		expect(t.stats.queries).toBe(before);
	});

	test("drafts.json changes announce kakao_draft for the watched room whose drafts changed", async () => {
		const t = setup();
		const draft = (code: string, chatId: string, status = "pending") => ({ code, chatId, status });
		mkdirSync(join(dir, "kakao"), { recursive: true });
		writeFileSync(t.paths.drafts, JSON.stringify([draft("KAAAA", DIRECT)]));
		await t.live.sync();
		const draftWatch = t.watchers[1]!;
		draftWatch.cb("sends.json");
		expect(t.timers.size).toBe(0);
		writeFileSync(t.paths.drafts, JSON.stringify([draft("KAAAA", DIRECT, "sent"), draft("KBBBB", GROUP)]));
		draftWatch.cb(basename(t.paths.drafts));
		expect([...t.timers.values()].map(x => x.ms)).toEqual([250]);
		await t.fire();
		expect(t.events).toEqual([{ kind: "kakao_draft", chatId: DIRECT }]);
		t.live.pollDrafts();
		expect(t.events).toHaveLength(1);
	});
});
