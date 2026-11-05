// Context search command line (docs: recall-index.ts, recall-search.ts). Everything is local: index builds or refreshes the SQLite file,
// search/open/status read it, dump writes every doc as JSONL for an evaluator.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { indexPath, ingest, openRecall } from "./recall-index.ts";
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
const BOOLEAN = new Set(["keyword", "json"]);

export function parseArgs(argv: readonly string[]): Args {
	const pos: string[] = [];
	const flags = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
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
	const vecs = one<{ model: string; c: number }>("SELECT model, count(*) c FROM vecs GROUP BY model").map(r => `${r.model}=${r.c}`).join(" ") || "none";
	return [`docs ${total?.c ?? 0} (${kinds || "none"}) from ${total?.lo ?? "-"} to ${total?.hi ?? "-"}`, `by month ${months || "-"}`, `files ${files}, vectors ${vecs}`].join("\n");
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function formatHits(hits: readonly Hit[]): string {
	if (!hits.length) return "no match; try other words, the person's own phrasing, or drop the date and project limits";
	return hits.map((h, i) => {
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

function main(argv: readonly string[]): void {
	const [cmd, ...rest] = argv;
	const { pos, flags } = parseArgs(rest);
	const one = (n: string): string | undefined => flags.get(n)?.[0];
	if (cmd === "index") {
		const budget = one("budget-ms");
		const db = openRecall(DATA_DIR);
		const r = ingest(db, { roots: sessionDirs(), budgetMs: budget ? Number(budget) : undefined, convKeys: convKeys() });
		console.log(`indexed ${r.docs} docs from ${r.files} files, removed ${r.removed} gone files${r.complete ? "" : " (budget reached, run again to continue)"}`);
		return;
	}
	if (cmd === "search") {
		const query = pos.join(" ").trim();
		if (!query) fail("search needs a query");
		const limit = Number(one("limit") ?? 8);
		if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");
		const db = openRecall(DATA_DIR, true);
		const hits = search(db, { query, also: flags.get("also"), after: one("after"), before: one("before"), project: one("project"), limit }, { mode: "keyword" });
		console.log(flags.has("json") ? JSON.stringify(hits) : formatHits(hits));
		return;
	}
	if (cmd === "open") {
		const id = pos[0];
		if (!id) fail("open needs a doc id");
		const doc = openDoc(openRecall(DATA_DIR, true), id as string);
		if (!doc) fail(`no doc ${id}`);
		const d = doc as NonNullable<typeof doc>;
		console.log(`${d.id} ${d.ts} ${d.kind} ${d.room} ${d.project} ${d.file}:${d.line}${d.rawFound ? "" : " (raw text gone, showing the indexed copy)"}\nprev ${d.prev || "-"} next ${d.next || "-"}\n\nOWNER:\n${d.owner}\n\nANSWER:\n${d.answer}`);
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
	fail(`usage: bun hub/recall-cli.ts index|search|open|status|dump (index at ${indexPath(DATA_DIR)})`);
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2));
	} catch (e) {
		fail((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "failed");
	}
}
