// The merge gate lands only the CLEAR-reviewed head: a commit after the review, a BLOCK verdict, or red/empty CI refuses.
// Lanes use a real local repo and worktree; gh is injected, so nothing touches the network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeGate, recordReview, reviewedUniversal, type Run } from "./mergegate.ts";

let root = "";
let repo = "";
let lane = "";
let dir = "";
const sh = (cmd: string, cwd = repo) => Bun.spawnSync(["bash", "-c", cmd], { cwd }).stdout.toString().trim();
const commit = (cwd: string, msg: string) => sh(`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m ${msg} && git rev-parse HEAD`, cwd);
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-mergegate-"));
	repo = join(root, "repo");
	lane = join(root, "lane");
	dir = join(root, "store");
	sh(`git init -q -b main ${repo}`, root);
	commit(repo, "init");
	sh(`git worktree add -q -b work ${lane}`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("lane: a commit after the review refuses the ff-merge; the re-reviewed head lands", async () => {
	const reviewed = commit(lane, "a");
	expect(await recordReview({ cwd: lane, verdict: "CLEAR" }, { dir })).toContain("REVIEW CLEAR branch work");
	const later = commit(lane, "b");
	await expect(mergeGate({ cwd: lane }, { dir })).rejects.toThrow(`reviewed at ${reviewed.slice(0, 12)} but its head is now ${later.slice(0, 12)}`);
	expect(sh("git rev-parse main")).not.toBe(later);
	await recordReview({ cwd: lane, verdict: "BLOCK" }, { dir });
	await expect(mergeGate({ cwd: lane }, { dir })).rejects.toThrow("is BLOCK");
	await recordReview({ cwd: lane, verdict: "CLEAR", sha: later.slice(0, 10) }, { dir });
	expect(await mergeGate({ cwd: lane }, { dir })).toContain("MERGED branch work -> main");
	expect(sh("git rev-parse main")).toBe(later);
});

test("lane: no review refuses, and a base that is not checked out still only fast-forwards", async () => {
	await expect(mergeGate({ cwd: lane }, { dir })).rejects.toThrow("no review recorded");
	sh("git branch release");
	const head = commit(lane, "a");
	await recordReview({ cwd: lane, verdict: "CLEAR" }, { dir });
	expect(await mergeGate({ cwd: lane, into: "release" }, { dir })).toContain("-> release");
	expect(sh("git rev-parse release")).toBe(head);
});

// A fake gh: the PR head and the check list are set per test; every call is recorded.
function fakeGh(state: { head: string; checks: unknown; url?: string }) {
	const calls: string[][] = [];
	const gh: Run = async args => {
		calls.push(args);
		if (args[1] === "view") return { code: 0, stdout: `${state.head}\t${state.url ?? "https://github.com/acme/app/pull/7"}\n`, stderr: "" };
		if (args[1] === "checks") return { code: 1, stdout: JSON.stringify(state.checks), stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	return { gh, calls };
}

test("PR: merge refused on red, empty or skip-only CI and after a new commit; allowed when pinned and green", async () => {
	const a = "a".repeat(40);
	const state = { head: a, checks: [{ name: "test", bucket: "fail" }] as unknown };
	const { gh, calls } = fakeGh(state);
	await recordReview({ cwd: repo, pr: "7", verdict: "CLEAR", scope: "universal" }, { dir, gh });
	await expect(mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).rejects.toThrow("CI not green for PR 7: test=fail");
	state.checks = [];
	await expect(mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).rejects.toThrow("no CI checks reported");
	state.checks = [{ name: "lint", bucket: "skipping" }];
	await expect(mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).rejects.toThrow("was skipped");
	state.checks = [{ name: "test", bucket: "pass" }, { name: "lint", bucket: "skipping" }];
	state.head = "b".repeat(40);
	await expect(mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).rejects.toThrow("review the current head again");
	expect(calls.some(c => c[1] === "merge")).toBe(false);
	state.head = a;
	expect(await mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).toBe(`MERGED PR 7 head=${a.slice(0, 12)}`);
	expect(calls.at(-1)).toEqual(["pr", "merge", "7", "--squash", "--match-head-commit", a]);
});

const green = () => fakeGh({ head: "a".repeat(40), checks: [{ name: "test", bucket: "pass" }] });

test("PR: a review without scope is refused and records nothing, so the merge stays refused", async () => {
	const { gh, calls } = green();
	await expect(recordReview({ cwd: repo, pr: "7", verdict: "CLEAR" }, { dir, gh })).rejects.toThrow("needs scope");
	await expect(mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).rejects.toThrow("no review recorded");
	expect(calls.some(c => c[1] === "merge")).toBe(false);
});

test("PR: a personal scope refuses the merge and points the author at the custom layer", async () => {
	const { gh, calls } = green();
	expect(await recordReview({ cwd: repo, pr: "7", verdict: "CLEAR", scope: "personal" }, { dir, gh })).toContain("personal");
	await expect(mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).rejects.toThrow("docs/customization.md");
	expect(calls.some(c => c[1] === "merge")).toBe(false);
	await recordReview({ cwd: repo, pr: "7", verdict: "CLEAR", scope: "universal" }, { dir, gh });
	expect(await mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).toContain("MERGED PR 7");
});

test("PR: a review stored before scope existed does not pass", async () => {
	const { gh, calls } = green();
	await recordReview({ cwd: repo, pr: "7", verdict: "CLEAR", scope: "universal" }, { dir, gh });
	const store = join(dir, "reviews");
	const file = join(store, readdirSync(store)[0]!);
	const { scope: _, ...old } = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify(old));
	await expect(mergeGate({ cwd: repo, pr: "7" }, { dir, gh })).rejects.toThrow("no universal scope");
	expect(calls.some(c => c[1] === "merge")).toBe(false);
});

test("PR: the scope belongs to the repository and number GitHub reports, however the PR was named", async () => {
	const { gh } = green();
	expect(reviewedUniversal("acme/app", "7", { dir })).toBe(false);
	await recordReview({ cwd: lane, pr: "feature-10", verdict: "CLEAR", scope: "universal" }, { dir, gh });
	expect(reviewedUniversal("acme/app", "7", { dir })).toBe(true);
	expect(reviewedUniversal("acme/app", "10", { dir })).toBe(false);
	expect(reviewedUniversal("other/repo", "7", { dir })).toBe(false);
	await recordReview({ cwd: repo, pr: "7", verdict: "BLOCK", scope: "universal" }, { dir, gh });
	expect(reviewedUniversal("acme/app", "7", { dir })).toBe(false);
});
