import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareVersions,
	cutInSlot,
	dirtyTracked,
	dispatchSlot,
	hasCommitsSince,
	localTags,
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
			return publishVersion({ auto: true, force: false, dryRun: false, cwd, now: at, print: () => {} });
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
	});

	describe("dispatch", () => {
		const stateDir = () => {
			const dir = mkdtempSync(join(tmpdir(), "dotz-release-state-"));
			roots.push(dir);
			return dir;
		};
		const gh = (login: string, runCode = 0) => {
			const calls: string[] = [];
			const exec = async (cmd: readonly string[]) => {
				if (cmd[1] === "api") return { code: 0, out: login };
				calls.push(cmd.join(" "));
				return { code: runCode, out: "" };
			};
			return { calls, exec };
		};
		const print = () => {};

		test("the owner's watch starts the workflow once per slot", async () => {
			const dir = stateDir();
			const { calls, exec } = gh("ddotz");
			await dispatchSlot({ stateDir: dir, exec, print, now: kst("2026-11-05T12:00:10") });
			await dispatchSlot({ stateDir: dir, exec, print, now: kst("2026-11-05T12:01:10") });
			expect(calls).toEqual(["gh workflow run release.yml --repo ddotz/dotz --ref main"]);
			await dispatchSlot({ stateDir: dir, exec, print, now: kst("2026-11-05T18:00:10") });
			expect(calls).toHaveLength(2);
		});

		test("a non-owner install never fires", async () => {
			const dir = stateDir();
			const { calls, exec } = gh("someone-else");
			expect(await dispatchSlot({ stateDir: dir, exec, print, now: kst("2026-11-05T12:00:10") })).toBe(0);
			expect(await dispatchSlot({ stateDir: dir, exec, print, now: kst("2026-11-05T18:00:10") })).toBe(0);
			expect(calls).toEqual([]);
		});

		test("no GitHub login fails the check and fires nothing", async () => {
			const calls: string[] = [];
			const exec = async (cmd: readonly string[]) => {
				calls.push(cmd.join(" "));
				return { code: 1, out: "not logged in" };
			};
			expect(await dispatchSlot({ stateDir: stateDir(), exec, print })).toBe(1);
			expect(calls).toEqual(["gh api user --jq .login"]);
		});

		test("a failed dispatch is retried on the next tick", async () => {
			const dir = stateDir();
			const now = kst("2026-11-05T12:00:10");
			expect(await dispatchSlot({ stateDir: dir, exec: gh("ddotz", 1).exec, print, now })).toBe(1);
			expect(existsSync(join(dir, "release-slot"))).toBe(false);
			const { calls, exec } = gh("ddotz");
			expect(await dispatchSlot({ stateDir: dir, exec, print, now })).toBe(0);
			expect(calls).toHaveLength(1);
		});

		test("a dry run starts nothing and keeps the slot open", async () => {
			const dir = stateDir();
			const { calls, exec } = gh("ddotz");
			expect(await dispatchSlot({ stateDir: dir, exec, print, dryRun: true })).toBe(0);
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
