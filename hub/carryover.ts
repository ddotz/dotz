// After an update the updater backed up the owner's local changes (hub/selfupdate-local.ts saveLocal: branch dotz-local/<stamp>, or a
// diff + copy folder dotz-local-<stamp>-dirty in the logs dir). At gateway start each backup not yet handled is found here and the
// orchestrator is woken ONCE for it with the backup name, the changed files and a short stat (never the diff). The backup is marked
// handled when the wake is made, in <data dir>/self-update/carryover-handled.json, so a later start does not repeat it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";
import type { Exec } from "./selfupdate.ts";

export type Backup = { id: string; where: string; read: string; stat: string; files: string };
type Handled = Record<string, string>;

const WINDOW_MS = 30 * 86_400_000;
const MAX_WAKES = 3;
const FILE_LINES = 15;
const BRANCH = "dotz-local/";
const handledFile = (dataDir: string) => join(dataDir, "self-update", "carryover-handled.json");

function readHandled(dataDir: string): Handled {
	try {
		return JSON.parse(readFileSync(handledFile(dataDir), "utf8")) ?? {};
	} catch {
		return {};
	}
}
function markHandled(dataDir: string, ids: string[], now: Date): void {
	const h = readHandled(dataDir);
	for (const id of ids) h[id] = now.toISOString();
	mkdirSync(join(dataDir, "self-update"), { recursive: true });
	writeAtomic(handledFile(dataDir), `${JSON.stringify(h, null, 1)}\n`);
}

// "<added>\t<deleted>\t<path>" lines (git numstat) as the file list and one short stat line.
export function summarize(numstat: string): { stat: string; files: string } | undefined {
	const rows = numstat.split("\n").map(l => l.split("\t")).filter(r => r.length >= 3);
	if (!rows.length) return undefined;
	const n = (s: string) => (/^\d+$/.test(s) ? Number(s) : 0);
	const shown = rows.slice(0, FILE_LINES).map(r => `- ${r.slice(2).join("\t")} (+${n(r[0])} -${n(r[1])})`);
	if (rows.length > FILE_LINES) shown.push(`- 외 ${rows.length - FILE_LINES}개`);
	return { stat: `파일 ${rows.length}개, +${rows.reduce((s, r) => s + n(r[0]), 0)} -${rows.reduce((s, r) => s + n(r[1]), 0)}`, files: shown.join("\n") };
}

// The backup time is in the name (saveLocal: YYYYMMDD-HHMM, local time); the file or commit time is only a fallback.
const stampOf = (name: string, fallback: number): number => {
	const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(name);
	return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime() : fallback;
};

/** The backups that still need a wake (newest first, at most MAX_WAKES). Older, empty, already-present or surplus ones are marked handled without a wake. */
export async function pendingBackups(exec: Exec, dir: string, logDir: string, dataDir: string, now = new Date()): Promise<Backup[]> {
	const handled = readHandled(dataDir);
	const found: { id: string; at: number; make: () => Promise<Backup | undefined> }[] = [];
	const refs = await exec(["git", "for-each-ref", "--format=%(refname:short) %(committerdate:unix)", `refs/heads/${BRANCH}`], dir, 15_000);
	for (const line of refs.code === 0 ? refs.out.split("\n") : []) {
		const [branch, unix] = line.trim().split(" ");
		if (!branch || handled[branch]) continue;
		found.push({
			id: branch,
			at: stampOf(branch, Number(unix) * 1000),
			make: async () => {
				const base = (await exec(["git", "merge-base", "HEAD", branch], dir, 15_000)).out.trim();
				if (!base) return undefined;
				// Every commit of it already upstream (same patch): nothing to carry over.
				const cherry = await exec(["git", "cherry", "HEAD", branch], dir, 15_000);
				if (cherry.code === 0 && !cherry.out.split("\n").some(l => l.startsWith("+"))) return undefined;
				const s = summarize((await exec(["git", "-c", "core.quotepath=off", "diff", "--numstat", base, branch], dir, 30_000)).out);
				return s && { id: branch, where: `브랜치 ${branch}`, read: `git diff ${base.slice(0, 12)} ${branch}`, ...s };
			},
		});
	}
	for (const name of existsSync(logDir) ? readdirSync(logDir) : []) {
		const patch = join(logDir, `${name}.patch`);
		if (!/^dotz-local-.*-dirty$/.test(name) || handled[name] || !existsSync(patch)) continue;
		found.push({
			id: name,
			at: stampOf(name, statSync(patch).mtimeMs),
			make: async () => {
				// Already in the files (the new version has it, or the update put it back on top as a local patch): nothing to carry over.
				if ((await exec(["git", "apply", "-R", "--check", patch], dir, 15_000)).code === 0) return undefined;
				const s = summarize((await exec(["git", "apply", "--numstat", patch], dir, 15_000)).out);
				return s && { id: name, where: `패치 ${patch}, 사본 폴더 ${join(logDir, name)}`, read: `cat ${patch}`, ...s };
			},
		});
	}
	found.sort((a, b) => b.at - a.at);
	const wake: Backup[] = [];
	const quiet: string[] = [];
	for (const f of found) {
		const b = wake.length < MAX_WAKES && now.getTime() - f.at <= WINDOW_MS ? await f.make() : undefined;
		if (b) wake.push(b);
		else quiet.push(f.id);
	}
	if (quiet.length || wake.length) markHandled(dataDir, [...quiet, ...wake.map(b => b.id)], now);
	return wake;
}
