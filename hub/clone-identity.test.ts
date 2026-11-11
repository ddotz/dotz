import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCommitIdentity } from "./clone-identity.ts";
import { noreplyMail } from "./commit-identity.ts";
import { denyReason } from "./runtime/claude-deny-hook.ts";

const NAME = "Pat Placeholder";
const MAIL = "pat@example.com";
const VALUE = "zebrafish-private-term";
const LOGIN = "pat-dev";
const ID = "4242";
const WHO = { login: LOGIN, id: ID };
const NOREPLY = noreplyMail(LOGIN, ID);

let root: string, work: string, data: string, globalConfig: string;
let asked = 0;
const lookup = () => (asked++, WHO);
const nobody = () => (asked++, undefined);
const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};
const localEmail = (cwd: string) => Bun.spawnSync(["git", "config", "--local", "user.email"], { cwd, stdout: "pipe" }).stdout.toString().trim();
const prepare = (command: string, cwd = work, who: () => typeof WHO | undefined = lookup) => prepareCommitIdentity(command, data, cwd, who);
const agentCommit = (cwd: string, file: string) => {
	writeFileSync(join(cwd, file), file);
	git(cwd, "add", file);
	git(cwd, "commit", "-q", "-m", file);
	return git(cwd, "log", "-1", "--format=%an|%ae|%cn|%ce");
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clone-identity-"));
	globalConfig = join(root, "global.gitconfig");
	writeFileSync(globalConfig, `[user]\n\tname = ${NAME}\n\temail = ${MAIL}\n`);
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	asked = 0;
	const publicRemote = join(root, "ddotz", "dotz.git");
	mkdirSync(publicRemote, { recursive: true });
	git(publicRemote, "init", "-q", "--bare", "-b", "main");
	data = join(root, "data");
	mkdirSync(join(data, "secrets"), { recursive: true });
	writeFileSync(join(data, "secrets", "privacy-terms.txt"), `${VALUE}\n`);
	work = join(root, "work");
	mkdirSync(work);
	git(work, "init", "-q", "-b", "main");
	git(work, "remote", "add", "origin", publicRemote);
	git(work, "remote", "add", "fork", "https://github.com/alice/dotz-site.git");
	writeFileSync(join(work, "base"), "base");
	git(work, "add", "base");
	git(work, "commit", "-q", "-m", "base");
});
afterEach(() => {
	for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

test("an agent commit in a dotz clone with only a personal global identity is already noreply, with no fix command", () => {
	expect(localEmail(work)).toBe("");
	expect(prepare("git add -A && git commit -m work")).toBeUndefined();
	expect(agentCommit(work, "one")).toBe(`${LOGIN}|${NOREPLY}|${LOGIN}|${NOREPLY}`);
	expect(readFileSync(globalConfig, "utf8")).toContain(MAIL);
	expect(JSON.parse(readFileSync(join(data, "github-login.json"), "utf8"))).toEqual(WHO);
});

test("one write covers every linked worktree, and the first commit there is clean too", () => {
	const linked = join(root, "linked");
	git(work, "worktree", "add", "-q", "-b", "lane", linked);
	expect(prepare("git commit -m x", linked)).toBeUndefined();
	expect(localEmail(work)).toBe(NOREPLY);
	expect(agentCommit(linked, "lane-file")).toBe(`${LOGIN}|${NOREPLY}|${LOGIN}|${NOREPLY}`);
	expect(agentCommit(work, "main-file")).toBe(`${LOGIN}|${NOREPLY}|${LOGIN}|${NOREPLY}`);
});

test("the working folder can come from -C and from a cd before the command", () => {
	expect(prepare(`git -C ${work} commit -m x`, root)).toBeUndefined();
	expect(localEmail(work)).toBe(NOREPLY);
	const second = join(root, "second");
	git(root, "clone", "-q", join(root, "ddotz", "dotz.git"), second);
	expect(prepare(`cd ${second} && git commit -m x`, root)).toBeUndefined();
	expect(localEmail(second)).toBe(NOREPLY);
});

test("a repo that is not a dotz clone gets nothing written, and asks nobody", () => {
	const other = join(root, "other");
	mkdirSync(other);
	git(other, "init", "-q", "-b", "main");
	git(other, "remote", "add", "origin", "https://github.com/alice/notes.git");
	expect(prepare("git commit -m x", other)).toBeUndefined();
	expect(localEmail(other)).toBe("");
	expect(asked).toBe(0);
	expect(prepare("git commit -m x", root)).toBeUndefined();
});

test("with no login to be found the command is refused with the one step, and nothing is written", () => {
	const refused = prepare("git commit -m x", work, nobody);
	expect(refused).toContain("gh auth login");
	expect(refused).not.toContain(MAIL);
	expect(localEmail(work)).toBe("");
	expect(existsSync(join(data, "github-login.json"))).toBe(false);
});

test("the login is read once and cached, later clones need no lookup", () => {
	prepare("git commit -m x");
	const second = join(root, "second");
	git(root, "clone", "-q", join(root, "ddotz", "dotz.git"), second);
	expect(prepare("git commit -m x", second, () => { throw new Error("no network on later commands"); })).toBeUndefined();
	expect(localEmail(second)).toBe(NOREPLY);
	expect(asked).toBe(1);
});

test("a clone already on a noreply identity keeps it, and commands that create no commit run no git", () => {
	git(work, "config", "--local", "user.name", "other-dev");
	git(work, "config", "--local", "user.email", noreplyMail("other-dev", "7"));
	expect(prepare("git commit -m x")).toBeUndefined();
	expect(localEmail(work)).toBe(noreplyMail("other-dev", "7"));
	git(work, "config", "--local", "--unset", "user.email");
	expect(prepare("git status && git log && ls")).toBeUndefined();
	expect(localEmail(work)).toBe("");
	expect(asked).toBe(0);
});

test("a phone number in a commit message is refused at commit time by label, without the value", () => {
	const refused = prepare(`git commit -m "call 010-1234-5678 for details"`);
	expect(refused).toContain("message: phone");
	expect(refused).not.toContain("010-1234-5678");
	expect(prepare(`git commit -m "call the team"`)).toBeUndefined();
});

test("an install value in a staged added line is refused, as in a tracked file with -a; a removed line is not", () => {
	writeFileSync(join(work, "new.txt"), `has ${VALUE} inside\n`);
	git(work, "add", "new.txt");
	const staged = prepare(`git commit -m x`);
	expect(staged).toContain("added line");
	expect(staged).not.toContain(VALUE);
	git(work, "rm", "-q", "-f", "--cached", "new.txt");
	writeFileSync(join(work, "base"), `edited ${VALUE}\n`);
	expect(prepare(`git commit -m x`)).toBeUndefined();
	expect(prepare(`git commit -am x`)).toContain("added line");
	git(work, "checkout", "-q", "--", "base");
	writeFileSync(join(work, "base"), "clean\n");
	git(work, "add", "base");
	expect(prepare(`git commit -m x`)).toBeUndefined();
});

test("the claude hook's deny step runs the preparation as its last step", () => {
	writeFileSync(join(data, "github-login.json"), JSON.stringify(WHO));
	expect(denyReason("git commit -m x", data, work)).toBeUndefined();
	expect(localEmail(work)).toBe(NOREPLY);
	expect(denyReason(`git commit -m "call 010-1234-5678"`, data, work)).toContain("message: phone");
});

test("read-only git subcommands that start with a commit-creating word are not commits, a commit still is", () => {
	for (const command of ["git merge-base --is-ancestor HEAD HEAD", "git commit-graph write", "git rebase-todo-list", "git pull-request-info"]) {
		expect(prepare(command, work, nobody)).toBeUndefined();
		expect(localEmail(work)).toBe("");
	}
	expect(prepare("git commit -m x", work, nobody)).toBeDefined();
	expect(localEmail(work)).toBe("");
});

test("only the commit command's own text is checked, up to a separator outside a quoted string and a heredoc", () => {
	git(work, "config", "--local", "user.name", LOGIN);
	git(work, "config", "--local", "user.email", NOREPLY);
	expect(prepare(`git commit --allow-empty -m "ok" && echo done > /Users/someone/out.log`)).toBeUndefined();
	expect(prepare(`git commit --allow-empty -m "ok"; cat /home/alice/notes.txt`)).toBeUndefined();
	expect(prepare(`git commit --allow-empty -m "ok" || cat /home/alice/notes.txt | head`)).toBeUndefined();
	expect(prepare("git commit -m ok\ncat /home/alice/notes.txt")).toBeUndefined();
	expect(prepare(`git commit -m "call 010-1234-5678"`)).toContain("message: phone");
	expect(prepare(`git commit -m "ok; and && call 010-1234-5678" && echo done`)).toContain("message: phone");
	expect(prepare("git commit -F - <<'EOF'\nok; call 010-1234-5678\nEOF")).toContain("message: phone");
	expect(prepare("git commit -m \"$(cat <<'EOF'\nok && call 010-1234-5678\nEOF\n)\" && echo done")).toContain("message: phone");
});

test("-a is read from the commit command's own text only", () => {
	git(work, "config", "--local", "user.name", LOGIN);
	git(work, "config", "--local", "user.email", NOREPLY);
	writeFileSync(join(work, "base"), `edited ${VALUE}\n`);
	expect(prepare("git commit -m x && ls -a")).toBeUndefined();
	expect(prepare("git commit -m x; ls -a")).toBeUndefined();
	expect(prepare("git commit -am x; ls")).toContain("added line");
});

const dotzFiles = (dir: string, name: string) => {
	mkdirSync(join(dir, "hub"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
	writeFileSync(join(dir, "hub", "public-scrub.ts"), "");
};

test("a clone whose only remote is a fork under another repo name is a dotz clone when it holds dotz's own source", () => {
	const fork = join(root, "fork-only");
	mkdirSync(fork);
	git(fork, "init", "-q", "-b", "main");
	git(fork, "remote", "add", "fork", "https://github.com/alice/dotz-site.git");
	dotzFiles(fork, "dotz");
	expect(prepare("git commit -m x", fork)).toBeUndefined();
	expect(localEmail(fork)).toBe(NOREPLY);
	expect(prepare("git commit -m x", join(fork, "hub"))).toBeUndefined(); // from a sub folder too
});

test("without the public remote and without dotz's source nothing is a dotz clone, and nothing is written", () => {
	const cases: [string, (dir: string) => void][] = [
		["plain", () => {}],
		["other-package", dir => dotzFiles(dir, "notes")],
		["no-scrub-file", dir => writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dotz" }))],
	];
	for (const [name, setup] of cases) {
		const other = join(root, name);
		mkdirSync(other);
		git(other, "init", "-q", "-b", "main");
		git(other, "remote", "add", "origin", "https://github.com/alice/dotz-site.git");
		setup(other);
		expect(prepare("git commit -m x", other)).toBeUndefined();
		expect(localEmail(other)).toBe("");
	}
	expect(asked).toBe(0);
});
