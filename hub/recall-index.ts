// Context search, index (docs: recall-extract.ts, recall-search.ts, recall-cli.ts). A local SQLite file (<dataDir>/recall/index.db, WAL,
// owner-only) of owner/answer pairs from the OmO/omp session files. Bun's SQLite has FTS5 but cannot load extensions, so the vectors
// another worker computes live as BLOBs in `vecs` and are searched by brute force. Text goes into FTS5 as pre-tokenized columns
// (Latin words as they are, Hangul runs as the word plus overlapping bigrams, so particles do not break a match and two-letter words match).
// ingest() is incremental: each file resumes at the start of its last unclosed pair, a shrunk or replaced file is read whole, a deleted
// file takes its docs with it, and a time budget stops it between pairs so the next call carries on.
// Secrets are masked before a pair is stored (maskSecrets, hub/public-scrub.ts); an index built before that is masked once (MASK_VERSION).
// A file the session hygiene retired past its retention (retireFile, files.kept = 1) keeps its pairs after the raw file is gone, so an old
// conversation stays findable; deleting its session folder, or `recall-cli forget`, still removes them.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEMP_PATH } from "./live-guard.ts";
import { parseNote } from "./day-note-format.ts";
import { msg } from "./i18n.ts";
import { maskSecrets } from "./public-scrub.ts";
import { ANSWER_CAP, EXTRACT_VERSION, extractPairs, OWNER_CAP, sessionHeader, type Pair, type RawLine, type RecallCtx } from "./recall-extract.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs(n INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, file TEXT NOT NULL, line INTEGER, off INTEGER, entry TEXT, ts TEXT, ts_ms INTEGER,
	room TEXT, project TEXT, cwd TEXT, session TEXT, title TEXT, kind TEXT, owner TEXT, answer TEXT, text_hash TEXT);
CREATE INDEX IF NOT EXISTS docs_file ON docs(file, line);
CREATE INDEX IF NOT EXISTS docs_ts ON docs(ts_ms);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(owner, answer, meta, tokenize='unicode61 remove_diacritics 0', detail=column);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_terms USING fts5vocab(fts, row);
CREATE TABLE IF NOT EXISTS msgs(msg_id TEXT PRIMARY KEY, doc_n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER, mtime REAL, head TEXT, tail TEXT, off INTEGER, line INTEGER, cwd TEXT, session TEXT, title TEXT,
	skip INTEGER, complete INTEGER, after_brief INTEGER);
CREATE TABLE IF NOT EXISTS vecs(doc_id TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY(doc_id, model));
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);`;

export const indexPath = (dataDir: string): string => join(dataDir, "recall", "index.db");

export function openRecall(dataDir: string, readOnly = false): Database {
	const file = indexPath(dataDir);
	if (readOnly) {
		if (!existsSync(file)) throw new Error(`no recall index at ${file}; run: bun hub/recall-cli.ts index`);
		const ro = new Database(file, { readonly: true });
		ro.exec("PRAGMA busy_timeout = 5000");
		return ro;
	}
	mkdirSync(join(dataDir, "recall"), { recursive: true, mode: 0o700 });
	chmodSync(join(dataDir, "recall"), 0o700);
	const db = new Database(file, { create: true });
	chmodSync(file, 0o600);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
	db.exec(SCHEMA);
	if (!db.query<{ name: string }, []>("PRAGMA table_info(files)").all().some(c => c.name === "kept")) db.exec("ALTER TABLE files ADD COLUMN kept INTEGER");
	return db;
}

const CJK = "\\uAC00-\\uD7A3\\u4E00-\\u9FFF\\u3040-\\u30FF";
const WORDS = new RegExp(`([${CJK}]+)|((?:(?![${CJK}])[\\p{L}\\p{N}])+)`, "gu");

export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const m of text.toLowerCase().matchAll(WORDS)) {
		const cjk = m[1];
		if (cjk === undefined) {
			const w = m[2] ?? "";
			if (w.length <= 40 && (w.length > 1 || /\d/.test(w))) out.push(w);
			continue;
		}
		if (cjk.length === 1) continue;
		if (cjk.length > 2) out.push(cjk);
		for (let i = 0; i + 2 <= cjk.length; i++) out.push(cjk.slice(i, i + 2));
	}
	return out;
}

const sha = (data: string | Buffer): string => createHash("sha1").update(data).digest("base64");

const MAX_LINE_BYTES = 16 << 20;
interface ReadState { end: number; line: number }

export function* readLines(file: string, start: number, startLine: number, state: ReadState): Generator<RawLine> {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(1 << 20);
		let carry: Buffer[] = [], carryLen = 0, skipping = false;
		let pos = start, lineStart = start, line = startLine;
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, pos);
			if (n <= 0) return;
			const chunk = buf.subarray(0, n);
			let s = 0;
			for (;;) {
				const nl = chunk.indexOf(10, s);
				if (nl < 0) {
					carryLen += n - s;
					if (carryLen > MAX_LINE_BYTES) { carry = []; skipping = true; carryLen = 0; }
					else if (!skipping) carry.push(Buffer.from(chunk.subarray(s)));
					break;
				}
				const text = skipping ? "" : carry.length ? Buffer.concat([...carry, chunk.subarray(s, nl)]).toString("utf8") : chunk.toString("utf8", s, nl);
				yield { text, line, offset: lineStart };
				lineStart = pos + nl + 1;
				state.end = lineStart;
				state.line = ++line;
				carry = []; carryLen = 0; skipping = false;
				s = nl + 1;
			}
			pos += n;
		}
	} finally {
		closeSync(fd);
	}
}

function readBytes(file: string, at: number, len: number): Buffer {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(len);
		return buf.subarray(0, readSync(fd, buf, 0, len, Math.max(0, at)));
	} finally {
		closeSync(fd);
	}
}

const tailOf = (file: string, off: number): string => (off > 0 ? sha(readBytes(file, off - 256, Math.min(256, off))) : "");

function deleteDoc(db: Database, n: number): void {
	const id = db.query<{ id: string }, [number]>("SELECT id FROM docs WHERE n = ?").get(n)?.id;
	if (id !== undefined) db.query("DELETE FROM vecs WHERE doc_id = ?").run(id);
	db.query("DELETE FROM fts WHERE rowid = ?").run(n);
	db.query("DELETE FROM msgs WHERE doc_n = ?").run(n);
	db.query("DELETE FROM docs WHERE n = ?").run(n);
}

function removeFile(db: Database, path: string): void {
	for (const r of db.query<{ n: number }, [string]>("SELECT n FROM docs WHERE file = ?").all(path)) deleteDoc(db, r.n);
	db.query("DELETE FROM files WHERE path = ?").run(path);
}

interface DocRow { n: number; answer: string; ts_ms: number; file: string; text_hash: string }

// The same message id in two sessions is one doc: the one with an answer wins, then the earlier, then the smaller path.
function winsOver(a: { answer: string; ts_ms: number; file: string }, b: { answer: string; ts_ms: number; file: string }): boolean {
	if (!a.answer !== !b.answer) return a.answer !== "";
	return a.ts_ms !== b.ts_ms ? a.ts_ms < b.ts_ms : a.file <= b.file;
}

function upsertPair(db: Database, raw: Pair, file: string, secrets: readonly string[]): void {
	const p = { ...raw, owner: maskSecrets(raw.owner, secrets).text, answer: maskSecrets(raw.answer, secrets).text, title: maskSecrets(raw.title, secrets).text };
	const tsMs = Date.parse(p.ts) || 0;
	const textHash = sha(`${p.owner}\0${p.answer}`);
	const mine = db.query<DocRow, [string]>("SELECT n, answer, ts_ms, file, text_hash FROM docs WHERE id = ?").get(p.id);
	const incoming = { answer: p.answer, ts_ms: tsMs, file };
	for (const msgId of p.msgIds) {
		const other = db.query<DocRow, [string, number]>("SELECT d.n, d.answer, d.ts_ms, d.file, d.text_hash FROM msgs m JOIN docs d ON d.n = m.doc_n WHERE m.msg_id = ? AND d.n != ?").get(msgId, mine?.n ?? -1);
		if (!other) continue;
		if (winsOver(other, incoming)) {
			if (mine) deleteDoc(db, mine.n);
			return;
		}
		deleteDoc(db, other.n);
	}
	let n = mine?.n;
	const cols = [p.line, p.offset, p.entry, p.ts, tsMs, p.room, p.project, p.cwd, p.session, p.title, p.kind, p.owner, p.answer, textHash] as const;
	if (n === undefined) {
		n = Number(db.query("INSERT INTO docs(id, file, line, off, entry, ts, ts_ms, room, project, cwd, session, title, kind, owner, answer, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(p.id, file, ...cols).lastInsertRowid);
	} else {
		if (mine?.text_hash !== textHash) db.query("DELETE FROM vecs WHERE doc_id = ?").run(p.id);
		db.query("UPDATE docs SET line=?, off=?, entry=?, ts=?, ts_ms=?, room=?, project=?, cwd=?, session=?, title=?, kind=?, owner=?, answer=?, text_hash=? WHERE n = ?").run(...cols, n);
		db.query("DELETE FROM fts WHERE rowid = ?").run(n);
	}
	putFts(db, n, p);
	for (const msgId of p.msgIds) db.query("INSERT OR REPLACE INTO msgs(msg_id, doc_n) VALUES (?, ?)").run(msgId, n);
}

function putFts(db: Database, n: number, p: { owner: string; answer: string; title: string; project: string; room: string; kind: string }): void {
	db.query("INSERT INTO fts(rowid, owner, answer, meta) VALUES (?, ?, ?, ?)").run(n, tokenize(p.owner).join(" "), tokenize(p.answer).join(" "), tokenize(`${p.title} ${p.project} ${p.room} ${p.kind}`).join(" "));
}

// Bumped when the masking rules change: ingest() then re-masks every stored doc once.
export const MASK_VERSION = "1";

// Masks the stored text of every doc and rewrites its FTS row; a changed doc loses its vectors, so pendingDocs re-embeds it.
export function maskExisting(db: Database, secrets: readonly string[]): { docs: number; changed: number; hits: Record<string, number> } {
	const hits: Record<string, number> = {};
	let docs = 0, changed = 0;
	db.exec("BEGIN");
	try {
		for (const d of db.query<{ n: number; id: string; owner: string; answer: string; title: string; project: string; room: string; kind: string }, []>("SELECT n, id, owner, answer, title, project, room, kind FROM docs").all()) {
			docs++;
			const [o, a, t] = [d.owner, d.answer, d.title].map(s => maskSecrets(s ?? "", secrets)) as [ReturnType<typeof maskSecrets>, ReturnType<typeof maskSecrets>, ReturnType<typeof maskSecrets>];
			if (o.text === (d.owner ?? "") && a.text === (d.answer ?? "") && t.text === (d.title ?? "")) continue;
			changed++;
			for (const r of [o, a, t]) for (const [k, v] of Object.entries(r.hits)) hits[k] = (hits[k] ?? 0) + v;
			db.query("UPDATE docs SET owner = ?, answer = ?, title = ?, text_hash = ? WHERE n = ?").run(o.text, a.text, t.text, sha(`${o.text}\0${a.text}`), d.n);
			db.query("DELETE FROM fts WHERE rowid = ?").run(d.n);
			putFts(db, d.n, { ...d, owner: o.text, answer: a.text, title: t.text });
			db.query("DELETE FROM vecs WHERE doc_id = ?").run(d.id);
		}
		db.query("INSERT OR REPLACE INTO meta(k, v) VALUES ('mask', ?)").run(MASK_VERSION);
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
	return { docs, changed, hits };
}

// Called by the session hygiene before it deletes a raw file past its retention: true (and the file's pairs are kept for good) only
// when the index holds the whole file as it is now, so nothing unindexed is lost with it.
export function retireFile(db: Database, path: string): boolean {
	if (!existsSync(path)) return false;
	const st = statSync(path);
	const row = db.query<{ size: number; mtime: number; complete: number }, [string]>("SELECT size, mtime, complete FROM files WHERE path = ?").get(path);
	if (!row || row.complete !== 1 || row.size !== st.size || row.mtime !== st.mtimeMs) return false;
	db.query("UPDATE files SET kept = 1 WHERE path = ?").run(path);
	return true;
}

// Deliberate deletion of a retired file's pairs (its raw file is gone): by its path or its session id. Returns the files removed.
export function forget(db: Database, pathOrSession: string): number {
	const rows = db.query<{ path: string }, [string, string]>("SELECT path FROM files WHERE path = ? OR session = ?").all(pathOrSession, pathOrSession);
	for (const r of rows) removeFile(db, r.path);
	return rows.length;
}

export interface IngestOpts { readonly roots: readonly string[]; readonly budgetMs?: number; readonly convKeys?: ReadonlyMap<string, string>; readonly secrets?: readonly string[]; /** The day notes folder (hub/day-note.ts): each section of a note is one doc. */ readonly notesDir?: string }
export interface IngestResult { files: number; docs: number; removed: number; complete: boolean }
interface FileRow { size: number; mtime: number; head: string; tail: string; off: number; line: number; cwd: string; session: string; title: string; skip: number; complete: number; after_brief: number }
interface Stat { path: string; size: number; mtime: number }

function sessionFiles(roots: readonly string[]): Stat[] {
	const out: Stat[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const d of readdirSync(root, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			for (const f of readdirSync(join(root, d.name))) {
				if (!f.endsWith(".jsonl")) continue;
				const path = join(root, d.name, f);
				const st = statSync(path);
				out.push({ path, size: st.size, mtime: st.mtimeMs });
			}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

const FILE_COLS = "path, size, mtime, head, tail, off, line, cwd, session, title, skip, complete, after_brief";

function saveRow(db: Database, path: string, r: FileRow): void {
	db.query(`INSERT OR REPLACE INTO files(${FILE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(path, r.size, r.mtime, r.head, r.tail, r.off, r.line, r.cwd, r.session, r.title, r.skip, r.complete, r.after_brief);
}

// Returns the docs written; a file read to the end is complete, one stopped by the budget resumes at the pair it did not write.
function ingestFile(db: Database, st: Stat, deadline: number, convKeys: ReadonlyMap<string, string> | undefined, secrets: readonly string[]): number {
	const row = db.query<FileRow, [string]>(`SELECT ${FILE_COLS} FROM files WHERE path = ?`).get(st.path);
	if (row && row.complete === 1 && row.size === st.size && row.mtime === st.mtime) return 0;
	const headBytes = readBytes(st.path, 0, 4096);
	const head = sha(headBytes.subarray(0, 512));
	const header = sessionHeader(headBytes.toString("utf8").split("\n")[0] ?? "");
	const whole = !row || st.size < row.size || row.head !== head || row.tail !== tailOf(st.path, row.off);
	if (row && whole) removeFile(db, st.path);
	const base = { size: st.size, mtime: st.mtime, head };
	if (whole && (!header || TEMP_PATH.test(header.cwd))) {
		saveRow(db, st.path, { ...base, tail: "", off: st.size, line: 1, cwd: header?.cwd ?? "", session: header?.session ?? "", title: "", skip: 1, complete: 1, after_brief: 0 });
		return 0;
	}
	if (!whole && row?.skip === 1) {
		saveRow(db, st.path, { ...row, ...base });
		return 0;
	}
	const start = whole ? { off: 0, line: 1, cwd: header?.cwd ?? "", session: header?.session ?? "", title: "", after_brief: 0 } : (row as FileRow);
	const ctx: RecallCtx = { file: st.path, cwd: start.cwd, session: start.session, title: start.title, convKey: convKeys?.get(st.path) ?? "", afterBrief: start.after_brief === 1, ownerCap: OWNER_CAP, answerCap: ANSWER_CAP };
	const state: ReadState = { end: start.off, line: start.line };
	let next: { off: number; line: number; cwd: string; session: string; title: string; after_brief: number; complete: number } | undefined;
	let docs = 0;
	db.exec("BEGIN");
	try {
		for (const p of extractPairs(readLines(st.path, start.off, start.line, state), ctx)) {
			const stopped = !p.open && Date.now() > deadline;
			if (stopped || p.open) next = { off: p.offset, line: p.line, cwd: p.cwd, session: p.session, title: p.title, after_brief: p.afterBrief ? 1 : 0, complete: stopped ? 0 : 1 };
			if (stopped) break;
			upsertPair(db, p, st.path, secrets);
			docs++;
		}
		const fin = next ?? { off: state.end, line: state.line, cwd: start.cwd, session: start.session, title: start.title, after_brief: start.after_brief, complete: 1 };
		saveRow(db, st.path, { ...base, ...fin, tail: tailOf(st.path, fin.off), skip: 0 });
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
	return docs;
}

// A day note is not a session file: it has no row in `files`, its docs are found by their file, and it is read again only when its size or time changed.
function ingestNotes(db: Database, dir: string, secrets: readonly string[]): number {
	const seen = new Set<string>();
	let docs = 0;
	if (existsSync(dir)) {
		for (const name of readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort()) {
			const path = join(dir, name);
			seen.add(path);
			const st = statSync(path);
			const stamp = `${st.size}:${st.mtimeMs}:${MASK_VERSION}`;
			if (db.query<{ v: string }, [string]>("SELECT v FROM meta WHERE k = ?").get(`note:${path}`)?.v === stamp) continue;
			const note = parseNote(readFileSync(path, "utf8"));
			db.exec("BEGIN");
			try {
				for (const r of db.query<{ n: number }, [string]>("SELECT n FROM docs WHERE file = ?").all(path)) deleteDoc(db, r.n);
				for (const [i, s] of (note?.sections ?? []).entries()) {
					const owner = maskSecrets(`${note!.day} ${msg().dayNote.headings[s.key]}`, secrets).text;
					const answer = maskSecrets(s.lines.join("\n"), secrets).text;
					const tsMs = note!.windowEnd;
					const p = { owner, answer, title: `day note ${note!.day}`, project: "day-note", room: "memory", kind: "note" };
					const n = Number(db.query("INSERT INTO docs(id, file, line, off, entry, ts, ts_ms, room, project, cwd, session, title, kind, owner, answer, text_hash) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?)")
						.run(sha(`note:${note!.day}#${s.key}`), path, i + 1, `${note!.day}#${s.key}`, new Date(tsMs).toISOString(), tsMs, p.room, p.project, p.title, p.kind, owner, answer, sha(`${owner}\0${answer}`)).lastInsertRowid);
					putFts(db, n, p);
					docs++;
				}
				db.query("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)").run(`note:${path}`, stamp);
				db.exec("COMMIT");
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		}
	}
	for (const r of db.query<{ k: string }, []>("SELECT k FROM meta WHERE k LIKE 'note:%'").all()) {
		const path = r.k.slice(5);
		if (seen.has(path)) continue;
		for (const d of db.query<{ n: number }, [string]>("SELECT n FROM docs WHERE file = ?").all(path)) deleteDoc(db, d.n);
		db.query("DELETE FROM meta WHERE k = ?").run(r.k);
	}
	return docs;
}

export function ingest(db: Database, opts: IngestOpts): IngestResult {
	const deadline = Date.now() + (opts.budgetMs ?? Number.POSITIVE_INFINITY);
	const result: IngestResult = { files: 0, docs: 0, removed: 0, complete: true };
	if (db.query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'extract'").get()?.v !== EXTRACT_VERSION) {
		// A retired file cannot be read again, so its pairs stay as they were extracted.
		for (const r of db.query<{ path: string }, []>("SELECT path FROM files WHERE kept IS NOT 1").all()) removeFile(db, r.path);
		db.query("INSERT OR REPLACE INTO meta(k, v) VALUES ('extract', ?)").run(EXTRACT_VERSION);
	}
	const secrets = opts.secrets ?? [];
	if (db.query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'mask'").get()?.v !== MASK_VERSION) maskExisting(db, secrets);
	for (const r of db.query<{ path: string; kept: number | null }, []>("SELECT path, kept FROM files").all()) {
		// A retired file's pairs go only with its session folder (a deliberate deletion: the folder, or the project's sessions).
		if (existsSync(r.path) || (r.kept === 1 && existsSync(dirname(r.path)))) continue;
		removeFile(db, r.path);
		result.removed++;
	}
	for (const st of sessionFiles(opts.roots)) {
		if (Date.now() > deadline) { result.complete = false; break; }
		const docs = ingestFile(db, st, deadline, opts.convKeys, secrets);
		result.files++;
		result.docs += docs;
		if (Date.now() > deadline && !db.query("SELECT 1 FROM files WHERE path = ? AND complete = 1").get(st.path)) result.complete = false;
	}
	if (opts.notesDir) result.docs += ingestNotes(db, opts.notesDir, secrets);
	return result;
}

// One vector per doc, measured: the first 500 characters of the owner text, a newline, the first 900 of the answer.
export const EMBED_OWNER_CHARS = 500;
export const EMBED_ANSWER_CHARS = 900;

export function pendingDocs(db: Database, model: string, limit: number): { id: string; text: string }[] {
	return db.query<{ id: string; text: string }, [string, number]>(
		`SELECT d.id AS id, substr(d.owner, 1, ${EMBED_OWNER_CHARS}) || char(10) || substr(d.answer, 1, ${EMBED_ANSWER_CHARS}) AS text FROM docs d WHERE NOT EXISTS (SELECT 1 FROM vecs v WHERE v.doc_id = d.id AND v.model = ?) ORDER BY d.ts_ms DESC LIMIT ?`,
	).all(model, limit);
}

export function putVec(db: Database, id: string, model: string, vec: Float32Array): void {
	db.query("INSERT OR REPLACE INTO vecs(doc_id, model, vec) VALUES (?, ?, ?)").run(id, model, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
}
