// The guard that refuses a recursive search of a broad path (extension/guard-shell.ts broadSearchProblem): a table of what it blocks and what it lets by.
// A recursive search of the home folder once grew a process to 22GB, so each row is one way the check could be dropped or turned around.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { broadSearchProblem } from "./guard-shell.ts";

const home = homedir();
const lib = join(home, "Library");
const bash = (command: string) => broadSearchProblem("bash", { command });

test("grep and glob tools: a broad path in the path field is blocked, a path inside a project is not", () => {
	for (const tool of ["grep", "Glob", "GREP"])
		for (const path of ["/", "/Users", home, "~", "$HOME", "${HOME}", lib, join(home, "Library", "Application Support"), `${home}/`, `${home}/projects/..`, `/tmp/x;${home}`])
			expect([tool, path, typeof broadSearchProblem(tool, { path })]).toEqual([tool, path, "string"]);
	for (const path of [join(home, "projects", "app"), "/tmp", "relative/dir", "src", "", "~/projects", join(lib, "Logs")])
		expect([path, broadSearchProblem("grep", { path })]).toEqual([path, undefined]);
	expect(broadSearchProblem("grep", {})).toBeUndefined();
	expect(broadSearchProblem("grep", { path: 5 })).toBeUndefined();
	expect(broadSearchProblem("read", { path: "/" })).toBeUndefined();
	expect(broadSearchProblem("bash", undefined)).toBeUndefined();
	expect(broadSearchProblem("bash", { command: 5 })).toBeUndefined();
});

test("bash: a recursive search of a broad path is blocked, whatever wraps or follows it", () => {
	const blocked = [
		"rg foo ~",
		"rg foo /",
		"find / -name x",
		"find ~ -name x",
		"find /Users -name x",
		"du -sh ~/Library",
		"fd x /",
		"fdfind x $HOME",
		"grep -r foo ~",
		"grep -rn foo $HOME",
		"egrep -R foo ~",
		"fgrep --recursive foo ~",
		"zgrep --dereference-recursive foo /Users",
		"ls -R /Users",
		"ls --recursive ~",
		"sudo rg foo ~",
		"FOO=1 rg foo ~",
		"time nice rg foo ~",
		"xargs rg foo ~",
		"/usr/bin/rg foo ~",
		"cd /tmp && rg foo ~",
		"echo hi; find / -name x",
		"true | rg foo ~",
		`rg foo "${home}"`,
		`rg foo ${lib}`,
	];
	for (const command of blocked) expect([command, typeof bash(command)]).toEqual([command, "string"]);
});

test("bash: an unquoted expansion in a recursive search is blocked, a quoted one is not", () => {
	for (const command of ["rg foo $P", "grep -r foo $P", "find $P -name x", "rg foo ${P}", "rg foo $(pwd)", "rg foo `pwd`"]) expect([command, typeof bash(command)]).toEqual([command, "string"]);
	for (const command of ['P=/tmp/x; rg foo "$P"', 'rg foo "$P"', "rg foo '$P'"]) expect([command, bash(command)]).toEqual([command, undefined]);
});

test("bash: an unquoted variable is expanded first; only an unknown, space-holding or broad value is blocked", () => {
	for (const command of ["rg foo $HOME/.dotz/projects/x/gate", "rg foo ${HOME}/projects/app", "D=/tmp/x; rg foo $D", "export D=/tmp/x && find $D -name y", "G=/tmp/g; rg foo $G/omo-ai"]) expect([command, bash(command)]).toEqual([command, undefined]);
	for (const command of ["rg foo $UNSET_VAR", "rg foo /Users", "rg foo $HOME", "D=/; rg foo $D", 'D="/tmp/a b"; rg foo $D', "D=$X/y; rg foo $D", "HOME=/; rg foo $HOME"]) expect([command, typeof bash(command)]).toEqual([command, "string"]);
});

test("bash: a search inside a project, a non-recursive command and other commands pass", () => {
	const passed = [
		"rg foo ~/projects/app",
		"rg foo src",
		"rg foo /tmp",
		`find ${home}/projects -name x`,
		"grep foo ~",
		"grep -n foo ~",
		"ls ~",
		"ls -la ~",
		"ls -R ~/projects",
		"cat ~",
		"echo ~ /",
		"git status",
		"cd ~ && git status",
		"rg foo ~/projects; ls ~",
		"FOO=~ git status",
		"",
	];
	for (const command of passed) expect([command, bash(command)]).toEqual([command, undefined]);
});
