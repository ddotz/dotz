// Context search command line (docs: recall-index.ts, recall-search.ts, recall-embed.ts). Everything is local: index builds or refreshes the SQLite file,
// refresh does that plus the meaning vectors within a time budget (the one command the gateway runs, hub/recall-idle.ts), search/open/status read it,
// dump writes every doc as JSONL for an evaluator. Search is hybrid when vectors and the embedder exist, else keyword with a visible note.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { bunBin, embedPending, loadEmbedder, MODEL_NAME, modelReady, notReadyReason, provision, vectorCount } from "./recall-embed.ts";
import { daysDir } from "./day-note-format.ts";
import { secretFileValues } from "./public-scrub.ts";
import { forget, indexPath, ingest, openRecall } from "./recall-index.ts";
import { provisionRerank, rerankHits, rerankReady, RERANK_NAME, RERANK_POOL } from "./recall-rerank.ts";
import { openDoc, search, type Hit } from "./recall-search.ts";

const REPO = resolve(import.meta.dir, "..");
const DATA_DIR = process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
const sessionDirs = (): string[] => [
	join(process.env.OMO_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".omo", "agent"), "sessions"),
	join(homedir(), ".omp", "agent", "sessions"),
];
const fail = (msg: string): never => {
	console.error(`recall: ${msg}`);
	process.exit(1);
};

interface Args { pos: string[]; flags: Map<string, string[]> }
const BOOLEAN = new Set(["keyword", "json", "no-rerank"]);

export function parseArgs(argv: readonly string[]): Args {
	const pos: string[] = [];
	const flags = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
		if (!a.startsWith("--")) { pos.push(a); continue; }
		const name = a.slice(2);
		if (BOOLEAN.has(name)) { flags.set(name, ["1"]); continue; }
		const v = argv[++i];
		if (v === undefined) fail(`--${name} needs a value`);
		flags.set(name, [...(flags.get(name) ?? []), v as string]);
	}
	return { pos, flags };
}

function convKeys(): Map<string, string> {
	const out = new Map<string, string>();
	const own = join(DATA_DIR, "conv-sessions");
	const root = existsSync(own) ? own : join(homedir(), ".dotz", "conv-sessions");
	if (!existsSync(root)) return out;
	for (const key of readdirSync(root)) {
		try {
			const st = JSON.parse(readFileSync(join(root, key, "state.json"), "utf8")) as { sessionFile?: unknown };
			if (typeof st.sessionFile === "string") out.set(st.sessionFile, key);
		} catch (e) {
			if (!(e instanceof Error) || !("code" in e) || e.code !== "ENOENT") continue;
		}
	}
	return out;
}

function status(db: Database): string {
	const one = <T>(sql: string): T[] => db.query<T, []>(sql).all();
	const total = one<{ c: number; lo: string; hi: string }>("SELECT count(*) c, min(ts) lo, max(ts) hi FROM docs WHERE ts != ''")[0];
	const kinds = one<{ kind: string; c: number }>("SELECT kind, count(*) c FROM docs GROUP BY kind").map(r => `${r.kind}=${r.c}`).join(" ");
	const months = one<{ m: string; c: number }>("SELECT substr(ts,1,7) m, count(*) c FROM docs GROUP BY m ORDER BY m").map(r => `${r.m}:${r.c}`).join(" ");
	const files = one<{ c: number }>("SELECT count(*) c FROM files")[0]?.c ?? 0;
	const v = vectorCount(db, MODEL_NAME);
	const why = notReadyReason(DATA_DIR);
	return [
		`docs ${total?.c ?? 0} (${kinds || "none"}) from ${total?.lo ?? "-"} to ${total?.hi ?? "-"}`, `by month ${months || "-"}`,
		`files ${files}, vectors ${v.done} of ${v.total} (${MODEL_NAME})`, `model ${why ? `not ready: ${why}` : "ready"}`,
		`reranker ${rerankReady(DATA_DIR) ? "ready" : "not downloaded yet"} (${RERANK_NAME})`,
	].join("\n");
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function formatHits(hits: readonly Hit[], note = ""): string {
	if (!hits.length) return `${note}no match; try other words, the person's own phrasing, or drop the date and project limits`;
	return note + hits.map((h, i) => {
		const where = [h.room, h.project].filter(Boolean).join(" ");
		return `${i + 1}. ${h.id} ${h.ts} ${h.kind}${where ? ` ${where}` : ""}\n   Q: ${clip(h.owner, 110)}\n   A: ${clip(h.answer, 110)}`;
	}).join("\n");
}

function dump(db: Database, out: string): number {
	const file = resolve(out);
	if (!relative(REPO, file).startsWith("..")) fail("--out must be outside the repository");
	const lines = db.query<Record<string, unknown>, []>("SELECT id, ts, room, project, cwd, session, title, kind, file, line, owner, answer FROM docs ORDER BY ts_ms").all().map(r => JSON.stringify(r));
	writeFileSync(`${file}.tmp`, lines.length ? `${lines.join("\n")}\n` : "");
	renameSync(`${file}.tmp`, file);
	return lines.length;
}

async function refresh(budgetMs: number): Promise<number> {
	const t0 = Date.now();
	const db = openRecall(DATA_DIR);
	const r = ingest(db, { roots: sessionDirs(), budgetMs, convKeys: convKeys(), secrets: secretFileValues(DATA_DIR), notesDir: daysDir() });
	const lines = [`indexed ${r.docs} docs from ${r.files} files, removed ${r.removed} gone files${r.complete ? "" : " (budget reached)"}`];
	let code = 0;
	if (!modelReady(DATA_DIR)) {
		const p = await provision({ dataDir: DATA_DIR, bun: bunBin() });
		lines.push(`model setup: ${p.status}${p.reason ? ` (${p.reason})` : ""}`);
		if (p.status === "failed") code = 2;
	}
	if (!rerankReady(DATA_DIR)) {
		const p = await provisionRerank({ dataDir: DATA_DIR });
		lines.push(`reranker setup: ${p.status}${p.reason ? ` (${p.reason})` : ""}`);
	}
	const { embedder: e, reason } = await loadEmbedder(DATA_DIR);
	if (e) {
		const x = await embedPending(db, e, Math.max(0, budgetMs - (Date.now() - t0)));
		lines.push(`embedded ${x.done}${x.failed ? `, ${x.failed} failed (${x.firstError})` : ""}${x.stopped ? " (budget reached, run again to continue)" : ""}`);
	} else lines.push(`no embedding: ${reason}`);
	const v = vectorCount(db, MODEL_NAME);
	lines.push(`vectors ${v.done} of ${v.total}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	console.log(lines.join("\n"));
	return code;
}

// Hybrid needs stored vectors and a loadable embedder; any miss ends in keyword search with the reason on stderr.
async function queryVectors(db: Database, phrases: readonly string[]): Promise<{ vecs?: Float32Array[]; reason?: string }> {
	if (vectorCount(db, MODEL_NAME).done === 0) return { reason: "no vectors stored yet" };
	const { embedder: e, reason } = await loadEmbedder(DATA_DIR);
	if (!e) return { reason };
	try {
		const vecs: Float32Array[] = [];
		for (const p of phrases) vecs.push(await e.embed(p));
		return { vecs };
	} catch (err) {
		return { reason: `embedding failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}` };
	}
}

async function main(argv: readonly string[]): Promise<void> {
	const [cmd, ...rest] = argv;
	const { pos, flags } = parseArgs(rest);
	const one = (n: string): string | undefined => flags.get(n)?.[0];
	if (cmd === "refresh") {
		const budget = Number(one("budget-ms") ?? 20000);
		if (!Number.isFinite(budget) || budget < 0) fail("--budget-ms must be a number");
		process.exitCode = await refresh(budget);
		return;
	}
	if (cmd === "index") {
		const budget = one("budget-ms");
		const db = openRecall(DATA_DIR);
		const r = ingest(db, { roots: sessionDirs(), budgetMs: budget ? Number(budget) : undefined, convKeys: convKeys(), secrets: secretFileValues(DATA_DIR), notesDir: daysDir() });
		console.log(`indexed ${r.docs} docs from ${r.files} files, removed ${r.removed} gone files${r.complete ? "" : " (budget reached, run again to continue)"}`);
		return;
	}
	if (cmd === "search") {
		const query = pos.join(" ").trim();
		if (!query) fail("search needs a query");
		const limit = Number(one("limit") ?? 8);
		if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");
		const db = openRecall(DATA_DIR, true);
		const q = { query, also: flags.get("also"), after: one("after"), before: one("before"), project: one("project"), limit };
		const forced = flags.has("keyword");
		const { vecs, reason } = forced ? ({} as { vecs?: Float32Array[]; reason?: string }) : await queryVectors(db, [query, ...(q.also ?? [])]);
		if (reason) console.error(`recall: keyword only: ${reason}`);
		const rerank = !forced && !flags.has("no-rerank");
		const found = search(db, { ...q, limit: rerank ? Math.max(limit, RERANK_POOL) : limit }, vecs ? { mode: "hybrid", queryVecs: vecs, model: MODEL_NAME } : { mode: "keyword" });
		const ranked = rerank ? await rerankHits(db, query, found, DATA_DIR) : { hits: found };
		if (ranked.reason) console.error(`recall: not reranked: ${ranked.reason}`);
		const hits = ranked.hits.slice(0, limit);
		console.log(flags.has("json") ? JSON.stringify(hits) : formatHits(hits, vecs || forced ? "" : "(keyword only)\n"));
		return;
	}
	if (cmd === "open") {
		const id = pos[0];
		if (!id) fail("open needs a doc id");
		const doc = openDoc(openRecall(DATA_DIR, true), id as string, secretFileValues(DATA_DIR));
		if (!doc) fail(`no doc ${id}`);
		const d = doc as NonNullable<typeof doc>;
		console.log(`${d.id} ${d.ts} ${d.kind} ${d.room} ${d.project} ${d.file}:${d.line}${d.rawFound ? "" : " (raw text gone, showing the indexed copy)"}\nprev ${d.prev || "-"} next ${d.next || "-"}\n\nOWNER:\n${d.owner}\n\nANSWER:\n${d.answer}`);
		return;
	}
	// The pairs of a session file the hygiene retired (raw file gone) stay until its folder goes or the owner asks: forget <path|session id>.
	if (cmd === "forget") {
		const what = pos[0];
		if (!what) fail("forget needs a session file path or session id");
		console.log(`forgot ${forget(openRecall(DATA_DIR), what as string)} file(s)`);
		return;
	}
	if (cmd === "status") {
		console.log(status(openRecall(DATA_DIR, true)));
		return;
	}
	if (cmd === "dump") {
		const out = one("out");
		if (!out) fail("dump needs --out <file>");
		console.log(`dumped ${dump(openRecall(DATA_DIR, true), out as string)} docs to ${out}`);
		return;
	}
	fail(`usage: bun hub/recall-cli.ts refresh|index|search|open|forget|status|dump (index at ${indexPath(DATA_DIR)})`);
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		() => process.exit(process.exitCode ?? 0),
		e => fail((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "failed"),
	);
}
