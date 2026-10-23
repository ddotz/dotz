import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnboard, type Gateway } from "../features/comments/bin/onboard.ts";
import { createApp } from "./app-off.ts";
import { createEngine } from "./comments/engine.ts";
import type { CommentAdapter } from "./comments/contract.ts";
import { LEGACY_ID, legacyAnswer, MIGRATIONS, MIGRATIONS_FILE, runMigrations, type Migration } from "./migrations.ts";

// Temp data dirs only; the token values are placeholders that must never reach a notice, a reply or a log line.
const VALUE = "placeholder-refresh-token-value";
const KEPT = { dotz: process.env.DOTZ_DIR, legacy: process.env.DOTZ_LEGACY_SECRETS };
let root: string;
let dir: string;
let old: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dz-migrations-"));
	dir = join(root, "now");
	old = join(root, "earlier", "secrets");
	mkdirSync(dir, { recursive: true });
	process.env.DOTZ_DIR = dir;
	process.env.DOTZ_LEGACY_SECRETS = "";
});
afterEach(() => {
	for (const [k, v] of [["DOTZ_DIR", KEPT.dotz], ["DOTZ_LEGACY_SECRETS", KEPT.legacy]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
	rmSync(root, { recursive: true, force: true });
});

const put = (file: string, text: string) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
};
const site = (key: string, label: string) => ({ key, kind: "website", label, watch: ["*"], autoDraft: false, site: { read: { kind: "rss", url: "http://x.test/feed" }, post: { kind: "webhook", url: "http://x.test/post" } } });
const putSites = (at: string, sources: object[]) => put(join(at, "custom", "comments", "config.json"), JSON.stringify({ enabled: true, sources: Object.fromEntries(sources.map((s: any) => [s.key, s])) }));
const readApps = (at: string) => JSON.parse(readFileSync(join(at, "custom", "apps.json"), "utf8"));
const spy = () => {
	const asks: string[] = [], notes: string[] = [], logs: string[] = [];
	return { asks, notes, logs, deps: (migrations?: Migration[]) => ({ dataDir: dir, ask: (t: string) => void asks.push(t), notify: (t: string) => void notes.push(t), log: (s: string) => void logs.push(s), ...(migrations ? { migrations } : {}) }) };
};
const putLegacy = () => {
	put(join(old, "youtube-oauth.json"), JSON.stringify({ refresh_token: VALUE }));
	put(join(old, "instagram.json"), JSON.stringify({ access_token: VALUE }));
	process.env.DOTZ_LEGACY_SECRETS = old;
};

describe("runner", () => {
	test("a migration runs once, the state file records it, one log line each", async () => {
		const s = spy();
		let runs = 0;
		const m: Migration = { id: "one", label: "하나", run: () => (runs++, "하나를 했어요") };
		await runMigrations(s.deps([m]));
		await runMigrations(s.deps([m]));
		expect(runs).toBe(1);
		expect(JSON.parse(readFileSync(join(dir, MIGRATIONS_FILE), "utf8")).done.one.note).toBe("하나를 했어요");
		expect(s.logs).toEqual(["migration one: 하나를 했어요"]);
	});

	test("a failure leaves a Korean notice, is not marked done, and is retried at the next start", async () => {
		const s = spy();
		let fail = true;
		const m: Migration = { id: "flaky", label: "불안정한 설정", run: () => { if (fail) throw new Error("디스크가 가득 찼어요"); return "마쳤어요"; } };
		const first = await runMigrations(s.deps([m]));
		expect(first.failed).toEqual(["flaky"]);
		expect(s.notes).toHaveLength(1);
		expect(s.notes[0]).toContain("불안정한 설정");
		expect(s.notes[0]).toContain("디스크가 가득 찼어요");
		fail = false;
		const second = await runMigrations(s.deps([m]));
		expect(second.ran).toEqual(["마쳤어요"]);
		expect((await runMigrations(s.deps([m]))).ran).toEqual([]);
	});

	test("the update-done notice lists the migrations that changed something in one line, and stays quiet when none did", async () => {
		const s = spy();
		const a: Migration = { id: "a", label: "가", run: () => "가를 했어요" };
		const b: Migration = { id: "b", label: "나", run: () => undefined };
		const c: Migration = { id: "c", label: "다", run: () => "다를 했어요" };
		await runMigrations(s.deps([a, b, c]));
		expect(s.notes).toEqual(["업데이트 뒤 필요한 설정을 자동으로 마쳤어요: 가를 했어요, 다를 했어요"]);
		const quiet = spy();
		rmSync(join(dir, MIGRATIONS_FILE));
		await runMigrations(quiet.deps([b]));
		expect(quiet.notes).toEqual([]);
	});
});

describe("site comment apps", () => {
	test("creates the missing instance for each website source, leaves existing ones alone, and is idempotent", async () => {
		putSites(dir, [site("site-mapia", "맵이 블로그"), site("site-shop", "가게"), { ...site("yt", "유튜브"), kind: "youtube" }]);
		createApp(dir, { app: "site", id: "site-shop", label: "내가 바꾼 이름", filter: { source: "shop" } });
		const s = spy();
		const r = await runMigrations(s.deps(MIGRATIONS.filter(m => m.id === "site-comment-apps")));
		expect(r.ran).toEqual(["웹사이트 댓글 앱 1개 만듦 (mapia)"]);
		const apps = readApps(dir);
		expect(Object.keys(apps).sort()).toEqual(["site-mapia", "site-shop"]);
		expect(apps["site-shop"].label).toBe("내가 바꾼 이름");
		const before = readFileSync(join(dir, "custom", "apps.json"), "utf8");
		rmSync(join(dir, MIGRATIONS_FILE));
		const again = await runMigrations(s.deps(MIGRATIONS.filter(m => m.id === "site-comment-apps")));
		expect(again.ran).toEqual([]);
		expect(readFileSync(join(dir, "custom", "apps.json"), "utf8")).toBe(before);
	});

	test("the result equals what onboard.ts on --app site --name X makes", async () => {
		const other = join(root, "onboarded");
		mkdirSync(other, { recursive: true });
		process.env.DOTZ_DIR = other;
		const adapter: CommentAdapter = { kind: "website", list: async () => ({ comments: [] }), reply: async () => ({ ok: false, reason: "x" }), ownReplies: async () => [] };
		const engine = createEngine({ dir: join(other, "custom", "comments"), now: () => 1000, collector: "m", adapters: { website: adapter } });
		const gateway: Gateway = { watches: async () => [], add: async () => undefined, pause: async () => undefined, app: async b => void createApp(other, b) };
		const r = await runOnboard(["on", "--app", "site", "--name", "mapia", "--label", "맵이 블로그", "--read-kind", "rss", "--read", "http://x.test/feed", "--post-kind", "webhook", "--post", "http://x.test/post"], { engine, gateway });
		expect(r.code).toBe(0);
		process.env.DOTZ_DIR = dir;
		putSites(dir, [JSON.parse(readFileSync(join(other, "custom", "comments", "config.json"), "utf8")).sources["site-mapia"]]);
		await runMigrations(spy().deps(MIGRATIONS.filter(m => m.id === "site-comment-apps")));
		expect(readApps(dir)).toEqual(readApps(other));
	});

	test("with no website source nothing is written", async () => {
		const r = await runMigrations(spy().deps(MIGRATIONS.filter(m => m.id === "site-comment-apps")));
		expect(r.ran).toEqual([]);
		expect(existsSync(join(dir, "custom", "apps.json"))).toBe(false);
	});
});

describe("legacy YouTube/Instagram tokens", () => {
	const legacyOnly = MIGRATIONS.filter(m => m.id === LEGACY_ID);
	const secret = (name: string) => join(dir, "secrets", name);

	test("asks once with names only, copies nothing before the yes", async () => {
		putLegacy();
		const s = spy();
		await runMigrations(s.deps(legacyOnly));
		expect(s.asks).toHaveLength(1);
		expect(s.asks[0]).toContain("[ask] 예전 유튜브·인스타 연결을 찾았어요. 가져올까요?");
		expect(s.asks[0]).toContain("1) 가져오기");
		expect(s.asks[0]).toContain("2) 안 가져오기");
		expect(s.asks[0]).not.toContain(VALUE);
		expect(existsSync(secret("youtube-oauth.json"))).toBe(false);
		await runMigrations(s.deps(legacyOnly));
		expect(s.asks).toHaveLength(1);
	});

	test("yes imports both files with 0600 and never prints a value; a second answer is ignored", async () => {
		putLegacy();
		await runMigrations(spy().deps(legacyOnly));
		const reply = legacyAnswer(dir, "1) 가져오기");
		expect(reply).toContain("youtube-oauth.json");
		expect(reply).not.toContain(VALUE);
		for (const f of ["youtube-oauth.json", "instagram.json"]) {
			expect(statSync(secret(f)).mode & 0o777).toBe(0o600);
			expect(readFileSync(secret(f), "utf8")).toContain(VALUE);
		}
		expect(legacyAnswer(dir, "1) 가져오기")).toBeUndefined();
	});

	test("no records the refusal and copies nothing; it is not asked again", async () => {
		putLegacy();
		const s = spy();
		await runMigrations(s.deps(legacyOnly));
		expect(legacyAnswer(dir, "2) 안 가져오기")).toContain("가져오지 않아요");
		expect(existsSync(secret("youtube-oauth.json"))).toBe(false);
		expect(existsSync(join(dir, "custom", "sns", "legacy-import.json"))).toBe(true);
		rmSync(join(dir, MIGRATIONS_FILE));
		await runMigrations(s.deps(legacyOnly));
		expect(s.asks).toHaveLength(1);
	});

	test("no question when there is nothing to import or the tokens are already there, and an answer with no open question does nothing", async () => {
		const s = spy();
		await runMigrations(s.deps(legacyOnly));
		expect(s.asks).toEqual([]);
		putLegacy();
		put(secret("youtube-oauth.json"), "{}");
		put(secret("instagram.json"), "{}");
		rmSync(join(dir, MIGRATIONS_FILE));
		await runMigrations(s.deps(legacyOnly));
		expect(s.asks).toEqual([]);
		expect(legacyAnswer(dir, "1) 가져오기")).toBeUndefined();
		expect(legacyAnswer(dir, "안녕")).toBeUndefined();
	});
});
