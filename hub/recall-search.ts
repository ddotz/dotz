// Context search, query side (docs: recall-index.ts). Each phrasing (the question plus the asker's own rewordings) is run as an OR query
// over the tokenized FTS columns, BM25-ranked with owner text weighted over the answer; the ranks merge by reciprocal rank fusion, and in
// hybrid mode a brute-force cosine pass over the stored vectors joins the fusion. open() re-reads the raw lines so the reader gets the
// original words, not a snippet.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { OPEN_CAP, extractPairs, type RecallCtx } from "./recall-extract.ts";
import { readLines, tokenize } from "./recall-index.ts";
import { maskSecrets } from "./public-scrub.ts";

export interface SearchQuery {
	readonly query: string;
	readonly also?: readonly string[];
	readonly after?: string;
	readonly before?: string;
	readonly project?: string;
	readonly limit?: number;
}
export interface SearchOpts { readonly mode: "keyword" | "hybrid"; readonly queryVecs?: readonly Float32Array[]; readonly model?: string }
export interface Hit { id: string; ts: string; room: string; project: string; kind: string; file: string; line: number; owner: string; answer: string }
export interface OpenedDoc { id: string; ts: string; room: string; project: string; kind: string; file: string; line: number; owner: string; answer: string; prev: string; next: string; rawFound: boolean }

const DAY = 86_400_000;
const SLACK = 6 * 3600_000;
// Measured: k 20, each vector list counts double a keyword list (one vector list per phrasing).
const RRF_K = 20;
const KEYWORD_WEIGHT = 1;
const VECTOR_WEIGHT = 2;
const PROJECT_BOOST = 1.5;
const COMMON_SHARE = 0.4;
const BM25 = "bm25(fts, 5.0, 1.0, 2.0)";

const kst = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

function bound(s: string | undefined, fallback: number, end: boolean): number {
	if (s === undefined) return fallback;
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
	const ms = Date.parse(dateOnly ? `${s}T00:00:00+09:00` : s);
	if (Number.isNaN(ms)) throw new Error(`bad date: ${s}`);
	return end ? ms + (dateOnly ? DAY : 0) + SLACK : ms - SLACK;
}

function usefulTerms(db: Database, phrase: string): string[] {
	const terms = [...new Set(tokenize(phrase))];
	const total = db.query<{ c: number }, []>("SELECT count(*) AS c FROM docs").get()?.c ?? 0;
	if (total < 200) return terms;
	const rare = terms.filter(t => (db.query<{ doc: number }, [string]>("SELECT doc FROM fts_terms WHERE term = ?").get(t)?.doc ?? 0) <= total * COMMON_SHARE);
	return rare.length ? rare : terms;
}

function keywordRanks(db: Database, terms: readonly string[], range: readonly [number, number], pool: number): number[] {
	if (!terms.length) return [];
	const match = terms.map(t => `"${t}"`).join(" OR ");
	return db.query<{ n: number }, [string, number, number, number]>(
		`SELECT d.n AS n FROM fts JOIN docs d ON d.n = fts.rowid WHERE fts MATCH ? AND d.ts_ms BETWEEN ? AND ? ORDER BY ${BM25} LIMIT ?`,
	).all(match, range[0], range[1], pool).map(r => r.n);
}

function unit(v: Float32Array): Float32Array {
	let s = 0;
	for (const x of v) s += x * x;
	const k = s > 0 ? 1 / Math.sqrt(s) : 0;
	return v.map(x => x * k);
}

function vectorRanks(db: Database, queries: readonly Float32Array[], model: string | undefined, range: readonly [number, number], pool: number): number[][] {
	const chosen = model ?? db.query<{ model: string }, []>("SELECT model FROM vecs GROUP BY model ORDER BY count(*) DESC LIMIT 1").get()?.model;
	if (!chosen || !queries.length) return [];
	const rows = db.query<{ n: number; vec: Uint8Array }, [string, number, number]>(
		"SELECT d.n AS n, v.vec AS vec FROM vecs v JOIN docs d ON d.id = v.doc_id WHERE v.model = ? AND d.ts_ms BETWEEN ? AND ?",
	).all(chosen, range[0], range[1]);
	const dim = (queries[0]?.length ?? 0);
	const fit = rows.filter(r => r.vec.byteLength === dim * 4);
	const mat = new Float32Array(fit.length * dim);
	fit.forEach((r, i) => mat.set(unit(new Float32Array(r.vec.slice().buffer)), i * dim));
	return queries.filter(q => q.length === dim).map(q => {
		const qu = unit(q);
		const scores = fit.map((r, i) => {
			let dot = 0;
			for (let j = 0; j < dim; j++) dot += (mat[i * dim + j] ?? 0) * (qu[j] ?? 0);
			return { n: r.n, dot };
		});
		return scores.sort((a, b) => b.dot - a.dot).slice(0, pool).map(s => s.n);
	});
}

function snippet(text: string, needles: readonly string[], width: number): string {
	const lower = text.toLowerCase();
	const at = needles.map(w => lower.indexOf(w)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
	const start = Math.max(0, at - 50);
	const cut = text.slice(start, start + width).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "..." : ""}${cut}${start + width < text.length ? "..." : ""}`;
}

interface DocRow { id: string; n: number; ts_ms: number; room: string; project: string; title: string; kind: string; file: string; line: number; owner: string; answer: string }

export function search(db: Database, q: SearchQuery, opts: SearchOpts): Hit[] {
	const limit = q.limit ?? 8;
	const pool = Math.max(50, limit * 6);
	const range = [bound(q.after, 0, false), bound(q.before, Number.MAX_SAFE_INTEGER, true)] as const;
	const phrases = [q.query, ...(q.also ?? [])];
	const lists = phrases.map(p => ({ weight: KEYWORD_WEIGHT, ranks: keywordRanks(db, usefulTerms(db, p), range, pool) }));
	if (opts.mode === "hybrid") lists.push(...vectorRanks(db, opts.queryVecs ?? [], opts.model, range, pool).map(ranks => ({ weight: VECTOR_WEIGHT, ranks })));
	const score = new Map<number, number>();
	for (const { weight, ranks } of lists) ranks.forEach((n, rank) => score.set(n, (score.get(n) ?? 0) + weight / (RRF_K + rank)));
	const byN = db.query<DocRow, [number]>("SELECT id, n, ts_ms, room, project, title, kind, file, line, owner, answer FROM docs WHERE n = ?");
	const want = q.project?.toLowerCase();
	const needles = [...new Set(phrases.flatMap(p => tokenize(p)))].filter(w => w.length >= 2);
	return [...score.entries()].flatMap(([n, s]) => {
		const d = byN.get(n);
		if (!d) return [];
		const boosted = want && `${d.project} ${d.room} ${d.title}`.toLowerCase().includes(want) ? s * PROJECT_BOOST : s;
		return [{ d, s: boosted }];
	}).sort((a, b) => b.s - a.s).slice(0, limit).map(({ d }) => ({
		id: d.id, ts: kst(d.ts_ms), room: d.room, project: d.project, kind: d.kind, file: d.file, line: d.line,
		owner: snippet(d.owner, needles, 160), answer: snippet(d.answer, needles, 160),
	}));
}

// The raw text is masked like the stored copy (a session file written before the hygiene ran may still hold a secret).
export function openDoc(db: Database, id: string, secrets: readonly string[] = []): OpenedDoc | undefined {
	const d = db.query<DocRow & { off: number; cwd: string; session: string }, [string]>("SELECT * FROM docs WHERE id = ?").get(id);
	if (!d) return undefined;
	const near = (cmp: "<" | ">", order: "DESC" | "ASC") =>
		db.query<{ id: string }, [string, number]>(`SELECT id FROM docs WHERE file = ? AND line ${cmp} ? ORDER BY line ${order} LIMIT 1`).get(d.file, d.line)?.id ?? "";
	const head = { id: d.id, ts: kst(d.ts_ms), room: d.room, project: d.project, kind: d.kind, file: d.file, line: d.line, prev: near("<", "DESC"), next: near(">", "ASC") };
	let raw: { owner: string; answer: string } | undefined;
	if (d.kind !== "note" && existsSync(d.file)) {
		const ctx: RecallCtx = { file: d.file, cwd: d.cwd, session: d.session, title: d.title, convKey: d.project, afterBrief: d.kind !== "brief", ownerCap: OPEN_CAP, answerCap: OPEN_CAP };
		for (const p of extractPairs(readLines(d.file, d.off, d.line, { end: d.off, line: d.line }), ctx)) {
			if (p.id === d.id) raw = { owner: maskSecrets(p.owner, secrets).text, answer: maskSecrets(p.answer, secrets).text };
			break;
		}
	}
	return { ...head, owner: raw?.owner ?? d.owner, answer: raw?.answer ?? d.answer, rawFound: raw !== undefined };
}
