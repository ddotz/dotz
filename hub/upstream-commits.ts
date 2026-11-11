// What a command publishes through commits, checked before it runs (publicPostDeny in hub/public-scrub.ts reads only the TEXT of a post). A `gh pr create`
// to ddotz/dotz publishes the commits of its head branch that public main lacks: their author and committer, their messages and their added lines must hold
// nothing personal. A `git push` from a dotz clone to any GitHub remote, a contributor's fork included, gets the identity check, whether or not the
// pre-push hook is installed; a push to the public repo itself (`origin HEAD:main`, `origin <branch>:main`, a plain `git push`, `--all`) gets the same message and added-line
// check as a PR, and fails closed when git cannot be read. "Public main" is the clone's own tracking ref, so nothing here touches the network; a stale ref can list commits that are
// already public, which refuses more, never less. A refusal names commits by short sha and labels and never a name, an address or a matched value.
import { FIX_COMMAND, PUBLIC_URL, badRows, gitText, identityRefusal, isDotzClone, isGithubRemote, isPublicRemote, newCommits, publicRefs, remoteUrls } from "./commit-identity.ts";
import { MAYBE_POST, PUBLIC_REPO, installTerms, postDir, postKind, postStart, postsToDotz, scrub, shellPath, type Term } from "./public-scrub.ts";

const MAYBE_PUSH = /\bgit\b[^\n]*\bpush\b/;
const PUSH = /(?:^|[;&|(\n])\s*(?:\w+=\S+\s+)*git((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+push\b([^;&|\n]*)/g;
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const NO_BRANCH_RULE = `no remote of this clone is ${PUBLIC_REPO}, so what is new to it cannot be told. Run \`${FIX_COMMAND}\` in the clone: it adds ${PUBLIC_URL} as a remote and fetches its main`;

// Not leaks: the allowed-signers line is a public key, and a test fixture shows an address, a host or an id of the shapes scrub() knows (a value that is this install's own still hits as its own label).
// Nor is the counting run 1234567890… that an id field shows as its example, in any file or message: it is nobody's id.
const PUBLIC_KEY_LINE = /namespaces="git"/;
const EXAMPLE_ID = /(?<![\w.-])1234567890\d{7,10}(?![\w.-])/g;
const noExampleId = (text: string) => text.replace(EXAMPLE_ID, id => ([...id].every((d, i) => Number(d) === (i + 1) % 10) ? "example-id" : id));
const FIXTURE = /\.test\.[jt]sx?$|(?:^|\/)(?:fixtures?|__tests__)\//;
const FIXTURE_LABELS = new Set(["email", "phone", "tailnet host", "private address", "messenger id"]);

export type Finding = { sha: string; labels: string[]; files: string[] };

// The added lines of a unified diff by file; a removed line never counts.
export function addedByFile(diff: string): Map<string, string[]> {
	const added = new Map<string, string[]>();
	let file = "";
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
		else if (line.startsWith("+")) added.set(file, [...(added.get(file) ?? []), line.slice(1)]);
	}
	return added;
}

export function addedLabels(added: ReadonlyMap<string, string[]>, terms: readonly Term[]): { labels: string[]; files: string[] } {
	const labels: string[] = [];
	const files: string[] = [];
	const kept = [...added].map(([name, lines]) => [name, noExampleId(lines.filter(l => !PUBLIC_KEY_LINE.test(l)).join("\n"))] as const);
	if (scrub(kept.map(([, text]) => text).join("\n"), terms).hits.length) {
		for (const [name, text] of kept) {
			const hits = scrub(text, terms).hits.filter(h => !(FIXTURE.test(name) && FIXTURE_LABELS.has(h)));
			if (hits.length) files.push(name);
			for (const h of hits) if (!labels.includes(`added line: ${h}`)) labels.push(`added line: ${h}`);
		}
	}
	return { labels, files };
}

// Messages and added lines of the commits `revs` holds beyond `refs`; a removed line or a commit already on public main never counts.
export function contentFindings(dir: string, revs: readonly string[], refs: readonly string[], terms: readonly Term[]): Finding[] | undefined {
	const out = gitText(dir, ["log", "--no-show-signature", "-p", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--format=%x1e%H%x1f%B%x1f", ...revs, "--not", ...refs], 60_000);
	if (out === undefined) return undefined;
	const found: Finding[] = [];
	for (const chunk of out.split("\x1e").slice(1)) {
		const first = chunk.indexOf("\x1f");
		const second = chunk.indexOf("\x1f", first + 1);
		const sha = chunk.slice(0, first);
		const labels = scrub(noExampleId(chunk.slice(first + 1, second)), terms).hits.map(h => `message: ${h}`);
		const { labels: lineLabels, files } = addedLabels(addedByFile(chunk.slice(second + 1)), terms);
		labels.push(...lineLabels);
		if (labels.length) found.push({ sha, labels, files });
	}
	return found;
}

// The refusal for what contentFindings found; `again` is the verb that retries the command.
export const contentRefusal = (found: readonly Finding[], again: "post" | "push"): string =>
	`refused, ${found.length} commit(s) new to ${PUBLIC_REPO} carry personal or sensitive content: ${found.slice(0, 8).map(f => `${f.sha.slice(0, 8)} (${f.labels.join(", ")})`).join("; ")}. Remove the value from those commits (amend or rebase), keep the detail, and ${again} again${again === "push" ? ". A ref that is behind the public main can list commits that are already public: git fetch first" : ""}`;

function headOf(post: string): string | undefined {
	const m = /\bgh\s+pr\b/.test(post) ? /(?:--head[ =]|\s-H[ =]?)["']?([^\s"']+)/.exec(post) : /\bhead["']?\s*[=:]\s*\\?["']?([^\s"',\\&]+)/.exec(post);
	return m?.[1]?.replace(/^[^:]*:/, "");
}

function prDeny(flat: string, dataDir: string, cwd: string): string | undefined {
	const start = postStart(flat);
	if (start < 0 || postKind(flat.slice(start)) !== "pr") return undefined;
	const dir = postDir(flat, start, cwd);
	const post = flat.slice(start);
	if (!postsToDotz(post, dir)) return undefined;
	const head = headOf(post) ?? "HEAD";
	const cannot = (why: string) => `cannot read the commits this pull request to ${PUBLIC_REPO} would publish (${why}). Post it from the dotz clone that holds the head branch, naming it with --head, so its commits can be checked first`;
	if (head.startsWith("-") || gitText(dir, ["rev-parse", "--verify", "-q", `${head}^{commit}`]) === undefined) return cannot("not a git folder, or the head branch is unknown here");
	const refs = publicRefs(dir);
	if (!refs.length) return NO_BRANCH_RULE;
	const rows = newCommits(dir, [head], refs);
	if (!rows) return cannot("git could not list them");
	const found = contentFindings(dir, [head], refs, installTerms(dataDir));
	if (!found) return cannot("git could not read their text");
	const bad = badRows(rows);
	const parts = [...(bad.length ? [identityRefusal(bad)] : []), ...(found.length ? [contentRefusal(found, "post")] : [])];
	return parts.length ? parts.join(" ") : undefined;
}

function pushTarget(dir: string, remote: string | undefined): string | undefined {
	if (remote && /[:/]/.test(remote)) return remote;
	const name = remote ?? gitText(dir, ["config", "--get", `branch.${gitText(dir, ["symbolic-ref", "-q", "--short", "HEAD"])?.trim() ?? ""}.remote`])?.trim() ?? "origin";
	return remoteUrls(dir).filter(([n]) => n === name).at(-1)?.[1];
}

function pushRefusal(dir: string, args: readonly string[], dataDir: string): string | undefined {
	const positional: string[] = [];
	let all = false;
	for (let i = 0; i < args.length; i++) {
		const a = (args[i] ?? "").replace(/^["'\x60]|["'\x60]$/g, "");
		if (a === "--delete" || a === "-d" || a === "--mirror" || a === "--tags") return undefined;
		if (a === "--all" || a === "--branches") all = true;
		else if (PUSH_VALUE_FLAGS.has(a)) i++;
		else if (!a.startsWith("-")) positional.push(a);
	}
	const url = pushTarget(dir, positional[0]);
	const toPublic = url !== undefined && isPublicRemote(url); // only a push to the public repo gets the content check, and only it fails closed
	if (!url || !(toPublic || (isGithubRemote(url) && isDotzClone(dir)))) return undefined;
	const sources = positional.slice(1).map(spec => spec.replace(/^\+/, "").split(":")[0] ?? "").filter(Boolean);
	if (positional.length > 1 && !sources.length) return undefined; // only deletions (`:branch`)
	const revs = (all ? ["--branches"] : sources.length ? sources : ["HEAD"]).filter(rev => rev === "--branches" || (!rev.startsWith("-") && gitText(dir, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]) !== undefined));
	if (!revs.length) return undefined;
	const refs = publicRefs(dir);
	if (!refs.length) return `refused, ${NO_BRANCH_RULE}.`;
	const rows = newCommits(dir, revs, refs);
	if (!rows && toPublic) return `refused, git could not list the commits this push to ${PUBLIC_REPO} would publish, so they cannot be checked. Retry the push`;
	const bad = badRows(rows ?? []);
	const found = toPublic ? contentFindings(dir, revs, refs, installTerms(dataDir)) : [];
	if (!found) return `refused, git could not read the text of the commits this push to ${PUBLIC_REPO} would publish, so it cannot be checked. Retry the push`;
	const parts = [...(bad.length ? [identityRefusal(bad)] : []), ...(found.length ? [contentRefusal(found, "push")] : [])];
	return parts.length ? parts.join(" ") : undefined;
}

function pushDeny(flat: string, dataDir: string, cwd: string): string | undefined {
	for (const m of flat.matchAll(PUSH)) {
		const dir = /-C\s+(\S+)/.exec(m[1] ?? "");
		const refused = pushRefusal(dir ? shellPath(dir[1] as string, postDir(flat, m.index, cwd)) : postDir(flat, m.index, cwd), (m[2] ?? "").match(/\S+/g) ?? [], dataDir);
		if (refused) return refused;
	}
	return undefined;
}

// Runs after publicPostDeny and before any other deny. Other commands pay two regexes; git runs only for a PR post to dotz or a `git push`.
export function upstreamCommitsDeny(command: string, dataDir: string, cwd: string): string | undefined {
	const push = MAYBE_PUSH.test(command);
	const post = MAYBE_POST.test(command) || /api\.github\.com/.test(command);
	if (!push && !post) return undefined;
	const flat = command.replace(/\\\r?\n\s*/g, " ");
	const refused = (push ? pushDeny(flat, dataDir, cwd) : undefined) ?? (post ? prDeny(flat, dataDir, cwd) : undefined);
	return refused && `this command would publish commits that are not de-identified: ${refused}`;
}
