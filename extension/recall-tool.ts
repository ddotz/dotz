// dotz_recall: search the owner's past conversations (hub/recall-cli.ts). Deferred (exposure "search"): no schema in the prompt, found through
// tool search. It runs the CLI as a child and imports nothing from hub/ (the extension->hub edge ceiling). It only reads the local index.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

const CLI = join(import.meta.dir, "..", "hub", "recall-cli.ts");
const TIMEOUT_MS = 20_000;

export interface RecallParams { query?: string; also?: string[]; after?: string; before?: string; project?: string; limit?: number; open?: string }

export const RECALL_DESCRIPTION = `Search the owner's past conversations (this machine only) for what was said, decided or done earlier. Work out the period, project and topic from your current context first. query: plain words. also: 2 or 3 other phrasings, in words the original conversation likely used. after/before (YYYY-MM-DD): only from a real time hint, with a margin. project: name of the project or room. Results are short and each starts with an id: call again with open=<id> for the raw text, open the best candidates and answer from the raw text. If nothing fits, say it was not found; do not guess.`;

/** The CLI arguments for a call: `open` alone when set, else a search; the query goes after `--` so it can never read as a flag. */
export function recallArgv(p: RecallParams): string[] {
	if (p.open) return ["open", p.open];
	const args = ["search"];
	for (const a of p.also ?? []) if (a.trim()) args.push("--also", a);
	if (p.after) args.push("--after", p.after);
	if (p.before) args.push("--before", p.before);
	if (p.project) args.push("--project", p.project);
	if (p.limit !== undefined) args.push("--limit", String(Math.trunc(p.limit)));
	return [...args, "--", (p.query ?? "").trim()];
}

/** The host may be a compiled binary, so process.execPath is bun only when it is named so; otherwise the first bun on PATH or in the usual places. */
export function findBun(execPath: string, env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync): string {
	if (/^bun(\.exe)?$/i.test(basename(execPath))) return execPath;
	const dirs = [...(env.PATH ?? "").split(delimiter), join(env.HOME ?? homedir(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
	return dirs.filter(Boolean).map(d => join(d, "bun")).find(exists) ?? "bun";
}

export type RunCli = (argv: string[], dataDir: string) => Promise<string>;

export const runCli: RunCli = (argv, dataDir) =>
	new Promise(resolve => {
		execFile(findBun(process.execPath, process.env), [CLI, ...argv], { timeout: TIMEOUT_MS, maxBuffer: 1 << 20, env: { ...process.env, DOTZ_DIR: dataDir } }, (err, stdout, stderr) => {
			if (!err) return resolve(stdout.trim() || "no output");
			resolve(`recall failed: ${(stderr.trim() || stdout.trim() || err.message).split("\n").slice(-3).join(" ")}`);
		});
	});

export function recallTool(pi: any, dataDir: string, run: RunCli = runCli): void {
	const z = pi.zod;
	pi.registerTool({
		name: "dotz_recall",
		label: "Dotz recall",
		description: RECALL_DESCRIPTION,
		exposure: "search",
		searchText: "recall search past conversations earlier discussion history what did we say decide mail finance project",
		parameters: z.object({
			query: z.string().optional(),
			also: z.array(z.string()).optional(),
			after: z.string().optional(),
			before: z.string().optional(),
			project: z.string().optional(),
			limit: z.number().min(1).max(20).optional(),
			open: z.string().optional(),
		}),
		async execute(_id: string, p: RecallParams) {
			if (!p.open && !(p.query ?? "").trim()) return { content: [{ type: "text", text: "recall failed: give a query, or open=<id> from an earlier result" }] };
			return { content: [{ type: "text", text: await run(recallArgv(p), dataDir) }] };
		},
	});
}
