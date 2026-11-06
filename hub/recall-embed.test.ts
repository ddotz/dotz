// Synthetic sessions and fake network/runtime in temp dirs only: no model is downloaded and no ONNX runtime is loaded.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { embedPending, loadEmbedder, MODEL_NAME, notReadyReason, provision, pruneNative, vectorCount, type ModelFile, type ProvisionDeps } from "./recall-embed.ts";
import { ingest, openRecall, pendingDocs, putVec } from "./recall-index.ts";
import { search } from "./recall-search.ts";

let base = "", dataDir = "", db: Database;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "recall-embed-"));
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

// Pairs of [owner, answer], one hour apart, oldest first.
function sessions(pairs: readonly (readonly [string, string])[]): void {
	const dir = join(base, "sessions", "--proj--");
	mkdirSync(dir, { recursive: true });
	const rows = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-10-01T00:00:00.000Z", cwd: "/proj/app" })];
	pairs.forEach(([owner, answer], i) => {
		const ts = new Date(Date.UTC(2026, 9, 1, i + 1)).toISOString();
		const msg = (role: string, text: string) => JSON.stringify({ type: "message", id: `${role}${i}`, timestamp: ts, message: { role, content: [{ type: "text", text }] } });
		rows.push(msg("user", `[dotz inbox] web msg=q${i}000001 from tester\n${owner}`), msg("assistant", answer));
	});
	writeFileSync(join(dir, "s.jsonl"), `${rows.join("\n")}\n`);
	ingest(db, { roots: [join(base, "sessions")] });
}
const idOf = (needle: string): string => pendingDocs(db, "none", 50).find(d => d.text.includes(needle))?.id ?? "";

describe("provision", () => {
	const file = (body: string): ModelFile => ({ name: "m.bin", url: "https://example.invalid/m.bin", sha256: sha(body) });
	const reply = (body: string) => async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer });
	const deps = (over: Partial<ProvisionDeps> = {}): ProvisionDeps => ({
		dataDir, bun: "/bin/bun", files: [file("model")], fetch: reply("model"),
		run: async (_argv, cwd) => (touch(join(cwd, ...ORT)), touch(join(cwd, ...TOK)), { code: 0, err: "" }),
		...over,
	});

	test("installs the pinned packages without scripts, downloads the model through a temp name, and keeps the folders private", async () => {
		const argvs: { argv: string[]; cwd: string }[] = [];
		const r = await provision(deps({ run: async (argv, cwd) => (argvs.push({ argv, cwd }), touch(join(cwd, ...ORT)), touch(join(cwd, ...TOK)), { code: 0, err: "" }) }));
		expect(r.status).toBe("ok");
		expect(argvs).toEqual([{ argv: ["/bin/bun", "add", "--exact", "--ignore-scripts", "onnxruntime-node@1.31.1", "@huggingface/tokenizers@0.2.0"], cwd: join(dataDir, "recall", "runtime") }]);
		expect(readdirSync(join(dataDir, "recall", "model"))).toEqual(["m.bin"]);
		for (const d of ["runtime", "model"]) expect(statSync(join(dataDir, "recall", d)).mode & 0o777).toBe(0o700);
		expect(existsSync(join(dataDir, "recall", "provision.lock"))).toBe(false);
	});

	test("a sha256 mismatch is rejected: nothing is kept and the failure is recorded", async () => {
		const r = await provision(deps({ fetch: reply("tampered") }));
		expect(r.status).toBe("failed");
		expect(r.reason).toContain("sha256");
		expect(readdirSync(join(dataDir, "recall", "model"))).toEqual([]);
		expect(notReadyReason(dataDir)).toContain("setup failed");
	});

	test("after a failure the next try waits 6 hours, then goes ahead and clears the marker on success", async () => {
		let t = Date.parse("2026-10-01T00:00:00Z");
		let calls = 0;
		const counting = async () => (calls++, { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
		expect((await provision(deps({ fetch: counting, now: () => t }))).status).toBe("failed");
		t += 3600_000;
		expect(await provision(deps({ fetch: counting, now: () => t }))).toMatchObject({ status: "backoff", reason: "download m.bin: HTTP 503" });
		expect(calls).toBe(1);
		t += 5 * 3600_000;
		expect((await provision(deps({ now: () => t }))).status).toBe("ok");
		expect(existsSync(join(dataDir, "recall", "provision-failed.json"))).toBe(false);
	});

	test("a failed bun add is a failure; a second run at the same time backs off, a stale lock is taken over", async () => {
		const r = await provision(deps({ run: async () => ({ code: 1, err: "no network\n" }) }));
		expect(r).toMatchObject({ status: "failed", reason: "bun add exited 1: no network" });
		rmSync(join(dataDir, "recall", "provision-failed.json"));
		const lock = join(dataDir, "recall", "provision.lock");
		writeFileSync(lock, "");
		const fresh = new Date(Date.now());
		utimesSync(lock, fresh, fresh);
		expect((await provision(deps())).status).toBe("busy");
		const old = new Date(Date.now() - 3600_000);
		utimesSync(lock, old, old);
		expect((await provision(deps())).status).toBe("ok");
	});

	test("only this platform's native binaries stay", () => {
		const bin = join(dataDir, "rt", "node_modules", "onnxruntime-node", "bin", "napi-v6");
		for (const p of ["darwin/arm64", "darwin/x64", "linux/x64", "win32/x64"]) touch(join(bin, p, "onnxruntime_binding.node"));
		pruneNative(join(dataDir, "rt"), "darwin", "arm64");
		expect(readdirSync(bin)).toEqual(["darwin"]);
		expect(readdirSync(join(bin, "darwin"))).toEqual(["arm64"]);
	});
});

describe("embedPending", () => {
	const long = (c: string, n: number): string => c.repeat(n);

	test("the text of a doc is the first 500 characters of the owner text, a newline, the first 900 of the answer", () => {
		sessions([[long("o", 700), long("a", 1200)]]);
		expect(pendingDocs(db, "m", 1)[0]?.text).toBe(`${long("o", 500)}\n${long("a", 900)}`);
	});

	test("stops at the budget with the newest docs done, and the next call resumes with the rest", async () => {
		sessions([["first topic", "a"], ["second topic", "b"], ["third topic", "c"]]);
		let clock = 0;
		const e = { model: "m", embed: async () => ((clock += 10), new Float32Array([1, 0])) };
		const a = await embedPending(db, e, 20, () => clock);
		expect(a).toMatchObject({ done: 2, failed: 0, stopped: true });
		expect(pendingDocs(db, "m", 10).map(d => d.text.split("\n")[0])).toEqual(["first topic"]);
		const b = await embedPending(db, e, 100, () => clock);
		expect(b).toMatchObject({ done: 1, stopped: false });
		expect(pendingDocs(db, "m", 10)).toEqual([]);
	});

	test("a doc that cannot be embedded is passed over and does not hold the loop", async () => {
		sessions([["fine one", "a"], ["poison", "b"], ["fine two", "c"]]);
		const e = { model: "m", embed: async (t: string) => { if (t.includes("poison")) throw new Error("bad input"); return new Float32Array([0, 1]); } };
		expect(await embedPending(db, e, 10_000)).toMatchObject({ done: 2, failed: 1, stopped: false, firstError: "bad input" });
		expect(pendingDocs(db, "m", 10).map(d => d.text.split("\n")[0])).toEqual(["poison"]);
		expect(vectorCount(db, "m")).toEqual({ done: 2, total: 3 });
	});
});

describe("fusion", () => {
	const owners = () => search(db, { query: "zebra" }, { mode: "keyword" }).map(h => h.owner);
	const hybrid = (...vecs: number[][]) => search(db, { query: "zebra" }, { mode: "hybrid", queryVecs: vecs.map(v => new Float32Array(v)), model: "m" }).map(h => h.owner.slice(0, 3));

	test("a vector list counts double: the second vector match outranks the top keyword-only match", () => {
		sessions([["zebra crossing question", "x"], ["vee0 nearest", "y"], ["vee1 next", "z"]]);
		putVec(db, idOf("vee0"), "m", new Float32Array([1, 0]));
		putVec(db, idOf("vee1"), "m", new Float32Array([0.9, 0.1]));
		expect(owners()).toEqual(["zebra crossing question"]);
		expect(hybrid([1, 0])).toEqual(["vee", "vee", "zeb"]);
	});

	test("each phrasing adds its own vector list", () => {
		sessions([["zebra topic", "x"], ["left side", "y"], ["right side", "z"]]);
		putVec(db, idOf("left"), "m", new Float32Array([1, 0]));
		putVec(db, idOf("right"), "m", new Float32Array([0, 1]));
		const order = (...v: number[][]) => hybrid(...v).filter(o => o !== "zeb");
		expect(order([1, 0])).toEqual(["lef", "rig"]);
		expect(order([0, 1], [0, 1], [1, 0])).toEqual(["rig", "lef"]);
	});
});

describe("without a model", () => {
	const cli = join(import.meta.dir, "recall-cli.ts");
	const run = async (...args: string[]) => {
		const p = Bun.spawn([process.execPath, cli, ...args], { env: { ...process.env, DOTZ_DIR: dataDir }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { out, err, code };
	};

	test("nothing installed: the reason is plain, no runtime is loaded", async () => {
		expect(notReadyReason(dataDir)).toContain("not downloaded");
		expect(await loadEmbedder(dataDir)).toEqual({ reason: notReadyReason(dataDir) });
	});

	test("search still answers and says keyword only, with or without stored vectors; --keyword needs no note", async () => {
		sessions([["zebra crossing question", "answer text"]]);
		const plain = await run("search", "zebra");
		expect(plain.code).toBe(0);
		expect(plain.out.split("\n")[0]).toBe("(keyword only)");
		expect(plain.out).toContain("zebra crossing question");
		expect(plain.err).toContain("keyword only: no vectors stored yet");
		putVec(db, idOf("zebra"), MODEL_NAME, new Float32Array(768));
		const withVec = await run("search", "zebra");
		expect(withVec.out.split("\n")[0]).toBe("(keyword only)");
		expect(withVec.err).toContain("not downloaded");
		const forced = await run("search", "--keyword", "zebra");
		expect(forced.out).not.toContain("keyword only");
		expect(forced.err).toBe("");
		const status = await run("status");
		expect(status.out).toContain("vectors 1 of 1");
		expect(status.out).toContain("model not ready");
	});

	test("a query that starts with dashes is a query, not a flag", async () => {
		sessions([["zebra crossing question", "answer text"]]);
		expect((await run("search", "--", "--zebra")).out).toContain("zebra crossing question");
	});
});
