// Settings → 업데이트 against real git repos in a temp dir: a bare "origin", a clone the updater works on, and a second
// clone that pushes newer commits. The test command is a shell check so a commit can make "the tests" fail on purpose.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDecisions } from "./choices.ts";
import { cfg } from "./config.ts";
import { autoHooks, commit, failFileTestCmd as testCmd, git as sh, head, makeRepos, type Repos, setSelfUpdateCfg } from "./selfupdate-fixture.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import { clearTrackedTimers } from "./shutdown.ts";
import { apply, autoCheck, CHECK_EVERY_MS, check, defaultExec, type Exec, fetchError, scrub, startSelfUpdate, updateAvailable, updateRoute } from "./selfupdate.ts";
import { failedTestNames, failureBlocks, parseRelease, releaseTags } from "./selfupdate-parse.ts";

setDefaultTimeout(30_000); // real git repos and test runs: seconds each, more under parallel load

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

describe("against temp git repos", () => {
	let r: Repos;
	let work: string, pusher: string, logDir: string;
	const opts = (exec?: Exec) => ({ dir: work, remote: "origin", branch: "main", testCmd, logDir, exec, alert: () => {} }); // these tags are unsigned: the signature alert has its own tests
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

	// What GET /api/update hands to `dotz status` and the settings screen: a check made on another version than the disk's is no state.
	const reported = async () => {
		const url = new URL("http://localhost/api/update");
		const res = await updateRoute(new Request(url), url, { boot: "b", busy: () => [], restartIdle: () => "", restartNow: () => "", options: opts() });
		return ((await res!.json()) as { lastCheck: { incomingTotal: number } | null }).lastCheck;
	};

	test("a stored check made on the version now on disk still reports its incoming count", async () => {
		setSelfUpdateCfg({ auto_apply: false });
		r.release("a.txt", "2\n", "second");
		await autoCheck(opts());
		expect((await reported())?.incomingTotal).toBe(1);
	});

	test("after an update is applied the check made before it is no longer reported", async () => {
		setSelfUpdateCfg({ auto_apply: false });
		r.release("a.txt", "2\n", "second");
		await autoCheck(opts());
		expect((await apply(opts())).status).toBe("updated");
		expect(await reported()).toBeNull();
	});

	test("a fetch failure says why", async () => {
		sh(work, "remote", "set-url", "origin", join(r.root, "missing.git"));
		const c = await check(opts());
		expect(c.ok).toBe(false);
		expect(c.error?.reason).toBeTruthy();
	});

	// The automatic check runs every CHECK_EVERY_MS on one timer that is armed again only after a check has finished.
	test("the automatic check runs every CHECK_EVERY_MS on one rearmed timer", async () => {
		setSelfUpdateCfg({ auto_apply: false });
		const waiters: Array<() => void> = [];
		let checks = 0;
		const exec: Exec = async (cmd, cwd, ms) => {
			const out = await defaultExec(cmd, cwd, ms);
			if (cmd[1] === "ls-remote") { checks++; waiters.splice(0).forEach(w => w()); }
			return out;
		};
		const checked = (n: number) => new Promise<void>(res => { const tick = () => (checks >= n ? res() : waiters.push(tick)); tick(); });
		let noted = () => {};
		const note = new Promise<void>(res => { noted = res; });
		try {
			await startSelfUpdate(() => noted(), { ...opts(exec) });
			await advance(CHECK_EVERY_MS - 1);
			expect(checks).toBe(0);
			r.release("a.txt", "2\n", "second");
			await advance(1);
			await checked(1);
			await note;
			await flush();
			await advance(CHECK_EVERY_MS - 1);
			expect(checks).toBe(1);
			await advance(1);
			await checked(2);
		} finally {
			clearTrackedTimers();
		}
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

		test("reverts on a test failure, alerts with its card in the owner's language and its id, does not retry that commit and does not restart", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			const before = head(work);
			r.release("FAIL", "boom\n", "breaks the tests");
			const { seen, exec } = spy();
			const { h, api, cardIds } = autoHooks();
			const was = cfg.identity;
			cfg.identity = { ...was!, language: "ko" };
			try {
				await autoCheck(opts(exec), api);
			} finally {
				cfg.identity = was;
			}
			expect(head(work)).toBe(before);
			expect(h.alerts).toHaveLength(1);
			expect(cardIds).toEqual([["update:self"]]);
			const card = parseDecisions(h.alerts[0]!).blocks[0]!;
			expect(card.title).toBe("dotz 업데이트 · 원인을 확인할까요?");
			expect(card.evidence?.[0]).toBe("버전 261101.1 → 261101.2: 적용하지 못했어요");
			expect(card.evidence).toContain("새 커밋 1개, 마지막: breaks the tests");
			expect(card.evidence?.[3]).toBe("지금 버전 그대로예요. 더 새 버전이 오면 다시 시도해요");
			expect(card.options.map(o => o.label)).toEqual(["원인 확인", "자동 업데이트 끄기"]);
			expect(h.restarts).toBe(0);
			expect(h.worklog).toEqual([]);
			const merged = merges(seen);
			await autoCheck(opts(exec), api);
			expect(merges(seen)).toBe(merged);
			expect(h.alerts).toHaveLength(1);
		});

		test("a rollback that fails too: the card says the update stopped halfway, which commit the files are at, and its command, pasted as printed, puts the files back and keeps the local change", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			const before = head(work);
			r.release("FAIL", "boom\n", "breaks the tests");
			const { h, api, cardIds } = autoHooks();
			const was = cfg.identity;
			cfg.identity = { ...was!, language: "ko" };
			try {
				await autoCheck({ ...opts(), testCmd: ["sh", "-c", "echo local >> VERSION; test ! -f FAIL"] }, api);
			} finally {
				cfg.identity = was;
			}
			const stuck = head(work);
			expect(stuck).not.toBe(before);
			expect(cardIds).toEqual([["update:self"]]);
			const evidence = parseDecisions(h.alerts[0]!).blocks[0]!.evidence ?? [];
			expect(evidence[0]).toBe("버전 261101.1 → 261101.2: 적용하지 못했어요");
			expect(evidence[1]).toStartWith("이유: ");
			expect(evidence[2]).toBe(`업데이트가 중간에 멈췄어요. 파일은 새 버전 ${stuck.slice(0, 7)}에 있어요`);
			expect(evidence[3]).toStartWith(`되돌리려면 터미널에서: \`git -C ${JSON.stringify(work)} `);
			expect(evidence.filter(l => l.includes("그대로") || l.includes("되돌리기도"))).toEqual([]);
			const pasted = /^되돌리려면 터미널에서: `?(git -C .+?)`?$/.exec(evidence[3]!)![1]!;
			expect(Bun.spawnSync(["sh", "-c", pasted]).exitCode).toBe(0);
			expect(head(work)).toBe(before);
			expect([existsSync(join(work, "FAIL")), sh(work, "status", "--porcelain")]).toEqual([false, ""]);
			expect(sh(work, "stash", "show", "-p", "stash@{0}")).toContain("+local");
		});

		test("a step that throws after the merge leaves the files at the new version: the card says so and its command puts them back, never that the version is unchanged", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			const before = head(work);
			r.release("b.txt", "2\n", "a release");
			const exec: Exec = async (cmd, cwd, ms) => {
				if (cmd.join(" ") === testCmd.join(" ")) throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
				return defaultExec(cmd, cwd, ms);
			};
			const { h, api } = autoHooks();
			const was = cfg.identity;
			cfg.identity = { ...was!, language: "ko" };
			try {
				await autoCheck(opts(exec), api);
			} finally {
				cfg.identity = was;
			}
			const stuck = head(work);
			expect(stuck).not.toBe(before);
			const evidence = parseDecisions(h.alerts[0]!).blocks[0]!.evidence ?? [];
			expect(evidence.filter(l => l.includes("그대로"))).toEqual([]);
			expect(evidence[2]).toBe(`업데이트가 중간에 멈췄어요. 파일은 새 버전 ${stuck.slice(0, 7)}에 있어요`);
			const pasted = /^되돌리려면 터미널에서: `?(git -C .+?)`?$/.exec(evidence[3] ?? "")?.[1] ?? "";
			expect(Bun.spawnSync(["sh", "-c", pasted]).exitCode).toBe(0);
			expect(head(work)).toBe(before);
		});

		test("an install from a tarball address has no release number: its failed update says the new commits could not be applied, never a version named by a hash", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			const app = join(r.root, "app"), src = join(r.root, "src"), tgz = join(r.root, "dotz.tar.gz");
			mkdirSync(join(src, "dotz", "hub"), { recursive: true });
			for (const f of ["setup.ts", "hub/main.ts", "FAIL"]) writeFileSync(join(src, "dotz", f), "x\n");
			expect(Bun.spawnSync(["tar", "-czf", tgz, "-C", src, "dotz"]).exitCode).toBe(0);
			mkdirSync(app);
			writeFileSync(join(app, ".dotz-install"), `source=file://${tgz}\nkind=url\ntarball=file://${tgz}\nsha=${"a".repeat(64)}\nauth=public\n`);
			const exec: Exec = async (cmd, cwd, ms) => (cmd[0] === "bun" ? { code: 0, out: "" } : defaultExec(cmd, cwd, ms));
			const { h, api } = autoHooks();
			const was = cfg.identity;
			cfg.identity = { ...was!, language: "ko" };
			try {
				await autoCheck({ dir: app, testCmd, logDir, exec, alert: () => {} }, api);
			} finally {
				cfg.identity = was;
			}
			expect(parseDecisions(h.alerts[0]!).blocks[0]!.evidence?.[0]).toBe("새 커밋을 적용하지 못했어요");
		});

		test("a refused auto-update posts its card with its id", async () => {
			setSelfUpdateCfg({ auto_apply: true });
			r.release("b.txt", "2\n", "a new release");
			sh(work, "checkout", "-q", "-b", "dev");
			const { h, api, cardIds } = autoHooks();
			const was = cfg.identity;
			cfg.identity = { ...was!, language: "ko" };
			try {
				await autoCheck(opts(), api);
			} finally {
				cfg.identity = was;
			}
			expect(cardIds).toEqual([["update:self"]]);
			expect(parseDecisions(h.alerts[0]!).blocks[0]!.evidence?.[0]).toBe("버전 261101.1 → 261101.2: 막혀서 적용하지 않았어요");
		});
	});

	test("a commit that failed its tests is not tested again until a newer commit arrives or the owner asks", async () => {
		const before = head(work);
		r.release("FAIL", "boom\n", "breaks the tests");
		const { seen, exec } = spy();
		const tests = () => seen.filter(c => c === testCmd.join(" ")).length;
		expect((await apply(opts(exec))).status).toBe("failed");
		expect(tests()).toBe(1);
		const merged = merges(seen);

		const again = await apply(opts(exec));
		expect(again.status).toBe("failed");
		expect(again.message).toContain("같은 커밋");
		expect(tests()).toBe(1);
		expect(merges(seen)).toBe(merged);
		expect(head(work)).toBe(before);

		expect((await apply(opts(exec), { retry: true })).status).toBe("failed");
		expect(tests()).toBe(2);

		r.release("FAIL", "fixed? no\n", "still breaks the tests");
		expect((await apply(opts(exec))).status).toBe("failed");
		expect(tests()).toBe(3);
	});
});
