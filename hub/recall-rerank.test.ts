// Synthetic docs, fake network and a fake scorer in temp dirs only: no model is downloaded and no ONNX runtime is loaded.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { openRecall } from "./recall-index.ts";
import { loadReranker, orderByScore, provisionRerank, rerankDocs, rerankHits, rerankReady, RERANK_FILES, RERANK_POOL, type Reranker } from "./recall-rerank.ts";
import type { ModelFile } from "./recall-embed.ts";
import type { Hit } from "./recall-search.ts";

let base = "", dataDir = "", db: Database;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "recall-rerank-"));
	dataDir = join(base, "data");
	db = openRecall(dataDir);
});
afterEach(() => {
	db.close();
	rmSync(base, { recursive: true, force: true });
});

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const ORT = ["node_modules", "onnxruntime-node", "dist", "index.js"];
const TOK = ["node_modules", "@huggingface", "tokenizers", "dist", "tokenizers.mjs"];
const touch = (file: string): void => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "x");
};
const runtime = (): void => {
	touch(join(dataDir, "recall", "runtime", ...ORT));
	touch(join(dataDir, "recall", "runtime", ...TOK));
};
const reply = (body: string) => async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer });
const file = (body: string): ModelFile => ({ name: "r.bin", url: "https://example.invalid/r.bin", sha256: sha(body) });

function addDoc(id: string, owner: string, answer: string): void {
	db.query("INSERT INTO docs(id, file, line, off, ts_ms, owner, answer) VALUES (?, 'f.jsonl', 1, 0, 0, ?, ?)").run(id, owner, answer);
}
const hit = (id: string): Hit => ({ id, ts: "", room: "", project: "", kind: "owner", file: "f.jsonl", line: 1, owner: "", answer: "" });

describe("provisionRerank", () => {
	test("waits for the runtime, then downloads the pinned files privately and clears an old failure", async () => {
		expect(await provisionRerank({ dataDir, files: [file("m")], fetch: reply("m") })).toMatchObject({ status: "waiting" });
		runtime();
		expect((await provisionRerank({ dataDir, files: [file("m")], fetch: reply("m") })).status).toBe("ok");
		expect(readdirSync(join(dataDir, "recall", "rerank"))).toEqual(["r.bin"]);
		expect(await provisionRerank({ dataDir, files: [file("m")], fetch: async () => { throw new Error("must not fetch again"); } })).toEqual({ status: "ok" });
	});

	test("a sha256 mismatch keeps nothing and waits 6 hours before the next try", async () => {
		runtime();
		let t = Date.parse("2026-10-01T00:00:00Z");
		const bad = await provisionRerank({ dataDir, files: [file("m")], fetch: reply("tampered"), now: () => t });
		expect(bad.status).toBe("failed");
		expect(bad.reason).toContain("sha256");
		expect(readdirSync(join(dataDir, "recall", "rerank"))).toEqual([]);
		t += 3600_000;
		expect((await provisionRerank({ dataDir, files: [file("m")], fetch: reply("m"), now: () => t })).status).toBe("backoff");
		t += 6 * 3600_000;
		expect((await provisionRerank({ dataDir, files: [file("m")], fetch: reply("m"), now: () => t })).status).toBe("ok");
		expect(existsSync(join(dataDir, "recall", "rerank-failed.json"))).toBe(false);
	});

	test("the shipped list pins every file by sha256 at a fixed revision", () => {
		for (const f of RERANK_FILES) {
			expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
		}
	});
});

describe("loading", () => {
	test("not ready without the files or without the runtime, and the reason says so instead of throwing", async () => {
		expect(rerankReady(dataDir)).toBe(false);
		expect((await loadReranker(dataDir)).reason).toContain("not downloaded");
	});
});

describe("ordering", () => {
	test("orderByScore sorts best first and keeps the fused order on equal scores", () => {
		expect(orderByScore(["a", "b", "c", "d"], [0.1, 2, 0.1, 2])).toEqual(["b", "d", "a", "c"]);
		expect(orderByScore(["a", "b"], [1])).toEqual(["a", "b"]);
	});

	test("rerankDocs reads the start of the owner's words and of the answer, and an unknown id gives an empty text", () => {
		addDoc("d1", "o".repeat(400), "a".repeat(900));
		const [text, none] = rerankDocs(db, ["d1", "zz"]);
		expect(text).toBe(`${"o".repeat(300)}\n${"a".repeat(500)}`);
		expect(none).toBe("");
	});
});

describe("rerankHits", () => {
	const scorer = (score: (docs: readonly string[]) => number[]): Reranker => ({ score: async (_q, docs) => score(docs) });
	const loaded = (r: Reranker) => async () => ({ reranker: r });

	test("puts the reader's favourite first among the top candidates and leaves the tail as it was", async () => {
		const ids = Array.from({ length: RERANK_POOL + 3 }, (_, i) => `d${i}`);
		ids.forEach((id, i) => addDoc(id, `owner ${i}`, "answer"));
		const asked: string[][] = [];
		const out = await rerankHits(db, "q", ids.map(hit), dataDir, loaded(scorer(docs => (asked.push([...docs]), docs.map(d => (d.startsWith("owner 7\n") ? 5 : 0))))));
		expect(out.reason).toBeUndefined();
		expect(asked[0]).toHaveLength(RERANK_POOL);
		expect(out.hits.map(h => h.id).slice(0, 3)).toEqual(["d7", "d0", "d1"]);
		expect(out.hits.map(h => h.id).slice(RERANK_POOL)).toEqual(ids.slice(RERANK_POOL));
		expect(out.hits).toHaveLength(ids.length);
	});

	test("a missing or failing reranker leaves the fused order and says why", async () => {
		addDoc("a", "x", "y");
		addDoc("b", "x", "y");
		const hits = [hit("a"), hit("b")];
		expect(await rerankHits(db, "q", hits, dataDir, async () => ({ reason: "reranker not downloaded yet" }))).toEqual({ hits, reason: "reranker not downloaded yet" });
		const broken = await rerankHits(db, "q", hits, dataDir, loaded({ score: async () => { throw new Error("boom\nmore"); } }));
		expect(broken.hits.map(h => h.id)).toEqual(["a", "b"]);
		expect(broken.reason).toBe("reranking failed: boom");
	});

	test("one hit or none is returned as is without loading anything", async () => {
		const never = async () => { throw new Error("must not load"); };
		expect(await rerankHits(db, "q", [], dataDir, never)).toEqual({ hits: [] });
		expect((await rerankHits(db, "q", [hit("a")], dataDir, never)).hits.map(h => h.id)).toEqual(["a"]);
	});
});
