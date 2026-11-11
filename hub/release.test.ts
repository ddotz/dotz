import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLOT_SKIPPED_EXIT } from "./release-exit.ts";
import { type Attempt, failedFiles, failedTests, RETRY_MAX_FAILED_SHARE, runGate, runWithRetry, type GateEnv, type SuiteFn, type SuiteResult, testFileCount } from "./release-gate.ts";
import {
	compareVersions,
	cutInSlot,
	dirtyTracked,
	dispatchSlot,
	type DispatchOptions,
	gitOutput,
	hasCommitsSince,
	localTags,
	newCommitsSinceNewestTag,
	newestVersion,
	parseVersion,
	planForcedNext,
	planNext,
	publishVersion,
	shiftDay,
	slotStart,
	summarizeChanges,
	todayKst,
} from "./release.ts";

const roots: string[] = [];
// These tests are about notes and slots, not signing: the one unsigned transition release (a runner, no key anywhere) needs no key fixtures.
const UNSIGNED = { ci: true, signingKey: join(tmpdir(), "dotz-release-no-such-key") };

function tempRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "dotz-release-"));
	roots.push(root);
	git(root, "init", "-q");
	git(root, "config", "user.name", "test");
	git(root, "config", "user.email", "test@example.com");
	return root;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commit(root: string, message: string): void {
	git(root, "commit", "--allow-empty", "-q", "-m", message);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("planNext", () => {
	test("first release of the day after an older day", () => {
		const plan = planNext(["v261102.3"], "261103");
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.version.text).toBe("261103.1");
		expect(plan.previous?.text).toBe("261102.3");
	});

	test("counts today's versions, no gaps from skipped windows", () => {
		const first = planNext(["v261103.1"], "261103");
		expect(first.ok && first.version.text).toBe("261103.2");
		const second = planNext(["v261103.1", "v261103.2"], "261103");
		expect(second.ok && second.version.text).toBe("261103.3");
		const quietDay = planNext(["v261101.1", "v261102.2"], "261103");
		expect(quietDay.ok && quietDay.version.text).toBe("261103.1");
	});

	test("no tags at all starts today at .1", () => {
		const plan = planNext([], "261103");
		expect(plan.ok && plan.version.text).toBe("261103.1");
		expect(plan.ok && plan.previous).toBeNull();
	});

	test("a fourth release in one day is refused with the reason", () => {
		const plan = planNext(["v261103.1", "v261103.2", "v261103.3"], "261103");
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.code).toBe("limit");
		expect(plan.reason).toContain("세 번");
		expect(plan.reason).toContain("261104.1");
	});

	test("a day already carrying .3 is closed", () => {
		const plan = planNext(["v261103.3"], "261103");
		expect(plan.ok).toBe(false);
	});

	test("a tag dated after today is refused instead of reused", () => {
		const plan = planNext(["v261104.1"], "261103");
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.code).toBe("future");
	});

	test("junk tags are ignored", () => {
		const plan = planNext(["nightly", "v261103", "v261133.1", "v261103.0", "v261102.2"], "261103");
		expect(plan.ok && plan.version.text).toBe("261103.1");
	});
});

describe("ordering", () => {
	test("date and number compare numerically", () => {
		const a = parseVersion("261103.2")!;
		const b = parseVersion("261103.1")!;
		const c = parseVersion("261102.3")!;
		const d = parseVersion("261031.3")!;
		expect(compareVersions(a, b)).toBeGreaterThan(0);
		expect(compareVersions(b, c)).toBeGreaterThan(0);
		expect(compareVersions(b, d)).toBeGreaterThan(0);
		expect(compareVersions(a, a)).toBe(0);
	});

	test("hotfix parts order after the scheduled version", () => {
		expect(compareVersions(parseVersion("261103.1.2")!, parseVersion("261103.1.1")!)).toBeGreaterThan(0);
		expect(compareVersions(parseVersion("261103.1.1")!, parseVersion("261103.1")!)).toBeGreaterThan(0);
		expect(compareVersions(parseVersion("261103.2")!, parseVersion("261103.1.9")!)).toBeGreaterThan(0);
	});

	test("newestVersion picks the greatest tag", () => {
		expect(newestVersion(["v261102.3", "v261103.1", "v261031.3"])?.text).toBe("261103.1");
		expect(newestVersion(["junk", "v261103.1"])?.text).toBe("261103.1");
		expect(newestVersion(["junk"])).toBeNull();
	});
});

describe("parseVersion", () => {
	test("parses scheduled and forced versions", () => {
		expect(parseVersion("v261103.1")?.text).toBe("261103.1");
		expect(parseVersion("261103.1")?.text).toBe("261103.1");
		expect(parseVersion(" v261103.2 ")?.text).toBe("261103.2");
		expect(parseVersion("v261103.1.1")?.text).toBe("261103.1.1");
		expect(parseVersion("v261103.1.12")?.text).toBe("261103.1.12");
	});

	test("bad tags yield null instead of throwing", () => {
		for (const bad of ["", "v261103", "v26110.1", "v261133.1", "v261103.0", "v261103.4", "v261103.1.0", "release-2026", "v261103.x"]) {
			expect(parseVersion(bad)).toBeNull();
		}
	});
});

describe("planForcedNext", () => {
	test("appends the hotfix part to the newest scheduled version", () => {
		expect(planForcedNext(["v261103.1"])).toMatchObject({ ok: true, version: { text: "261103.1.1" } });
		expect(planForcedNext(["v261103.1.1"])).toMatchObject({ ok: true, version: { text: "261103.1.2" } });
		expect(planForcedNext(["v261103.2"])).toMatchObject({ ok: true, version: { text: "261103.2.1" } });
		expect(planForcedNext(["v261103.1.2", "v261103.2"])).toMatchObject({ ok: true, version: { text: "261103.2.1" } });
	});

	test("keeps the base day even when it is not today", () => {
		const plan = planForcedNext(["v261102.3"]);
		expect(plan.ok && plan.version.text).toBe("261102.3.1");
	});

	test("ignores the three-a-day cap", () => {
		expect(planNext(["v261103.1", "v261103.2", "v261103.3"], "261103").ok).toBe(false);
		expect(planForcedNext(["v261103.1", "v261103.2", "v261103.3"])).toMatchObject({ ok: true, version: { text: "261103.3.1" } });
	});

	test("needs a base version first", () => {
		const plan = planForcedNext([]);
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.reason).toContain("정기 버전");
	});
});

describe("dates", () => {
	test("todayKst follows the KST calendar", () => {
		expect(todayKst(new Date("2026-11-02T15:30:00Z"))).toBe("261103");
		expect(todayKst(new Date("2026-11-03T14:59:59Z"))).toBe("261103");
		expect(todayKst(new Date("2026-11-03T15:00:00Z"))).toBe("261104");
	});

	test("shiftDay crosses month ends", () => {
		expect(shiftDay("261031", 1)).toBe("261101");
		expect(shiftDay("261230", 2)).toBe("270101");
	});
});

describe("release note", () => {
	const kst = (text: string) => new Date(`${text}+09:00`);
	const published = async (force: boolean) => {
		const parent = mkdtempSync(join(tmpdir(), "dotz-release-gh-"));
		roots.push(parent);
		const origin = join(parent, "github.com", "ddotz", "dotz.git");
		mkdirSync(origin, { recursive: true });
		git(origin, "init", "-q", "--bare", "-b", "main");
		const root = tempRepo();
		git(root, "remote", "add", "origin", origin);
		git(root, "switch", "-q", "-c", "main");
		commit(root, "base");
		git(root, "tag", "v261105.1");
		git(root, "commit", "--allow-empty", "-q", "-m", "메시지가 끊기지 않아요", "-m", "왜: 재시작 뒤 답이 사라졌어요.\n어떻게: 이제 다시 보내요.");
		git(root, "push", "-q", "origin", "main", "v261105.1");
		const calls: { cmd: readonly string[]; body: string }[] = [];
		const exec = async (cmd: readonly string[]) => {
			calls.push({ cmd, body: readFileSync(cmd[cmd.length - 1], "utf8") });
			return { code: 0, out: "https://github.com/ddotz/dotz/releases/tag/x" };
		};
		const code = await publishVersion({ ...UNSIGNED, auto: false, force, dryRun: false, cwd: root, now: kst("2026-11-06T13:00:00"), print: () => {}, exec, terms: [], address: "" });
		return { code, calls };
	};

	for (const [name, force, tag] of [["scheduled", false, "v261106.1"], ["--force", true, "v261105.1.1"]] as const) {
		test(`a ${name} release publishes the note as its GitHub Release`, async () => {
			const { code, calls } = await published(force);
			expect(code).toBe(0);
			expect(calls).toHaveLength(1);
			expect(calls[0].cmd.slice(0, 6)).toEqual(["gh", "release", "create", tag, "--repo", "ddotz/dotz"]);
			expect(calls[0].body).toContain("- 메시지가 끊기지 않아요");
			expect(calls[0].body).not.toContain("**왜**");
			expect(calls[0].body).not.toMatch(/\b[0-9a-f]{7,}\b/);
			expect(calls[0].body).not.toContain("release: v");
		});
	}

	test("--dry-run prints the note and calls nothing", async () => {
		const root = tempRepo();
		commit(root, "base");
		git(root, "tag", "v261105.1");
		commit(root, "버튼 폭을 고칩니다");
		const lines: string[] = [];
		const exec = async () => { throw new Error("no exec in a dry run"); };
		expect(await publishVersion({ ...UNSIGNED, auto: false, force: false, dryRun: true, cwd: root, now: kst("2026-11-06T13:00:00"), print: l => lines.push(l), exec, terms: [], address: "" })).toBe(0);
		expect(lines.join("\n")).toContain("- 버튼 폭을 고칩니다");
	});

	test("--dry-run on a full day says so and still shows what the next version would carry", async () => {
		const root = tempRepo();
		commit(root, "base");
		for (const n of [1, 2, 3]) git(root, "tag", `v261106.${n}`);
		git(root, "commit", "--allow-empty", "-q", "-m", "버튼 폭을 고칩니다", "-m", "왜: 글자가 잘렸어요.");
		const lines: string[] = [];
		expect(await publishVersion({ ...UNSIGNED, auto: false, force: false, dryRun: true, cwd: root, now: kst("2026-11-06T19:00:00"), print: l => lines.push(l), terms: [], address: "" })).toBe(1);
		const text = lines.join("\n");
		expect(text).toContain("# dotz 다음 버전");
		expect(text).toContain("- 버튼 폭을 고칩니다");
	});

	test("a failed GitHub Release fails the run and keeps the note in the log", async () => {
		const parent = mkdtempSync(join(tmpdir(), "dotz-release-gh-"));
		roots.push(parent);
		const origin = join(parent, "github.com", "ddotz", "dotz.git");
		mkdirSync(origin, { recursive: true });
		git(origin, "init", "-q", "--bare", "-b", "main");
		const root = tempRepo();
		git(root, "remote", "add", "origin", origin);
		git(root, "switch", "-q", "-c", "main");
		commit(root, "base");
		git(root, "push", "-q", "origin", "main");
		const lines: string[] = [];
		const code = await publishVersion({ ...UNSIGNED, auto: false, force: false, dryRun: false, cwd: root, now: kst("2026-11-06T13:00:00"), print: l => lines.push(l), exec: async () => { throw new Error("gh is not installed"); }, terms: [], address: "" });
		expect(code).toBe(1);
		expect(git(origin, "tag", "--list", "v*").trim()).toBe("v261106.1");
		expect(lines.join("\n")).toContain("# dotz v261106.1");
	});

	// A checkout whose site/demo was built from an older web/, with an origin to push to.
	const withDemo = () => {
		const parent = mkdtempSync(join(tmpdir(), "dotz-release-gh-"));
		roots.push(parent);
		const origin = join(parent, "github.com", "ddotz", "dotz.git");
		mkdirSync(origin, { recursive: true });
		git(origin, "init", "-q", "--bare", "-b", "main");
		const root = tempRepo();
		git(root, "remote", "add", "origin", origin);
		git(root, "switch", "-q", "-c", "main");
		mkdirSync(join(root, "site", "demo"), { recursive: true });
		writeFileSync(join(root, "site", "demo", "app.js"), "old demo\n");
		git(root, "add", ".");
		commit(root, "base");
		git(root, "push", "-q", "origin", "main");
		const release = (buildDemo: (cmd: readonly string[]) => Promise<{ code: number; out: string }>, lines: string[] = []) =>
			publishVersion({ ...UNSIGNED, auto: false, force: false, dryRun: false, cwd: root, now: kst("2026-11-06T13:00:00"), print: l => lines.push(l), exec: async () => ({ code: 0, out: "" }), buildDemo, terms: [], address: "" });
		return { root, origin, release };
	};

	test("the release commit carries the rebuilt demo together with VERSION", async () => {
		const { root, origin, release } = withDemo();
		const lines: string[] = [];
		const cmds: (readonly string[])[] = [];
		const code = await release(async cmd => {
			cmds.push(cmd);
			writeFileSync(join(root, "site", "demo", "app.js"), "rebuilt demo\n");
			return { code: 0, out: "" };
		}, lines);
		expect(code).toBe(0);
		expect(cmds).toEqual([["bun", "site/build-demo.ts"]]);
		expect(git(origin, "tag", "--list", "v*").trim()).toBe("v261106.1");
		expect(git(root, "show", "--name-only", "--format=", "v261106.1").split("\n").filter(Boolean).sort()).toEqual(["VERSION", "site/demo/app.js"]);
		expect(git(root, "show", "v261106.1:site/demo/app.js")).toBe("rebuilt demo\n");
		expect(git(origin, "show", "main:site/demo/app.js")).toBe("rebuilt demo\n");
		expect(lines.join("\n")).toContain("데모");
	});

	for (const [name, build] of [
		["reports a failure", (root: string) => async () => { writeFileSync(join(root, "site", "demo", "app.js"), "half written\n"); writeFileSync(join(root, "site", "demo", "new.js"), "stray\n"); return { code: 1, out: "banned word in the bundle" }; }],
		["throws", (root: string) => async () => { writeFileSync(join(root, "site", "demo", "app.js"), "half written\n"); throw new Error("bun is not installed"); }],
	] as const) {
		test(`a builder that ${name} is logged and the release goes out without the demo update`, async () => {
			const { root, origin, release } = withDemo();
			const lines: string[] = [];
			expect(await release(build(root), lines)).toBe(0);
			expect(git(origin, "tag", "--list", "v*").trim()).toBe("v261106.1");
			expect(git(root, "show", "--name-only", "--format=", "v261106.1").trim()).toBe("VERSION");
			expect(readFileSync(join(root, "site", "demo", "app.js"), "utf8")).toBe("old demo\n");
			expect(existsSync(join(root, "site", "demo", "new.js"))).toBe(false);
			expect(lines.join("\n")).toContain("데모를 다시 만들지 못해서");
		});
	}
});

describe("summarizeChanges", () => {
	test("one line from the log, not the raw lines", () => {
		const line = summarizeChanges(["50a7f3e docs: README 정리", "abc1234 설정 한도 문구", "def5678 버튼 폭 수정"], parseVersion("v261102.3"));
		expect(line).toContain("바뀐 것 3건");
		expect(line).toContain("README 정리");
		expect(line).not.toContain("50a7f3e");
		expect(line).not.toContain("\n");
	});

	test("says the release series starts when there is no previous tag", () => {
		const line = summarizeChanges(["abc1234 첫 커밋"], null);
		expect(line).toContain("버전 배포를 시작해요");
	});

	test("caps the shown subjects", () => {
		const line = summarizeChanges(["a111111 one", "b222222 two", "c333333 three", "d444444 four"], parseVersion("v261102.3"));
		expect(line).toContain("외 1건");
		expect(line).not.toContain("four");
	});
});

describe("release slots", () => {
	const kst = (text: string) => new Date(`${text}+09:00`);

	test("a time belongs to the latest 00:00, 12:00 or 18:00 KST", () => {
		const cases: [string, string][] = [
			["2026-11-05T00:00:00", "2026-11-05T00:00:00"],
			["2026-11-05T11:59:59", "2026-11-05T00:00:00"],
			["2026-11-05T12:00:00", "2026-11-05T12:00:00"],
			["2026-11-05T17:59:59", "2026-11-05T12:00:00"],
			["2026-11-05T18:00:00", "2026-11-05T18:00:00"],
			["2026-11-05T23:59:59", "2026-11-05T18:00:00"],
		];
		for (const [at, start] of cases) expect(slotStart(kst(at))).toEqual(kst(start));
	});

	test("a forced release does not take the slot", async () => {
		const root = tempRepo();
		git(root, "commit", "--allow-empty", "-q", "-m", "first", "--date", "2026-11-05T01:00:00+09:00");
		git(root, "tag", "v261105.1");
		git(root, "tag", "v261105.1.1");
		const tags = await localTags(root);
		const cutAt = new Date(Number(git(root, "log", "-1", "--format=%ct", "v261105.1").trim()) * 1000);
		expect((await cutInSlot(root, tags, cutAt))?.text).toBe("261105.1");
		expect(await cutInSlot(root, ["v261105.1.1"], cutAt)).toBeNull();
	});

	test("one slot publishes once when the dispatch and the late cron both run", async () => {
		const origin = mkdtempSync(join(tmpdir(), "dotz-release-origin-"));
		roots.push(origin);
		git(origin, "init", "-q", "--bare", "-b", "main");
		const clone = () => {
			const root = tempRepo();
			git(root, "remote", "add", "origin", origin);
			return root;
		};
		const seed = clone();
		git(seed, "switch", "-q", "-c", "main");
		commit(seed, "work");
		git(seed, "push", "-q", "origin", "main");
		const checkout = () => {
			const root = clone();
			git(root, "switch", "-q", "-c", "main");
			git(root, "pull", "-q", "origin", "main");
			return root;
		};
		const dispatched = checkout();
		const staleCron = checkout();
		const tagsOnOrigin = () => git(origin, "tag", "--list", "v*").split("\n").filter(Boolean);
		const auto = (cwd: string, at: Date) => {
			process.env.GIT_COMMITTER_DATE = at.toISOString();
			return publishVersion({ ...UNSIGNED, auto: true, force: false, dryRun: false, cwd, now: at, print: () => {} });
		};

		try {
			const noon = kst("2026-11-05T12:00:30");
			expect(await auto(dispatched, noon)).toBe(0);
			expect(tagsOnOrigin()).toEqual(["v261105.1"]);

			// Both triggers at once: the cron run queued behind the dispatch, on the commit it started from.
			expect(await auto(staleCron, noon)).toBe(0);
			expect(tagsOnOrigin()).toEqual(["v261105.1"]);

			// The cron landing hours late in the same slot, with new work on main: still the same slot.
			commit(seed, "more work");
			git(seed, "pull", "-q", "--rebase", "origin", "main");
			git(seed, "push", "-q", "origin", "main");
			const lateCron = checkout();
			expect(await auto(lateCron, kst("2026-11-05T17:40:00"))).toBe(0);
			expect(tagsOnOrigin()).toEqual(["v261105.1"]);

			// The next slot goes out.
			expect(await auto(lateCron, kst("2026-11-05T18:00:30"))).toBe(0);
			expect(tagsOnOrigin()).toEqual(["v261105.1", "v261105.2"]);
		} finally {
			delete process.env.GIT_COMMITTER_DATE;
		}
	}, 20_000); // Real git repos and pushes: 2 s alone, over the default 5 s in a full run under load.

	test("a pinned release tags the tested commit plus VERSION, not the main that moved on", async () => {
		const origin = mkdtempSync(join(tmpdir(), "dotz-release-origin-"));
		roots.push(origin);
		git(origin, "init", "-q", "--bare", "-b", "main");
		const clone = () => {
			const root = tempRepo();
			git(root, "remote", "add", "origin", origin);
			return root;
		};
		const seed = clone();
		git(seed, "switch", "-q", "-c", "main");
		commit(seed, "tested");
		git(seed, "push", "-q", "origin", "main");
		const checkout = clone();
		git(checkout, "switch", "-q", "-c", "main");
		git(checkout, "pull", "-q", "origin", "main");
		const tested = git(checkout, "rev-parse", "HEAD").trim();
		commit(seed, "untested");
		git(seed, "push", "-q", "origin", "main");
		const noon = kst("2026-11-05T12:00:30");
		try {
			process.env.GIT_COMMITTER_DATE = noon.toISOString();
			expect(await publishVersion({ ...UNSIGNED, auto: true, force: false, dryRun: false, cwd: checkout, sha: "c".repeat(40), now: noon, print: () => {} })).toBe(1);
			expect(git(origin, "tag", "--list", "v*").trim()).toBe("");
			expect(await publishVersion({ ...UNSIGNED, auto: true, force: false, dryRun: false, cwd: checkout, sha: tested, now: noon, print: () => {} })).toBe(0);
		} finally {
			delete process.env.GIT_COMMITTER_DATE;
		}
		expect(git(origin, "rev-parse", "v261105.1^").trim()).toBe(tested);
		expect(git(origin, "log", "--format=%s", "v261105.1")).not.toContain("untested");
		git(origin, "merge-base", "--is-ancestor", "v261105.1", "main");
		expect(git(origin, "log", "--format=%s", "main")).toContain("untested");
	}, 20_000);

	test("the failing files come from the junit file of the run", () => {
		const xml = '<testsuite name="a" file="hub/a.test.ts" tests="3" failures="1"/><testsuite name="b" file="hub/b.test.ts" tests="2" failures="0"/>';
		expect(failedFiles(xml)).toEqual(["hub/a.test.ts"]);
	});

	test("the failed tests come from the junit file with the first line of their error", () => {
		const xml = [
			'<testsuite name="hub/a.test.ts" file="hub/a.test.ts" tests="3" failures="2">',
			'<testcase name="times out" classname="a" time="5.2" file="hub/a.test.ts" line="4" assertions="0"><failure type="TimeoutError" message="test timed out" /></testcase>',
			'<testcase name="it&apos;s fine" classname="a" time="0.1" file="hub/a.test.ts" line="9" assertions="1" />',
			'<testcase name="wrong value" classname="a" time="0.1" file="hub/a.test.ts" line="12" assertions="1"><failure type="Error" message="expected 1&#10;received 2">Error: expected 1&#10;  at x</failure></testcase>',
			"</testsuite>",
		].join("\n");
		expect(failedTests(xml)).toEqual([
			{ file: "hub/a.test.ts", name: "times out", error: "test timed out" },
			{ file: "hub/a.test.ts", name: "wrong value", error: "expected 1" },
		]);
	});

	describe("dispatch", () => {
		const stateDir = () => {
			const dir = mkdtempSync(join(tmpdir(), "dotz-release-state-"));
			roots.push(dir);
			return dir;
		};
		const gh = (login: string) => {
			const calls: string[] = [];
			const exec = async (cmd: readonly string[]) => {
				if (cmd[1] === "api") return { code: 0, out: login };
				calls.push(cmd.join(" "));
				return { code: 0, out: "" };
			};
			return { calls, exec };
		};
		const print = () => {};
		const GREEN: SuiteResult = { green: true, failed: [], detail: "" };
		// The gate with no network, no process and no real suite: a local bare repo is origin, spawn/alive/kill are recorded, and `finish` is the
		// detached runner's work run in place (real git and clone, stubbed suite).
		const gateKit = (suite: SuiteResult = GREEN) => {
			const url = mkdtempSync(join(tmpdir(), "dotz-release-origin-"));
			roots.push(url);
			git(url, "init", "-q", "--bare", "-b", "main");
			const seed = tempRepo();
			git(seed, "remote", "add", "origin", url);
			git(seed, "switch", "-q", "-c", "main");
			const push = (message: string) => {
				commit(seed, message);
				git(seed, "push", "-q", "origin", "main");
				return git(seed, "rev-parse", "HEAD").trim();
			};
			const tag = (name: string) => {
				git(seed, "tag", name);
				git(seed, "push", "-q", "origin", name);
			};
			const state = { head: push("work"), suite, runner: undefined as SuiteFn | undefined, gateLog: [] as string[], suites: 0, spawned: [] as string[][], alive: true, killed: [] as number[], pid: 100, released: [] as string[], release: { code: 0, out: "released" } };
			const env: GateEnv = {
				origin: url,
				spawn: cmd => {
					state.spawned.push([...cmd]);
					return state.pid++;
				},
				alive: () => state.alive,
				kill: pid => {
					state.killed.push(pid);
					state.alive = false;
				},
			};
			const finish = (dir: string, now: Date, origin: string = url) =>
				runGate({
					stateDir: dir,
					slot: slotStart(now).toISOString(),
					origin,
					git: gitOutput,
					runSuite: async d => {
						state.suites++;
						return state.runner ? state.runner(d) : state.suite;
					},
					log: line => state.gateLog.push(line),
					hasNewCommits: async (repo, sha) => (await newCommitsSinceNewestTag(repo, sha)).any,
					release: async (_dir, sha) => {
						state.released.push(sha);
						return state.release;
					},
				});
			return { state, env, push, tag, finish };
		};
		type Kit = ReturnType<typeof gateKit>;
		// The signing key is only looked for, never read: an empty file stands in for it.
		const presentKey = () => {
			const file = join(stateDir(), "release-signing-key");
			writeFileSync(file, "");
			return file;
		};
		const tick = (kit: Kit, o: Omit<DispatchOptions, "gate">) => dispatchSlot({ gate: kit.env, signingKey: presentKey(), ...o });
		// The three ticks of one clean slot: the one that starts the runner, the runner finishing, the one that reads the result.
		const launch = async (kit: Kit, o: Omit<DispatchOptions, "gate" | "now">, at: string) => {
			const now = kst(at);
			await tick(kit, { ...o, now });
			await kit.finish(o.stateDir, now);
			return tick(kit, { ...o, now: new Date(now.getTime() + 30_000) });
		};

		test("start, running, then green: the commit the suite ran on is released once and the slot is used", async () => {
			const dir = stateDir();
			const kit = gateKit();
			const { calls, exec } = gh("ddotz");
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:00:10") })).toBe(0);
			expect(kit.state.spawned).toHaveLength(1);
			expect(kit.state.spawned[0]).toContain("--gate-run");
			expect(existsSync(join(dir, "release-slot"))).toBe(false);
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:01:10") })).toBe(0);
			expect(kit.state.spawned).toHaveLength(1);
			expect(calls).toEqual([]);
			await kit.finish(dir, kst("2026-11-05T12:00:10"));
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:02:10") })).toBe(0);
			expect(kit.state.released).toEqual([kit.state.head]);
			expect(existsSync(join(dir, "release-slot"))).toBe(true);
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:03:10") })).toBe(0);
			expect(kit.state.released).toHaveLength(1);
			expect(calls).toEqual([]);
			expect(kit.state.suites).toBe(1);
			expect(kit.state.spawned).toHaveLength(1);
			expect(await launch(kit, { stateDir: dir, exec, print }, "2026-11-05T18:00:10")).toBe(0);
			expect(kit.state.released).toHaveLength(2);
		});

		// A suite runner that is not real: each call takes the next scripted run and records which files it was asked for (undefined = all of them).
		const scripted = (runs: Attempt[]) => {
			const calls: (readonly string[] | undefined)[] = [];
			const attempt = async (_dir: string, files?: readonly string[]): Promise<Attempt> => {
				calls.push(files);
				const next = runs[calls.length - 1];
				if (!next) throw new Error("a run beyond the script");
				return next;
			};
			return { calls, attempt };
		};
		const names = (n: number) => Array.from({ length: n }, (_, i) => `hub/f${i}.test.ts`);
		const failing = (failed: string[], total = 100): Attempt => ({ green: false, failed, total, detail: "" });
		const passing = (total: number): Attempt => ({ green: true, failed: [], total, detail: "" });

		test("a full run red in a few files is retried once on those files and, when they pass, is green: released, with them named as flaky", async () => {
			const dir = stateDir();
			const hubLines: string[] = [];
			const out: string[] = [];
			const kit = gateKit();
			const run = scripted([failing(names(7)), passing(7)]);
			kit.state.runner = d => runWithRetry(d, run.attempt);
			const { calls, exec } = gh("ddotz");
			expect(await launch(kit, { stateDir: dir, exec, print: l => out.push(l), hubLog: l => hubLines.push(l) }, "2026-11-05T12:00:10")).toBe(0);
			expect(run.calls).toEqual([undefined, names(7)]);
			expect(kit.state.released).toEqual([kit.state.head]);
			expect(calls).toEqual([]);
			expect(existsSync(join(dir, "release-slot"))).toBe(true);
			expect(hubLines).toHaveLength(1);
			for (const n of names(7)) expect(hubLines[0]).toContain(n);
			expect(kit.state.gateLog).toHaveLength(1);
			expect(kit.state.gateLog[0]).toContain(names(7)[6]!);
			const shown = out.filter(l => l.includes(names(7)[0]!));
			expect(shown).toHaveLength(1);
			expect(shown[0]).toContain(names(7)[4]!);
			expect(shown[0]).not.toContain(names(7)[5]!); // up to 5 names
		});

		test("a hub.log write that fails does not fail the tick or the release", async () => {
			const dir = stateDir();
			const kit = gateKit();
			const run = scripted([failing(names(2)), passing(2)]);
			kit.state.runner = d => runWithRetry(d, run.attempt);
			const hubLog = () => {
				throw new Error("disk full");
			};
			expect(await launch(kit, { stateDir: dir, exec: gh("ddotz").exec, print, hubLog }, "2026-11-05T12:00:10")).toBe(0);
			expect(kit.state.released).toEqual([kit.state.head]);
			expect(existsSync(join(dir, "release-slot"))).toBe(true);
		});

		test("the flaky files travel in gate-result.json", async () => {
			const dir = stateDir();
			const kit = gateKit();
			const run = scripted([failing(names(2)), passing(2)]);
			kit.state.runner = d => runWithRetry(d, run.attempt);
			const now = kst("2026-11-05T12:00:10");
			await tick(kit, { stateDir: dir, exec: gh("ddotz").exec, print, now });
			await kit.finish(dir, now);
			const result = JSON.parse(readFileSync(join(dir, "gate-result.json"), "utf8")) as { green: boolean; flaky: string[]; release: { code: number } };
			expect(result.green).toBe(true);
			expect(result.flaky).toEqual(names(2));
			expect(result.release.code).toBe(0);
		});

		test("the retry fails too: nothing is released, the slot is skipped as red, with the files that still fail", async () => {
			const dir = stateDir();
			const kit = gateKit();
			const run = scripted([failing(names(3)), failing([names(3)[1]!], 3)]);
			kit.state.runner = d => runWithRetry(d, run.attempt);
			const out: string[] = [];
			expect(await launch(kit, { stateDir: dir, exec: gh("ddotz").exec, print: l => out.push(l) }, "2026-11-05T12:00:10")).toBe(SLOT_SKIPPED_EXIT);
			expect(kit.state.released).toEqual([]);
			expect(run.calls).toHaveLength(2); // never a second retry
			expect(readFileSync(join(dir, "release-slot"), "utf8").trim()).toBe(slotStart(kst("2026-11-05T12:00:10")).toISOString());
			expect(out.filter(l => l.includes(names(3)[1]!))).toHaveLength(1);
			expect(out.some(l => l.includes(names(3)[0]!))).toBe(false);
		});

		test("failing files over the share of all test files: no retry, red", async () => {
			const dir = stateDir();
			const kit = gateKit();
			const over = Math.floor(100 * RETRY_MAX_FAILED_SHARE) + 1;
			const run = scripted([failing(names(over))]);
			kit.state.runner = d => runWithRetry(d, run.attempt);
			expect(await launch(kit, { stateDir: dir, exec: gh("ddotz").exec, print }, "2026-11-05T12:00:10")).toBe(SLOT_SKIPPED_EXIT);
			expect(run.calls).toEqual([undefined]);
			expect(kit.state.released).toEqual([]);
		});

		test("the share is checked against the total of the same report: exactly at it is retried, one more is not", async () => {
			const at = Math.floor(100 * RETRY_MAX_FAILED_SHARE);
			const retried = scripted([failing(names(at)), passing(at)]);
			expect((await runWithRetry("d", retried.attempt)).flaky).toEqual(names(at));
			const refused = scripted([failing(names(at + 1))]);
			expect((await runWithRetry("d", refused.attempt)).green).toBe(false);
			expect(refused.calls).toHaveLength(1);
			const unread = scripted([failing([])]); // red with no file readable: nothing to retry
			expect((await runWithRetry("d", unread.attempt)).green).toBe(false);
			expect(unread.calls).toHaveLength(1);
		});

		test("a green full run is not retried and has no flaky files; a retry that fails is the last run", async () => {
			const green = scripted([passing(100)]);
			expect(await runWithRetry("d", green.attempt)).toEqual({ green: true, failed: [], detail: "" });
			expect(green.calls).toHaveLength(1);
			const stubborn = scripted([failing(names(2)), failing(names(2), 2), passing(2)]);
			expect((await runWithRetry("d", stubborn.attempt)).green).toBe(false);
			expect(stubborn.calls).toHaveLength(2);
		});

		test("the total of test files is the distinct files of the report", () => {
			const xml = '<testsuite name="a" file="hub/a.test.ts" failures="0"/><testsuite name="inner" file="hub/a.test.ts" failures="0"/><testsuite name="b" file="hub/b.test.ts" failures="0"/>';
			expect(testFileCount(xml)).toBe(2);
		});

		test("no commit after the newest tag: the suite does not run, nothing is released, and the slot is used without a failure", async () => {
			const dir = stateDir();
			const kit = gateKit();
			kit.tag("v261105.1");
			const { calls, exec } = gh("ddotz");
			const lines: string[] = [];
			const say = (l: string) => lines.push(l);
			const noon = kst("2026-11-05T12:00:10");
			expect(await tick(kit, { stateDir: dir, exec, print: say, now: noon })).toBe(0);
			await kit.finish(dir, noon);
			lines.length = 0;
			expect(await tick(kit, { stateDir: dir, exec, print: say, now: kst("2026-11-05T12:01:10") })).toBe(0);
			expect(lines).toHaveLength(1);
			expect(kit.state.suites).toBe(0);
			expect(calls).toEqual([]);
			expect(existsSync(join(dir, "release-slot"))).toBe(true);
			expect(existsSync(join(dir, "release-run.json"))).toBe(false);
			expect(await tick(kit, { stateDir: dir, exec, print: say, now: kst("2026-11-05T12:02:10") })).toBe(0);
			expect(kit.state.spawned).toHaveLength(1);
		});

		test("a commit after the newest tag: the suite runs and that commit is released", async () => {
			const dir = stateDir();
			const kit = gateKit();
			kit.tag("v261105.1");
			const head = kit.push("newer work");
			const { calls, exec } = gh("ddotz");
			await launch(kit, { stateDir: dir, exec, print }, "2026-11-05T18:00:10");
			expect(kit.state.suites).toBe(1);
			expect(kit.state.released).toEqual([head]);
			expect(calls).toEqual([]);
		});

		test("a non-owner install never gates or fires", async () => {
			const dir = stateDir();
			const kit = gateKit();
			const { calls, exec } = gh("someone-else");
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:00:10") })).toBe(0);
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T18:00:10") })).toBe(0);
			expect(calls).toEqual([]);
			expect(kit.state.spawned).toEqual([]);
		});

		test("no GitHub login fails the check and fires nothing", async () => {
			const calls: string[] = [];
			const exec = async (cmd: readonly string[]) => {
				calls.push(cmd.join(" "));
				return { code: 1, out: "not logged in" };
			};
			const kit = gateKit();
			expect(await tick(kit, { stateDir: stateDir(), exec, print })).toBe(1);
			expect(calls).toEqual(["gh api user --jq .login"]);
			expect(kit.state.spawned).toEqual([]);
		});

		test("a missing signing key fails the tick before the gate starts and does not use the slot", async () => {
			const dir = stateDir();
			const kit = gateKit();
			const { calls, exec } = gh("ddotz");
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:00:10"), signingKey: join(dir, "absent") })).toBe(1);
			expect(kit.state.spawned).toEqual([]);
			expect(existsSync(join(dir, "gate-run.json"))).toBe(false);
			expect(existsSync(join(dir, "release-slot"))).toBe(false);
			expect(calls).toEqual([]);
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:01:10") })).toBe(0);
			expect(kit.state.spawned).toHaveLength(1);
		});

		describe("a green suite whose release failed", () => {
			test("is a red slot: the watch fails with the release output until the next slot, which tries again", async () => {
				const dir = stateDir();
				const kit = gateKit();
				const { exec } = gh("ddotz");
				const lines: string[] = [];
				const say = (l: string) => lines.push(l);
				kit.state.release = { code: 1, out: "first line\npush refused: remote hung up" };
				expect(await launch(kit, { stateDir: dir, exec, print: say }, "2026-11-05T12:00:10")).toBe(SLOT_SKIPPED_EXIT);
				expect(lines.at(-1)).toContain("push refused: remote hung up");
				expect(existsSync(join(dir, "release-slot"))).toBe(true);
				expect(JSON.parse(readFileSync(join(dir, "release-run.json"), "utf8"))).toMatchObject({ state: "failed" });
				expect(await tick(kit, { stateDir: dir, exec, print: say, now: kst("2026-11-05T13:00:10") })).toBe(SLOT_SKIPPED_EXIT);
				expect(kit.state.suites).toBe(1);
				expect(kit.state.released).toHaveLength(1);
				kit.state.release = { code: 0, out: "released" };
				expect(await launch(kit, { stateDir: dir, exec, print: say }, "2026-11-05T18:00:10")).toBe(0);
				expect(kit.state.released).toHaveLength(2);
				expect(existsSync(join(dir, "release-run.json"))).toBe(false);
			});

			test("a result with no release info at all counts as failed", async () => {
				const dir = stateDir();
				const kit = gateKit();
				const { exec } = gh("ddotz");
				const now = kst("2026-11-05T12:00:10");
				await tick(kit, { stateDir: dir, exec, print, now });
				writeFileSync(join(dir, "gate-result.json"), JSON.stringify({ slot: slotStart(now).toISOString(), sha: kit.state.head, green: true, failed: [], detail: "" }));
				expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:01:10") })).toBe(SLOT_SKIPPED_EXIT);
				expect(existsSync(join(dir, "release-slot"))).toBe(true);
			});
		});

		test("a red suite releases nothing", async () => {
			const dir = stateDir();
			const kit = gateKit({ green: false, failed: ["hub/a.test.ts"], detail: "" });
			expect(await launch(kit, { stateDir: dir, exec: gh("ddotz").exec, print }, "2026-11-05T12:00:10")).toBe(SLOT_SKIPPED_EXIT);
			expect(kit.state.released).toEqual([]);
			expect(JSON.parse(readFileSync(join(dir, "release-run.json"), "utf8"))).toMatchObject({ state: "failed" });
		});

		test("start, then red: the slot is skipped and the watch fails with the failing files; the next slot tests the new head", async () => {
			const dir = stateDir();
			const { calls, exec } = gh("ddotz");
			const kit = gateKit({ green: false, failed: ["hub/a.test.ts", "hub/b.test.ts"], detail: "" });
			const lines: string[] = [];
			const say = (l: string) => lines.push(l);
			expect(await launch(kit, { stateDir: dir, exec, print: say }, "2026-11-05T12:00:10")).toBe(SLOT_SKIPPED_EXIT);
			expect(lines.at(-1)).toContain("hub/a.test.ts, hub/b.test.ts");
			expect(calls).toEqual([]);
			expect(kit.state.released).toEqual([]);
			// the rest of the slot: the watch keeps failing, the suite is not run again
			expect(await tick(kit, { stateDir: dir, exec, print: say, now: kst("2026-11-05T12:01:10") })).toBe(SLOT_SKIPPED_EXIT);
			expect(kit.state.suites).toBe(1);
			expect(kit.state.spawned).toHaveLength(1);
			expect(calls).toEqual([]);
			// the next slot: a new head, green this time
			kit.state.head = kit.push("next");
			kit.state.suite = GREEN;
			expect(await launch(kit, { stateDir: dir, exec, print: say }, "2026-11-05T18:00:10")).toBe(0);
			expect(kit.state.suites).toBe(2);
			expect(kit.state.released).toEqual([kit.state.head]);
		});

		test("a red run leaves its failed tests, their first error line and the output tail in the state dir, and names the tests in the skip message", async () => {
			const dir = stateDir();
			const failures = [
				{ file: "hub/a.test.ts", name: "seeds a long mailbox", error: "test timed out" },
				{ file: "hub/b.test.ts", name: "closes only that question", error: "expected 1" },
			];
			const kit = gateKit({ green: false, failed: ["hub/a.test.ts", "hub/b.test.ts"], failures, detail: "the tail of the output" });
			const lines: string[] = [];
			expect(await launch(kit, { stateDir: dir, exec: gh("ddotz").exec, print: l => lines.push(l) }, "2026-11-05T12:00:10")).toBe(SLOT_SKIPPED_EXIT);
			expect(existsSync(join(dir, "gate-result.json"))).toBe(false); // cleared, as before
			const kept = JSON.parse(readFileSync(join(dir, "release-red.json"), "utf8")) as { failures: unknown; failed: unknown; detail: string; sha: string };
			expect(kept).toMatchObject({ failures, failed: ["hub/a.test.ts", "hub/b.test.ts"], detail: "the tail of the output", sha: kit.state.head });
			expect(lines.at(-1)).toContain("seeds a long mailbox");
			expect(lines.at(-1)).toContain("closes only that question");
		});

		test("a runner that died without a result fails the tick without using the slot, and the next tick starts it again", async () => {
			const dir = stateDir();
			const { calls, exec } = gh("ddotz");
			const kit = gateKit();
			const lines: string[] = [];
			const say = (l: string) => lines.push(l);
			expect(await tick(kit, { stateDir: dir, exec, print: say, now: kst("2026-11-05T12:00:10") })).toBe(0);
			kit.state.alive = false;
			expect(await tick(kit, { stateDir: dir, exec, print: say, now: kst("2026-11-05T12:01:10") })).toBe(1);
			expect(lines.at(-1)).toContain("결과 없이 끝났어요");
			expect(existsSync(join(dir, "release-slot"))).toBe(false);
			expect(existsSync(join(dir, "gate-run.json"))).toBe(false);
			kit.state.alive = true;
			expect(await tick(kit, { stateDir: dir, exec, print: say, now: kst("2026-11-05T12:02:10") })).toBe(0);
			expect(kit.state.spawned).toHaveLength(2);
			await kit.finish(dir, kst("2026-11-05T12:00:10"));
			expect(await tick(kit, { stateDir: dir, exec, print: say, now: kst("2026-11-05T12:03:10") })).toBe(0);
			expect(kit.state.released).toHaveLength(1);
		});

		test("a run past 45 minutes is killed and started again at the next tick", async () => {
			const dir = stateDir();
			const { exec } = gh("ddotz");
			const kit = gateKit();
			await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:00:10") });
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:40:10") })).toBe(0);
			expect(kit.state.killed).toEqual([]);
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:46:10") })).toBe(1);
			expect(kit.state.killed).toEqual([100]);
			expect(existsSync(join(dir, "release-slot"))).toBe(false);
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:47:10") })).toBe(0);
			expect(kit.state.spawned).toHaveLength(2);
		});

		test("a runner that cannot reach origin leaves an error: the tick fails, the slot stays open, the next tick retries", async () => {
			const dir = stateDir();
			const { calls, exec } = gh("ddotz");
			const kit = gateKit();
			const lines: string[] = [];
			const now = kst("2026-11-05T12:00:10");
			await tick(kit, { stateDir: dir, exec, print, now });
			await kit.finish(dir, now, join(dir, "no-such-origin"));
			expect(await tick(kit, { stateDir: dir, exec, print: l => lines.push(l), now: kst("2026-11-05T12:01:10") })).toBe(1);
			expect(lines.at(-1)).toContain("시험을 돌리지 못했어요");
			expect(calls).toEqual([]);
			expect(existsSync(join(dir, "release-slot"))).toBe(false);
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:02:10") })).toBe(0);
			expect(kit.state.spawned).toHaveLength(2);
		});

		test("a new slot kills the run that is still going from the old one, then starts its own", async () => {
			const dir = stateDir();
			const { calls, exec } = gh("ddotz");
			const kit = gateKit();
			await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T12:00:10") });
			expect(kit.state.killed).toEqual([]);
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T18:00:10") })).toBe(0);
			expect(kit.state.killed).toEqual([100]);
			expect(kit.state.spawned).toHaveLength(2);
			await kit.finish(dir, kst("2026-11-05T18:00:10"));
			expect(await tick(kit, { stateDir: dir, exec, print, now: kst("2026-11-05T18:01:10") })).toBe(0);
			expect(kit.state.released).toHaveLength(1);
		});

		test("an install without .git still gates: the runner keeps its own clone in the state dir", async () => {
			const dir = stateDir();
			const kit = gateKit();
			const now = kst("2026-11-05T12:00:10");
			await tick(kit, { stateDir: dir, exec: gh("ddotz").exec, print, now });
			expect(existsSync(join(dir, ".git"))).toBe(false);
			const [bun, script, flag, stateArg, , originArg] = kit.state.spawned[0]!;
			expect(script).toEndWith("release.ts");
			expect([bun !== "", flag, stateArg, originArg]).toEqual([true, "--gate-run", dir, kit.env.origin]);
			await kit.finish(dir, now);
			const result = JSON.parse(readFileSync(join(dir, "gate-result.json"), "utf8"));
			expect(result).toMatchObject({ green: true, sha: kit.state.head });
			expect(existsSync(join(dir, "gate-repo", ".git"))).toBe(true);
			expect(existsSync(join(dir, "gate-tree"))).toBe(false);
			// the second run fetches into the same clone and tests the commit that arrived
			const next = kit.push("later");
			await kit.finish(dir, now);
			expect(JSON.parse(readFileSync(join(dir, "gate-result.json"), "utf8")).sha).toBe(next);
			expect(git(join(dir, "gate-repo"), "worktree", "list").trim().split("\n")).toHaveLength(1);
		});

		test("a dry run starts nothing, runs no suite and keeps the slot open", async () => {
			const dir = stateDir();
			const { calls, exec } = gh("ddotz");
			const kit = gateKit();
			expect(await tick(kit, { stateDir: dir, exec, print, dryRun: true })).toBe(0);
			expect(kit.state.spawned).toEqual([]);
			expect(calls).toEqual([]);
			expect(existsSync(join(dir, "release-slot"))).toBe(false);
		});
	});
});

describe("git in a temporary repo", () => {
	test("reads local tags", async () => {
		const root = tempRepo();
		commit(root, "first");
		git(root, "tag", "v261103.1");
		git(root, "tag", "not-a-version");
		git(root, "tag", "v261103.1.1");
		git(root, "tag", "v261104.4");
		expect(await localTags(root)).toEqual(["v261103.1", "v261103.1.1"]);
	});

	test("sees changed tracked files and ignores untracked ones", async () => {
		const root = tempRepo();
		writeFileSync(join(root, "file.txt"), "one\n");
		git(root, "add", "file.txt");
		commit(root, "first");
		expect(await dirtyTracked(root)).toEqual([]);
		writeFileSync(join(root, "untracked.txt"), "x\n");
		expect(await dirtyTracked(root)).toEqual([]);
		writeFileSync(join(root, "file.txt"), "two\n");
		expect(await dirtyTracked(root)).toHaveLength(1);
	});

	test("hasCommitsSince is false right after a tag and true after a commit", async () => {
		const root = tempRepo();
		commit(root, "first");
		git(root, "tag", "v261103.1");
		expect(await hasCommitsSince(root, "v261103.1")).toBe(false);
		commit(root, "second");
		expect(await hasCommitsSince(root, "v261103.1")).toBe(true);
		expect(await hasCommitsSince(root, null)).toBe(true);
	});
});
