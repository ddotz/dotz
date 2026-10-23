// Local work on a git install, for selfupdate.ts: which local commits are already upstream, a trial rebase of the rest in a temporary
// worktree (the live checkout is never touched), and the safe copy (branch dotz-local/<YYYYMMDD-HHMM> + patch files in the logs dir)
// that is made before anything of the owner's is moved aside.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Commit, Exec } from "./selfupdate.ts";

export const SEP = "\x1f";
export const FORMAT = `--format=%H${SEP}%h${SEP}%cI${SEP}%s`;
export const parseCommits = (out: string): Commit[] =>
	out
		.split("\n")
		.filter(l => l.includes(SEP))
		.map(l => {
			const [sha, short, date, ...rest] = l.split(SEP);
			return { sha, short, date, subject: rest.join(SEP).slice(0, 200) };
		});
const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
const lastOf = (s: string) => lines(s).pop()?.slice(0, 300) ?? "";

export type Saved = { tag: string; branch?: string; patch?: string; dirtyPatch?: string; filesDir?: string };
// Local work the update cannot carry over by itself: shown with a button (settings → 업데이트) and in the notice.
export type Keep = { line: string; commits: Commit[]; dirty: string[]; saved?: Saved };

// Is this checkout one the owner develops in (never auto-discard its local work)? self_update.keep_local says so explicitly; else an
// install.sh --git clone (marker .git/dotz-install) or the default install folder is not a developer checkout.
export function keepsLocal(dir: string, flag: unknown, env: Record<string, string | undefined> = process.env): boolean {
	if (typeof flag === "boolean") return flag;
	if (existsSync(join(dir, ".git", "dotz-install"))) return false;
	const real = (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			return resolve(p);
		}
	};
	return real(dir) !== real(env.DOTZ_HOME || join(homedir(), ".local", "share", "dotz"));
}

// The code folder of this install when the bot must not change it (not a developer checkout, same rule as above), else undefined.
// Shared by the guards (hub/codeguard.ts): reads self_update.keep_local from <dataDir>/config.json itself, so it runs in any process.
export function lockedCodeDir(dataDir: string, dir = join(import.meta.dir, ".."), env: Record<string, string | undefined> = process.env): string | undefined {
	let flag: unknown;
	try {
		flag = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).self_update?.keep_local;
	} catch {
		flag = undefined;
	}
	return keepsLocal(dir, flag, env) ? undefined : resolve(dir);
}

// Local commits split into those upstream already has (same patch-id per `git cherry`) and the rest, oldest first.
export async function splitEquivalent(exec: Exec, dir: string, upstream: string): Promise<{ dropped: Commit[]; rest: Commit[] }> {
	const [all, cherry] = await Promise.all([exec(["git", "log", "--reverse", "--topo-order", FORMAT, `${upstream}..HEAD`], dir, 30_000), exec(["git", "cherry", upstream, "HEAD"], dir, 30_000)]);
	const same = new Set(lines(cherry.out).filter(l => l.startsWith("- ")).map(l => l.slice(2).trim()));
	const commits = parseCommits(all.out);
	return { dropped: commits.filter(c => same.has(c.sha)), rest: commits.filter(c => !same.has(c.sha)) };
}

export type Trial =
	| { ok: true; wt: string; sha: string; kept: Commit[]; emptied: Commit[]; close: () => Promise<void> }
	| { ok: false; reason: string };

// Re-applies `commits` one by one on `to` in a temporary detached worktree. A commit whose changes upstream already contains
// applies to nothing and is dropped (`emptied`). The caller closes a successful trial (after running its checks in `wt`).
export async function openTrial(exec: Exec, dir: string, to: string, commits: Commit[]): Promise<Trial> {
	const tmp = mkdtempSync(join(tmpdir(), "dotz-rebase-"));
	const wt = join(tmp, "wt");
	const close = async () => {
		await exec(["git", "worktree", "remove", "--force", wt], dir, 60_000);
		await exec(["git", "worktree", "prune"], dir, 15_000);
		rmSync(tmp, { recursive: true, force: true });
	};
	const fail = async (reason: string): Promise<Trial> => {
		await close();
		return { ok: false, reason };
	};
	const add = await exec(["git", "worktree", "add", "--detach", wt, to], dir, 60_000);
	if (add.code !== 0) return fail(`임시 작업 폴더를 만들지 못했어요: ${lastOf(add.out)}`);
	const hasId = (await exec(["git", "config", "user.email"], dir, 15_000)).out.trim() !== "";
	const id = ["-c", "commit.gpgsign=false", ...(hasId ? [] : ["-c", "user.name=dotz", "-c", "user.email=dotz@localhost"])];
	const kept: Commit[] = [];
	const emptied: Commit[] = [];
	for (const c of commits) {
		const parents = await exec(["git", "rev-list", "--parents", "-n", "1", c.sha], dir, 15_000);
		if (parents.out.trim().split(/\s+/).length > 2) return fail(`${c.short}은(는) 병합 커밋이라 자동으로 얹을 수 없어요`);
		const pick = await exec(["git", "cherry-pick", "--no-commit", c.sha], wt, 60_000);
		if (pick.code !== 0) {
			const files = lines((await exec(["git", "diff", "--name-only", "--diff-filter=U"], wt, 15_000)).out).slice(0, 3);
			await exec(["git", "cherry-pick", "--quit"], wt, 15_000);
			return fail(`${c.short}이(가) 새 버전과 충돌해요${files.length ? ` (${files.join(", ")})` : ""}`);
		}
		if ((await exec(["git", "diff", "--cached", "--quiet"], wt, 15_000)).code === 0) {
			emptied.push(c);
			await exec(["git", "reset", "-q", "--hard"], wt, 15_000);
			continue;
		}
		const done = await exec(["git", ...id, "commit", "-q", "--no-verify", "-C", c.sha], wt, 60_000);
		if (done.code !== 0) return fail(`${c.short}을(를) 커밋하지 못했어요: ${lastOf(done.out)}`);
		kept.push(c);
	}
	const sha = (await exec(["git", "rev-parse", "HEAD"], wt, 15_000)).out.trim();
	return { ok: true, wt, sha, kept, emptied, close };
}

const two = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
const PREFIX = "dotz-local/";

// Saves the commits (branch + mbox patch) and/or the uncommitted changes (diff + a plain copy of every changed and untracked file)
// into branch/logs before the caller moves anything. Saving the same state again reuses the earlier copy.
export async function saveLocal(exec: Exec, dir: string, logDir: string, commits: Commit[], dirty: boolean, now = new Date()): Promise<Saved> {
	mkdirSync(logDir, { recursive: true });
	const saved: Saved = { tag: stamp(now) };
	if (commits.length) {
		const have = lines((await exec(["git", "for-each-ref", "--points-at", "HEAD", "--format=%(refname:short)", `refs/heads/${PREFIX}`], dir, 15_000)).out)[0];
		let branch = have;
		if (!branch) {
			let name = `${PREFIX}${saved.tag}`;
			for (let n = 2; (await exec(["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`], dir, 15_000)).code === 0; n++) name = `${PREFIX}${saved.tag}-${n}`;
			const b = await exec(["git", "branch", name, "HEAD"], dir, 15_000);
			if (b.code !== 0) throw new Error(`보관 브랜치를 만들지 못했어요: ${lastOf(b.out)}`);
			branch = name;
		}
		saved.branch = branch;
		const patch = join(logDir, `dotz-local-${branch.slice(PREFIX.length)}.patch`);
		if (!existsSync(patch)) {
			let mbox = "";
			for (const c of commits) mbox += (await exec(["sh", "-c", 'git format-patch -1 --stdout "$1"', "sh", c.sha], dir, 30_000)).out.replace(/\s*$/, "\n");
			writeFileSync(patch, mbox);
		}
		saved.patch = patch;
	}
	if (dirty) {
		const [tracked, untracked] = await Promise.all([exec(["git", "-c", "core.quotepath=off", "diff", "HEAD", "--name-only"], dir, 15_000), exec(["git", "-c", "core.quotepath=off", "ls-files", "-o", "--exclude-standard"], dir, 15_000)]);
		const files = [...new Set([...lines(tracked.out), ...lines(untracked.out)])].filter(f => existsSync(join(dir, f)) && statSync(join(dir, f)).isFile());
		const tmpPatch = join(logDir, `.dotz-local-${process.pid}.tmp`);
		await exec(["sh", "-c", 'git diff HEAD --binary > "$1"', "sh", tmpPatch], dir, 30_000);
		const hash = new Bun.CryptoHasher("sha256").update(readFileSync(tmpPatch));
		for (const f of files) hash.update(f).update(readFileSync(join(dir, f)));
		const sig = hash.digest("hex");
		const same = readdirSync(logDir).find(n => /^dotz-local-.*-dirty$/.test(n) && existsSync(join(logDir, n, "SIG")) && readFileSync(join(logDir, n, "SIG"), "utf8") === sig);
		if (same) {
			rmSync(tmpPatch, { force: true });
			saved.filesDir = join(logDir, same);
			saved.dirtyPatch = join(logDir, `${same}.patch`);
			saved.tag = same.slice("dotz-local-".length, -"-dirty".length);
		} else {
			let base = `dotz-local-${saved.tag}-dirty`;
			for (let n = 2; existsSync(join(logDir, base)); n++) base = `dotz-local-${saved.tag}-${n}-dirty`;
			saved.filesDir = join(logDir, base);
			saved.dirtyPatch = join(logDir, `${base}.patch`);
			for (const f of files) {
				mkdirSync(dirname(join(saved.filesDir, "files", f)), { recursive: true });
				copyFileSync(join(dir, f), join(saved.filesDir, "files", f));
			}
			mkdirSync(saved.filesDir, { recursive: true });
			writeFileSync(join(saved.filesDir, "SIG"), sig);
			writeFileSync(saved.dirtyPatch, readFileSync(tmpPatch));
			rmSync(tmpPatch, { force: true });
		}
	}
	return saved;
}

// One Korean line for the owner after a button/auto move: what was saved and how to get it back.
export function savedNote(s: Saved, upstream: string): string {
	const where = [s.branch && `브랜치 ${s.branch}`, s.patch && `패치 ${s.patch}`, s.filesDir && `사본 폴더 ${s.filesDir}`].filter(Boolean).join(", ");
	const back = s.branch ? `\`git cherry-pick ${upstream}..${s.branch}\`` : s.dirtyPatch ? `\`git apply ${s.dirtyPatch}\`` : "";
	return `내 수정은 ${where}에 보관했고, 터미널에서 ${back}를 실행하면 다시 얹을 수 있어요.`;
}

// A short Korean summary per saved commit (files, gist), written to <dataDir>/self-update/ so the bot can re-create the personal parts
// in the custom layer. Returns the file and its text.
export async function writeSavedSummary(exec: Exec, dir: string, dataDir: string, commits: Commit[], saved: Saved): Promise<{ file: string; text: string; turn: string }> {
	const items: string[] = [];
	for (const c of commits) {
		const files = lines((await exec(["git", "-c", "core.quotepath=off", "show", "--format=", "--name-only", c.sha], dir, 15_000)).out);
		items.push(`- ${c.short} ${c.subject.slice(0, 80)}: 파일 ${files.length}개 (${files.slice(0, 5).join(", ")}${files.length > 5 ? " 외" : ""})`);
	}
	const text = `보관한 로컬 커밋 ${commits.length}개${saved.branch ? ` (브랜치 ${saved.branch}${saved.patch ? `, 패치 ${saved.patch}` : ""})` : ""}\n${items.join("\n")}\n`;
	const folder = join(dataDir, "self-update");
	mkdirSync(folder, { recursive: true });
	const file = join(folder, `local-${saved.tag}.md`);
	writeFileSync(file, text);
	const turn = `[dotz 업데이트] 이 설치에서 dotz 코드가 직접 고쳐져 있어서, 업데이트 전에 로컬 커밋을 보관하고 새 버전으로 바꿨어요. 요약은 ${file}에 있어요.\n${text}\n개인 설정에 해당하는 것은 ~/.dotz/custom, features, RULES.md에 다시 만들어 주세요. 개인 몰인지 분명하지 않은 것은 오너에게 물어보세요. 모두에게 필요한 수정은 짧은 보고(작업로그)로 남기세요. dotz 코드는 고치지 마세요.`;
	return { file, text, turn };
}

export function keepLine(commits: Commit[], dirty: number, why?: string): string {
	const parts: string[] = [];
	if (commits.length) parts.push(`로컬 커밋 ${commits.length}개(${commits.slice(0, 3).map(c => c.subject.slice(0, 40)).join(" / ")}${commits.length > 3 ? " 외" : ""})를 새 버전 위에 얹을 수 없어요${why ? ` — ${why}` : ""}`);
	if (dirty) parts.push(`커밋하지 않은 변경 ${dirty}개가 있어요`);
	return `${parts.join(". ")}. 내 수정은 먼저 보관해 뒀어요. '내 수정을 보관하고 새 버전 받기'를 누르면 새 버전으로 바꿔요.`;
}
