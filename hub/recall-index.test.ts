// Synthetic sessions in temp dirs only; the session header cwd is a made-up path, never a real one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ingest, openRecall, pendingDocs, putVec, tokenize } from "./recall-index.ts";
import { openDoc, search } from "./recall-search.ts";

let root = "", dataDir = "", db: Database;
let n = 0;
beforeEach(() => {
	const base = mkdtempSync(join(tmpdir(), "recall-test-"));
	root = join(base, "sessions");
	dataDir = join(base, "data");
	mkdirSync(join(root, "--home-x--"), { recursive: true });
	db = openRecall(dataDir);
});
afterEach(() => {
	db.close();
	rmSync(join(root, ".."), { recursive: true, force: true });
});

const HEADER = JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-10-01T00:00:00.000Z", cwd: "/home/x/.dotz" });
const entry = (role: string, text: string, ts: string): string => JSON.stringify({ type: "message", id: `e${++n}`, timestamp: ts, message: { role, content: [{ type: "text", text }] } });
const ask = (text: string, ts: string, msg = `m${n + 1}`): string => entry("user", `[dotz inbox] web msg=${msg} from tester\n${text}`, ts);
const reply = (text: string, ts: string): string => entry("assistant", text, ts);
const sessionFile = (name: string): string => join(root, "--home-x--", `${name}.jsonl`);
const write = (name: string, ...rows: string[]): string => {
	const f = sessionFile(name);
	writeFileSync(f, [HEADER, ...rows].join("\n") + "\n");
	return f;
};
const sync = (budgetMs?: number) => ingest(db, { roots: [root], budgetMs });
const find = (query: string, extra: Partial<Parameters<typeof search>[1]> = {}) => search(db, { query, ...extra }, { mode: "keyword" });
const count = (): number => db.query<{ c: number }, []>("SELECT count(*) AS c FROM docs").get()?.c ?? 0;

describe("tokenize", () => {
	test("hangul runs become the word plus bigrams, latin words are lowercased", () => {
		expect(tokenize("서버를 Restart v2")).toEqual(["서버를", "서버", "버를", "restart", "v2"]);
		expect(tokenize("서버")).toEqual(["서버"]);
	});
});

describe("search", () => {
	test("matches a two-letter Korean word and survives a particle", () => {
		write("a", ask("서버 재시작 해줘", "2026-10-01T01:00:00.000Z"), reply("재시작 했어요", "2026-10-01T01:01:00.000Z"),
			ask("배포는 언제 끝나", "2026-10-01T02:00:00.000Z"), reply("거의 다 됐어요", "2026-10-01T02:01:00.000Z"));
		sync();
		expect(find("서버를 껐다").map(h => h.owner)).toEqual(["서버 재시작 해줘"]);
		expect(find("배포").map(h => h.owner)).toEqual(["배포는 언제 끝나"]);
		expect(find("kubernetes")).toEqual([]);
	});

	test("answers are searchable but rank below an owner match", () => {
		write("a", ask("deploy status", "2026-10-01T01:00:00.000Z"), reply("everything fine", "2026-10-01T01:01:00.000Z"),
			ask("unrelated chatter", "2026-10-01T02:00:00.000Z"), reply("the deploy finished", "2026-10-01T02:01:00.000Z"));
		sync();
		expect(find("deploy").map(h => h.owner)).toEqual(["deploy status", "unrelated chatter"]);
	});

	test("after and before are hard date filters in KST", () => {
		write("a", ask("alpha topic", "2026-10-01T01:00:00.000Z"), reply("one", "2026-10-01T01:01:00.000Z"),
			ask("alpha topic again", "2026-10-10T01:00:00.000Z"), reply("two", "2026-10-10T01:01:00.000Z"));
		sync();
		expect(find("alpha").length).toBe(2);
		expect(find("alpha", { after: "2026-10-05" }).map(h => h.owner)).toEqual(["alpha topic again"]);
		expect(find("alpha", { before: "2026-10-05" }).map(h => h.owner)).toEqual(["alpha topic"]);
		expect(find("alpha", { after: "2026-10-20" })).toEqual([]);
	});

	test("extra phrasings are fused in", () => {
		write("a", ask("the invoice is wrong", "2026-10-01T01:00:00.000Z"), reply("fixing", "2026-10-01T01:01:00.000Z"));
		sync();
		expect(find("billing mistake")).toEqual([]);
		expect(find("billing mistake", { also: ["invoice"] }).length).toBe(1);
	});

	test("open re-reads the raw text and names the neighbours", () => {
		const long = `start ${"x".repeat(2500)} end`;
		write("a", ask("first question", "2026-10-01T01:00:00.000Z"), reply(long, "2026-10-01T01:01:00.000Z"), ask("second question", "2026-10-01T02:00:00.000Z"), reply("short", "2026-10-01T02:01:00.000Z"));
		sync();
		const [first, second] = db.query<{ id: string }, []>("SELECT id FROM docs ORDER BY line").all();
		const opened = openDoc(db, first?.id ?? "");
		expect(opened).toMatchObject({ rawFound: true, owner: "first question", prev: "", next: second?.id });
		expect(opened?.answer).toBe(long);
		expect(openDoc(db, second?.id ?? "")?.prev).toBe(first?.id);
		expect(openDoc(db, "nope")).toBeUndefined();
	});
});

describe("incremental ingest", () => {
	test("an open pair is re-parsed when its answer is appended", () => {
		const f = write("a", ask("long running request", "2026-10-01T01:00:00.000Z"));
		expect(sync().docs).toBe(1);
		expect(find("pineapple")).toEqual([]);
		appendFileSync(f, `${reply("pineapple result", "2026-10-01T01:05:00.000Z")}\n`);
		sync();
		expect(count()).toBe(1);
		expect(find("pineapple").map(h => h.owner)).toEqual(["long running request"]);
		appendFileSync(f, `${ask("next request", "2026-10-01T03:00:00.000Z")}\n`);
		sync();
		expect(count()).toBe(2);
	});

	test("an unchanged file is not read again", () => {
		write("a", ask("steady", "2026-10-01T01:00:00.000Z"), reply("yes", "2026-10-01T01:01:00.000Z"));
		expect(sync().docs).toBe(1);
		expect(sync().docs).toBe(0);
	});

	test("a vanished file takes its docs, vectors and index entries with it", () => {
		const f = write("a", ask("ephemeral thought", "2026-10-01T01:00:00.000Z"), reply("gone soon", "2026-10-01T01:01:00.000Z"));
		sync();
		const id = pendingDocs(db, "m", 10)[0]?.id ?? "";
		putVec(db, id, "m", new Float32Array([1, 0]));
		rmSync(f);
		expect(sync().removed).toBe(1);
		expect(count()).toBe(0);
		expect(find("ephemeral")).toEqual([]);
		expect(db.query("SELECT 1 FROM vecs").get()).toBeNull();
	});

	test("a shrunk file is re-read whole", () => {
		const f = write("a", ask("old words here", "2026-10-01T01:00:00.000Z"), reply("old reply", "2026-10-01T01:01:00.000Z"), ask("more old words", "2026-10-01T02:00:00.000Z"), reply("more", "2026-10-01T02:01:00.000Z"));
		sync();
		writeFileSync(f, [HEADER, ask("fresh start", "2026-10-02T01:00:00.000Z"), reply("new", "2026-10-02T01:01:00.000Z")].join("\n") + "\n");
		sync();
		expect(count()).toBe(1);
		expect(find("old")).toEqual([]);
		expect(find("fresh").length).toBe(1);
	});

	test("a replaced file of the same size is re-read whole", () => {
		const f = write("a", ask("aaaa bbbb", "2026-10-01T01:00:00.000Z", "m1"), reply("cccc", "2026-10-01T01:01:00.000Z"));
		sync();
		writeFileSync(f, [HEADER, ask("dddd eeee", "2026-10-01T01:00:00.000Z", "m2"), reply("cccc", "2026-10-01T01:01:00.000Z")].join("\n") + "\n");
		appendFileSync(f, "");
		sync();
		expect(find("aaaa")).toEqual([]);
		expect(find("dddd").length).toBe(1);
	});

	test("the budget stops between files and the next call carries on", () => {
		write("a", ask("first file", "2026-10-01T01:00:00.000Z"), reply("r", "2026-10-01T01:01:00.000Z"));
		write("b", ask("second file", "2026-10-01T02:00:00.000Z"), reply("r", "2026-10-01T02:01:00.000Z"));
		const cut = sync(-1);
		expect(cut).toMatchObject({ complete: false, docs: 0 });
		expect(sync()).toMatchObject({ complete: true, docs: 2 });
	});

	test("sessions in a temp cwd are skipped", () => {
		writeFileSync(sessionFile("t"), [HEADER.replace("/home/x/.dotz", "/tmp/scratch"), ask("scratch", "2026-10-01T01:00:00.000Z"), reply("r", "2026-10-01T01:01:00.000Z")].join("\n") + "\n");
		sync();
		expect(count()).toBe(0);
	});
});

describe("dedupe and vectors", () => {
	test("the same message id in two sessions is one doc, the answered one wins", () => {
		write("a", ask("repeated question", "2026-10-01T01:00:00.000Z", "same0001"));
		write("b", ask("repeated question", "2026-10-01T01:00:00.000Z", "same0001"), reply("with an answer", "2026-10-01T01:01:00.000Z"));
		sync();
		const rows = db.query<{ answer: string }, []>("SELECT answer FROM docs").all();
		expect(rows).toEqual([{ answer: "with an answer" }]);
	});

	test("vectors are listed as pending until stored, and cleared when the text changes", () => {
		const f = write("a", ask("embed me", "2026-10-01T01:00:00.000Z"));
		sync();
		const [doc] = pendingDocs(db, "m1", 5);
		expect(doc?.text).toContain("embed me");
		putVec(db, doc?.id ?? "", "m1", new Float32Array([0.5, 0.5]));
		expect(pendingDocs(db, "m1", 5)).toEqual([]);
		expect(pendingDocs(db, "m2", 5).length).toBe(1);
		appendFileSync(f, `${reply("an answer that changes the text", "2026-10-01T01:02:00.000Z")}\n`);
		sync();
		expect(pendingDocs(db, "m1", 5).length).toBe(1);
	});
});

describe("files on disk", () => {
	test("the index directory is private and a read-only handle sees the data", () => {
		write("a", ask("visible", "2026-10-01T01:00:00.000Z"), reply("yes", "2026-10-01T01:01:00.000Z"));
		sync();
		expect(statSync(join(dataDir, "recall")).mode & 0o777).toBe(0o700);
		expect(statSync(join(dataDir, "recall", "index.db")).mode & 0o777).toBe(0o600);
		const ro = openRecall(dataDir, true);
		expect(search(ro, { query: "visible" }, { mode: "keyword" }).length).toBe(1);
		ro.close();
	});
});
