import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareVersions,
	dirtyTracked,
	hasCommitsSince,
	localTags,
	newestVersion,
	parseVersion,
	planNext,
	shiftDay,
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
		const c = parseVersion("261102.9")!;
		const d = parseVersion("261031.3")!;
		expect(compareVersions(a, b)).toBeGreaterThan(0);
		expect(compareVersions(b, c)).toBeGreaterThan(0);
		expect(compareVersions(b, d)).toBeGreaterThan(0);
		expect(compareVersions(a, a)).toBe(0);
	});

	test("double-digit number is not string-compared", () => {
		expect(compareVersions(parseVersion("261103.10")!, parseVersion("261103.9")!)).toBeGreaterThan(0);
	});

	test("newestVersion picks the greatest tag", () => {
		expect(newestVersion(["v261102.9", "v261103.1", "v261031.3"])?.text).toBe("261103.1");
		expect(newestVersion(["junk", "v261103.1"])?.text).toBe("261103.1");
		expect(newestVersion(["junk"])).toBeNull();
	});
});

describe("parseVersion", () => {
	test("parses with and without the v prefix", () => {
		expect(parseVersion("v261103.1")?.text).toBe("261103.1");
		expect(parseVersion("261103.1")?.text).toBe("261103.1");
		expect(parseVersion(" v261103.2 ")?.text).toBe("261103.2");
	});

	test("bad tags yield null instead of throwing", () => {
		for (const bad of ["", "v261103", "v26110.1", "v261133.1", "v261103.0", "release-2026", "v261103.x"]) {
			expect(parseVersion(bad)).toBeNull();
		}
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

describe("git in a temporary repo", () => {
	test("reads local tags", async () => {
		const root = tempRepo();
		commit(root, "first");
		git(root, "tag", "v261103.1");
		git(root, "tag", "not-a-version");
		expect(await localTags(root)).toEqual(["v261103.1"]);
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
