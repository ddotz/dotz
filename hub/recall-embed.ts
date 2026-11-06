// Context search, meaning vectors (docs: recall-index.ts, recall-search.ts, recall-cli.ts). The package has no dependencies: the ONNX
// runtime and the model are fetched into <data dir>/recall (runtime/, model/) the first time `refresh` runs, with no switch to turn on.
// provision() installs the two npm packages with exact versions and no install scripts, downloads the model files under a temp name,
// checks their sha256 and renames; a failure leaves a marker so the next try waits 6 hours, and a second run at the same time backs off.
// embedder() loads the runtime by absolute path and returns undefined (with a reason) when anything is missing, so every caller falls back
// to keyword search. Conversation text never leaves the machine: only the runtime and the model come in.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pendingDocs, putVec } from "./recall-index.ts";

export const MODEL_NAME = "ko-sroberta-multitask@8fca7c9:qint8";
const REPO_URL = "https://huggingface.co/jhgan/ko-sroberta-multitask/resolve/8fca7c9c98c26599be0e14b9916b11a756a26f19";
export interface ModelFile { readonly name: string; readonly url: string; readonly sha256: string }
export const MODEL_FILES: readonly ModelFile[] = [
	{ name: "model_qint8_avx512_vnni.onnx", url: `${REPO_URL}/onnx/model_qint8_avx512_vnni.onnx`, sha256: "ddd6107a06385baf8a76a1ccbfd8718c684a1a751708db116061069a1224ffd6" },
	{ name: "tokenizer.json", url: `${REPO_URL}/tokenizer.json`, sha256: "70f194d3bd8fc273ee0bca77b49404c6230ebaca2cfe0af04d6b82964e054660" },
	{ name: "tokenizer_config.json", url: `${REPO_URL}/tokenizer_config.json`, sha256: "f534522d501e985fd55c18a97cf90674fbbdbf736d4c6b0ab14cd2f86cc96d7f" },
];
export const RUNTIME_PACKAGES = ["onnxruntime-node@1.31.1", "@huggingface/tokenizers@0.2.0"] as const;
export const ORT_ENTRY = ["node_modules", "onnxruntime-node", "dist", "index.js"];
export const TOKENIZER_ENTRY = ["node_modules", "@huggingface", "tokenizers", "dist", "tokenizers.mjs"];
const MAX_TOKENS = 256;
const DIMS = 768;
export const RETRY_AFTER_MS = 6 * 3600_000;
const LOCK_STALE_MS = 30 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export const recallDir = (dataDir: string): string => join(dataDir, "recall");
export const runtimeDir = (dataDir: string): string => join(recallDir(dataDir), "runtime");
const modelDir = (dataDir: string): string => join(recallDir(dataDir), "model");
const markerPath = (dataDir: string): string => join(recallDir(dataDir), "provision-failed.json");
const lockPath = (dataDir: string): string => join(recallDir(dataDir), "provision.lock");

/** The bun that runs this code, or the one on PATH when the host is some other binary. */
export function bunBin(execPath: string = process.execPath, which: (name: string) => string | null = n => Bun.which(n)): string {
	return /^bun(\.exe)?$/i.test(basename(execPath)) ? execPath : (which("bun") ?? "bun");
}

export function privateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

export function modelReady(dataDir: string): boolean {
	return MODEL_FILES.every(f => existsSync(join(modelDir(dataDir), f.name))) && existsSync(join(runtimeDir(dataDir), ...ORT_ENTRY)) && existsSync(join(runtimeDir(dataDir), ...TOKENIZER_ENTRY));
}

export interface FailureMarker { at: number; reason: string }
export function provisionFailure(dataDir: string): FailureMarker | undefined {
	try {
		const m = JSON.parse(readFileSync(markerPath(dataDir), "utf8")) as Partial<FailureMarker>;
		return typeof m.at === "number" && typeof m.reason === "string" ? { at: m.at, reason: m.reason } : undefined;
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
		return undefined;
	}
}

function writeMarker(dataDir: string, m: FailureMarker): void {
	const tmp = `${markerPath(dataDir)}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(m));
	renameSync(tmp, markerPath(dataDir));
}

export interface RunResult { code: number; err: string }
export interface ProvisionDeps {
	readonly dataDir: string;
	readonly bun?: string;
	readonly fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "arrayBuffer">>;
	readonly run?: (argv: string[], cwd: string) => Promise<RunResult>;
	readonly now?: () => number;
	readonly files?: readonly ModelFile[];
	readonly platform?: { os: string; arch: string };
}
export interface ProvisionResult { status: "ok" | "failed" | "backoff" | "busy"; reason?: string }

async function defaultRun(argv: string[], cwd: string): Promise<RunResult> {
	const p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: INSTALL_TIMEOUT_MS });
	const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
	return { code, err };
}

/** Only this machine's native onnxruntime binaries stay: the package ships every platform, about 200 MB more. */
export function pruneNative(runtime: string, os: string, arch: string): void {
	const bin = join(runtime, "node_modules", "onnxruntime-node", "bin");
	if (!existsSync(bin)) return;
	for (const napi of readdirSync(bin)) {
		const base = join(bin, napi);
		if (!statSync(base).isDirectory()) continue;
		for (const platform of readdirSync(base)) {
			if (platform !== os) { rmSync(join(base, platform), { recursive: true, force: true }); continue; }
			for (const a of readdirSync(join(base, platform))) if (a !== arch) rmSync(join(base, platform, a), { recursive: true, force: true });
		}
	}
}

async function installRuntime(d: Required<Pick<ProvisionDeps, "bun" | "run">> & { runtime: string; os: string; arch: string }): Promise<void> {
	privateDir(d.runtime);
	const manifest = join(d.runtime, "package.json");
	if (!existsSync(manifest)) {
		const tmp = `${manifest}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify({ name: "recall-runtime", private: true }));
		renameSync(tmp, manifest);
	}
	if (!existsSync(join(d.runtime, ...ORT_ENTRY)) || !existsSync(join(d.runtime, ...TOKENIZER_ENTRY))) {
		const r = await d.run([d.bun, "add", "--exact", "--ignore-scripts", ...RUNTIME_PACKAGES], d.runtime);
		if (r.code !== 0) throw new Error(`bun add exited ${r.code}: ${r.err.trim().split("\n").pop() ?? ""}`);
	}
	pruneNative(d.runtime, d.os, d.arch);
}

export async function downloadModel(dir: string, files: readonly ModelFile[], fetchFn: NonNullable<ProvisionDeps["fetch"]> = (url, init) => fetch(url, init)): Promise<void> {
	privateDir(dir);
	for (const f of files) {
		const dest = join(dir, f.name);
		if (existsSync(dest)) continue;
		const res = await fetchFn(f.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`download ${f.name}: HTTP ${res.status}`);
		const data = Buffer.from(await res.arrayBuffer());
		const got = createHash("sha256").update(data).digest("hex");
		if (got !== f.sha256) throw new Error(`download ${f.name}: sha256 ${got.slice(0, 12)} is not the expected ${f.sha256.slice(0, 12)}`);
		const tmp = `${dest}.tmp-${process.pid}`;
		writeFileSync(tmp, data, { mode: 0o600 });
		renameSync(tmp, dest);
	}
}

function takeLock(dataDir: string, now: number): boolean {
	const file = lockPath(dataDir);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			closeSync(openSync(file, "wx", 0o600));
			return true;
		} catch (e) {
			if (!(e instanceof Error) || !("code" in e) || e.code !== "EEXIST") throw e;
			if (now - statSync(file).mtimeMs <= LOCK_STALE_MS) return false;
			rmSync(file, { force: true });
		}
	}
	return false;
}

export async function provision(deps: ProvisionDeps): Promise<ProvisionResult> {
	const { dataDir } = deps;
	const now = deps.now ?? Date.now;
	if (modelReady(dataDir)) return { status: "ok" };
	privateDir(recallDir(dataDir));
	const failed = provisionFailure(dataDir);
	if (failed && now() - failed.at < RETRY_AFTER_MS) return { status: "backoff", reason: failed.reason };
	if (!takeLock(dataDir, Date.now())) return { status: "busy", reason: "another provision is running" };
	try {
		await installRuntime({ bun: deps.bun ?? bunBin(), run: deps.run ?? defaultRun, runtime: runtimeDir(dataDir), os: deps.platform?.os ?? process.platform, arch: deps.platform?.arch ?? process.arch });
		await downloadModel(modelDir(dataDir), deps.files ?? MODEL_FILES, deps.fetch);
		rmSync(markerPath(dataDir), { force: true });
		return { status: "ok" };
	} catch (e) {
		const reason = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "failed";
		writeMarker(dataDir, { at: now(), reason });
		return { status: "failed", reason };
	} finally {
		rmSync(lockPath(dataDir), { force: true });
	}
}

export interface Embedder { readonly model: string; embed(text: string): Promise<Float32Array> }
type Loaded = { embedder?: Embedder; reason?: string };

interface Tensor { data: Float32Array; dims: number[] }
interface Session { inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>> }

/** Why the meaning search is not available right now, from files alone (cheap enough for `status`). */
export function notReadyReason(dataDir: string, now: number = Date.now()): string | undefined {
	if (modelReady(dataDir)) return undefined;
	const f = provisionFailure(dataDir);
	if (f) return `setup failed ${new Date(f.at).toISOString().slice(0, 16)}Z: ${f.reason}${now - f.at < RETRY_AFTER_MS ? " (retries after 6 hours)" : ""}`;
	return "model not downloaded yet (bun hub/recall-cli.ts refresh)";
}

export async function loadEmbedder(dataDir: string): Promise<Loaded> {
	const reason = notReadyReason(dataDir);
	if (reason) return { reason };
	try {
		const rt = runtimeDir(dataDir);
		const ortMod = (await import(join(rt, ...ORT_ENTRY))) as { default?: unknown };
		const ort = (ortMod.default ?? ortMod) as { InferenceSession: { create(file: string, opts: object): Promise<Session> }; Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown };
		const { Tokenizer } = (await import(join(rt, ...TOKENIZER_ENTRY))) as { Tokenizer: new (json: unknown, config: unknown) => { encode(text: string): { ids: ArrayLike<number> } } };
		const dir = modelDir(dataDir);
		const tok = new Tokenizer(JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")), JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")));
		const session = await ort.InferenceSession.create(join(dir, "model_qint8_avx512_vnni.onnx"), { executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1, enableCpuMemArena: false });
		const big = (a: number[]) => new ort.Tensor("int64", BigInt64Array.from(a.map(BigInt)), [1, a.length]);
		const embed = async (text: string): Promise<Float32Array> => {
			const ids = Array.from(tok.encode(text).ids).slice(0, MAX_TOKENS);
			const feeds: Record<string, unknown> = { input_ids: big(ids), attention_mask: big(ids.map(() => 1)) };
			if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = big(ids.map(() => 0));
			const out = await session.run(feeds);
			let v: Float32Array;
			if (out.sentence_embedding) v = Float32Array.from(out.sentence_embedding.data);
			else {
				const h = out.last_hidden_state ?? out[session.outputNames[0] ?? ""];
				if (!h) throw new Error("model returned no hidden state");
				const [, n = 0, d = 0] = h.dims;
				v = new Float32Array(d);
				for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) v[j] = (v[j] ?? 0) + (h.data[i * d + j] ?? 0);
			}
			if (v.length !== DIMS) throw new Error(`model gave ${v.length} dimensions, expected ${DIMS}`);
			let s = 0;
			for (const x of v) s += x * x;
			const k = 1 / (Math.sqrt(s) || 1);
			return v.map(x => x * k);
		};
		return { embedder: { model: MODEL_NAME, embed } };
	} catch (e) {
		return { reason: `runtime failed to load: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
	}
}

export async function embedder(dataDir: string): Promise<Embedder | undefined> {
	return (await loadEmbedder(dataDir)).embedder;
}

export function vectorCount(db: Database, model: string): { done: number; total: number } {
	const total = db.query<{ c: number }, []>("SELECT count(*) AS c FROM docs").get()?.c ?? 0;
	const done = db.query<{ c: number }, [string]>("SELECT count(*) AS c FROM vecs v JOIN docs d ON d.id = v.doc_id WHERE v.model = ?").get(model)?.c ?? 0;
	return { done, total };
}

export interface EmbedResult { done: number; failed: number; stopped: boolean; firstError?: string }
const BATCH = 16;

/** Newest docs first. Stops at the budget; the next call resumes at what is still pending. A doc that fails is passed over for the rest of this call, so one bad doc cannot hold the loop. */
export async function embedPending(db: Database, e: Pick<Embedder, "model" | "embed">, budgetMs: number, now: () => number = Date.now): Promise<EmbedResult> {
	const deadline = now() + budgetMs;
	const bad = new Set<string>();
	const r: EmbedResult = { done: 0, failed: 0, stopped: false };
	for (;;) {
		const batch = pendingDocs(db, e.model, BATCH + bad.size).filter(d => !bad.has(d.id)).slice(0, BATCH);
		if (!batch.length) return r;
		for (const d of batch) {
			if (now() >= deadline) return { ...r, stopped: true };
			try {
				putVec(db, d.id, e.model, await e.embed(d.text));
				r.done++;
			} catch (err) {
				bad.add(d.id);
				r.failed++;
				r.firstError ??= (err instanceof Error ? err.message : String(err)).split("\n")[0];
			}
		}
	}
}
