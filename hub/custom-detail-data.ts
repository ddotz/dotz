// What a project's page reads from disk and git for its detail (docs/layers.md §4): the repo state of its folder, the verification
// receipts and a lane's last report. Split from custom.ts, which keeps the view that shapes them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { exec } from "./watch.ts";

export type GitState = { branch: string; base: string; dirty: number; commits: Array<{ hash: string; at: string; subject: string }>; unmerged: Array<{ branch: string; at: string; ahead: number }> };
export type ReceiptIn = { command: string; cwd: string; exitCode: number; ranAt: number };

const gitCache = new Map<string, { at: number; v?: GitState }>();
export async function gitState(dir: string): Promise<GitState | undefined> {
	const hit = gitCache.get(dir);
	if (hit && Date.now() - hit.at < 15_000) return hit.v;
	const run = async (cmd: string) => {
		const r = await exec(["/bin/sh", "-c", cmd], dir, 5000, undefined, 8000).catch(() => undefined);
		return r && r.code === 0 && !r.timedOut ? r.output.trim() : undefined;
	};
	let v: GitState | undefined;
	const branch = existsSync(dir) ? await run("git rev-parse --abbrev-ref HEAD 2>/dev/null") : undefined;
	if (branch) {
		const base = (await run("git rev-parse --verify -q main >/dev/null && echo main")) || branch;
		const [dirty, log5, refs] = await Promise.all([
			run("git status --porcelain 2>/dev/null | wc -l"),
			run("git log -5 --format='%h%x1f%cI%x1f%s'"),
			run(`git for-each-ref --no-merged=${base} --sort=-committerdate --count=8 --format='%(refname:short) %(committerdate:iso-strict)' refs/heads/lane/`),
		]);
		const split = (s?: string) => (s ? s.split("\n").filter(Boolean).map(l => l.split("\x1f")) : []);
		const unmerged = await Promise.all((refs ? refs.split("\n").filter(Boolean).map(l => l.split(" ")) : []).map(async ([b, at]) => ({ branch: b!, at: at!, ahead: Number(await run(`git rev-list --count ${base}..'${b!.replace(/'/g, "")}'`)) || 0 })));
		v = { branch, base, dirty: Number(dirty) || 0, commits: split(log5).map(([hash, at, subject]) => ({ hash: hash!, at: at!, subject: (subject ?? "").slice(0, 200) })), unmerged };
	}
	gitCache.set(dir, { at: Date.now(), v });
	return v;
}

export function readReceipts(): ReceiptIn[] {
	const dir = join(DATA_DIR, "receipts");
	try {
		return readdirSync(dir).filter(f => f.endsWith(".json")).map(f => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 200).flatMap(f => {
			try {
				const r = JSON.parse(readFileSync(f, "utf8"));
				return typeof r.command === "string" && typeof r.cwd === "string" ? [{ command: r.command, cwd: r.cwd, exitCode: Number(r.exitCode), ranAt: Number(r.ranAt) || 0 }] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

export function readReport(name: string): { text: string; at?: string } | undefined {
	const file = join(DATA_DIR, "lanes", name, "report.md");
	try {
		return { text: readFileSync(file, "utf8").slice(0, 4000), at: new Date(statSync(file).mtimeMs).toISOString() };
	} catch {
		return undefined;
	}
}
