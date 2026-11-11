import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDone, doneChecks, doneProblem, splitChecks } from "./donesignals.ts";

test("launch gate: a checkable Done-when passes; plain text only when the owner asked for the lane; a malformed check never", () => {
	expect(doneProblem("Build it.\nDone when: command `bun test`; file out/r.md; url https://x.dev status=204; merged me/app#12", false)).toBeUndefined();
	const plain = doneProblem("Build it.\nDone when: tests pass", false);
	expect(plain).toContain("not machine-checkable");
	expect(plain).toContain("command `<shell command>`");
	expect(plain).toContain("owner_asked_for_lane=true");
	expect(doneProblem("Build it.\nDone when: owner approves the theme", true)).toBeUndefined();
	expect(doneProblem("Build it.", false)).toContain("Done when");
	expect(doneProblem("Build it.\nDone when: command bun test", true)).toContain("backticks");
	expect(doneProblem("Build it.\nDone when: merged me/app", true)).toContain("<owner/repo>#<N>");
	expect(doneProblem("Build it.\nDone when: url ftp://x", true)).toContain("http(s)");
});

test("checks split on ; outside backticks and quotes; only an all-checkable line is auto-checked", () => {
	expect(splitChecks('command `a; b` stdout~"x;y"; file f')).toEqual(['command `a; b` stdout~"x;y"', "file f"]);
	expect(doneChecks("x\nDone when: file a; command `true`")).toEqual(["file a", "command `true`"]);
	expect(doneChecks("x\nDone when: file a; owner approves")).toBeUndefined();
	expect(doneChecks("x\nAcceptance: green")).toBeUndefined();
});

test("each check kind reads live state and says why it fails", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "dotz-done-"));
	writeFileSync(join(cwd, "here.txt"), "1\n");
	const receiptsDir = mkdtempSync(join(tmpdir(), "dotz-done-r-"));
	const pages: Record<string, number> = { "https://ok.dev/": 200, "https://gone.dev/": 404 };
	const io = {
		receiptsDir,
		fetch: async (u: string) => ({ status: pages[u] ?? 500, text: async () => "all good" }),
		gh: async (args: string[]) => ({ code: 0, out: JSON.stringify(args[2] === "1" ? { state: "MERGED", mergeCommit: { oid: "abc1234567890" } } : { state: "OPEN", mergeCommit: null }), err: "" }),
	};
	const checks = await checkDone(
		["file here.txt", "file missing.txt", "command `echo hi`", 'command `echo hi` stdout~"bye"', "command `exit 3`", "url https://ok.dev/ body~\"good\"", "url https://gone.dev/", "merged me/app#1", "merged me/app#2"],
		cwd,
		io,
	);
	expect(checks.map(c => c.ok)).toEqual([true, false, true, false, false, true, false, true, false]);
	expect(checks[1]!.detail).toContain("missing");
	expect(checks[3]!.detail).toContain("does not match");
	expect(checks[4]!.detail).toContain("exit 3");
	expect(checks[6]!.detail).toBe("status 404, want 200");
	expect(checks[8]!.detail).toContain("OPEN");
});

test("stdout~: $ ignores trailing newlines, and no pattern passes on one stream alone", async () => {
	const cases: [string, boolean][] = [
		['command `echo 1` stdout~"^1$"', true],
		['command `echo 2` stdout~"^1$"', false],
		['command `true` stdout~"^$"', true],
		['command `echo dirty` stdout~"^$"', false],
		['command `echo FAIL` stdout~"^(?!.*FAIL)"', false],
		['command `echo ok; echo FAIL >&2` stdout~"^(?![^]*FAIL)"', false],
		['command `echo 2; echo 1 >&2` stdout~"^1$"', false],
		['command `echo 2; echo 1 >&2` stdout~"1$"', false],
		['command `echo 1; echo warn >&2` stdout~"warn"', true],
		['command `echo 1` stdout~"1\\n"', true],
	];
	const checks = await checkDone(cases.map(c => c[0]), mkdtempSync(join(tmpdir(), "dotz-done-")), { receiptsDir: mkdtempSync(join(tmpdir(), "dotz-done-r-")) });
	expect(checks.map(c => [c.signal, c.ok])).toEqual(cases);
});
