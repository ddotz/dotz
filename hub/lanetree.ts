import { type Lane, persist, type Worktree, dir } from "./lanestate.ts";
import { msg } from "./i18n.ts";
import { join, relative } from "node:path";
import { existsSync, realpathSync } from "node:fs";

// Gives a lane whose worktree went with its merge a fresh one; the text gets the new path in front.
export function withWorktree(lane: Lane, text: string): string {
	if (lane.worktree) return text;
	const place = laneWorktree(lane.name, lane.cwd);
	if (!place.worktree) return text;
	lane.cwd = place.cwd;
	lane.worktree = place.worktree;
	persist(lane);
	return `${worktreeNote(place.worktree)}\n\n${text}`;
}

export function worktreeNote(w: Worktree | undefined): string {
	return w ? msg().worktree(w) : msg().noGit;
}

const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

// For a cwd inside a git repo with commits: the lane's worktree (created, or reused when the lane is relaunched) on
// branch lane/<name> from the current HEAD, and the matching cwd inside it. Anything else runs in place, including a cwd
// that HEAD does not track (an ignored or untracked folder, e.g. ~/.dotz/projects/* under a `*` .gitignore): a worktree
// holds only tracked files, so that folder would not exist in it.
export function laneWorktree(name: string, cwd: string): { cwd: string; worktree?: Worktree } {
	const repo = git(cwd, "rev-parse", "--show-toplevel");
	const base = git(cwd, "symbolic-ref", "--short", "HEAD");
	if (!repo.ok || !base.ok || !git(cwd, "rev-parse", "--verify", "--quiet", "HEAD").ok) return { cwd };
	const rel = relative(realpathSync(repo.out), realpathSync(cwd));
	if (rel && !git(repo.out, "ls-tree", "-d", "--name-only", "HEAD", "--", rel).out) return { cwd };
	const w: Worktree = { path: join(dir(name), "worktree"), repo: repo.out, branch: `lane/${name}`, base: base.out };
	if (!existsSync(w.path)) {
		const exists = git(w.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`).ok;
		const add = git(w.repo, "worktree", "add", ...(exists ? [w.path, w.branch] : ["-b", w.branch, w.path, "HEAD"]));
		if (!add.ok) throw new Error(`could not create the lane worktree: ${add.err}`);
	}
	return { cwd: join(w.path, rel), worktree: w };
}

// Removes a closed lane's worktree and branch once its work is in the base branch and nothing is left uncommitted;
// otherwise keeps both and says why.
export function dropWorktree(lane: Lane): string {
	const w = lane.worktree;
	if (!w || !existsSync(w.path)) return "";
	if (git(w.path, "status", "--porcelain").out) return `worktree kept: uncommitted changes in ${w.path}`;
	// A rebase, merge or cherry-pick stopped half way leaves the branch at its old tip (already merged) and the new commits on a detached HEAD:
	// removing then lost a session's rebased work (2026-10-28). So is any HEAD with commits the base does not have.
	const gitDir = git(w.path, "rev-parse", "--absolute-git-dir").out;
	if (gitDir && ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"].some(f => existsSync(join(gitDir, f)))) return `worktree kept: a rebase or merge is in progress in ${w.path}`;
	const head = git(w.path, "rev-parse", "HEAD").out;
	if (head && !git(w.repo, "merge-base", "--is-ancestor", head, w.base).ok) return `worktree kept: its HEAD has commits not in ${w.base}`;
	if (!git(w.repo, "merge-base", "--is-ancestor", w.branch, w.base).ok) return `worktree kept: ${w.branch} is not merged into ${w.base}`;
	const rm = git(w.repo, "worktree", "remove", w.path);
	if (!rm.ok) return `worktree kept: ${rm.err}`;
	git(w.repo, "branch", "-d", w.branch);
	lane.cwd = join(w.repo, relative(w.path, lane.cwd));
	lane.worktree = undefined;
	persist(lane);
	return `worktree removed (${w.branch} merged into ${w.base})`;
}
