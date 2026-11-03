// Settings → 업데이트 against real git repos in a temp dir: a bare "origin", a clone the updater works on, and a second
// clone that pushes newer commits. The test command is a shell check so a commit can make "the tests" fail on purpose.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoHooks, commit, failFileTestCmd as testCmd, git as sh, head, makeRepos, type Repos, setSelfUpdateCfg } from "./selfupdate-fixture.ts";
import { apply, autoCheck, check, defaultExec, type Exec, failedTestNames, failureBlocks, fetchError, nextRuns, RELEASE_AT, parseRelease, releaseTags, scrub, updateAvailable } from "./selfupdate.ts";

test("failureBlocks keeps the error block bun prints before each (fail) line, and nothing from passing tests", () => {
	const out = [
		"bun test v1.4.2",
		"",
		"hub/a.test.ts:",
		"(pass) a > fine [0.10ms]",
		"12 |   const id = await ask({ site: \"shop-once\" });",
		"13 |   expect(leaks).not.toContain(bit);",
		"                       ^",
		"error: expect(received).not.toContain(expected)",
		"",
		"Expected to not contain: \"7391\"",
		"Received: \"...7391...\"",
		"",
		"      at <anonymous> (hub/auth.test.ts:94:30)",
		"(fail) one-time form [2.40ms]",
		"(pass) a > also fine [0.20ms]",
		"",
		"hub/b.test.ts:",
		"error: boom",
		"      at <anonymous> (hub/b.test.ts:5:9)",
		"(fail) b > broken [1.00ms]",
		"",
		" 1142 pass",
		" 2 fail",
	].join("\n");
	const kept = failureBlocks(out);
	expect(kept).toContain("error: expect(received).not.toContain(expected)");
	expect(kept).toContain("Expected to not contain: \"7391\"");
	expect(kept).toContain("(fail) one-time form [2.40ms]");
	expect(kept).toContain("error: boom\n      at <anonymous> (hub/b.test.ts:5:9)\n(fail) b > broken [1.00ms]");
	expect(kept).not.toContain("(pass)");
	expect(kept).not.toContain("a.test.ts:\n");
	expect(failureBlocks("(pass) x [1ms]\n 3 pass\n 0 fail")).toBe("");
	// capped: many failures keep a bounded number of blocks and say how many were dropped
	const many = Array.from({ length: 40 }, (_, i) => `error: e${i}\n(fail) t${i} [1ms]`).join("\n");
	const capped = failureBlocks(many);
	expect(capped).toContain("error: e0");
	expect(capped).not.toContain("error: e39");
	expect(capped).toContain("25 more failure(s) not kept");
});

test("failedTestNames lists each failing test once (bun repeats them in its summary), at most three", () => {
	const out = ["(pass) ok [1ms]", "(fail) a > one [2.40ms]", "(fail) two", "(fail) three [1ms]", "(fail) four [1ms]", "", "(fail) a > one [2.40ms]"].join("\n");
	expect(failedTestNames(out)).toEqual(["a > one", "two", "three"]);
	expect(failedTestNames("(pass) ok [1ms]\n 3 pass")).toEqual([]);
});

test("fetchError names the fix for a missing login, and scrub hides tokens", () => {
	const auth = fetchError("fatal: could not read Username for 'https://github.com': terminal prompts disabled", "origin");
	expect(auth.fix).toContain("gh auth login");
	expect(scrub("https://x-access-token:ghp_abcdefghijklmnop@github.com/o/r")).not.toContain("ghp_");
});

test("release tags: the newest by numeric (date, N, forced) order, peeled tag shas and malformed tags ignored", () => {
	const out = [
		"1111111111111111111111111111111111111111\trefs/tags/v261103.2",
		"2222222222222222222222222222222222222222\trefs/tags/v261103.1",
		"3333333333333333333333333333333333333333\trefs/tags/v261103.1.2",
		"4444444444444444444444444444444444444444\trefs/tags/v261103.1.2^{}",
		"5555555555555555555555555555555555555555\trefs/tags/v261103.4",
		"6666666666666666666666666666666666666666\trefs/tags/v26113.1",
		"7777777777777777777777777777777777777777\trefs/tags/release-1",
		"8888888888888888888888888888888888888888\trefs/tags/v261102.3.9",
	].join("\n");
	const tags = releaseTags(out);
	expect(tags.map(t => t.tag)).toEqual(["v261103.2", "v261103.1.2", "v261103.1", "v261102.3.9"]);
	// the peeled line is the commit an annotated tag points at
	expect(tags.find(t => t.tag === "v261103.1.2")?.sha).toBe("4".repeat(40));
	expect(parseRelease("v261103.4")).toBeUndefined();
	expect(parseRelease("v261103.1.2")?.text).toBe("261103.1.2");
});

test("hotfix track: a forced version is newer than its base and older than the next N", () => {
	const c = (release: string, available: string) =>
		updateAvailable({ at: "", version: { kind: "git", branch: "main", commit: { sha: "a", short: "a", date: "", subject: "" }, release }, ok: true, upstream: "origin/main", available, incoming: [], incomingTotal: 0, ahead: [], dropped: [], dirty: [], blocked: [] });
	expect(c("261103.1", "261103.1.1")).toBe(true);
	expect(c("261103.1.1", "261103.1")).toBe(false);
	expect(c("261103.1.2", "261103.2")).toBe(true);
	expect(c("261103.1", "261103.1.2")).toBe(true);
});

test("three windows a day in KST: next runs at 11:00, then across 18:00, 24:00 and the next day", () => {
	const at = RELEASE_AT;
	const runs = (iso: string) => nextRuns(at, new Date(iso)).map(d => d.toISOString());
	// 11:00 KST
	expect(runs("2026-11-03T02:00:00Z")).toEqual(["2026-11-03T03:00:00.000Z", "2026-11-03T09:00:00.000Z", "2026-11-03T15:00:00.000Z"]);
	// 18:30 KST: midnight, then tomorrow's 12:00 and 18:00
	expect(runs("2026-11-03T09:30:00Z")).toEqual(["2026-11-03T15:00:00.000Z", "2026-11-04T03:00:00.000Z", "2026-11-04T09:00:00.000Z"]);
	// 00:05 KST: the 24:00 window is tonight's midnight, not the one just past
	expect(runs("2026-11-03T15:05:00Z")).toEqual(["2026-11-04T03:00:00.000Z", "2026-11-04T09:00:00.000Z", "2026-11-04T15:00:00.000Z"]);
	// a single window still works
	expect(nextRuns("10:00", new Date("2026-11-03T02:00:00Z"))).toHaveLength(1);
});

describe("against temp git repos", () => {
	let r: Repos;
	let work: string, pusher: string, logDir: string;
	const opts = (exec?: Exec) => ({ dir: work, remote: "origin", branch: "main", testCmd, logDir, exec });
	// An exec that runs for real and records each command line.
	const spy = () => {
		const seen: string[] = [];
		const exec: Exec = async (cmd, cwd, ms) => (seen.push(cmd.join(" ")), defaultExec(cmd, cwd, ms));
		return { seen, exec };
	};
	const merges = (seen: string[]) => seen.filter(c => c.startsWith("git merge --ff-only ")).length;
	const logged = () => readdirSync(logDir).map(f => readFileSync(join(logDir, f), "utf8")).join("\n");

	beforeEach(() => {
		r = makeRepos();
		({ work, pusher, logDir } = r);
	});
	afterEach(() => {
		setSelfUpdateCfg(undefined);
		r.remove();
	});

	test("check lists the incoming commits to the newest release and changes nothing in the checkout", async () => {
		const before = head(work);
		commit(pusher, "a.txt", "2\n", "second change");
		commit(pusher, "b.txt", "x\n", "third change");
		const version = r.release("c.txt", "y\n", "release change");
		const c = await check(opts());
		expect(c.ok).toBe(true);
		expect(c.available).toBe(version);
		expect(c.version.kind === "git" && c.version.release).toBe("261101.1");
		expect(c.summary).toBe(`261101.1 → ${version}`);
		expect(c.incomingTotal).toBe(3);
		expect(c.incoming.map(i => i.subject).slice(1)).toEqual(["third change", "second change"]);
		expect(c.blocked).toEqual([]);
		expect(head(work)).toBe(before);
		expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("1\n");
	});

	test("a new commit on main is not an update: the disk version is at the newest tag", async () => {
		r.push("a.txt", "2\n", "unreleased change");
		const c = await check(opts());
		expect(c.ok).toBe(true);
		expect(c.incomingTotal).toBe(0);
		expect(c.available).toBe("261101.1");
		expect(c.remoteHead).toBeUndefined();
		expect(c.summary).toBe("업데이트 없음 (261101.1)");
		expect(updateAvailable(c)).toBe(false);
		expect(logged()).toContain("업데이트 없음");
	});

	test("an install with no VERSION on disk (never released) is older than any tag", async () => {
		rmSync(join(work, "VERSION"));
		const c = await check(opts());
		expect(c.ok).toBe(true);
		expect(c.available).toBe("261101.1");
		expect(updateAvailable(c)).toBe(true);
		expect(c.summary).toBe("설치본 → 261101.1");
	});

	// Owner 2026-10-29: a local edit never stops a shipped update ("로컬에서 수정해서 사용하는거때문에 내가 배포한 업뎃이 실패하면 안됨").
	test("uncommitted changes do not stop the update: saved, moved on, untracked files kept", async () => {
		r.release("a.txt", "2\n", "second");
		writeFileSync(join(work, "a.txt"), "my edit\n");
		writeFileSync(join(work, "notes.txt"), "untracked\n");
		const j = await apply(opts());
		expect(j.status).toBe("updated");
		expect(head(work)).toBe(head(pusher));
		expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("2\n");
		expect(existsSync(join(work, "notes.txt"))).toBe(true);
	});

	test("local commits that conflict with the new version do not stop the update and are kept on a branch, never dropped", async () => {
		commit(work, "a.txt", "local\n", "my local work");
		const mine = head(work);
		r.release("a.txt", "2\n", "second");
		const j = await apply(opts());
		expect(j.status).toBe("updated");
		expect(j.note).toContain("dotz-local/");
		expect(sh(work, "log", "-1", "--format=%s", j.note!.match(/dotz-local\/[\w-]+/)![0])).toBe("my local work");
		expect(sh(work, "rev-parse", j.note!.match(/dotz-local\/[\w-]+/)![0])).toBe(mine);
	});

	test("a clean checkout fast-forwards to origin, tests pass, every step is logged", async () => {
		const before = head(work);
		r.release("a.txt", "2\n", "second");
		const target = head(pusher);
		const { seen, exec } = spy();
		const j = await apply(opts(exec));
		expect(j.status).toBe("updated");
		expect(j.from).toBe(before);
		expect(j.to).toBe(target);
		expect(head(work)).toBe(target);
		expect(merges(seen)).toBe(1);
		expect(seen).not.toContain("bun install");
		expect(logged()).toContain("fast-forward");
	});

	test("a changed package.json runs bun install before the tests", async () => {
		r.release("package.json", "{}\n", "deps");
		const seen: string[] = [];
		const exec: Exec = async (cmd, cwd, ms) => {
			seen.push(cmd.join(" "));
			return cmd[0] === "bun" ? { code: 0, out: "" } : defaultExec(cmd, cwd, ms);
		};
		const j = await apply(opts(exec));
		expect(j.status).toBe("updated");
		expect(seen.indexOf("bun install")).toBeGreaterThan(-1);
		expect(seen.indexOf("bun install")).toBeLessThan(seen.indexOf(testCmd.join(" ")));
	});

	test("the gate the incoming commit defines in hub/update-gate.json is the one that runs, on the same update", async () => {
		mkdirSync(join(pusher, "hub"), { recursive: true });
		r.release("hub/update-gate.json", JSON.stringify({ cmd: ["bun", "test", "--new-gate"], timeoutMinutes: 30 }), "new gate");
		const seen: { cmd: string; ms: number }[] = [];
		const exec: Exec = async (cmd, cwd, ms) => (seen.push({ cmd: cmd.join(" "), ms }), cmd[0] === "bun" ? { code: 0, out: "" } : defaultExec(cmd, cwd, ms));
		const j = await apply({ ...opts(exec), testCmd: undefined });
		expect(j.status).toBe("updated");
		expect(seen.filter(s => s.cmd.startsWith("bun test"))).toEqual([{ cmd: "bun test --new-gate", ms: 30 * 60_000 }]);
	});

	test("an incoming commit without a gate file runs the running version's gate, not nothing", async () => {
		r.release("x.txt", "x", "no gate file");
		const seen: { cmd: string; ms: number }[] = [];
		const exec: Exec = async (cmd, cwd, ms) => (seen.push({ cmd: cmd.join(" "), ms }), cmd[0] === "bun" ? { code: 0, out: "" } : defaultExec(cmd, cwd, ms));
		const j = await apply({ ...opts(exec), testCmd: undefined });
		expect(j.status).toBe("updated");
		expect(seen.filter(s => s.cmd.startsWith("bun test"))).toEqual([{ cmd: "bun test --isolate", ms: 20 * 60_000 }]);
	});

	test("an applied update leaves update-pending.json and starts the rollback watchdog from a copy in the data dir", async () => {
		const before = head(work);
		const data = join(r.root, "data");
		r.release("x.txt", "x", "new version");
		const spawned: string[][] = [];
		const j = await apply({ ...opts(), dataDir: data, watch: { pid: 4242, port: 47111, spawn: c => void spawned.push(c) } });
		expect(j.status).toBe("updated");
		const marker = JSON.parse(readFileSync(join(data, "update-pending.json"), "utf8"));
		expect(marker).toMatchObject({ kind: "git", dir: work, from: before, to: head(work), deps: false, status: "pending", gatewayPid: 4242, port: 47111 });
		expect(spawned).toEqual([[process.execPath, join(data, "update-watchdog.ts"), join(data, "update-pending.json")]]);
		expect(readFileSync(join(data, "update-watchdog.ts"), "utf8")).toBe(readFileSync(join(import.meta.dir, "update-watchdog.ts"), "utf8"));
	});

	test("a failed update leaves no pending marker and starts no watchdog", async () => {
		const data = join(r.root, "data");
		r.release("FAIL", "boom\n", "breaks the tests");
		const spawned: string[][] = [];
		const j = await apply({ ...opts(), dataDir: data, watch: { pid: 4242, port: 47111, spawn: c => void spawned.push(c) } });
		expect(j.status).toBe("failed");
		expect(existsSync(join(data, "update-pending.json"))).toBe(false);
		expect(spawned).toEqual([]);
	});

	test("failing tests put the checkout back on the old commit", async () => {
		const before = head(work);
		r.release("FAIL", "boom\n", "breaks the tests");
		const j = await apply(opts());
		expect(j.status).toBe("failed");
		expect(head(work)).toBe(before);
		expect(existsSync(join(work, "FAIL"))).toBe(false);
		expect(sh(work, "status", "--porcelain")).toBe("");
	});

	test("a failing apply logs the failing test block, not only the tail", async () => {
		r.release("FAIL", "boom\n", "breaks the tests");
		const exec: Exec = async (cmd, cwd, ms) =>
			cmd.join(" ") === testCmd.join(" ") ? { code: 1, out: `${"noise\n".repeat(100)}error: expect(received).toBe(expected)\n(fail) the broken one [1ms]\n 1 fail\n` } : defaultExec(cmd, cwd, ms);
		const j = await apply(opts(exec));
		expect(j.status).toBe("failed");
		expect(j.message).toContain("the broken one");
		expect(logged()).toContain("failed tests\nnoise");
		expect(logged()).toContain("error: expect(received).toBe(expected)\n(fail) the broken one [1ms]");
	});

	// Owner 2026-11-01: "1pass 이거 뜨는거 불필요" - bun's counts stay in the update log, never in the owner-facing text.
	test("the test counts are logged but never shown to the owner, on success and on failure", async () => {
		r.release("a.txt", "2\n", "second");
		const ok: Exec = async (cmd, cwd, ms) => (cmd.join(" ") === testCmd.join(" ") ? { code: 0, out: "(pass) one [1ms]\n 1 pass\n 0 fail\n" } : defaultExec(cmd, cwd, ms));
		const j = await apply(opts(ok));
		expect(j.status).toBe("updated");
		expect(j.message).toMatch(/받았어요\. 재시작하면 적용돼요/);
		expect(j.message).not.toMatch(/\d+ (pass|fail)|테스트/);
		expect(logged()).toContain("1 pass, 0 fail");

		r.release("FAIL", "boom\n", "breaks the tests");
		const bad: Exec = async (cmd, cwd, ms) => (cmd.join(" ") === testCmd.join(" ") ? { code: 1, out: "(fail) the broken one [1ms]\n 3 pass\n 1 fail\n" } : defaultExec(cmd, cwd, ms));
		const f = await apply(opts(bad));
		expect(f.status).toBe("failed");
		expect(f.message).toContain("테스트 실패: the broken one");
		expect(f.message).not.toMatch(/\d+ (pass|fail)/);
		expect(logged()).toContain("3 pass, 1 fail");
	});

	test("nothing new is reported as current and does not run the tests", async () => {
		const { seen, exec } = spy();
		const j = await apply(opts(exec));
		expect(j.status).toBe("current");
		expect(seen).not.toContain(testCmd.join(" "));
	});

	test("a fetch failure says why", async () => {
		sh(work, "remote", "set-url", "origin", join(r.root, "missing.git"));
		const c = await check(opts());
		expect(c.ok).toBe(false);
		expect(c.error?.reason).toBeTruthy();
	});

	// auto_apply: the check applies a new release by itself unless the owner turns it off (default on). Local repos only, no network;
	// hooks record what main.ts would do.
	describe("auto_apply", () => {
		test("on by default: a new release applies on its own and restarts through the idle gate", async () => {
			setSelfUpdateCfg(undefined);
			r.release("a.txt", "2\n", "second");
			const { h, api } = autoHooks();
			await autoCheck(opts(), api);
			expect(head(work)).toBe(head(pusher));
			expect(h.worklog).toHaveLength(1);
			expect(h.worklog[0]).toContain("261101.1 → 261101.2");
			expect(h.restarts).toBe(1);
			expect(h.alerts).toEqual([]);
		});

		test("off: a new release only notifies, nothing is applied or restarted", async () => {
			setSelfUpdateCfg({ auto_apply: false });
			const before = head(work);
			r.release("a.txt", "2\n", "second");
			const { h, api } = autoHooks();
			await autoCheck(opts(), api);
			expect(head(work)).toBe(before);
			expect(h).toEqual({ worklog: [], alerts: [], restarts: 0 });
		});

		test("applies a clean, not-ahead checkout, says so in worklog and restarts through the idle gate", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			r.release("a.txt", "2\n", "second");
			const { h, api } = autoHooks();
			await autoCheck(opts(), api);
			expect(head(work)).toBe(head(pusher));
			expect(h.worklog).toHaveLength(1);
			expect(h.restarts).toBe(1);
			expect(h.alerts).toEqual([]);
		});

		test("a dirty checkout still updates on its own: no alert, one restart, the edit kept in the backup", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			r.release("a.txt", "2\n", "second");
			writeFileSync(join(work, "a.txt"), "my edit\n");
			// the first changed file keeps its two-column status, so the screen does not read "M .txt" (Mac mini 2026-10-29: "ub/laneops.ts")
			expect((await check(opts())).dirty).toEqual([" M a.txt"]);
			const { h, api } = autoHooks();
			await autoCheck(opts(), api);
			expect(head(work)).toBe(head(pusher));
			expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("2\n");
			expect(h.alerts).toEqual([]);
			expect(h.restarts).toBe(1);
		});

		test("a developer checkout whose local commits conflict still updates; the commits are kept on a branch", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			commit(work, "a.txt", "local\n", "my local work");
			r.release("a.txt", "2\n", "second");
			const { h, api } = autoHooks();
			await autoCheck(opts(), api);
			expect(head(work)).toBe(head(pusher));
			expect(h.alerts).toEqual([]);
			expect(h.restarts).toBe(1);
		});

		test("reverts on a test failure, alerts with a choice block, does not retry that commit and does not restart", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			const before = head(work);
			r.release("FAIL", "boom\n", "breaks the tests");
			const { seen, exec } = spy();
			const { h, api } = autoHooks();
			await autoCheck(opts(exec), api);
			expect(head(work)).toBe(before);
			expect(h.alerts).toHaveLength(1);
			expect(h.alerts[0]).toContain("결정:");
			expect(h.restarts).toBe(0);
			expect(h.worklog).toEqual([]);
			const merged = merges(seen);
			await autoCheck(opts(exec), api);
			expect(merges(seen)).toBe(merged);
			expect(h.alerts).toHaveLength(1);
		});
	});
});
