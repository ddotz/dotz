import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIX_COMMAND, identityLabels, noreplyMail, parseRows } from "./commit-identity.ts";
import { run } from "./history-rewrite.ts";
import { fixIdentity, refusal } from "./push-identity.ts";
import { RELEASE_EMAIL, RELEASE_NAME } from "./release-sign.ts";
import { publicPostDeny } from "./systemdeny.ts";
import { contentFindings } from "./upstream-commits.ts";

const NAME = "Pat Placeholder";
const MAIL = "pat@example.com";
const VALUE = "zebrafish-private-term";
const LOGIN = "pat-dev";
const ID = "4242";
const CLASSED = `--body "분류: 보편 개선"`;
const PR = `gh pr create -R ddotz/dotz --head feature --title t ${CLASSED}`;

let root: string, work: string, data: string;
const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};
const commit = (file: string, text: string, message = file, identity: [string, string] = [NAME, MAIL]) => {
	writeFileSync(join(work, file), text);
	git(work, "add", file);
	git(work, "-c", `user.name=${identity[0]}`, "-c", `user.email=${identity[1]}`, "commit", "-q", "-m", message);
};
const deny = (command: string) => publicPostDeny(command, data, work);
const login = async () => ({ login: LOGIN, id: ID });

beforeEach(() => {
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	root = mkdtempSync(join(tmpdir(), "upstream-commits-"));
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
	git(work, "remote", "add", "fork", "https://github.com/alice/dotz-site.git"); // a fork whose repo is not named dotz
	commit("base", "base", "base");
	git(work, "push", "-q", "origin", "main");
	git(work, "checkout", "-q", "-b", "feature");
});
afterEach(() => {
	for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

test("a pull request with a personal identity is refused naming the fix and no value, and passes once the fix has run", async () => {
	commit("change", "one");
	const refused = deny(PR);
	expect(refused).toBeDefined();
	expect(refused).toContain(FIX_COMMAND);
	expect(refused).not.toContain(NAME);
	expect(refused).not.toContain(MAIL);
	await fixIdentity(work, login);
	expect(deny(PR)).toBeUndefined();
	expect(git(work, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe(`${LOGIN}|${noreplyMail(LOGIN, ID)}|${LOGIN}|${noreplyMail(LOGIN, ID)}`);
	expect(git(work, "config", "--local", "user.email")).toBe(noreplyMail(LOGIN, ID));
	expect(git(work, "log", "main", "-1", "--format=%ae")).toBe(MAIL); // what public main already holds stays as it was
});

test("a push to a fork is refused before the fix and passes after it, with the hook not installed", async () => {
	commit("change", "one");
	const refused = deny("git push fork feature");
	expect(refused).toContain(FIX_COMMAND);
	expect(refused).not.toContain(MAIL);
	expect(deny("git push -u fork HEAD")).toBeDefined();
	expect(deny("git push fork --delete feature")).toBeUndefined();
	expect(deny(`cd ${work} && git push fork feature`)).toBeDefined();
	await fixIdentity(work, login);
	expect(deny("git push fork feature")).toBeUndefined();
	expect(deny("git push -u fork HEAD")).toBeUndefined();
});

test("a push from a folder that is not a dotz clone is left alone", () => {
	const other = join(root, "other");
	mkdirSync(other);
	git(other, "init", "-q", "-b", "main");
	git(other, "remote", "add", "origin", "https://github.com/alice/notes.git");
	writeFileSync(join(other, "a"), "a");
	git(other, "add", "a");
	git(other, "-c", `user.name=${NAME}`, "-c", `user.email=${MAIL}`, "commit", "-q", "-m", "a");
	expect(publicPostDeny("git push origin main", data, other)).toBeUndefined();
});

test("a noreply mail with a name that is not its login is refused, the release and the web identities are not", () => {
	commit("change", "one", "change", ["Someone Else", noreplyMail(LOGIN, ID)]);
	expect(deny(PR)).toContain("author name");
	expect(deny(PR)).toContain("committer name");
	const row = (authorName: string, authorMail: string, committerName: string, committerMail: string) => ({ sha: "a".repeat(40), authorName, authorMail, committerName, committerMail, subject: "" });
	expect(identityLabels(row(RELEASE_NAME, RELEASE_EMAIL, RELEASE_NAME, RELEASE_EMAIL))).toEqual([]);
	expect(identityLabels(row(LOGIN, noreplyMail(LOGIN, ID), "GitHub", "noreply@github.com"))).toEqual([]);
	expect(identityLabels(row(LOGIN.toUpperCase(), `${LOGIN}@users.noreply.github.com`, LOGIN, noreplyMail(LOGIN, ID)))).toEqual([]);
	expect(identityLabels(row(LOGIN, MAIL, LOGIN, noreplyMail(LOGIN, ID)))).toEqual(["author mail"]);
	expect(parseRows(`${"b".repeat(40)}\tn\ta\tn\ta\tsubject\nfatal: not a commit`)).toHaveLength(1);
});

test("a phone number in a message and an install value in an added line are refused by label; removed lines and public commits are not", async () => {
	const identity: [string, string] = [LOGIN, noreplyMail(LOGIN, ID)];
	commit("one", "text", "call 010-1234-5678 for details", identity);
	const message = deny(PR);
	expect(message).toContain("message: phone");
	expect(message).not.toContain("010-1234-5678");
	git(work, "reset", "-q", "--hard", "HEAD~1");
	commit("two", `has ${VALUE} inside`, "two", identity);
	const added = deny(PR);
	expect(added).toContain("added line");
	expect(added).not.toContain(VALUE);
	git(work, "reset", "-q", "--hard", "HEAD~1");
	git(work, "checkout", "-q", "main");
	commit("three", `legacy ${VALUE}`, "legacy 010-1234-5678", identity);
	git(work, "push", "-q", "origin", "main"); // already public: not new
	git(work, "checkout", "-q", "-b", "later");
	commit("three", "clean now", "clean", identity); // the value is on a removed line only
	expect(deny(PR.replace("--head feature", "--head later"))).toBeUndefined();
});

test("a pull request post without its class line, or marked as a personal setting, is refused as an issue is; comments and edits get the value check", () => {
	commit("change", "one", "change", [LOGIN, noreplyMail(LOGIN, ID)]);
	const none = deny(`gh pr create -R ddotz/dotz --head feature --title t --body "just a body"`);
	expect(none).toContain("분류:");
	const personal = deny(`gh pr create -R ddotz/dotz --head feature --title t --body "분류: 개인 설정"`);
	expect(personal).toContain("personal setting");
	expect(personal).not.toContain("분류: 소스 오류");
	expect(deny(PR)).toBeUndefined();
	expect(deny(`gh pr comment 5 -R ddotz/dotz --body "see ${VALUE}"`)).toContain("privacy list");
	expect(deny(`gh pr edit 5 -R ddotz/dotz --body "mail ${MAIL.replace("example.com", "gmail.com")}"`)).toContain("email");
});

test("a pull request whose commits cannot be read is refused rather than passed", () => {
	const empty = join(root, "empty");
	mkdirSync(empty);
	expect(publicPostDeny(PR, data, empty)).toBeDefined();
	expect(deny(PR.replace("--head feature", "--head nonexistent"))).toBeDefined();
});

test("the head can come from the API forms and from a cd before the post", () => {
	commit("change", "one");
	const api = `gh api repos/ddotz/dotz/pulls -f title=t -f head=alice:feature -f base=main -f body="분류: 보편 개선"`;
	expect(deny(api)).toContain(FIX_COMMAND);
	expect(publicPostDeny(`cd ${work} && ${PR}`, data, root)).toContain(FIX_COMMAND);
});

test("the fix with nothing to rewrite only sets the clone identity, and never the global config", async () => {
	git(work, "checkout", "-q", "main");
	const globalName = () => Bun.spawnSync(["git", "config", "--global", "user.name"], { cwd: work }).stdout.toString();
	const before = globalName();
	const lines = await fixIdentity(work, login);
	expect(lines.length).toBeGreaterThan(0);
	expect(git(work, "config", "--local", "user.name")).toBe(LOGIN);
	expect(globalName()).toBe(before);
});

test("the pre-push hook's check also covers a GitHub fork of a dotz clone", async () => {
	commit("change", "one");
	const fork = "https://github.com/alice/dotz-site.git";
	expect(await refusal(run, work, fork, "HEAD")).toContain(FIX_COMMAND);
	await fixIdentity(work, login);
	expect(await refusal(run, work, fork, "HEAD")).toBeUndefined();
});

test("the fix on a branch behind public main, which changed the same line, keeps the branch's base and content", async () => {
	commit("base", "branch-version", "branch change");
	const mergeBase = () => git(work, "merge-base", "HEAD", "origin/main");
	git(work, "checkout", "-q", "main");
	commit("base", "main-version", "main change", [LOGIN, noreplyMail(LOGIN, ID)]);
	git(work, "push", "-q", "origin", "main");
	git(work, "checkout", "-q", "feature");
	const before = mergeBase();
	expect(before).not.toBe(git(work, "rev-parse", "origin/main"));
	await fixIdentity(work, login);
	expect(mergeBase()).toBe(before);
	expect(git(work, "show", "HEAD:base")).toBe("branch-version");
	expect(git(work, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe(`${LOGIN}|${noreplyMail(LOGIN, ID)}|${LOGIN}|${noreplyMail(LOGIN, ID)}`);
	expect(git(work, "rev-list", "--count", "origin/main..HEAD")).toBe("1");
});

// A push to the public repo gets the PR's content check. The fixtures are built so this file holds no real-looking path.
const HOME_PATH = ["", "Users", "zed", "notes"].join("/");
const EMAIL = ["pat", "mailbox-placeholder.org"].join("@");
const CLEAN: [string, string] = [LOGIN, noreplyMail(LOGIN, ID)];
const PUSH_FORMS = ["git push origin HEAD:main", "git push origin feature:main", "git push origin feature", "git push origin +feature:refs/heads/topic", "git push --all origin", "git push origin", "git push"];

test("a push to the public repo with a personal path in an added line is refused in every form, naming no value", () => {
	commit("notes", `see ${HOME_PATH}`, "change", CLEAN);
	for (const form of PUSH_FORMS) {
		const refused = deny(form);
		expect(refused, form).toBeDefined();
		expect(refused).not.toContain(HOME_PATH);
		expect(refused).not.toContain("zed");
	}
	expect(deny(`cd ${work} && git push origin HEAD:main`)).toBeDefined();
});

test("a push to the public repo whose commit message carries an address is refused, and the address is not repeated", () => {
	commit("plain", "clean", `reach me at ${EMAIL}`, CLEAN);
	const refused = deny("git push origin HEAD:main");
	expect(refused).toBeDefined();
	expect(refused).not.toContain(EMAIL);
	expect(refused).not.toContain("pat@");
});

test("a test fixture may show an address on a push, any other file may not", () => {
	commit("addr.test.ts", `const mail = "${EMAIL}";`, "fixture", CLEAN);
	expect(deny("git push origin HEAD:main")).toBeUndefined();
	commit("addr.ts", `const mail = "${EMAIL}";`, "code", CLEAN);
	expect(deny("git push origin HEAD:main")).toBeDefined();
});

test("the counting-run id an input shows as its example passes in any file and message, another id of that shape does not", () => {
	commit("form.json", `{ "id_ph": "e.g. 123456789012345678" }`, "example 123456789012345678", CLEAN);
	expect(deny("git push origin HEAD:main")).toBeUndefined();
	commit("config.json", `{ "guild": "223456789012345678" }`, "id", CLEAN);
	expect(deny("git push origin HEAD:main")).toBeDefined();
});

test("commits already on the public main are not looked at, and a clean push after them passes", () => {
	git(work, "checkout", "-q", "main");
	commit("old", `legacy ${HOME_PATH}`, `legacy ${EMAIL}`, CLEAN);
	git(work, "push", "-q", "origin", "main");
	expect(deny("git push origin HEAD:main")).toBeUndefined();
	commit("fresh", "clean", "fresh", CLEAN);
	expect(deny("git push origin HEAD:main")).toBeUndefined();
	commit("worse", `new ${HOME_PATH}`, "worse", CLEAN);
	expect(deny("git push origin HEAD:main")).toBeDefined();
});

test("a push to a remote that is not the public repo gets no content check", () => {
	commit("notes", `see ${HOME_PATH}`, `mail ${EMAIL}`, CLEAN);
	expect(deny("git push fork feature")).toBeUndefined();
	expect(deny("git push -u fork HEAD")).toBeUndefined();
	expect(deny("git push origin :feature")).toBeUndefined(); // a deletion publishes no commit
	expect(deny("git push origin --delete feature")).toBeUndefined();
});

test("a push to the public repo that cannot be checked is refused rather than passed", () => {
	commit("plain", "clean", "clean", CLEAN);
	expect(deny("git push origin HEAD:main")).toBeUndefined();
	git(work, "update-ref", "-d", "refs/remotes/origin/main"); // what public main holds is no longer known
	expect(deny("git push origin HEAD:main")).toBeDefined();
	expect(contentFindings(join(root, "no-such-folder"), ["HEAD"], [], [])).toBeUndefined();
});
