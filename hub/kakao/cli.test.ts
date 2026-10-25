// CLI wiring: dry-run, the real process on an empty data dir, read / draft / send through a fake reader, and off.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ctx, type DraftsApi, type Reader, run } from "./cli.ts";
import { atomicWrite, cardFile, featureFile, STEPS } from "./onboard.ts";
import { type KakaoConfig, kakaoPaths, type Msg, type Room } from "./types.ts";

const CLI = join(import.meta.dir, "cli.ts");
const never = async () => {
	throw new Error("unexpected call");
};

const room = (chatId: string, name: string, kind: Room["kind"]): Room => ({ chatId, name, type: 0, kind, unread: 0, lastAt: 0 });
const msg = (n: number, text: string, o: Partial<Msg> = {}): Msg => ({ logId: `9007199254740${900 + n}`, chatId: "101", authorId: "2001", sender: "Alex", text, type: 1, sentAt: 1_700_000_000 + n * 60, fromMe: false, ...o });
const hhmm = (sentAt: number) => {
	const d = new Date(sentAt * 1000);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const MSGS = [msg(1, "hello"), msg(2, "hi there", { authorId: "1000", sender: "Owner", fromMe: true }), msg(3, "lunch?\nat noon"), msg(4, "photo", { type: 2 })];

function build(over: Partial<Ctx> = {}) {
	const root = mkdtempSync(join(tmpdir(), "kk-cli-"));
	const log = { runs: [] as string[][], hub: [] as { method: string; path: string; body?: any }[], out: [] as string[], spawned: [] as string[][], cleared: 0, fetched: [] as number[] };
	const reader: Reader = {
		rooms: async () => [room("101", "Alex", "direct"), room("105", "Shop", "channel")],
		messages: async (_chat, limit) => (log.fetched.push(limit), MSGS),
		draftable: r => r.kind === "direct" || r.kind === "group",
	};
	const ctx: Ctx = {
		paths: kakaoPaths(join(root, "data"), join(root, "home")),
		runner: async argv => (log.runs.push(argv), { code: 1, stdout: "", stderr: "" }),
		hub: {
			post: async (path, body) => (log.hub.push({ method: "POST", path, body }), { status: 200, json: { id: "x" } }),
			get: async path => (log.hub.push({ method: "GET", path }), { status: 200, json: [] }),
			patch: async (path, body) => (log.hub.push({ method: "PATCH", path, body }), { status: 200, json: {} }),
			del: async path => (log.hub.push({ method: "DELETE", path }), { status: 200, json: {} }),
		},
		ports: { hasKmsg: never as any, appInstalled: never, accessibilityGranted: never, hasCredentials: never, importAuthFile: never, clearCredentials: async () => void log.cleared++, login: never, resumeAfterConfirm: never, derive: never, readCounts: never },
		out: line => log.out.push(line),
		stdin: async () => "",
		repo: join(import.meta.dir, "..", ".."),
		execPath: "/fake/bin/bun",
		brew: "brew",
		spawnSetup: args => log.spawned.push(args),
		reader: async () => reader,
		drafts: never as any,
		sleep: async () => {},
		now: () => 0,
		pid: 1,
		isAlive: () => false,
		...over,
	};
	return { ctx, log };
}

const enable = (ctx: Ctx, extra: Partial<KakaoConfig> = {}) => atomicWrite(ctx.paths.config, JSON.stringify({ enabled: true, userId: 1000, ...extra }));

test("read includes the text written with an emoticon as (이모티콘) <text>; a sticker alone and a photo stay out", async () => {
	const list = [msg(1, "hello"), msg(2, "고마워", { type: 12 }), msg(3, "", { type: 20 }), msg(4, "photo", { type: 2 }), msg(5, "내일 봐", { type: 25, authorId: "1000", sender: "Owner", fromMe: true })];
	const reader: Reader = { rooms: async () => [room("101", "Alex", "direct")], messages: async () => list, draftable: () => true };
	const { ctx, log } = build({ reader: async () => reader });
	enable(ctx);
	expect(await run(["read", "--chat", "101"], ctx)).toBe(0);
	expect(log.out).toEqual([`[${hhmm(1_700_000_060)}] Alex: hello`, `[${hhmm(1_700_000_120)}] Alex: (이모티콘) 고마워`, `[${hhmm(1_700_000_300)}] 나: (이모티콘) 내일 봐`]);
});

test("setup --dry-run prints every step and the commands, with zero runner and gateway calls", async () => {
	const { ctx, log } = build();
	expect(await run(["setup", "--dry-run"], ctx)).toBe(0);
	expect(log.runs).toEqual([]);
	expect(log.hub).toEqual([]);
	expect(log.spawned).toEqual([]);
	expect(existsSync(ctx.paths.onboard)).toBe(false);
	const text = log.out.join("\n");
	for (const s of STEPS) expect(text).toContain(s.name);
	expect(text).toContain("run: brew --version");
	expect(text).toContain("ask: secret");
	expect(log.out.at(-1)!.startsWith("post: [done] 카톡 연결이 끝났어요")).toBe(true);
	expect(log.out.every(l => /^(run|post|ask): /.test(l))).toBe(true);
});

test("setup without --foreground detaches itself and prints one line; a running setup is reported once", async () => {
	const { ctx, log } = build();
	expect(await run(["setup", "--to", "ch:123"], ctx)).toBe(0);
	expect(log.spawned).toEqual([["setup", "--foreground", "--to", "ch:123"]]);
	expect(log.out).toHaveLength(1);
	atomicWrite(ctx.paths.onboard, JSON.stringify({ status: "running", steps: {}, started: "x", pid: 4242 }));
	const again = build({ isAlive: pid => pid === 4242 });
	again.ctx.paths = ctx.paths;
	expect(await run(["setup"], again.ctx)).toBe(0);
	expect(again.log.spawned).toEqual([]);
	expect(again.log.out).toHaveLength(1);
});

test("the real process on an empty data dir: status prints the off line and exits 0", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kk-proc-"));
	const env = { PATH: process.env.PATH ?? "", HOME: dir, DOTZ_DIR: dir };
	const status = Bun.spawn([process.execPath, CLI, "status"], { env, stdout: "pipe", stderr: "pipe" });
	expect(await status.exited).toBe(0);
	expect((await new Response(status.stdout).text()).trim()).not.toBe("");
	const read = Bun.spawn([process.execPath, CLI, "read", "--chat", "1"], { env, stdout: "pipe", stderr: "pipe" });
	expect(await read.exited).toBe(1);
	expect(existsSync(join(dir, "kakao"))).toBe(false);
});

test("read prints text messages oldest first with the owner as 나, and refuses rooms that are not draft candidates", async () => {
	const { ctx, log } = build();
	enable(ctx);
	expect(await run(["read", "--chat", "101", "--limit", "20"], ctx)).toBe(0);
	expect(log.out).toEqual([`[${hhmm(1_700_000_060)}] Alex: hello`, `[${hhmm(1_700_000_120)}] 나: hi there`, `[${hhmm(1_700_000_180)}] Alex: lunch?\n  at noon`]);
	log.out.length = 0;
	expect(await run(["read", "--chat", "101", "--limit", "1"], ctx)).toBe(0);
	expect(log.out).toHaveLength(1);
	expect(log.fetched.every(n => n === 50)).toBe(true);
	log.out.length = 0;
	expect(await run(["read", "--chat", "105"], ctx)).toBe(1);
	expect(await run(["read", "--chat", "999"], ctx)).toBe(1);
	expect(log.out).toHaveLength(2);
});

test("draft bases itself on the newest incoming text message; send hands the approval check the latest incoming log id", async () => {
	const created: any[] = [];
	const sent: string[] = [];
	const drafts: DraftsApi = {
		create: async input => (created.push(input), { code: "KAAAAA" }),
		block: d => `block:${d.code}`,
		send: async (code, deps) => {
			sent.push(`${code}:${await deps.latestIncoming("101")}:${(await deps.roomNames()).map(r => r.name).join(",")}`);
			return code === "KGOOD" ? { ok: true } : { ok: false, reason: "아직 보내도 된다는 답을 받지 못했어요" };
		},
	};
	const { ctx, log } = build({ drafts: async () => drafts, stdin: async () => " 좋아요, 정오에 봐요 \n" });
	enable(ctx);
	expect(await run(["draft", "--chat", "101"], ctx)).toBe(0);
	expect(created).toEqual([{ chatId: "101", roomName: "Alex", text: "좋아요, 정오에 봐요", basisLogId: MSGS[2]!.logId }]);
	expect(log.out).toEqual(["block:KAAAAA"]);
	log.out.length = 0;
	expect(await run(["draft", "--chat", "105"], ctx)).toBe(1);
	expect(created).toHaveLength(1);
	expect(await run(["send", "--draft", "KGOOD"], ctx)).toBe(0);
	expect(await run(["send", "--draft", "KBAD"], ctx)).toBe(1);
	expect(sent).toEqual([`KGOOD:${MSGS[2]!.logId}:Alex,Shop`, `KBAD:${MSGS[2]!.logId}:Alex,Shop`]);
	expect(log.out.at(-1)).toContain("아직 보내도 된다는 답을 받지 못했어요");
});

test("status when on lists the setup state, the app and the pending draft count; off removes what setup wrote", async () => {
	const { ctx, log } = build({
		runner: async argv => (argv[0] === "pgrep" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" }),
		hub: {
			post: async () => ({ status: 200, json: {} }),
			get: async path => (path === "/api/watches" ? { status: 200, json: [{ id: "w1", name: "kakao-new", lastRun: "2026-10-22T01:00:00.000Z", fails: 0 }] } : { status: 404, json: {} }),
			patch: async (path, body) => (void log.hub.push({ method: "PATCH", path, body }), { status: 200, json: {} }),
			del: async path => (void log.hub.push({ method: "DELETE", path }), { status: 409, json: { error: "belongs to a work channel" } }),
		},
	});
	enable(ctx, { exclude_chats: ["7"], dbPath: "/x/db" });
	atomicWrite(ctx.paths.onboard, JSON.stringify({ status: "done", steps: {}, started: "x" }));
	atomicWrite(ctx.paths.drafts, JSON.stringify([{ code: "K1", status: "pending" }, { code: "K2", status: "sent" }]));
	expect(await run(["status", "--json"], ctx)).toBe(0);
	expect(Object.values(JSON.parse(log.out[0]!))).toContain("2026-10-22T01:00:00.000Z");

	for (const f of [cardFile(ctx.paths), featureFile(ctx.paths)]) {
		mkdirSync(join(f, ".."), { recursive: true });
		writeFileSync(f, "x");
	}
	log.out.length = 0;
	expect(await run(["off", "--forget"], ctx)).toBe(0);
	expect(JSON.parse(readFileSync(ctx.paths.config, "utf8"))).toEqual({ enabled: false, userId: 1000, exclude_chats: ["7"], dbPath: "/x/db" });
	expect(log.hub).toEqual([{ method: "DELETE", path: "/api/watches/w1" }, { method: "PATCH", path: "/api/watches/w1", body: { paused: true } }]);
	expect([cardFile(ctx.paths), featureFile(ctx.paths), ctx.paths.onboard].some(existsSync)).toBe(false);
	expect(log.cleared).toBe(1);
	expect(await run(["read", "--chat", "101"], ctx)).toBe(1);
});

test("rooms lists draftable rooms newest first, labels unnamed groups by their members, and --all adds the rest", async () => {
	const T = Date.parse("2026-10-22T12:00:00");
	const rooms = [
		{ ...room("101", "Alex", "direct"), lastAt: T / 1000 - 600, unread: 2 },
		{ ...room("102", "(unknown)", "group"), lastAt: T / 1000 - 60 },
		{ ...room("105", "Shop", "channel"), lastAt: T / 1000 },
		{ ...room("103", "Old", "group"), lastAt: Date.parse("2026-10-20T09:05:00") / 1000 },
	];
	const reader: Reader = { rooms: async () => rooms, messages: never, draftable: r => r.kind === "direct" || r.kind === "group", label: async id => (id === "102" ? "Kim, Lee" : undefined) };
	const { ctx, log } = build({ reader: async () => reader, now: () => T });
	expect(await run(["rooms"], ctx)).toBe(1);
	enable(ctx);
	log.out.length = 0;
	expect(await run(["rooms", "--plain"], ctx)).toBe(0);
	expect(log.out.filter(l => /^\d+ /.test(l)).map(l => l.split(" ")[0])).toEqual(["102", "101", "103"]);
	expect(log.out[0]).toContain("Kim, Lee");
	log.out.length = 0;
	expect(await run(["rooms"], ctx)).toBe(0);
	expect(log.out).toHaveLength(1);
	expect(["Kim, Lee", "Alex", "Old"].every(n => log.out[0]!.includes(n))).toBe(true);
	log.out.length = 0;
	expect(await run(["rooms", "--all", "--limit", "1", "--plain"], ctx)).toBe(0);
	expect(log.out.filter(l => /^\d+ /.test(l)).map(l => l.split(" ")[0])).toEqual(["105"]);
});
