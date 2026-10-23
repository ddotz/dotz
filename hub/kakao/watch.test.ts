import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KakaoDb } from "./db.ts";
import { addMessage, BASE_LOG, BASE_TIME, makeFixtureDb, OWNER, ROOM } from "./fixture.ts";
import type { KakaoConfig } from "./types.ts";
import { runWatch } from "./watch.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kakao-watch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BODY = "secret-body-text";
const iso = (n: number) => new Date((BASE_TIME + n * 10) * 1000).toISOString();
const id = (n: number) => String(BASE_LOG + BigInt(n));

function setup(over: Partial<KakaoConfig> = {}) {
	const w = makeFixtureDb(join(dir, "k.sqlite"));
	const stateDir = join(dir, "state");
	const sigFile = join(dir, "sig-source");
	writeFileSync(sigFile, "a");
	let queries = 0;
	let clock = (BASE_TIME + 200) * 1000;
	const db: KakaoDb = {
		async query(sql, params = []) {
			queries++;
			return w.query(sql).all(...params) as Record<string, unknown>[];
		},
	};
	const config: KakaoConfig = { enabled: true, userId: OWNER, exclude_chats: [String(ROOM.excluded)], watch_chats: Object.values(ROOM).map(String), auto_draft_chats: Object.values(ROOM).map(String), ...over };
	return {
		w,
		stateDir,
		config,
		get queries() {
			return queries;
		},
		setNow: (ms: number) => {
			clock = ms;
		},
		touch: () => writeFileSync(sigFile, `${readFileSync(sigFile, "utf8")}x`),
		add: (n: number, chat: number, author: number, type = 1, sentAt = BASE_TIME + n * 10) => addMessage(w, { logId: BASE_LOG + BigInt(n), chatId: chat, authorId: author, message: BODY, type, sentAt }),
		run: (opts: { config?: KakaoConfig | undefined } = {}) =>
			runWatch({ db, config: "config" in opts ? opts.config : config, stateDir, now: () => clock, dbFiles: [sigFile] }),
		state: (name: string) => readFileSync(join(stateDir, name), "utf8"),
	};
}

describe("runWatch", () => {
	test("off: a missing config or enabled false reports DOTZ_FAIL off and never touches the db", async () => {
		const t = setup();
		for (const config of [undefined, { enabled: false }]) {
			const out = await t.run({ config });
			expect(out.code).toBe(1);
			expect(out.lines[0]).toBe("DOTZ_FAIL off");
			expect(out.lines).toHaveLength(2);
		}
		expect(t.queries).toBe(0);
	});

	test("the first run records a silent baseline", async () => {
		const t = setup();
		expect(await t.run()).toEqual({ lines: [], code: 0 });
		expect(t.state("last-id")).toBe(id(8));
	});

	test("batches per room and drops own, non-text, self, excluded and channel rows; output has no bodies or names", async () => {
		const t = setup();
		await t.run();
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.direct, 2001);
		t.add(11, ROOM.direct, OWNER);
		t.add(12, ROOM.direct, 2001, 2);
		t.add(13, ROOM.group, 2002);
		t.add(14, ROOM.self, 2002);
		t.add(15, ROOM.excluded, 2002);
		t.add(16, ROOM.channel, 2002);
		t.touch();
		const out = await t.run();
		expect(out).toEqual({
			lines: [`kakao chat=${ROOM.direct} new=2 from=${id(9)} to=${id(10)} at=${iso(10)}`, `kakao chat=${ROOM.group} new=1 from=${id(13)} to=${id(13)} at=${iso(13)}`],
			code: 0,
		});
		const text = out.lines.join("\n");
		for (const leaked of [BODY, "Alex", "Study Group", "Sam"]) expect(text).not.toContain(leaked);
		expect(t.state("last-id")).toBe(id(16));
		expect(await t.run()).toEqual({ lines: [], code: 0 });
	});

	test("an unchanged signature costs zero queries; a changed one reads again", async () => {
		const t = setup();
		await t.run();
		const before = t.queries;
		expect(await t.run()).toEqual({ lines: [], code: 0 });
		expect(t.queries).toBe(before);
		t.add(9, ROOM.group, 2002);
		t.touch();
		expect((await t.run()).lines).toHaveLength(1);
		expect(t.queries).toBeGreaterThan(before);
	});

	test("without an owner id in the config the db's own id is used", async () => {
		const t = setup({ userId: undefined });
		await t.run();
		t.add(9, ROOM.direct, OWNER);
		t.add(10, ROOM.direct, 2001);
		t.touch();
		expect((await t.run()).lines).toEqual([`kakao chat=${ROOM.direct} new=1 from=${id(10)} to=${id(10)} at=${iso(10)}`]);
	});

	test("settle: a fresh room is held one run, reported on the next, and never held twice", async () => {
		const t = setup({ settle_seconds: 20 });
		await t.run();
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.group, 2002);
		t.touch();
		t.setNow((BASE_TIME + 105) * 1000);
		const first = await t.run();
		expect(first.lines).toEqual([]);
		expect(JSON.parse(t.state("held.json"))).toEqual({ [ROOM.direct]: id(9), [ROOM.group]: id(10) });
		expect(t.state("last-id")).toBe(id(10));
		// no database change, no new signature: the held rooms still get their second look
		const second = await t.run();
		expect(second.lines).toEqual([
			`kakao chat=${ROOM.direct} new=1 from=${id(9)} to=${id(9)} at=${iso(9)}`,
			`kakao chat=${ROOM.group} new=1 from=${id(10)} to=${id(10)} at=${iso(10)}`,
		]);
		expect(JSON.parse(t.state("held.json"))).toEqual({});
		expect(await t.run()).toEqual({ lines: [], code: 0 });
	});

	test("settle: a settled room is not held while a fresh one waits, and the held batch grows with later messages", async () => {
		const t = setup({ settle_seconds: 20 });
		await t.run();
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.group, 2002);
		t.touch();
		t.setNow((BASE_TIME + 115) * 1000);
		const first = await t.run();
		expect(first.lines).toEqual([`kakao chat=${ROOM.direct} new=1 from=${id(9)} to=${id(9)} at=${iso(9)}`]);
		expect(JSON.parse(t.state("held.json"))).toEqual({ [ROOM.group]: id(10) });
		t.add(11, ROOM.group, 2002);
		t.touch();
		expect((await t.run()).lines).toEqual([`kakao chat=${ROOM.group} new=2 from=${id(10)} to=${id(11)} at=${iso(11)}`]);
	});

	test("max_per_run: the rest wait for the next run and nothing is lost", async () => {
		const chosen = [...Object.values(ROOM).map(String), "106", "107"];
		const t = setup({ max_per_run: 2, watch_chats: chosen, auto_draft_chats: chosen });
		t.w.query("INSERT INTO NTChatRoom (chatId, type, chatName, activeMembersCount, countOfNewMessage, lastUpdatedAt, directChatMemberUserId) VALUES (106, 1, 'Extra Group', 3, 0, 0, NULL)").run();
		t.w.query("INSERT INTO NTChatRoom (chatId, type, chatName, activeMembersCount, countOfNewMessage, lastUpdatedAt, directChatMemberUserId) VALUES (107, 1, 'More Group', 3, 0, 0, NULL)").run();
		await t.run();
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.group, 2002);
		t.add(11, 106, 2002);
		t.add(12, 107, 2002);
		t.touch();
		const first = await t.run();
		expect(first.lines).toHaveLength(2);
		const second = await t.run();
		expect(second.lines).toHaveLength(2);
		expect(await t.run()).toEqual({ lines: [], code: 0 });
		const chats = [...first.lines, ...second.lines].map((l) => /chat=(\d+)/.exec(l)?.[1]);
		expect(chats.sort()).toEqual([String(ROOM.direct), String(ROOM.group), "106", "107"].sort());
	});

	test("a restart from the state files alone misses nothing", async () => {
		const t = setup({ max_per_run: 1 });
		await t.run();
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.group, 2002);
		t.touch();
		const first = await t.run();
		expect(first.lines).toEqual([`kakao chat=${ROOM.direct} new=1 from=${id(9)} to=${id(9)} at=${iso(9)}`]);
		const db: KakaoDb = { query: async (sql, params = []) => t.w.query(sql).all(...params) as Record<string, unknown>[] };
		const rerun = await runWatch({ db, config: t.config, stateDir: t.stateDir, now: () => (BASE_TIME + 200) * 1000, dbFiles: [join(dir, "sig-source")] });
		expect(rerun.lines).toEqual([`kakao chat=${ROOM.group} new=1 from=${id(10)} to=${id(10)} at=${iso(10)}`]);
	});

	test("a backlog larger than one fetch is read over several runs without gaps or repeats", async () => {
		const t = setup();
		await t.run();
		t.w.exec("BEGIN");
		for (let n = 9; n < 9 + 620; n++) t.add(n, ROOM.direct, 2001, 1, BASE_TIME + 100);
		t.w.exec("COMMIT");
		t.touch();
		const first = await t.run();
		const second = await t.run();
		const parse = (l: string | undefined) => /new=(\d+) from=(\d+) to=(\d+)/.exec(l ?? "")?.slice(1).map(String);
		expect(parse(first.lines[0])).toEqual(["500", id(9), id(508)]);
		expect(parse(second.lines[0])).toEqual(["120", id(509), id(628)]);
		expect(await t.run()).toEqual({ lines: [], code: 0 });
	});
});

describe("auto_draft_chats: only rooms with 자동 초안 wake the bot", () => {
	test("a watched room without auto draft stays silent; a watched room with it wakes", async () => {
		const t = setup({ auto_draft_chats: [String(ROOM.group)] });
		await t.run();
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.group, 2002);
		t.touch();
		expect((await t.run()).lines).toEqual([`kakao chat=${ROOM.group} new=1 from=${id(10)} to=${id(10)} at=${iso(10)}`]);
		expect(t.state("last-id")).toBe(id(10));
	});

	test("an auto draft room that is not watched is ignored", async () => {
		const t = setup({ watch_chats: [String(ROOM.direct)], auto_draft_chats: [String(ROOM.group)] });
		await t.run();
		const baseline = t.queries;
		t.add(10, ROOM.group, 2002);
		t.touch();
		expect(await t.run()).toEqual({ lines: [], code: 0 });
		expect(t.queries).toBe(baseline);
	});

	test.each([[[]], [undefined]] as const)("auto_draft_chats %p reads no database after the baseline, though rooms are watched", async (auto_draft_chats: string[] | undefined) => {
		const t = setup({ auto_draft_chats });
		await t.run();
		const baseline = t.queries;
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.group, 2002);
		t.touch();
		expect(await t.run()).toEqual({ lines: [], code: 0 });
		expect(t.queries).toBe(baseline);
		expect(t.state("last-id")).toBe(id(8));
	});

	test("messages older than 30 minutes are never reported, also when the room is switched on later", async () => {
		const t = setup({ auto_draft_chats: [] });
		await t.run();
		const now = BASE_TIME + 200;
		t.add(9, ROOM.direct, 2001, 1, now - 31 * 60);
		t.add(10, ROOM.direct, 2001, 1, now - 29 * 60);
		t.touch();
		const later = { ...t.config, auto_draft_chats: [String(ROOM.direct)] };
		const out = await t.run({ config: later });
		expect(out.lines).toEqual([`kakao chat=${ROOM.direct} new=1 from=${id(10)} to=${id(10)} at=${new Date((now - 29 * 60) * 1000).toISOString()}`]);
		t.add(11, ROOM.group, 2002, 1, now - 3 * 3600);
		t.touch();
		expect(await t.run({ config: { ...later, auto_draft_chats: [String(ROOM.direct), String(ROOM.group)] } })).toEqual({ lines: [], code: 0 });
		expect(t.state("last-id")).toBe(id(11));
	});
});

describe("watch_chats: only the rooms the owner chose", () => {
	test("a chosen room wakes, an unchosen one does not", async () => {
		const t = setup({ watch_chats: [String(ROOM.group)] });
		await t.run();
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.group, 2002);
		t.touch();
		const out = await t.run();
		expect(out.lines).toEqual([`kakao chat=${ROOM.group} new=1 from=${id(10)} to=${id(10)} at=${iso(10)}`]);
	});

	test.each([[[]], [undefined]] as const)("watch_chats %p watches nothing and reads no database after the baseline", async (watch_chats: string[] | undefined) => {
		const t = setup({ watch_chats });
		await t.run();
		const baseline = t.queries;
		t.add(9, ROOM.direct, 2001);
		t.add(10, ROOM.group, 2002);
		t.touch();
		expect(await t.run()).toEqual({ lines: [], code: 0 });
		expect(t.queries).toBe(baseline);
	});
});
