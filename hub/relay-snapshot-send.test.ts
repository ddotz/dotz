import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSelfChat, type SelfChatConfig } from "./jandi-selfchat.ts";
import { buildSnapshot, createSnapshotSender, HEARTBEAT_MS, MIN_GAP_MS, type SnapshotSources, snapshotFileStore } from "./relay-snapshot-send.ts";
import { decodeSnapshot, encodeSnapshot, MAX_SNAPSHOT_CHARS, normalizeSnapshot, SNAPSHOT_MARK, type Snapshot, snapshotChanged } from "./relay-snapshot.ts";

const TOKEN = `sk-${"a1B2c3D4".repeat(4)}`;
const HOME = homedir();
const HOME_PATH = join(HOME, "work", "main.ts");
const FORBIDDEN_KEYS = ["cwd", "path", "url", "repo", "sessionFile", "channel", "watch", "schedule", "project_title", "scope"];

const sources = (over: Partial<SnapshotSources> = {}): SnapshotSources => ({
	projects: [{ key: "ch:1", name: "결제", note: "payments", live: 2 }],
	sessions: [
		{ name: "s-one", title: "fix login", cwd: HOME_PATH, repo: join(HOME, "repo"), sessionFile: join(HOME, "one-session"), status: "running", live: true, waiting: true, lastReportAt: "2026-01-01T00:00:00Z", startedAt: "2025-12-31T00:00:00Z", channel: "ch:99" },
		{ name: "s-two", status: "done", live: false, startedAt: "2025-12-30T00:00:00Z" },
	],
	monitors: [
		{ name: "site", watch: "site-1", kind: "watch", channel: "ch:5", last_result: "ok", connection: "connected", last_run: "2026-01-01T00:00:00Z", next_run: "2026-01-01T01:00:00Z", last_summary: "see https://example.test/a?token=abc", project: "ch:5", project_title: "p", scope: "project" },
	],
	todos: { open: 3, items: ["write tests"] },
	notices: [{ updated: "2026-01-01T00:00:00Z", tone: "fail", title: `build failed in ${HOME_PATH} with ${TOKEN}` }],
	...over,
});

const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);

describe("buildSnapshot", () => {
	test("copies no path, address or channel field, and a token or home path in a title is masked once encoded", () => {
		const snap = buildSnapshot(sources(), 1000);
		expect(snap).toMatchObject({ v: 1, at: 1000, todos: { open: 3, items: ["write tests"] } });
		expect(snap.projects).toEqual([{ key: "ch:1", name: "결제", note: "payments", live: 2 }]);
		expect(snap.sessions.map(s => s.name)).toEqual(["s-one", "s-two"]);
		expect(snap.sessions[0]).toMatchObject({ live: true, waiting: true, at: "2026-01-01T00:00:00Z" });
		expect(snap.sessions[1]!.at).toBe("2025-12-30T00:00:00Z");
		expect(snap.monitors[0]).toMatchObject({ name: "site", result: "ok", conn: "connected", last: "2026-01-01T00:00:00Z", next: "2026-01-01T01:00:00Z" });
		const found = keysOf(snap).filter(k => FORBIDDEN_KEYS.includes(k));
		expect(found).toEqual([]);
		expect(JSON.stringify(snap)).not.toContain("https://");
		expect(JSON.stringify(snap)).not.toContain("ch:5");

		const text = encodeSnapshot("[b]", snap)!;
		expect(text.startsWith(`[b] ${SNAPSHOT_MARK} `)).toBe(true);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(HOME);
		expect(decodeSnapshot(text.slice("[b] ".length))!.notices[0]!.title).toContain("build failed");
	});

	test("a live session is listed before an ended one", () => {
		const snap = buildSnapshot(sources({ sessions: [{ name: "old", status: "done", live: false }, { name: "now", status: "running", live: true }] }), 1);
		expect(snap.sessions.map(s => s.name)).toEqual(["now", "old"]);
	});

	test("60 projects and 60 monitors still encode within the limit, marked cut", () => {
		const long = "x".repeat(300);
		const big = sources({
			projects: Array.from({ length: 60 }, (_, i) => ({ key: `ch:${i}-${long}`, name: `project ${i} ${long}`, note: long, live: 1 })),
			monitors: Array.from({ length: 60 }, (_, i) => ({ name: `monitor ${i} ${long}`, kind: "watch" as const, last_result: "ok" as const, last_summary: long, last_run: "2026-01-01T00:00:00Z", next_run: "2026-01-01T01:00:00Z" })),
		});
		const snap = buildSnapshot(big, 1);
		const whole = `${SNAPSHOT_MARK} ${JSON.stringify(normalizeSnapshot(snap))}`;
		expect(whole.length).toBeGreaterThan(MAX_SNAPSHOT_CHARS);
		const text = encodeSnapshot("[b]", snap)!;
		expect(text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS);
		expect(decodeSnapshot(text.slice("[b] ".length))!.cut).toBe(true);
	});
});

describe("share_status in the self chat config", () => {
	test("only true turns it on", () => {
		const base = { enabled: true, team_id: 1, room_id: 2, member_id: 3, bot_id: 4 };
		expect(normalizeSelfChat({ ...base, share_status: true })).toMatchObject({ share_status: true });
		for (const v of [false, "true", 1, null, undefined, {}]) expect(normalizeSelfChat({ ...base, share_status: v })).not.toHaveProperty("share_status");
		expect(normalizeSelfChat(base)).not.toHaveProperty("share_status");
	});
});

describe("createSnapshotSender", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "snap-send-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const cfg = (over: Partial<SelfChatConfig> = {}): SelfChatConfig =>
		normalizeSelfChat({ enabled: true, team_id: 1, room_id: 2, member_id: 3, bot_id: 4, reply_prefix: "[b]", share_status: true, ...over })!;

	function rig(config: () => SelfChatConfig | undefined = () => cfg()) {
		const state = { now: 1_000_000, src: sources(), fail: false, posts: [] as string[], logs: [] as string[] };
		const store = snapshotFileStore(join(dir, "snapshot.json"));
		const make = () =>
			createSnapshotSender({
				config,
				build: () => buildSnapshot(state.src, state.now),
				post: async text => {
					if (state.fail) throw new Error("HTTP 500");
					state.posts.push(text);
				},
				now: () => state.now,
				store,
				log: m => state.logs.push(m),
			});
		return { state, store, make, sender: make() };
	}
	const changed = (state: { src: SnapshotSources }) => void (state.src = sources({ todos: { open: state.src.todos.open + 1, items: [] } }));

	test("posts the first time, then not while unchanged, and not within 30 minutes even when changed", async () => {
		const { state, sender } = rig();
		await sender.tick();
		expect(state.posts).toHaveLength(1);
		expect(state.posts[0]!.startsWith(`[b] ${SNAPSHOT_MARK} `)).toBe(true);
		state.now += 60_000;
		await sender.tick();
		expect(state.posts).toHaveLength(1);
		changed(state);
		state.now += MIN_GAP_MS - 120_000;
		await sender.tick();
		expect(state.posts).toHaveLength(1);
	});

	test("posts again after 30 minutes when changed, not when unchanged", async () => {
		const { state, sender } = rig();
		await sender.tick();
		state.now += MIN_GAP_MS + 1;
		await sender.tick();
		expect(state.posts).toHaveLength(1);
		changed(state);
		await sender.tick();
		expect(state.posts).toHaveLength(2);
	});

	test("posts after 6 hours even when unchanged", async () => {
		const { state, sender } = rig();
		await sender.tick();
		state.now += HEARTBEAT_MS - 1;
		await sender.tick();
		expect(state.posts).toHaveLength(1);
		state.now += 1;
		await sender.tick();
		expect(state.posts).toHaveLength(2);
	});

	test("a restart does not repost an unchanged snapshot", async () => {
		const { state, make, sender } = rig();
		await sender.tick();
		state.now += MIN_GAP_MS + 1;
		await make().tick();
		expect(state.posts).toHaveLength(1);
	});

	test("posts nothing when the switch is off, the prefix is empty, or the chat is not ready", async () => {
		for (const c of [cfg({ share_status: undefined }), cfg({ reply_prefix: "" }), cfg({ enabled: false }), undefined]) {
			const { state, sender } = rig(() => c);
			await sender.tick();
			expect(state.posts).toEqual([]);
		}
	});

	test("a failed post is logged, never thrown, and tried again on the next tick", async () => {
		const { state, sender } = rig();
		state.fail = true;
		await sender.tick();
		expect(state.posts).toEqual([]);
		expect(state.logs.join("\n")).toContain("HTTP 500");
		state.fail = false;
		state.now += 1000;
		await sender.tick();
		expect(state.posts).toHaveLength(1);
	});

	test("a build that throws is logged and does not throw", async () => {
		const sender = createSnapshotSender({ config: () => cfg(), build: () => { throw new Error("boom"); }, post: async () => {}, now: () => 1, store: snapshotFileStore(join(dir, "s.json")), log: () => {} });
		await sender.tick();
	});
});

describe("snapshot the sender keeps", () => {
	test("a stored file that is not a snapshot is ignored", () => {
		const dir = mkdtempSync(join(tmpdir(), "snap-store-"));
		try {
			const store = snapshotFileStore(join(dir, "none.json"));
			expect(store.load()).toBeUndefined();
			const snap: Snapshot = buildSnapshot(sources(), 5);
			store.save({ sentAt: 7, snap });
			expect(store.load()).toMatchObject({ sentAt: 7 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("what counts as a change", () => {
	test("a watch's run times and last line or a session's report time alone are not a change; its result is", () => {
		const a = buildSnapshot(sources(), 1);
		const moved = buildSnapshot(sources({ monitors: [{ name: "site", kind: "watch", last_result: "ok", connection: "connected", last_run: "2026-01-02T00:00:00Z", next_run: "2026-01-02T01:00:00Z", last_summary: "other line" }], sessions: sources().sessions.map(s => ({ ...s, lastReportAt: "2026-02-01T00:00:00Z" })) }), 2);
		expect(snapshotChanged(a, moved)).toBe(false);
		const failed = buildSnapshot(sources({ monitors: [{ name: "site", kind: "watch", last_result: "fail", connection: "connected" }] }), 3);
		expect(snapshotChanged(a, failed)).toBe(true);
	});
});
