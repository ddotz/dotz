// Secrets at rest: masking at recall ingest, in idle session files, and the 90-day retention that keeps recall pairs.
// Synthetic sessions in temp dirs only; every token is built at run time from a fake pattern.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { maskSecrets } from "./public-scrub.ts";
import { forget, ingest, openRecall } from "./recall-index.ts";
import { search } from "./recall-search.ts";
import { runSessionHygiene, sessionRoots } from "./session-hygiene.ts";

const DAY = 86_400_000;
const FAKE_GH = `ghp_${"A1b2".repeat(9)}`;
const FAKE_FILE_SECRET = `Qz${"7kLm".repeat(5)}`;
const SHA = "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f";
const UUID = "01a1c084-4c7d-7c95-9943-0055f863e322";

let base = "", root = "", folder = "", db: Database;
let n = 0;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "session-hygiene-test-"));
	root = join(base, "sessions");
	folder = join(root, "--home-x--");
	mkdirSync(folder, { recursive: true });
	db = openRecall(join(base, "data"));
});
afterEach(() => {
	db.close();
	rmSync(base, { recursive: true, force: true });
});

const entry = (role: string, text: string, ts: string): string => JSON.stringify({ type: "message", id: `e${++n}`, timestamp: ts, message: { role, content: [{ type: "text", text }] } });
const session = (id: string, ask: string, answer: string, ageDays: number): string => {
	const ts = new Date(Date.now() - ageDays * DAY).toISOString();
	const file = join(folder, `${ts.replace(/[:.]/g, "-")}_${id}.jsonl`);
	const header = JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: "/home/x/.dotz" });
	writeFileSync(file, `${[header, entry("user", `[dotz inbox] web msg=m${n} from tester\n${ask}`, ts), entry("assistant", answer, ts)].join("\n")}\n`, { mode: 0o644 });
	const at = new Date(Date.now() - ageDays * DAY);
	utimesSync(file, at, at);
	return file;
};
const sync = () => ingest(db, { roots: [root], secrets: [FAKE_FILE_SECRET] });
const hygiene = (extra: Partial<Parameters<typeof runSessionHygiene>[0]> = {}) =>
	runSessionHygiene({ roots: [root], secrets: [FAKE_FILE_SECRET], keepDays: 90, dryRun: false, recall: db, ...extra });
const find = (query: string) => search(db, { query }, { mode: "keyword" });
const docText = (): string => db.query<{ t: string }, []>("SELECT group_concat(owner || ' ' || answer, ' ') AS t FROM docs").get()?.t ?? "";

describe("maskSecrets", () => {
	test("credentials become kind markers, ordinary ids and paths stay", () => {
		const r = maskSecrets(`push with ${FAKE_GH} and Authorization: Bearer Zk3QmR8vTp2LxW9nBc4H, file value ${FAKE_FILE_SECRET}; commit ${SHA} uuid ${UUID} /Users/x/a.ts token=opts.token`, [FAKE_FILE_SECRET]);
		expect(r.text).toContain("[가림:github]");
		expect(r.text).toContain("Bearer [가림:auth-header]");
		expect(r.text).toContain("[가림:secret-file]");
		expect(r.text).toContain(SHA);
		expect(r.text).toContain(UUID);
		expect(r.text).toContain("/Users/x/a.ts token=opts.token");
		expect(r.text).not.toContain(FAKE_GH);
	});
});

describe("session hygiene", () => {
	test("a fake token is masked in the index row and in the idle session file, every line still parses", () => {
		const file = session("s1", `배포 키는 ${FAKE_GH} 이거야`, `커밋 ${SHA} 확인, 세션 ${UUID}`, 2);
		const mtime = statSync(file).mtimeMs;
		sync();
		expect(docText()).toContain("[가림:github]");
		expect(docText()).not.toContain(FAKE_GH);
		const r = hygiene();
		expect(r.masked).toEqual({ files: 1, lines: 1, hits: { github: 1 } });
		const text = readFileSync(file, "utf8");
		expect(text).toContain("[가림:github]");
		expect(text).not.toContain(FAKE_GH);
		expect(text).toContain(SHA);
		expect(text).toContain(UUID);
		for (const line of text.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(folder).mode & 0o777).toBe(0o700);
		expect(statSync(file).mtimeMs).toBe(mtime);
	});

	test("an index built before masking is masked once, its vectors dropped", () => {
		session("s1", "회의록 정리 부탁", "정리했어", 2);
		sync();
		db.query("UPDATE docs SET owner = ?").run(`회의록 ${FAKE_GH}`);
		db.query("INSERT INTO vecs(doc_id, model, vec) SELECT id, 'm', x'00' FROM docs").run();
		db.query("DELETE FROM meta WHERE k = 'mask'").run();
		sync();
		expect(docText()).toContain("[가림:github]");
		expect(db.query("SELECT count(*) AS c FROM vecs").get()).toEqual({ c: 0 });
	});

	test("a 91-day idle file is deleted and its pair is still found by recall", () => {
		const file = session("old1", "석 달 전 라즈베리파이 서버 설정", "포트 8080으로 열었어", 91);
		mkdirSync(file.replace(/\.jsonl$/, "-artifacts"));
		sync();
		const r = hygiene();
		expect(r.retention.deleted).toBe(1);
		expect(existsSync(file)).toBe(false);
		expect(existsSync(file.replace(/\.jsonl$/, "-artifacts"))).toBe(false);
		sync();
		expect(find("라즈베리파이").map(h => h.file)).toEqual([file]);
	});

	test("an old file the index has not fully read is not deleted", () => {
		const file = session("old2", "아직 색인 안 된 대화", "응", 91);
		expect(hygiene().retention).toEqual({ deleted: 0, bytes: 0, notIndexed: 1 });
		expect(existsSync(file)).toBe(true);
	});

	test("a file written within a day, a leased one and an active one are untouched", () => {
		const recent = session("rec1", `키 ${FAKE_GH}`, "응", 0);
		const leasedFile = session("lease1", `키 ${FAKE_GH}`, "응", 2);
		const activeFile = session("act1", `키 ${FAKE_GH}`, "응", 2);
		mkdirSync(join(folder, "extensions", "terminal"), { recursive: true });
		writeFileSync(join(folder, "extensions", "terminal", "lease1.lease"), JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }));
		const before = [recent, leasedFile, activeFile].map(f => readFileSync(f, "utf8"));
		const r = hygiene({ active: new Set([activeFile]) });
		expect(r.skipped).toMatchObject({ recent: 1, leased: 1, active: 1 });
		expect([recent, leasedFile, activeFile].map(f => readFileSync(f, "utf8"))).toEqual(before);
	});

	test("a lease whose pid now belongs to another program does not protect the file", async () => {
		const file = session("reused1", `키 ${FAKE_GH}`, "응", 2);
		const other = Bun.spawn(["sleep", "30"]);
		try {
			mkdirSync(join(folder, "extensions", "terminal"), { recursive: true });
			writeFileSync(join(folder, "extensions", "terminal", "reused1.lease"), JSON.stringify({ pid: other.pid, startedAtMs: Date.now() }));
			const r = hygiene();
			expect(r.skipped.leased).toBe(0);
			expect(readFileSync(file, "utf8")).not.toContain(FAKE_GH);
			expect(statSync(file).mode & 0o777).toBe(0o600);
		} finally {
			other.kill();
			await other.exited;
		}
	});

	test("a dry run counts and changes nothing", () => {
		const file = session("dry1", `키 ${FAKE_GH}`, "응", 2);
		const before = readFileSync(file, "utf8");
		expect(hygiene({ dryRun: true }).masked.hits).toEqual({ github: 1 });
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	test("deliberate deletion still removes pairs: the session folder, or forget for a retired file", () => {
		const live = session("live1", "삭제요청 감자 이야기", "알겠어", 2);
		const old = session("old3", "삭제요청 고구마 이야기", "알겠어", 91);
		sync();
		hygiene();
		expect(existsSync(old)).toBe(false);
		expect(forget(db, old)).toBe(1);
		expect(find("고구마")).toEqual([]);
		expect(find("감자").length).toBe(1);
		rmSync(folder, { recursive: true, force: true });
		sync();
		expect(find("삭제요청")).toEqual([]);
		expect(existsSync(live)).toBe(false);
	});
});

describe("Claude runtime sessions", () => {
	test("the Claude projects folder is a session root, and an idle Claude session file is masked there", () => {
		const prev = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(base, "claude");
		try {
			const projects = join(base, "claude", "projects");
			expect(sessionRoots()).toContain(projects);
			const dir = join(projects, "-home-x-dotz");
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${UUID}.jsonl`);
			const line = (role: string, text: string) => JSON.stringify({ type: role, sessionId: UUID, message: { role, content: text } });
			writeFileSync(file, `${line("user", `키는 ${FAKE_GH} 이야`)}\n${line("assistant", "알겠어")}\n`);
			const old = new Date(Date.now() - 2 * DAY);
			utimesSync(file, old, old);
			const r = runSessionHygiene({ roots: sessionRoots(), secrets: [], keepDays: 90, dryRun: false, recall: db });
			expect(r.masked.files).toBe(1);
			const text = readFileSync(file, "utf8");
			expect(text).not.toContain(FAKE_GH);
			expect(text).toContain("[가림:github]");
			expect(text).toContain(UUID);
			expect(statSync(file).mode & 0o777).toBe(0o600);
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = prev;
		}
	});

	test("an old Claude session file the recall index never read is kept", () => {
		const prev = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(base, "claude");
		try {
			const dir = join(base, "claude", "projects", "-home-x-dotz");
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${UUID}.jsonl`);
			writeFileSync(file, `${JSON.stringify({ type: "user", message: { role: "user", content: "오래된 대화" } })}\n`);
			const old = new Date(Date.now() - 91 * DAY);
			utimesSync(file, old, old);
			const r = runSessionHygiene({ roots: sessionRoots(), secrets: [], keepDays: 90, dryRun: false, recall: db });
			expect(r.retention.deleted).toBe(0);
			expect(existsSync(file)).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = prev;
		}
	});
});
