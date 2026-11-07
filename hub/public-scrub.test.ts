import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTerms, publicPostDeny, scrub } from "./public-scrub.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "dotz-scrub-")); dirs.push(d); return d; };
function install(): string {
	const dir = temp();
	mkdirSync(join(dir, "secrets"));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ discord: { owner_id: "123456", guild: "998877", token_file: "discord-bot-token" }, git: { remote: "origin" }, channels: { general: "general-room" }, models: { orchestrator: { model: "some-model" } }, web: { allow_logins: ["member@corp.test"] } }));
	writeFileSync(join(dir, "secrets", "hub-token"), "abcd-1234-efgh-5678\n");
	writeFileSync(join(dir, "secrets", "shop.json"), JSON.stringify({ address: "서울 어딘가 1번지", on: true }));
	writeFileSync(join(dir, "secrets", "privacy-terms.txt"), "우리회사\n\n");
	return dir;
}

describe("scrub", () => {
	test("masks each kind and reports labels, never the value", () => {
		const { text, hits } = scrub("mail a.b@corp.test, 010-1234-5678, id 123456789012345678, 100.70.1.2, box.tail99.ts.net, /Users/somebody/x, sk-ant-abcdefghijklmnopqrstuvwxyz");
		for (const value of ["corp.test", "1234-5678", "123456789012345678", "100.70", "tail99", "somebody", "sk-ant"]) {
			expect(text).not.toContain(value);
			expect(hits.join(" ")).not.toContain(value);
		}
		expect(hits).toEqual(expect.arrayContaining(["email", "phone", "messenger id", "private address", "tailnet host", "local path", "token"]));
	});

	test("leaves public, placeholder and ordinary text alone", () => {
		const clean = "git@github.com:ddotz/dotz, 1234+noreply@users.noreply.github.com, a@example.com, bun@1.3.0, actions/checkout@v4.1.1, /Users/you/x, 1700000000, v261106.3.1, 공개 문장";
		expect(scrub(clean)).toEqual({ text: clean, hits: [] });
	});

	test("a user name that starts like a placeholder is still masked", () => {
		expect(scrub("/Users/name-kim/x").text).toBe("~/x");
	});

	test("a short term stays quiet inside the ordinary words excepted for it, and only there", () => {
		const terms = [{ value: "푸른", label: "privacy list", except: ["푸른곰", "푸른별"] }];
		expect(scrub("푸른곰과 푸른별이 떠요", terms)).toEqual({ text: "푸른곰과 푸른별이 떠요", hits: [] });
		expect(scrub("푸른이가 푸른곰을 봐요", terms)).toEqual({ text: "[비공개]이가 푸른곰을 봐요", hits: ["privacy list"] });
	});

	test("install terms match whole words only", () => {
		const terms = [{ value: "box1", label: "machine name" }];
		expect(scrub("on Box1 now", terms)).toEqual({ text: "on [비공개] now", hits: ["machine name"] });
		expect(scrub("box12", terms).hits).toEqual([]);
	});
});

test("installTerms takes identifying config values, secrets and the privacy list, and leaves settings out", () => {
	const dir = install();
	const values = installTerms(dir).map(t => t.value);
	expect(values).toEqual(expect.arrayContaining(["123456", "998877", "member@corp.test", "abcd-1234-efgh-5678", "서울 어딘가 1번지", "우리회사"]));
	expect(values).not.toContain("some-model");
	expect(values).not.toContain("discord-bot-token");
	for (const setting of ["origin", "general-room"]) expect(values).not.toContain(setting);
	expect(installTerms(join(dir, "missing"))).toEqual([]);
});

test("the allow file reaches the listed term that sits inside its words, and a private tools folder is no secret", () => {
	const dir = install();
	writeFileSync(join(dir, "secrets", "privacy-terms-allow.txt"), "우리회사원\n다른단어\n");
	mkdirSync(join(dir, "secrets", "audit-tools"));
	writeFileSync(join(dir, "secrets", "audit-tools", "run.py"), "print('a long line of code')\n");
	const terms = installTerms(dir);
	expect(terms.find(t => t.value === "우리회사")?.except).toEqual(["우리회사원"]);
	expect(terms.map(t => t.value)).not.toContain("print('a long line of code')");
	expect(terms.map(t => t.value)).not.toContain("우리회사원");
});

describe("publicPostDeny", () => {
	test("refuses a post to ddotz/dotz that carries the install's values, naming no value", () => {
		const dir = install();
		const reason = publicPostDeny("gh issue create --repo ddotz/dotz --title t --body 'owner 998877 fails'", dir, dir);
		expect(reason).toContain("config discord");
		expect(reason).not.toContain("998877");
	});

	test("reads the body file, and ignores the paths around the post", () => {
		const dir = install();
		const file = join(dir, "body.md");
		writeFileSync(file, "abcd-1234-efgh-5678 leaked");
		expect(publicPostDeny("gh pr comment 5 -R ddotz/dotz --body-file " + file, dir, dir)).toContain("secret");
		writeFileSync(file, "일반화한 증상과 재현 순서");
		expect(publicPostDeny("cd /Users/somebody/code && gh pr comment 5 -R ddotz/dotz --body-file " + file, dir, dir)).toBeUndefined();
	});

	test("covers gh api writes and leaves reads and other repos alone", () => {
		const dir = install();
		expect(publicPostDeny("gh api repos/ddotz/dotz/issues -f title=x -f body=998877", dir, dir)).toBeDefined();
		expect(publicPostDeny("gh api repos/ddotz/dotz/issues --jq .[0].body # 998877", dir, dir)).toBeUndefined();
		expect(publicPostDeny("gh issue create --repo me/private --body 998877", dir, dir)).toBeUndefined();
		expect(publicPostDeny("gh issue view 3 --repo ddotz/dotz # 998877", dir, dir)).toBeUndefined();
	});

	test("every way of posting is seen", () => {
		const dir = install();
		for (const command of [
			"gh issue close 3 -R ddotz/dotz --comment 998877",
			"gh pr merge 3 -R ddotz/dotz --body 998877",
			"gh issue -R ddotz/dotz create --title t --body 998877",
			"gh api graphql -f query='mutation { x(repo: \"ddotz/dotz\", body: \"998877\") }'",
			"gh api repos/ddotz/dotz/issues -fbody=998877",
			"curl -s https://api.github.com/repos/ddotz/dotz/issues \\\n  -d '{\"body\":\"998877\"}'",
			"await tool.bash({ command: \"gh issue create --repo ddotz/dotz --body 998877\" })",
			"timeout 30 gh issue create --repo ddotz/dotz --body 998877",
			"env A=1 gh issue create --repo ddotz/dotz --body 998877",
			"if true; then gh issue create --repo ddotz/dotz --body 998877; fi",
			"BODY=$(cat <<E\n998877\nE\n)\ngh issue create --repo ddotz/dotz --body \"$BODY\"",
			"echo 998877 | gh issue create --repo ddotz/dotz --body-file -",
		]) expect(publicPostDeny(command, dir, dir)).toBeDefined();
	});

	test("text that only mentions a post, a read and what surrounds a post are left alone", () => {
		const dir = install();
		for (const command of [
			"grep -rn 'gh issue create --repo ddotz/dotz' . # 998877",
			"git commit -m 'gh pr create on ddotz/dotz 998877'",
			"curl -s https://api.github.com/repos/ddotz/dotz/issues # 998877",
			"export PATH=/Users/somebody/bin:$PATH; gh issue create --repo ddotz/dotz --body generalised",
		]) expect(publicPostDeny(command, dir, dir)).toBeUndefined();
	});

	test("a body file the check cannot reach is refused; one the command writes is read from the command", () => {
		const dir = install();
		expect(publicPostDeny("gh issue create -R ddotz/dotz --body-file $SOMEWHERE/x.md", dir, dir)).toContain("cannot read");
		const missing = join(dir, "later.md");
		expect(publicPostDeny(`cat > ${missing} <<EOF\n998877\nEOF\ngh issue create -R ddotz/dotz --body-file ${missing}`, dir, dir)).toContain("config discord");
	});

	test("each form of body file is read", () => {
		const dir = install();
		const file = join(dir, "leak.md");
		writeFileSync(file, "998877");
		for (const form of [`--body-file - < ${file}`, `--body-file ${file} 2>&1`]) expect(publicPostDeny(`gh issue create -R ddotz/dotz ${form}`, dir, dir)).toBeDefined();
		expect(publicPostDeny(`gh api repos/ddotz/dotz/issues -F "body=@${file}"`, dir, dir)).toBeDefined();
		expect(publicPostDeny("gh issue create -R ddotz/dotz --body-file $F 2>&1", dir, dir)).toContain("cannot read");
	});

	test("a cd into the checkout counts", () => {
		const dir = install();
		const repo = join(dir, "repo");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["remote", "add", "origin", "https://github.com/ddotz/dotz.git"], { cwd: repo });
		expect(publicPostDeny(`cd ${repo} && gh pr create --body 998877`, dir, dir)).toBeDefined();
	});

	test("a checkout of ddotz/dotz counts without --repo; another checkout does not", () => {
		const dir = install();
		const repo = join(dir, "repo");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["remote", "add", "origin", "git@github.com:other/thing.git"], { cwd: repo });
		expect(publicPostDeny("gh pr create --body 998877", dir, repo)).toBeUndefined();
		execFileSync("git", ["remote", "set-url", "origin", "https://github.com/ddotz/dotz.git"], { cwd: repo });
		expect(publicPostDeny("gh pr create --body 998877", dir, repo)).toBeDefined();
	});
});
