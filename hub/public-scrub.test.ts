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

	test("covers gh api writes and leaves reads alone", () => {
		const dir = install();
		expect(publicPostDeny("gh api repos/ddotz/dotz/issues -f title=x -f body=998877", dir, dir)).toBeDefined();
		expect(publicPostDeny("gh api repos/ddotz/dotz/issues --jq .[0].body # 998877", dir, dir)).toBeUndefined();
		expect(publicPostDeny("gh issue view 3 --repo ddotz/dotz # 998877", dir, dir)).toBeUndefined();
	});

	test("a gist and a post to any other repo get the same personal-value check, without the dotz rules", () => {
		const dir = install();
		const file = join(dir, "log.txt");
		writeFileSync(file, "owner 998877 fails");
		for (const command of [
			"gh gist create --public " + file,
			"gh gist create -d 'a log' " + file,
			"gh gist edit abc123 " + file,
			"gh gist create --public <<< 'owner 998877'",
			"gh issue create --repo other/repo --body 998877",
			"gh pr comment 5 -R other/repo --body-file " + file,
			"gh api repos/other/repo/issues -f title=x -f body=998877",
		]) {
			const reason = publicPostDeny(command, dir, dir);
			expect(reason, command).toContain("personal or sensitive");
			expect(reason).not.toContain("998877");
		}
		writeFileSync(file, "일반화한 증상과 재현 순서");
		for (const command of ["gh gist create --public " + file, "gh issue create --repo other/repo --body 'no value here'", "gh gist list", "gh gist view abc123"]) expect(publicPostDeny(command, dir, dir), command).toBeUndefined();
		// the dotz-only rules stay with the dotz repo: no class line is demanded elsewhere
		expect(publicPostDeny("gh issue create --repo other/repo --title t --body plain", dir, dir)).toBeUndefined();
		expect(publicPostDeny("gh issue create --repo ddotz/dotz --title t --body plain", dir, dir)).toContain("분류");
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
			`export PATH=/Users/you/bin:$PATH; gh pr create --repo ddotz/dotz --body '${PR_TEXT}'`,
		]) expect(publicPostDeny(command, dir, dir)).toBeUndefined();
	});

	test("a body file the check cannot reach is refused; one the command writes is read from the command", () => {
		const dir = install();
		expect(publicPostDeny("gh issue create -R ddotz/dotz --body-file $SOMEWHERE/x.md", dir, dir)).toContain("cannot read");
		const missing = join(dir, "later.md");
		expect(publicPostDeny(`cat > ${missing} <<EOF\n998877\nEOF\ngh issue create -R ddotz/dotz --body-file ${missing}`, dir, dir)).toContain("config discord");
	});

	test("each body file the check cannot read gets its own reason, and all stay refused", () => {
		const dir = install();
		const later = join(dir, "later.md");
		const post = "gh issue comment 5 -R ddotz/dotz --body-file";
		for (const command of [`${post} ${later}`, `printf 998877 | tee ${later}\n${post} ${later}`, `${post} $HOME/not-written-yet.md`]) {
			const refusal = publicPostDeny(command, dir, dir);
			expect(refusal).toContain("does not exist yet");
			expect(refusal).toContain("separate call");
		}
		expect(publicPostDeny(`${post} $SOMEWHERE/x.md`, dir, dir)).toContain("variable");
		expect(publicPostDeny(`${post} "\${SOMEWHERE}/x.md"`, dir, dir)).toContain("variable");
		const big = join(dir, "big.md");
		writeFileSync(big, "x".repeat(3 * 1024 * 1024));
		expect(publicPostDeny(`${post} ${big}`, dir, dir)).toContain("too big");
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

	test("a checkout of ddotz/dotz gets the dotz rules without --repo; another checkout only the personal-value check", () => {
		const dir = install();
		const repo = join(dir, "repo");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["remote", "add", "origin", "git@github.com:other/thing.git"], { cwd: repo });
		expect(publicPostDeny("gh pr create --body 998877", dir, repo)).toContain("a public GitHub repo or gist");
		expect(publicPostDeny("gh pr create --body plain", dir, repo)).toBeUndefined();
		execFileSync("git", ["remote", "set-url", "origin", "https://github.com/ddotz/dotz.git"], { cwd: repo });
		expect(publicPostDeny("gh pr create --body 998877", dir, repo)).toContain("this post to ddotz/dotz");
		expect(publicPostDeny("gh pr create --body plain", dir, repo)).toContain("분류");
	});
});

describe("filing classification", () => {
	const FILE = "gh issue create -R ddotz/dotz --title t";
	const PR = "gh pr create -R ddotz/dotz --title t";

	test("an issue or PR with no classification line is refused, with the accepted forms", () => {
		const dir = install();
		for (const command of [`${FILE} --body '증상과 재현 순서'`, "gh pr create -R ddotz/dotz --title t --body x", "gh pr create -R ddotz/dotz --fill", "gh pr create -R ddotz/dotz --body \"$OTHER\""]) {
			const reason = publicPostDeny(command, dir, dir);
			expect(reason).toContain("분류: 소스 오류");
			expect(reason).toContain("분류: 보편 개선");
		}
		expect(publicPostDeny(`${FILE} --body '분류: 뭐든 좋아요'`, dir, dir)).toContain("분류: 소스 오류");
		expect(publicPostDeny("gh issue create -R ddotz/dotz --title '분류: 소스 오류' --body x", dir, dir)).toContain("분류: 소스 오류");
		expect(publicPostDeny(`${FILE} --body '설명에 분류: 소스 오류 라고 적었어요'`, dir, dir)).toContain("분류: 소스 오류");
	});

	test("a source bug or a universal improvement passes through every way a body arrives", () => {
		const dir = install();
		const file = join(dir, "body.md");
		writeFileSync(file, `# 제목\r\n\r\n${PR_UNIVERSAL.replaceAll("\n", "\r\n")}`);
		for (const command of [
			`${PR} --body '${PR_TEXT}'`,
			`${PR} --body "${PR_UNIVERSAL.replaceAll("\n", "\\n")}"`,
			`${PR} --body "증상\n\n${PR_TEXT}"`,
			`gh pr create -R ddotz/dotz --title t --body '${PR_UNIVERSAL}'`,
			`${PR} --body-file ${file}`,
			`${PR} --body-file - < ${file}`,
			`cat ${file} | ${PR} --body-file -`,
			`${PR} --body-file - <<EOF\n${PR_TEXT}EOF`,
			`gh api repos/ddotz/dotz/pulls -f title=t -f body='${PR_TEXT}'`,
			`curl -s -X POST https://api.github.com/repos/ddotz/dotz/pulls -d '{"body":"${PR_TEXT.replaceAll("\n", "\\n")}"}'`,
		]) expect(publicPostDeny(command, dir, dir)).toBeUndefined();
	});

	test("a personal setting is refused with where it belongs, even beside another classification", () => {
		const dir = install();
		const file = join(dir, "body.md");
		writeFileSync(file, "분류: 개인 설정\n이 설치에서만 필요한 값");
		for (const command of [`${FILE} --body '분류: 개인 설정'`, `${FILE} --body-file ${file}`, `${FILE} --body "분류: 소스 오류\n분류: 개인 설정"`]) {
			const reason = publicPostDeny(command, dir, dir);
			expect(reason).toContain("docs/customization.md");
		}
	});

	test("only the body's own line counts: a title, an inline mention or another command's text does not", () => {
		const dir = install();
		for (const command of [
			"gh api repos/ddotz/dotz/issues -f title='분류: 소스 오류' -f body=x",
			"curl -X POST https://api.github.com/repos/ddotz/dotz/issues -d '{\"title\":\"분류: 소스 오류\"}'",
			"gh issue create -R ddotz/dotz -t'분류: 소스 오류' --body x",
			`${FILE} --body 'see \`분류: 소스 오류\` here'`,
			`git commit -m '분류: 소스 오류' && ${FILE} --body x`,
		]) expect(publicPostDeny(command, dir, dir)).toContain("분류: 소스 오류");
	});

	test("a valid body may mention the personal form, and a JSON body in double quotes passes", () => {
		const dir = install();
		for (const command of [
			`${PR} --body "${PR_TEXT}\`분류: 개인 설정\` 이 거부돼요"`,
			`curl -X POST https://api.github.com/repos/ddotz/dotz/pulls -d "{\\"body\\":\\"${PR_TEXT.replaceAll("\n", "\\n")}\\"}"`,
			`BODY='${PR_UNIVERSAL}'; gh pr create -R ddotz/dotz --body "$BODY"`,
			`echo '${PR_TEXT}' | ${PR} --body-file -`,
			`printf '${PR_UNIVERSAL.replaceAll("\n", "\\n")}' | ${PR} --body-file -`,
			`${PR} --body-file - <<< '${PR_TEXT}'`,
			`gh api graphql -f query='mutation { createPullRequest(input: {repositoryId: "x", title: "t", body: "${PR_TEXT.replaceAll("\n", "\\n")}"}) { clientMutationId } }' # ddotz/dotz`,
		]) expect(publicPostDeny(command, dir, dir)).toBeUndefined();
	});

	test("reads through the API and comments that quote a command are not filings", () => {
		const dir = install();
		for (const command of [
			"gh api -X GET repos/ddotz/dotz/issues -f state=open",
			"gh api repos/ddotz/dotz/issues --method GET -f state=open",
			"curl -sG https://api.github.com/repos/ddotz/dotz/issues -d state=open",
			"gh issue comment 5 -R ddotz/dotz --body '다음으로 실행\ngh pr merge 3\n'",
			"gh api repos/ddotz/dotz/issues/5/comments -f body='createIssue fails'",
		]) expect(publicPostDeny(command, dir, dir)).toBeUndefined();
	});

	test("the API path is the URL itself, wherever curl writes it and with a query", () => {
		const dir = install();
		for (const command of [
			"curl -X POST -d '{\"title\":\"see repos/a/b/issues/1\"}' https://api.github.com/repos/ddotz/dotz/issues",
			"gh api -X POST 'repos/ddotz/dotz/issues?x=1' -f title=t",
			"gh api -H 'X: repos/a/b/c' repos/ddotz/dotz/issues -f title=t",
			"gh api repos/ddotz/dotz/issues -f title=t -f body='run with -debug flag'",
			"gh api repos/ddotz/dotz/issues -f title=t -f body='method -X GET fails'",
			"curl -g -X POST https://api.github.com/repos/ddotz/dotz/issues -d '{\"title\":\"t\"}'",
		]) expect(publicPostDeny(command, dir, dir)).toContain("분류: 소스 오류");
	});

	test("creating through the API needs the line too; comments and other repos do not", () => {
		const dir = install();
		for (const command of ["gh api repos/ddotz/dotz/issues -f title=t -f body=x", "gh api repos/ddotz/dotz/pulls -f title=t -f head=a -f base=main", "curl -s -X POST https://api.github.com/repos/ddotz/dotz/issues -d '{\"title\":\"t\"}'", "gh api graphql -f query='mutation { createIssue(input: {repositoryId: \"ddotz/dotz\"}) { clientMutationId } }'"]) expect(publicPostDeny(command, dir, dir)).toContain("분류: 소스 오류");
		for (const command of ["gh pr comment 5 -R ddotz/dotz --body 'see repos/ddotz/dotz/issues'", "gh issue comment 5 -R ddotz/dotz --body x", "gh api repos/ddotz/dotz/issues/5/comments -f body=x", "gh issue create --repo me/private --body x"]) expect(publicPostDeny(command, dir, dir)).toBeUndefined();
	});

	test("a clone whose origin is a fork of the public repo still files there", () => {
		const dir = install();
		const repo = join(dir, "fork");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["remote", "add", "origin", "https://github.com/someone/dotz.git"], { cwd: repo });
		expect(publicPostDeny("gh pr create --body x", dir, repo)).toBeUndefined();
		execFileSync("git", ["remote", "add", "upstream", "https://github.com/ddotz/dotz.git"], { cwd: repo });
		expect(publicPostDeny("gh pr create --body x", dir, repo)).toContain("분류: 소스 오류");
	});
});

test("every command of a chain counts, inside a shell string too", () => {
	const dir = install();
	expect(publicPostDeny("gh issue comment 5 -R ddotz/dotz --body x && gh issue create -R ddotz/dotz --body x", dir, dir)).toContain("분류: 소스 오류");
	expect(publicPostDeny("gh pr comment 5 -R ddotz/dotz --body x && gh pr merge 5 -R ddotz/dotz", dir, dir)).toContain("dotz_merge");
	expect(publicPostDeny("await tool.bash({ command: \"gh api -X GET repos/ddotz/dotz/issues -f state=open\" })", dir, dir)).toBeUndefined();
});

const PR_TEXT = "분류: 소스 오류\n\n## 무엇이 바뀌나요\n카드를 고쳐요\n\n## 왜 바꾸나요\n카드가 두 번 떠요\n\n## 확인한 방법\n고치기 전에 red, 고친 뒤에 green인 테스트예요\n";
const PR_UNIVERSAL = PR_TEXT.replace("소스 오류", "보편 개선");
const FULL_ISSUE = "분류: 소스 오류\n\n## 증상\n카드가 두 번 떠요\n\n## 재현 순서(기본 설정에서)\n1. 메일 앱을 열어요\n\n## 기대 결과\n한 번 떠요\n\n## 실제 결과\n두 번 떠요\n\n## 버전(dotz 버전, OS)\n261108.1, macOS\n\n## 관련 코드 위치(파일:줄, 함수)\nhub/public-scrub.ts:10 scrub\n\n## 로그 일부\n없음: 화면 동작이라 로그가 남지 않아요\n\n## 원인 추정\n같은 알림을 두 번 받아요\n\n## 시도한 것\n재시작해도 같아요\n";

describe("the owner's work stays out of public posts", () => {
	const COMMENT = "gh issue comment 5 -R ddotz/dotz --body";
	function workInstall(): string {
		const dir = install();
		mkdirSync(join(dir, "projects", "가상공방-정산"), { recursive: true });
		mkdirSync(join(dir, "memory"));
		writeFileSync(join(dir, "memory", "owner.md"), "주인은 물레반죽 일을 해요. 물레반죽 일정이 많아요. 낯선한번낱말도 적혀 있어요.\n");
		writeFileSync(join(dir, "channels.json"), JSON.stringify({ lanes: { "lunar-glaze": "1" } }));
		mkdirSync(join(dir, "custom"));
		writeFileSync(join(dir, "custom", "mailboxes.json"), JSON.stringify({ boxes: [{ name: "유약주문", rules: [{ subject: "가마예약" }] }] }));
		return dir;
	}

	test("a file name outside the repo is refused on every text path, naming it and a neutral form", () => {
		const dir = install();
		const name = "주간회의록-최종.docx";
		for (const command of [
			`${COMMENT} '첨부 ${name}를 못 붙여요'`,
			`gh issue edit 5 -R ddotz/dotz --body '이름 앞이 같은 \`… - ${name}\`'`,
			`gh pr comment 5 -R ddotz/dotz --body '${name}'`,
			`gh pr edit 5 -R ddotz/dotz --body '${name}'`,
			`gh pr review 5 -R ddotz/dotz --comment --body '${name}'`,
			`gh api repos/ddotz/dotz/issues/5/comments -f body='${name}'`,
			`gh api repos/ddotz/dotz/commits/abc/comments -f body='${name}'`,
			`curl -X POST https://api.github.com/repos/ddotz/dotz/issues/5/comments -d '{"body":"${name}"}'`,
		]) {
			const reason = publicPostDeny(command, dir, dir);
			expect(reason).not.toContain(name);
			expect(reason).toContain("문서1.docx");
		}
		expect(publicPostDeny(`${COMMENT} '본문의 \`… 녹음 ….mp3\`'`, dir, dir)).toContain("파일1.mp3");
		expect(publicPostDeny(`${COMMENT} '(마감본)계약.pdf'`, dir, dir)).toContain("-> 문서1.pdf");
	}, 20_000); // every call walks and reads the whole repo tree (about 65 ms alone, several times that on a loaded machine) and the text paths must each run

	test("emphasis, angle brackets, a glob, a scratch folder or an attachment URL does not hide a file name", () => {
		const dir = install();
		for (const text of ["**분기실적.pdf**", "<분기실적.pdf>", "**/분기실적.pdf", "/tmp/분기실적.pdf", "https://github.com/user-attachments/files/1/분기실적.pdf", "https://github.com/someone/private/blob/main/분기실적.pdf", "분기실적.xlsm", "__분기실적.pdf__", "~~분기실적.pdf~~", "$HOME/문서/분기실적.pdf", "--분기실적.pdf", "cat > 분기실적.pdf", "tee 분기실적.pdf"]) expect(publicPostDeny(`${COMMENT} '${text} 봐요'`, dir, dir)).toContain("-> 문서1.");
	}, 20_000); // 13 posts, each walking and reading the whole repo tree (about 65 ms alone, several times that on a loaded machine)

	test("a body file over the secret size is still read, and one too big to read is refused", () => {
		const dir = install();
		const file = join(dir, "long.md");
		writeFileSync(file, `${"긴 로그\n".repeat(20000)}명단정리표.xlsx`);
		expect(publicPostDeny(`gh issue comment 5 -R ddotz/dotz --body-file ${file}`, dir, dir)).toContain("-> 문서1.xlsx");
		writeFileSync(file, "x".repeat(3 * 1024 * 1024));
		expect(publicPostDeny(`gh issue comment 5 -R ddotz/dotz --body-file ${file}`, dir, dir)).toContain("cannot read");
	});

	test("a name every project has, a body file made in the command and a release's assets pass", () => {
		const dir = install();
		for (const name of ["vite.config.ts", "Cargo.toml", "requirements.txt", "main.py"]) expect(publicPostDeny(`${COMMENT} '${name} 를 봤어요'`, dir, dir)).toBeUndefined();
		expect(publicPostDeny("cat > pr-body.md <<EOF\n고쳤어요\nEOF\ngh issue comment 5 -R ddotz/dotz --body-file pr-body.md", dir, dir)).toBeUndefined();
		expect(publicPostDeny("await tool.bash({ command: \"cat > /tmp/note-7.md <<EOF\n고쳤어요\nEOF\ngh issue comment 5 -R ddotz/dotz --body-file /tmp/note-7.md && rm /tmp/note-7.md\" })", dir, dir)).toBeUndefined();
		expect(publicPostDeny("gh release create v1 dotz-v1.tar.gz -R ddotz/dotz --notes '고친 점을 적어요'", dir, dir)).toBeUndefined();
	});

	test("a release's own text still counts, and a chain with another post counts whole", () => {
		const dir = install();
		expect(publicPostDeny(`${"gh issue comment 5 -R ddotz/dotz"} --body "ran gh release create v1 x-plan.pdf today"`, dir, dir)).toContain("-> 문서1.pdf");
		expect(publicPostDeny("gh release create v1 a.zip -R ddotz/dotz; echo x-plan.pdf | gh issue comment 1 -R ddotz/dotz -F -", dir, dir)).toContain("-> 문서1.pdf");
		for (const flag of ["--notes '분기실적.pdf'", "--notes 분기실적.pdf", "--title 분기실적.pdf"]) expect(publicPostDeny(`gh release create v1 dotz-v1.tar.gz -R ddotz/dotz ${flag}`, dir, dir)).toContain("-> 문서1.pdf");
		expect(publicPostDeny("gh release create v1 -R ddotz/dotz && gh api repos/ddotz/dotz/issues/5/comments -f body=분기실적.pdf", dir, dir)).toContain("-> 문서1.pdf");
		expect(publicPostDeny("gh release create v1 -R ddotz/dotz && gh issue comment 5 -R ddotz/dotz --body '분기실적.pdf'", dir, dir)).toContain("-> 문서1.pdf");
	});

	test("a merge or a personal setting keeps its own refusal even when the text names a file", () => {
		const dir = install();
		expect(publicPostDeny("gh pr merge 3 -R ddotz/dotz --body '분기실적.pdf'", dir, dir)).toContain("dotz_merge");
		expect(publicPostDeny("gh issue create -R ddotz/dotz --body '분류: 개인 설정\n분기실적.pdf'", dir, dir)).toContain("docs/customization.md");
	});

	test("a body file counts, and another repo's post is not this check's", () => {
		const dir = install();
		const file = join(dir, "body.md");
		writeFileSync(file, "명단정리표.xlsx 가 안 열려요");
		expect(publicPostDeny(`gh issue comment 5 -R ddotz/dotz --body-file ${file}`, dir, dir)).toContain("-> 문서1.xlsx");
		expect(publicPostDeny("gh issue comment 5 -R me/private --body '명단정리표.xlsx'", dir, dir)).toBeUndefined();
	});

	test("a word this install's own files know is refused with a neutral form", () => {
		const dir = workInstall();
		for (const [word, form] of [["가상공방", "프로젝트A"], ["lunar-glaze", "작업 채널"], ["유약주문", "메일 앱 A"], ["가마예약", "메일 앱 A"], ["물레반죽", "일반 표현"]]) {
			const reason = publicPostDeny(`${COMMENT} '오늘 ${word}에서 카드가 멈췄어요'`, dir, dir);
			expect(reason).toContain(`-> ${form}`);
			expect(reason).not.toContain(word);
		}
	});

	test("a decomposed folder name, a known word inside a compound and a word only inside a longer repo word are still refused", () => {
		const dir = workInstall();
		mkdirSync(join(dir, "projects", "달빛도예".normalize("NFD")));
		expect(publicPostDeny(`${COMMENT} '달빛도예 흐름이 멈춰요'`, dir, dir)).toContain("-> 프로젝트A");
		expect(publicPostDeny(`${COMMENT} '우리가상공방에서 멈춰요'`, dir, dir)).toContain("-> 프로젝트A");
		writeFileSync(join(dir, "channels.json"), JSON.stringify({ lanes: { plac: "1" } }));
		expect(publicPostDeny(`${COMMENT} 'plac 흐름이 멈춰요'`, dir, dir)).toContain("-> 작업 채널");
	});

	test("a word the repo uses, a one-off word of the notes and an allowed word pass", () => {
		const dir = workInstall();
		writeFileSync(join(dir, "channels.json"), JSON.stringify({ lanes: { "mail-card": "1" } }));
		for (const word of ["mail", "card", "낯선한번낱말"]) expect(publicPostDeny(`${COMMENT} '${word} 흐름이 멈춰요'`, dir, dir)).toBeUndefined();
		writeFileSync(join(dir, "secrets", "privacy-terms-allow.txt"), "물레반죽\n명단정리표.xlsx\n");
		expect(publicPostDeny(`${COMMENT} '물레반죽 명단정리표.xlsx'`, dir, dir)).toBeUndefined();
	});

	test("a neutral post passes: placeholders, behaviour, counts, code locations", () => {
		const dir = workInstall();
		expect(publicPostDeny(`${COMMENT} '가상공방의 발주내역.pdf 가 실패해요'`, dir, dir)).toBeDefined();
		const body = "첨부 문서A.pdf 와 파일1.xlsx, 파일 2개, attachment-2.png 중 1개가 실패해요. hub/draft-approval.ts:88 textVerdict, res.json() 뒤에요. .mp3와 *.wav는 오디오예요. 설정은 config.json, Node.js 기준이에요";
		expect(publicPostDeny(`${COMMENT} '${body}'`, dir, dir)).toBeUndefined();
	});

	test("repo paths are not refused, nor a planned file under a repo folder, nor a file only the posting branch has", () => {
		const dir = install();
		for (const path of ["hub/public-scrub.ts", "web/css/15-reply-card.css", "package.json", "./MODE.ko.md", "public-scrub.test.ts", "hub/not-written-yet.ts"]) expect(publicPostDeny(`${COMMENT} '${path} 를 봤어요'`, dir, dir)).toBeUndefined();
		const repo = temp();
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["remote", "add", "origin", "https://github.com/ddotz/dotz.git"], { cwd: repo });
		writeFileSync(join(repo, "only-on-this-branch.md"), "x");
		expect(publicPostDeny("gh pr comment 5 --body 'only-on-this-branch.md 를 더해요'", dir, repo)).toBeUndefined();
		expect(publicPostDeny(`${COMMENT} 'only-on-this-branch.md'`, dir, dir)).toContain("-> 파일1.md");
	});

	test("a scratch path that carries the body is no name of the post", () => {
		const dir = install();
		expect(publicPostDeny("cat > /tmp/note-66.md <<EOF\n고쳤어요\nEOF\ngh issue comment 5 -R ddotz/dotz --body-file /tmp/note-66.md && rm /tmp/note-66.md", dir, dir)).toBeUndefined();
	});
});

describe("a new issue carries what a fix needs", () => {
	const ISSUE = "gh issue create -R ddotz/dotz --title t";
	const NAMES = ["증상", "재현 순서", "기대 결과", "실제 결과", "버전", "관련 코드 위치", "로그 일부", "원인 추정", "시도한 것"];

	test("a bare issue is refused naming every missing section", () => {
		const dir = install();
		const reason = publicPostDeny(`${ISSUE} --body '분류: 소스 오류'`, dir, dir);
		for (const name of NAMES) expect(reason).toContain(name);
		expect(reason).toContain("Missing or empty: 증상, 재현 순서");
	});

	test("a missing section, an empty one and a code location without a line are each named", () => {
		const dir = install();
		const file = join(dir, "body.md");
		const missing = (body: string) => {
			writeFileSync(file, body);
			return /Missing or empty: ([^.]*)\./.exec(publicPostDeny(`${ISSUE} --body-file ${file}`, dir, dir) ?? "")?.[1];
		};
		expect(missing(FULL_ISSUE.replace("## 원인 추정\n같은 알림을 두 번 받아요\n", ""))).toBe("원인 추정");
		expect(missing(FULL_ISSUE.replace("재시작해도 같아요", "<!-- 여기에 써요 -->"))).toBe("시도한 것");
		expect(missing(FULL_ISSUE.replace("hub/public-scrub.ts:10 scrub", "scrub 근처"))).toBe("관련 코드 위치");
	});

	test("a template's empty list line and a last section left empty before a command's tail are empty", () => {
		const dir = install();
		const noTry = FULL_ISSUE.replace("재시작해도 같아요\n", "");
		for (const command of [`${ISSUE} --body "${noTry}" && echo posted`, `${ISSUE} --body-file - <<EOF\n${noTry}EOF\necho posted`, `printf '${noTry}' | ${ISSUE} --body-file -`]) expect(publicPostDeny(command, dir, dir)).toContain("Missing or empty: 시도한 것");
		expect(publicPostDeny(`${ISSUE} --body "${FULL_ISSUE.replace("1. 메일 앱을 열어요", "1.")}"`, dir, dir)).toContain("Missing or empty: 재현 순서");
	});

	test("a comment line or an issue number in a section is no heading", () => {
		const dir = install();
		const body = FULL_ISSUE.replace("없음: 화면 동작이라 로그가 남지 않아요", "# 재시작 뒤 로그\n#123 과 같아요");
		expect(publicPostDeny(`${ISSUE} --body "${body}"`, dir, dir)).toBeUndefined();
	});

	test("a complete issue passes however its body arrives, and a PR or comment needs no sections", () => {
		const dir = install();
		const file = join(dir, "body.md");
		writeFileSync(file, FULL_ISSUE);
		const escaped = FULL_ISSUE.replaceAll("\n", "\\n");
		for (const command of [
			`${ISSUE} --body-file ${file}`,
			`${ISSUE} --body-file - <<EOF\n${FULL_ISSUE}EOF`,
			`${ISSUE} --body "${FULL_ISSUE}" --label bug`,
			`gh api repos/ddotz/dotz/issues -f title=t -f body="${FULL_ISSUE}"`,
			`curl -s -X POST https://api.github.com/repos/ddotz/dotz/issues -d '{"body":"${escaped}"}'`,
			`gh api graphql -f query='mutation { createIssue(input: {repositoryId: "x", title: "t", body: "${escaped}"}) { clientMutationId } }' # ddotz/dotz`,
			`gh pr create -R ddotz/dotz --title t --body '${PR_TEXT}'`,
			"gh issue comment 5 -R ddotz/dotz --body '고쳤어요'",
		]) expect(publicPostDeny(command, dir, dir)).toBeUndefined();
		expect(publicPostDeny("gh api repos/ddotz/dotz/issues -f title=t -f body='분류: 소스 오류'", dir, dir)).toContain("Missing or empty");
	});

	test("a section heading quoted in a shell string with flags after it still needs content", () => {
		const dir = install();
		const reason = publicPostDeny(`${ISSUE} --body "${FULL_ISSUE.replace("재시작해도 같아요\n", "")}" --label bug`, dir, dir);
		expect(reason).toContain("Missing or empty: 시도한 것");
	});
});

test("a direct merge into ddotz/dotz is refused toward dotz_merge; other repos are not", () => {
	const dir = install();
	for (const command of ["gh pr merge 3 -R ddotz/dotz --squash", "gh api -X PUT repos/ddotz/dotz/pulls/3/merge", "curl -X PUT https://api.github.com/repos/ddotz/dotz/pulls/3/merge -d '{}'", "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {repo: \"ddotz/dotz\"}) { clientMutationId } }'"]) expect(publicPostDeny(command, dir, dir)).toContain("dotz_merge");
	expect(publicPostDeny("gh pr merge 3 -R me/private --squash", dir, dir)).toBeUndefined();
});

describe("a filing carries an analysis, in either language, and nothing of this install's own layer", () => {
	const ISSUE = "gh issue create -R ddotz/dotz --title t";
	const PR = "gh pr create -R ddotz/dotz --title t";
	const COMMENT = "gh issue comment 5 -R ddotz/dotz --body";
	const EN_ISSUE = "분류: 소스 오류\n\n## Symptom\nThe card shows twice\n\n## Steps to reproduce (default settings)\n1. Open the app\n\n## Expected\nOne card\n\n## Actual\nTwo cards\n\n## Version\n261108.1, macOS\n\n## Code location\nhub/public-scrub.ts:10 scrub\n\n## Log excerpt\nnone: a screen behaviour\n\n## Cause (suspected)\nThe same notice arrives twice\n\n## What was tried\nA restart changes nothing\n";
	const SHORT_ISSUE = "분류: 소스 오류\n\n## Symptom\nThe card shows twice\n\n## Cause (suspected)\nA retry\n\n## Fix suggestion\nDrop the retry\n\n## Location\nhub/public-scrub.ts:10\n";
	const EN_PR = "분류: 소스 오류\n\n## What\nThe card shows once\n\n## Why\nIt showed twice\n\n## Verification\nThe test failed before and passes after\n";
	const home = ["", "Users", "zed", "x"].join("/");

	test("an issue shaped like a short report is refused with its missing sections, and a complete English one passes", () => {
		const dir = install();
		const reason = publicPostDeny(`${ISSUE} --body "${SHORT_ISSUE}"`, dir, dir) ?? "";
		for (const name of ["재현 순서", "기대 결과", "실제 결과", "버전", "로그 일부", "시도한 것"]) expect(reason).toContain(name);
		expect(reason).toContain("do not work around");
		expect(reason).not.toContain("Missing or empty: 증상");
		expect(publicPostDeny(`${ISSUE} --body "${EN_ISSUE}"`, dir, dir)).toBeUndefined();
		expect(publicPostDeny(`${ISSUE} --body "${EN_ISSUE.replace("1. Open the app", "Open the app")}"`, dir, dir)).toContain("Missing or empty: 재현 순서");
	});

	test("a PR needs what, why and how it was verified; a complete one passes in either language", () => {
		const dir = install();
		expect(publicPostDeny(`${PR} --body '분류: 소스 오류'`, dir, dir)).toContain("Missing or empty: 무엇이 바뀌나요, 왜 바꾸나요, 확인한 방법");
		expect(publicPostDeny(`${PR} --body "${EN_PR.replace(/## Verification[\s\S]*/, "## Verification\n")}"`, dir, dir)).toContain("Missing or empty: 확인한 방법");
		for (const body of [EN_PR, PR_TEXT]) expect(publicPostDeny(`${PR} --body "${body}"`, dir, dir)).toBeUndefined();
		expect(publicPostDeny(`${PR} --body "${EN_PR.replace("분류: 소스 오류", "")}"`, dir, dir)).toContain("분류: 소스 오류");
	});

	test("a word only this install's own layer holds is refused by line and neutral form, never echoed", () => {
		const dir = install();
		mkdirSync(join(dir, "custom", "recipes", "유약배합"), { recursive: true });
		mkdirSync(join(dir, "features", "도자기장부"), { recursive: true });
		mkdirSync(join(dir, "rules"));
		writeFileSync(join(dir, "custom", "words.json"), JSON.stringify({ words: [{ word: "석영가마", use: "물레" }] }));
		writeFileSync(join(dir, "rules", "projects.md"), "금분정리 절차는 금분정리 일정을 따라요\n");
		for (const word of ["석영가마", "유약배합", "도자기장부", "금분정리"]) {
			const reason = publicPostDeny(`${COMMENT} '첫째 줄\n오늘 ${word}에서 카드가 멈춰요'`, dir, dir) ?? "";
			expect(reason, word).toContain("at line 2 -> ");
			expect(reason).not.toContain(word);
			expect(reason).toContain("do not work around");
		}
		expect(publicPostDeny(`${COMMENT} '카드가 두 번 떠요: 파일A, 항목A, 3개, hub/public-scrub.ts:10'`, dir, dir)).toBeUndefined();
	});

	test("a read-only search that only names a posting command is no post; a real post in quotes or a subshell is", () => {
		const dir = install();
		for (const command of [
			`grep -rln 'gh issue create\\|gh pr create' ${home}`,
			`grep -rlnE "gh issue create|gh pr create" ${home}`,
			`await tool.grep({ pattern: "gh issue create|gh pr create", path: "${home}" })`,
			`rg -n -e 'x' -e 'gh pr create' ${home}`,
		]) expect(publicPostDeny(command, dir, dir), command).toBeUndefined();
		for (const command of [
			`bash -c "gh issue create -R ddotz/dotz --title t --body 'see ${home}'"`,
			`echo $(gh pr create -R ddotz/dotz --body 'see ${home}')`,
			`grep -rn x . && sh -c 'gh issue create -R ddotz/dotz --body "see ${home}"'`,
			`grep -rn 'gh pr create' . ; gh pr create -R ddotz/dotz --body 'see ${home}'`,
			`await sh(\`gh issue create -R ddotz/dotz --body "see ${home}"\`)`,
			`grep "$(gh pr create -R ddotz/dotz --body 'see ${home}')" x`,
		]) {
			const reason = publicPostDeny(command, dir, dir);
			expect(reason, command).toBeDefined();
			expect(reason).not.toContain("zed");
		}
	});

	test("a cell that writes and runs a script of read-only API calls is no post, while a body file not written yet still is", () => {
		const dir = install();
		const script = ["#!/bin/sh", "gh api user --jq .login", 'gh api repos/ddotz/dotz/issues/$1/comments --jq ".[].id" > "$2"', "awk -F'\\t' '{print $1}' < \"$2\""].join("\n");
		const read = "gh api repos/ddotz/dotz/issues/5 --jq .updated_at";
		for (const command of [`cat > /tmp/chk-1.sh <<'EOF'\n${script}\nEOF\nsh /tmp/chk-1.sh 5 /tmp/out-1.txt\n${read}`, `await Bun.write("/tmp/chk-1.sh", \`${script}\n\`);\nawait sh("${read}");`]) expect(publicPostDeny(command, dir, dir), command).toBeUndefined();
		const later = join(dir, "later.md");
		expect(publicPostDeny(`${script}\ngh issue comment 5 -R ddotz/dotz --body-file ${later}`, dir, dir)).toContain("does not exist yet");
		expect(publicPostDeny(`gh api repos/ddotz/dotz/issues/5/comments > "$2"\ngh api repos/ddotz/dotz/issues -f title=t -f body=x`, dir, dir)).toContain("분류: 소스 오류");
	});
});
