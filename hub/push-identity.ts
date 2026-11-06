// Keeps personal addresses out of commit metadata on public ddotz/dotz. public-scrub.ts and the release note read text; a commit's author and committer
// come from a machine's git config and nothing else looks at them, so .githooks/pre-push runs this for every ref pushed there. Only what the remote does
// not hold yet counts, so commits already public never block a push. "Holds" means the remote's branches and tags right now, read live: tracking refs
// go stale, and a pull request ref is a contributor's commit that still has to pass when it lands on a branch. Other remotes (a contributor's fork) pass
// untouched. A refusal names commits by sha only and never repeats git's output, which can hold an address.
import { run } from "./history-rewrite.ts";
import { PUBLIC_REPO } from "./public-scrub.ts";
import type { Exec } from "./selfupdate.ts";

const PUBLIC_REMOTE = new RegExp(`(?:^|[:/])${PUBLIC_REPO}(?:\\.git)?/*$`, "i");
const NOREPLY = /(?:@users\.noreply\.github\.com|^noreply@github\.com)$/i;
const SHA = /^[0-9a-f]{40,64}$/;
const FIX = "Set git config user.email <id>+<login>@users.noreply.github.com, then run git rebase --exec 'git commit --amend --no-edit --reset-author' origin/main.";

export const isPublicRemote = (url: string): boolean => PUBLIC_REMOTE.test(url.trim());

export async function refusal(exec: Exec, dir: string, url: string, rev: string): Promise<string | undefined> {
	if (!isPublicRemote(url)) return undefined;
	const held = await exec(["git", "ls-remote", "--heads", "--tags", "--refs", url], dir, 15_000);
	if (held.code !== 0) return `could not read what ${PUBLIC_REPO} holds (git ls-remote exit ${held.code}), retry the push.`;
	const tips = held.out.split("\n").map(l => l.split("\t")[0] ?? "").filter(s => SHA.test(s));
	if (tips.length) { // by sha, into no ref: parallel lane pushes share this clone and would fight over any ref lock
		const fetched = await exec(["git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", url, ...tips], dir, 60_000);
		if (fetched.code !== 0) return `could not read what ${PUBLIC_REPO} holds (git fetch exit ${fetched.code}), retry the push.`;
	}
	const log = await exec(["git", "log", "--no-show-signature", "--format=%H%x09%ae%x09%ce", rev, "--not", ...tips], dir, 30_000);
	if (log.code !== 0) return `could not read the commits being pushed (git log exit ${log.code}).`;
	const commits = log.out.split("\n").map(l => l.split("\t")).filter(([sha]) => SHA.test(sha ?? "")); // the runner mixes stderr in; only commit lines count
	const bad = commits.filter(([, author = "", committer = ""]) => !NOREPLY.test(author) || !NOREPLY.test(committer));
	if (!bad.length) return undefined;
	return `refused, ${bad.length} commit(s) new to ${PUBLIC_REPO} (first ${bad[0]?.[0]?.slice(0, 8)}) have an author or committer that is not a GitHub noreply address. ${FIX}`;
}

if (import.meta.main) {
	const [url, rev] = process.argv.slice(2);
	if (!url || !rev) {
		console.error("usage: bun hub/push-identity.ts <url> <rev>");
		process.exit(2);
	}
	const refused = await refusal(run, process.cwd(), url, rev);
	if (refused) {
		console.error(`push-identity: ${refused}`);
		process.exit(1);
	}
}
