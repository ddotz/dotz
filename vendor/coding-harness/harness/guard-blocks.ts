import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { logsDir } from "./agent-home.ts";
import type { BlockRow } from "./guard/block-log.ts";

const DAY_MS = 86_400_000;
const WRAPPERS: Record<string, true> = { sudo: true, env: true, time: true, nice: true, nohup: true, command: true, exec: true, timeout: true, xargs: true };
const SUBCOMMANDS: Record<string, true> = { git: true, gh: true, bun: true, bunx: true, npx: true, npm: true, pnpm: true, yarn: true, cargo: true, wrangler: true, docker: true };

/** The command a bash block was about, after `cd x &&`, env assignments and wrappers: the command word, plus the verb for git, gh, bun, npm and the other commands whose first argument says what they do (`git push` and `git commit` are different heads). */
export function commandHead(command: string): string {
	const words = command.replace(/^(\s*cd\s+[^\s;&]+\s*(&&|;)\s*)+/, "").trim().split(/\s+/);
	let i = 0;
	while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS[basename(words[i])] === true || (i > 0 && /^(-|\d+$)/.test(words[i])))) i++;
	const name = basename((words[i] ?? "").replace(/;+$/, ""));
	if (SUBCOMMANDS[name] !== true) return name || "(empty)";
	let verb = i + 1;
	while (verb < words.length && words[verb].startsWith("-")) verb += words[verb] === "-C" || words[verb] === "-c" ? 2 : 1;
	return words[verb] ? `${name} ${words[verb]}` : name;
}

export function parseRows(text: string): BlockRow[] {
	const rows: BlockRow[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const fields: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
		const { at, phase, agentKind, cwd, tool, target } = fields;
		if (typeof at === "string" && typeof phase === "string" && typeof agentKind === "string" && typeof cwd === "string" && typeof tool === "string" && typeof target === "string") {
			rows.push({ at, phase, agentKind, cwd, tool, target });
		}
	}
	return rows;
}

const byCountThenName = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);

export function summarize(rows: BlockRow[], days: number, now: number): string {
	const recent = rows.filter(row => Date.parse(row.at) >= now - days * DAY_MS);
	if (!recent.length) return `guard blocks, last ${days} day(s): none`;
	const phases = new Map<string, BlockRow[]>();
	for (const row of recent) phases.set(row.phase, [...(phases.get(row.phase) ?? []), row]);
	const lines = [`guard blocks, last ${days} day(s): ${recent.length}`];
	for (const [phase, count] of [...phases].map(([name, group]): [string, number] => [name, group.length]).sort(byCountThenName)) {
		lines.push(`${String(count).padStart(5)}  ${phase}`);
		const heads = new Map<string, number>();
		for (const row of phases.get(phase) ?? []) {
			const head = row.tool === "bash" ? commandHead(row.target) : row.tool;
			heads.set(head, (heads.get(head) ?? 0) + 1);
		}
		for (const [head, n] of [...heads].sort(byCountThenName).slice(0, 5)) lines.push(`${String(n).padStart(9)}  ${head}`);
	}
	return lines.join("\n");
}

/**
 * The summary over `<dir>/guard-blocks.jsonl.1` (the rotated, older half) and `<dir>/guard-blocks.jsonl`, read in that order.
 * The log holds one JSON line per block (see guard/block-log.ts) and is rotated to guard-blocks.jsonl.1 at 5 MiB.
 * ORCH_GUARD_LOG_DIR moves the directory; the default is the `logs` directory under the harness directory of this copy.
 * `bun harness/guard-blocks.ts [days]` prints blocks per phase over the last N days (default 7) and per phase the five most frequent command heads.
 */
export function summarizeLog(dir: string, days: number, now: number): string {
	const files = [join(dir, "guard-blocks.jsonl.1"), join(dir, "guard-blocks.jsonl")].filter(file => existsSync(file));
	if (!files.length) return `no block log yet (${join(dir, "guard-blocks.jsonl")})`;
	return summarize(files.flatMap(file => parseRows(readFileSync(file, "utf8"))), days, now);
}

if (import.meta.main) {
	const days = Number(process.argv[2] ?? 7);
	if (!Number.isFinite(days) || days <= 0) {
		console.error("usage: bun harness/guard-blocks.ts [days]   (default 7)");
		process.exit(2);
	}
	console.log(summarizeLog(process.env.ORCH_GUARD_LOG_DIR ?? logsDir(), days, Date.now()));
}
