// Context search, reranker (docs: recall-search.ts, recall-embed.ts, recall-cli.ts). The fused order decides which turns are candidates; a small
// multilingual cross-encoder then reads the question together with each of the top candidates and puts them in order of how well they answer it.
// Files come the same way as the embedding model: under <data dir>/recall/rerank, sha256 pinned, a failed download waits 6 hours, and the
// ONNX runtime is the one recall-embed.ts already installed. Anything missing or failing leaves the fused order as it was.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hit } from "./recall-search.ts";
import { downloadModel, ORT_ENTRY, privateDir, recallDir, RETRY_AFTER_MS, runtimeDir, TOKENIZER_ENTRY, type FailureMarker, type ModelFile, type ProvisionDeps } from "./recall-embed.ts";

export const RERANK_NAME = "mmarco-mMiniLMv2-L12-H384-v1@1427fd6:qint8";
const REPO_URL = "https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/resolve/1427fd652930e4ba29e8149678df786c240d8825";
const MODEL_FILE = "model_qint8_avx512_vnni.onnx";
export const RERANK_FILES: readonly ModelFile[] = [
	{ name: MODEL_FILE, url: `${REPO_URL}/onnx/${MODEL_FILE}`, sha256: "1825907d6c1a9001ff78124780bbde20a614a8c3df3b63409cf3c72c6fe5c8b4" },
	{ name: "tokenizer.json", url: `${REPO_URL}/tokenizer.json`, sha256: "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626" },
	{ name: "tokenizer_config.json", url: `${REPO_URL}/tokenizer_config.json`, sha256: "e7fbfbfa6347b4e414c1cee50d142e2c2f9a895dad68b068ae83a8b564c3837e" },
];
/** How many of the top fused candidates the reranker reads. */
export const RERANK_POOL = 30;
const DOC_OWNER_CHARS = 300;
const DOC_ANSWER_CHARS = 500;
const MAX_TOKENS = 512;

const rerankDir = (dataDir: string): string => join(recallDir(dataDir), "rerank");
const markerPath = (dataDir: string): string => join(recallDir(dataDir), "rerank-failed.json");

export function rerankReady(dataDir: string): boolean {
	return RERANK_FILES.every(f => existsSync(join(rerankDir(dataDir), f.name))) && existsSync(join(runtimeDir(dataDir), ...ORT_ENTRY)) && existsSync(join(runtimeDir(dataDir), ...TOKENIZER_ENTRY));
}

function failure(dataDir: string): FailureMarker | undefined {
	try {
		const m = JSON.parse(readFileSync(markerPath(dataDir), "utf8")) as Partial<FailureMarker>;
		return typeof m.at === "number" && typeof m.reason === "string" ? { at: m.at, reason: m.reason } : undefined;
	} catch {
		return undefined;
	}
}

export interface RerankProvisionDeps { readonly dataDir: string; readonly fetch?: ProvisionDeps["fetch"]; readonly now?: () => number; readonly files?: readonly ModelFile[] }

/** Downloads the reranker files once the runtime is there. Never throws: the result says what happened. */
export async function provisionRerank(deps: RerankProvisionDeps): Promise<{ status: "ok" | "failed" | "backoff" | "waiting"; reason?: string }> {
	const now = deps.now ?? Date.now;
	const files = deps.files ?? RERANK_FILES;
	const dir = rerankDir(deps.dataDir);
	if (files.every(f => existsSync(join(dir, f.name)))) return { status: "ok" };
	if (!existsSync(join(runtimeDir(deps.dataDir), ...ORT_ENTRY))) return { status: "waiting", reason: "runtime not installed yet" };
	const failed = failure(deps.dataDir);
	if (failed && now() - failed.at < RETRY_AFTER_MS) return { status: "backoff", reason: failed.reason };
	try {
		await downloadModel(dir, files, deps.fetch);
		rmSync(markerPath(deps.dataDir), { force: true });
		return { status: "ok" };
	} catch (e) {
		const reason = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "failed";
		privateDir(recallDir(deps.dataDir));
		const tmp = `${markerPath(deps.dataDir)}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify({ at: now(), reason }));
		renameSync(tmp, markerPath(deps.dataDir));
		return { status: "failed", reason };
	}
}

export interface Reranker { score(query: string, docs: readonly string[]): Promise<number[]> }
type Loaded = { reranker?: Reranker; reason?: string };

export async function loadReranker(dataDir: string): Promise<Loaded> {
	if (!rerankReady(dataDir)) return { reason: "reranker not downloaded yet" };
	try {
		const rt = runtimeDir(dataDir);
		const ortMod = (await import(join(rt, ...ORT_ENTRY))) as { default?: unknown };
		const ort = (ortMod.default ?? ortMod) as {
			InferenceSession: { create(file: string, opts: object): Promise<{ inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> }> };
			Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
		};
		const { Tokenizer } = (await import(join(rt, ...TOKENIZER_ENTRY))) as {
			Tokenizer: new (json: unknown, config: unknown) => { encode(text: string, opts: { text_pair: string; add_special_tokens: boolean }): { ids: ArrayLike<number>; type_ids?: ArrayLike<number> } };
		};
		const dir = rerankDir(dataDir);
		const tok = new Tokenizer(JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")), JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")));
		const session = await ort.InferenceSession.create(join(dir, MODEL_FILE), { executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1, enableCpuMemArena: false });
		const big = (a: number[]) => new ort.Tensor("int64", BigInt64Array.from(a.map(BigInt)), [1, a.length]);
		const one = async (query: string, doc: string): Promise<number> => {
			const enc = tok.encode(query, { text_pair: doc, add_special_tokens: true });
			const ids = Array.from(enc.ids).slice(0, MAX_TOKENS);
			const feeds: Record<string, unknown> = { input_ids: big(ids), attention_mask: big(ids.map(() => 1)) };
			if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = big(Array.from(enc.type_ids ?? ids.map(() => 0)).slice(0, MAX_TOKENS));
			const out = await session.run(feeds);
			const logit = (out.logits ?? out[session.outputNames[0] ?? ""])?.data[0];
			if (logit === undefined || !Number.isFinite(logit)) throw new Error("reranker returned no score");
			return logit;
		};
		return { reranker: { score: async (query, docs) => { const s: number[] = []; for (const d of docs) s.push(await one(query, d)); return s; } } };
	} catch (e) {
		return { reason: `reranker failed to load: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
	}
}

/** The text the reranker reads for a doc: the start of the owner's words and the start of the answer. */
export function rerankDocs(db: Database, ids: readonly string[]): string[] {
	const q = db.query<{ owner: string; answer: string }, [string]>("SELECT owner, answer FROM docs WHERE id = ?");
	return ids.map(id => {
		const d = q.get(id);
		return d ? `${d.owner.slice(0, DOC_OWNER_CHARS)}\n${d.answer.slice(0, DOC_ANSWER_CHARS)}` : "";
	});
}

/** The top RERANK_POOL hits in the reranker's order, the rest as they were; the fused order plus a reason when the reranker is missing or fails. */
export async function rerankHits(db: Database, query: string, hits: readonly Hit[], dataDir: string, load: typeof loadReranker = loadReranker): Promise<{ hits: Hit[]; reason?: string }> {
	if (hits.length < 2) return { hits: [...hits] };
	const { reranker, reason } = await load(dataDir);
	if (!reranker) return { hits: [...hits], reason };
	try {
		const head = hits.slice(0, RERANK_POOL);
		const ids = head.map(h => h.id);
		const byId = new Map(head.map(h => [h.id, h]));
		const order = orderByScore(ids, await reranker.score(query, rerankDocs(db, ids)));
		return { hits: [...order.map(id => byId.get(id) as Hit), ...hits.slice(RERANK_POOL)] };
	} catch (e) {
		return { hits: [...hits], reason: `reranking failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
	}
}

/** The ids ordered by score, best first; equal scores keep the fused order. */
export function orderByScore(ids: readonly string[], scores: readonly number[]): string[] {
	return ids.map((id, i) => ({ id, i, s: scores[i] ?? Number.NEGATIVE_INFINITY })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.id);
}
