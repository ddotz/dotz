// Keeps personal names and addresses out of commit metadata on public ddotz/dotz. public-scrub.ts and the release note read text; a commit's author and
// committer come from a machine's git config and nothing else looks at them. The rule (hub/commit-identity.ts): mail is a GitHub noreply address and the name
// is the login inside it. Three places apply it: .githooks/pre-push runs this for every ref pushed to the public remote, and for a push to a fork or any
// other GitHub remote from a dotz clone it checks against the clone's own tracking ref of public main; hub/upstream-commits.ts runs it in the shell deny
// before an agent's `git push` or `gh pr create`, so a clone without the hook is covered too; `bun hub/push-identity.ts fix` repairs a clone.
// To the public remote only what the remote does not hold yet counts, so commits already public never block a push. "Holds" means the remote's branches and tags right now, read live: tracking refs
// go stale, and a pull request ref is a contributor's commit that still has to pass when it lands on a branch. A refusal names commits by sha and labels
// only and never repeats git's output, which can hold an address.
// The same list closes the hand landing: a commit new to public main with a `(#N)` subject is a PR rebased in, which never met dotz_merge, so it needs PR N's
// universal review from this install (hub/mergegate.ts).
import { type Login, knownLogin, setCloneIdentity } from "./clone-identity.ts";
import { FIX_COMMAND, PUBLIC_URL, LOG_FORMAT, badRows, gitText, identityRefusal, isGithubRemote, isPublicRemote, newCommits, parseRows, publicRefs, publicRemoteNames, remoteUrls } from "./commit-identity.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./history-rewrite.ts";
import { reviewedUniversal } from "./mergegate.ts";
import { PUBLIC_REPO } from "./public-scrub.ts";
import type { Exec } from "./selfupdate.ts";

const SHA = /^[0-9a-f]{40,64}$/;

export async function refusal(exec: Exec, dir: string, url: string, rev: string, ref?: string, dataDir?: string): Promise<string | undefined> {
	if (!isPublicRemote(url)) {
		if (!isGithubRemote(url) || !remoteUrls(dir).some(([, u]) => isPublicRemote(u))) return undefined; // a fork of a dotz clone: the clone's tracking ref says what public main holds
		const refs = publicRefs(dir);
		const bad = badRows(refs.length ? (newCommits(dir, [rev], refs) ?? []) : []);
		return bad.length ? identityRefusal(bad) : undefined;
	}
	const held = await exec(["git", "ls-remote", "--heads", "--tags", "--refs", url], dir, 15_000);
	if (held.code !== 0) return `could not read what ${PUBLIC_REPO} holds (git ls-remote exit ${held.code}), retry the push.`;
	const tips = held.out.split("\n").map(l => l.split("\t")[0] ?? "").filter(s => SHA.test(s));
	if (tips.length) { // by sha, into no ref: parallel lane pushes share this clone and would fight over any ref lock
		const fetched = await exec(["git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", url, ...tips], dir, 60_000);
		if (fetched.code !== 0) return `could not read what ${PUBLIC_REPO} holds (git fetch exit ${fetched.code}), retry the push.`;
	}
	const log = await exec(["git", "log", "--no-show-signature", `--format=${LOG_FORMAT}`, rev, "--not", ...tips], dir, 30_000);
	if (log.code !== 0) return `could not read the commits being pushed (git log exit ${log.code}).`;
	const commits = parseRows(log.out);
	const bad = badRows(commits);
	if (bad.length) return identityRefusal(bad);
	if (ref !== "refs/heads/main") return undefined;
	for (const { sha, subject } of commits) {
		const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
		if (pr && !reviewedUniversal(PUBLIC_REPO, pr, { dir: dataDir })) return `refused, commit ${sha.slice(0, 8)} lands PR #${pr} by hand with no universal review recorded. Review it through dotz_merge (action=review with scope) and land it there; a mixed PR's universal part goes in a new commit without the PR number.`;
	}
	return undefined;
}

// De-identifies this clone: the clone-local identity becomes the account's noreply identity (a linked worktree writes the shared clone config, so one run covers
// every worktree), and the current branch's commits that public main does not hold are rewritten to carry it. Never touches the global config.
export async function fixIdentity(dir: string, lookup: () => Promise<Login>): Promise<string[]> {
	const step = (...args: string[]) => {
		const out = gitText(dir, args, 120_000);
		if (out === undefined) throw new Error(`git ${args[0]} failed in this folder`);
		return out;
	};
	step("rev-parse", "--git-dir");
	setCloneIdentity(dir, await lookup());
	const report = ["clone-local git identity set to the GitHub noreply identity (global config untouched)"];
	if (!publicRemoteNames(dir).length) {
		step("remote", "add", remoteUrls(dir).some(([n]) => n === "upstream") ? "dotz-public" : "upstream", PUBLIC_URL);
		report.push(`added ${PUBLIC_REPO} as a remote`);
	}
	for (const name of publicRemoteNames(dir)) if (gitText(dir, ["fetch", "--quiet", "--no-tags", name, "main"], 60_000) === undefined) report.push(`could not fetch ${name} (offline?), using its last known main`);
	const refs = publicRefs(dir);
	if (!refs.length) throw new Error(`could not read what ${PUBLIC_REPO} holds: git fetch its main, then run ${FIX_COMMAND} again`);
	const bad = badRows(newCommits(dir, ["HEAD"], refs) ?? []);
	if (!bad.length) return [...report, "no unpublished commit carries a personal identity, nothing rewritten"];
	if (gitText(dir, ["symbolic-ref", "-q", "HEAD"]) === undefined) throw new Error("HEAD is detached: check out the branch first, then run the fix again");
	const base = (gitText(dir, ["merge-base", "HEAD", refs[0] as string]) ?? "").trim(); // the branch keeps its base: only author and committer change, public main's newer commits are not replayed onto
	if (!base) throw new Error(`could not find where this branch left ${PUBLIC_REPO}: git fetch its main, then run ${FIX_COMMAND} again`);
	const rebased = gitText(dir, ["-c", "core.editor=true", "-c", "sequence.editor=true", "rebase", "--autostash", "--exec", "git commit --amend --no-edit --reset-author -q", base], 300_000);
	if (rebased === undefined) {
		gitText(dir, ["rebase", "--abort"]);
		throw new Error("the rewrite stopped (a conflict or a dirty state) and was undone; no commit changed");
	}
	return [...report, `rewrote ${bad.length} unpublished commit(s) on the current branch; push them with --force-with-lease if they were pushed before`];
}

if (import.meta.main) {
	const [url, rev, ref] = process.argv.slice(2);
	if (url === "fix") {
		try {
			for (const line of await fixIdentity(process.cwd(), async () => {
				const who = knownLogin(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"));
				if (!who) throw new Error("could not read the signed-in GitHub account (gh api user); run gh auth login");
				return who;
			})) console.log(`push-identity: ${line}`);
		} catch (e) {
			console.error(`push-identity: ${(e as Error).message}`);
			process.exit(1);
		}
		process.exit(0);
	}
	if (!url || !rev) {
		console.error("usage: bun hub/push-identity.ts <url> <rev> [ref] | fix");
		process.exit(2);
	}
	const refused = await refusal(run, process.cwd(), url, rev, ref);
	if (refused) {
		console.error(`push-identity: ${refused}`);
		process.exit(1);
	}
}
