// Merge gate: a review verdict is bound to the exact commit it read, and dotz lands work (a PR through gh, or a lane
// branch fast-forwarded into its base) only while the head is still that commit and, for a PR, every CI check passed.
// A commit pushed after the review, a BLOCK verdict, or red/empty CI refuses with the reason and asks for a re-review.
// A PR also needs scope universal: personal values and preferences stay out of what every install gets.
// Node builtins only: extension/index.ts imports this (like receipts.ts). One small file per reviewed target.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Verdict = "CLEAR" | "BLOCK";
export type Scope = "universal" | "personal";
type Review = { target: string; sha: string; verdict: Verdict; at: number; scope?: Scope };
type Out = { code: number; stdout: string; stderr: string };
export type Run = (args: string[], cwd: string) => Promise<Out>;
type Deps = { gh?: Run; dir?: string };
type Target = { key: string; label: string; head: string; pr?: string; repo?: string; branch?: string };

export class Refusal extends Error {}

const runner = (bin: string): Run => (args, cwd) =>
	new Promise(done => execFile(bin, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) || (e ? String(e) : "") })));
const git = runner("git");
const short = (sha: string) => sha.slice(0, 12);
const AGAIN = "review the current head again (dotz_merge action=review)";

async function must(run: Run, args: string[], cwd: string, what: string): Promise<string> {
	const r = await run(args, cwd);
	if (r.code !== 0) throw new Refusal(`${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
	return r.stdout.trim();
}

const prKey = (repo: string, number: string) => `pr ${repo}#${number}`;

// A PR is keyed by what GitHub says it is, whichever checkout and form (number, URL, branch) named it; a lane by its repository and branch. The head is read live, never cached.
async function target(cwd: string, pr: string | undefined, gh: Run): Promise<Target> {
	if (pr) {
		const [head = "", url = ""] = (await must(gh, ["pr", "view", pr, "--json", "headRefOid,url", "-q", "[.headRefOid,.url]|@tsv"], cwd, `gh pr view ${pr}`)).split("\t");
		const id = /\/\/[^/]+\/(.+)\/pull\/(\d+)/.exec(url);
		if (!id) throw new Refusal(`gh pr view ${pr} gave no PR address`);
		return { key: prKey(id[1]!, id[2]!), label: `PR ${pr}`, head, pr };
	}
	const branch = await must(git, ["symbolic-ref", "--short", "HEAD"], cwd, "reading the branch (detached HEAD?)");
	const common = resolve(cwd, await must(git, ["rev-parse", "--git-common-dir"], cwd, "git rev-parse"));
	const head = await must(git, ["rev-parse", "HEAD"], cwd, "git rev-parse HEAD");
	return { key: `branch ${realpathSync(common)}:${branch}`, label: `branch ${branch}`, head, repo: dirname(realpathSync(common)), branch };
}

const store = (d: Deps) => join(d.dir ?? process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "reviews");
const fileOf = (d: Deps, key: string) => join(store(d), `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`);

function load(d: Deps, key: string): Review | undefined {
	try {
		const r = JSON.parse(readFileSync(fileOf(d, key), "utf8")) as Review;
		return r.target === key ? r : undefined;
	} catch {
		return undefined;
	}
}

/** The pre-push hook's question for a PR commit landed by hand: its head changes in a rebase, so only the verdict and scope count here. */
export function reviewedUniversal(repo: string, pr: string, d: Deps = {}): boolean {
	const r = load(d, prKey(repo, pr));
	return r?.verdict === "CLEAR" && r.scope === "universal";
}

/** Records a verdict for the commit the reviewer read: `sha` (7-40 hex, a prefix of the current head or another commit) or the current head. */
export async function recordReview(p: { cwd: string; verdict: Verdict; pr?: string; sha?: string; scope?: Scope }, d: Deps = {}): Promise<string> {
	if (p.pr && !p.scope) throw new Refusal(`review of PR ${p.pr} needs scope: universal or personal (dotz_merge description)`);
	const t = await target(p.cwd, p.pr, d.gh ?? runner("gh"));
	const sha = (p.sha ?? t.head).toLowerCase();
	if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Refusal(`sha ${p.sha} is not a commit id (7-40 hex)`);
	const review: Review = { target: t.key, sha, verdict: p.verdict, at: Date.now(), ...(p.pr ? { scope: p.scope } : {}) };
	const file = fileOf(d, t.key);
	mkdirSync(store(d), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(review));
	renameSync(tmp, file);
	return `REVIEW ${p.verdict} ${t.label}${p.pr ? ` scope=${p.scope}` : ""} at ${short(sha)}${t.head.startsWith(sha) ? "" : ` (head is ${short(t.head)}: merge stays refused until the head is reviewed)`}`;
}

type Check = { name: string; bucket: string };

/** Merges only the exact CLEAR-reviewed head: a PR also needs a non-empty, all-green check list (skips alone are not green). */
export async function mergeGate(p: { cwd: string; pr?: string; into?: string; dryRun?: boolean }, d: Deps = {}): Promise<string> {
	const gh = d.gh ?? runner("gh");
	const t = await target(p.cwd, p.pr, gh);
	const r = load(d, t.key);
	if (!r) throw new Refusal(`no review recorded for ${t.label}; ${AGAIN} at ${short(t.head)}`);
	if (t.pr && r.scope === "personal") throw new Refusal(`${t.label} was reviewed as personal, so it stays out of what every install gets: tell the author it belongs in their custom layer (docs/customization.md). A mixed PR's universal part lands alone, in a new commit`);
	if (t.pr && r.scope !== "universal") throw new Refusal(`no universal scope recorded for ${t.label}; ${AGAIN} with scope`);
	if (!t.head.startsWith(r.sha)) throw new Refusal(`${t.label} was reviewed at ${short(r.sha)} but its head is now ${short(t.head)} (commits after the review); ${AGAIN}`);
	if (r.verdict !== "CLEAR") throw new Refusal(`the review of ${t.label} at ${short(r.sha)} is ${r.verdict}; fix it and ${AGAIN}`);
	if (t.pr) {
		// gh exits non-zero for failing (1) or pending (8) checks but still prints the JSON; only the list decides.
		const out = (await gh(["pr", "checks", t.pr, "--json", "name,bucket"], p.cwd)).stdout.trim();
		let checks: Check[] = [];
		try {
			checks = out.startsWith("[") ? JSON.parse(out) : [];
		} catch {}
		if (checks.length === 0) throw new Refusal(`no CI checks reported for ${t.label} (an empty list is never green); wait for CI, then ${AGAIN}`);
		const bad = checks.filter(c => c.bucket !== "pass" && c.bucket !== "skipping");
		if (bad.length) throw new Refusal(`CI not green for ${t.label}: ${bad.map(c => `${c.name}=${c.bucket}`).join(", ")}; fix or wait, then ${AGAIN}`);
		if (!checks.some(c => c.bucket === "pass")) throw new Refusal(`every CI check of ${t.label} was skipped; ${AGAIN} once one runs`);
		if (p.dryRun) return `MERGE_OK ${t.label} head=${short(t.head)} (dry run)`;
		// --match-head-commit: GitHub itself refuses if a commit lands between this check and the merge.
		await must(gh, ["pr", "merge", t.pr, "--squash", "--match-head-commit", t.head], p.cwd, `gh pr merge ${t.pr}`);
		return `MERGED ${t.label} head=${short(t.head)}`;
	}
	const repo = t.repo!;
	const current = (await git(["symbolic-ref", "--short", "HEAD"], repo)).stdout.trim();
	const into = p.into ?? current;
	if (!into || into === t.branch) throw new Refusal(`no base branch to merge ${t.label} into; pass into`);
	if (p.dryRun) return `MERGE_OK ${t.label} -> ${into} head=${short(t.head)} (dry run)`;
	// The reviewed sha itself is merged, never the branch name, so a commit landing meanwhile cannot ride along.
	// A checked-out base moves with merge --ff-only; any other base with a fetch that refuses non-fast-forward updates.
	const args = into === current ? ["merge", "--ff-only", "-q", t.head] : ["fetch", "-q", ".", `${t.head}:refs/heads/${into}`];
	await must(git, args, repo, `fast-forward ${into}`);
	return `MERGED ${t.label} -> ${into} head=${short(t.head)}`;
}
