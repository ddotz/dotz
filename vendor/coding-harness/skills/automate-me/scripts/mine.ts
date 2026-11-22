#!/usr/bin/env bun
// Pre-extracts what the user typed into omp, before any model reads a transcript.
// Source of truth: ~/.omp/agent/history.db (only interactive input lands there; gateway lanes, subagent briefs and tool
// results do not). Each prompt is paired with the end of the assistant reply it answered, read from its session file.
// Claude Code transcripts are not mined: on this machine most "user" turns there are tool results and gateway shims.
// Usage: bun mine.ts [--since YYYY-MM-DD] [--out FILE]
// Output: JSONL rows {ts, cwd, session, prev, text}; summary on stderr.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const sinceArg = args[args.indexOf("--since") + 1];
const since = args.includes("--since") ? Date.parse(sinceArg) : 0;
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const agentDir = join(homedir(), ".omp", "agent");
// Scratch and gateway working dirs: probes and the dotz gateway, not the user's own work.
const SKIP_CWD = /^(\/tmp|\/private\/|\/var\/folders)|\/\.dotz(\/|$)/;

interface SessionLine {
	type?: string;
	message?: { role?: string; stopReason?: string; content?: unknown };
}

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map(b => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : "")).join("")
			: "";

// session id -> (user text -> the final assistant text right before it)
function previousReplies(sessionId: string): Map<string, string> {
	const replies = new Map<string, string>();
	const sessions = join(agentDir, "sessions");
	for (const dir of readdirSync(sessions)) {
		const file = readdirSync(join(sessions, dir)).find(n => n.endsWith(`${sessionId}.jsonl`));
		if (!file) continue;
		let prev = "";
		for (const line of readFileSync(join(sessions, dir, file), "utf8").split("\n")) {
			if (!line.includes('"role"')) continue;
			const entry = JSON.parse(line) as SessionLine; // omp's own session format, written by the runtime
			const m = entry.message;
			if (entry.type !== "message" || !m) continue;
			if (m.role === "assistant" && (m.stopReason === "stop" || m.stopReason === "length")) prev = textOf(m.content);
			if (m.role === "user") replies.set(textOf(m.content).trim(), prev.length > 500 ? `...${prev.slice(-500)}` : prev);
		}
		break;
	}
	return replies;
}

const db = join(agentDir, "history.db");
if (!existsSync(db)) {
	console.error(`no history at ${db}`);
	process.exit(1);
}
const prompts = new Database(db, { readonly: true })
	.query("select prompt, created_at, cwd, session_id from history where created_at >= ? order by created_at")
	.all(Math.floor(since / 1000)) as { prompt: string; created_at: number; cwd: string | null; session_id: string | null }[];

const cache = new Map<string, Map<string, string>>();
const rows: string[] = [];
const byCwd = new Map<string, number>();
let skipped = 0;
for (const p of prompts) {
	const cwd = p.cwd ?? "";
	if (SKIP_CWD.test(cwd)) {
		skipped++;
		continue;
	}
	const text = p.prompt.trim();
	let prev = "";
	if (p.session_id) {
		if (!cache.has(p.session_id)) cache.set(p.session_id, previousReplies(p.session_id));
		prev = cache.get(p.session_id)?.get(text) ?? "";
	}
	rows.push(JSON.stringify({ ts: new Date(p.created_at * 1000).toISOString(), cwd, session: p.session_id, prev, text }));
	byCwd.set(cwd, (byCwd.get(cwd) ?? 0) + 1);
}

if (out) writeFileSync(out, rows.length ? `${rows.join("\n")}\n` : "");
else if (rows.length) console.log(rows.join("\n"));
console.error(`${rows.length} prompts kept, ${skipped} skipped (scratch or gateway cwd), from ${byCwd.size} working dirs`);
for (const [cwd, n] of [...byCwd].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.error(`  ${n}\t${cwd || "(unknown)"}`);
