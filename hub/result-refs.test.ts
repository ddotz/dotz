// What a finished report names as its results (hub/result-refs.ts): files that exist, commits its `근거:` line names that a repo with a web
// remote has (as that commit's page), and web links; a hash or URL inside a code block, a local address or a missing file is left out.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoWebUrl, resultFiles, resultLinks } from "./result-refs.ts";

const dir = mkdtempSync(join(tmpdir(), "result-refs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.toString().trim();
git("init", "-q");
git("remote", "add", "origin", "git@github.com:acme/site.git");
writeFileSync(join(dir, "공지.md"), "# 공지\n");
git("add", ".");
git("commit", "-qm", "공지");
const full = git("rev-parse", "HEAD"), short = full.slice(0, 8);

test("a report's files, commit and link become results; the rest is left out", () => {
	const report = [
		"공지 초안을 다듬었어요.",
		`[file] ${join(dir, "공지.md")}`,
		`[file] ${join(dir, "없는파일.md")}`,
		`-# 근거: \`${short}\` main 포함 확인, deadbee1 없음`,
		"배포: https://github.com/acme/site/releases/tag/v1.",
		"미리보기: http://127.0.0.1:7420/x",
		"```",
		"https://example.com/in-code",
		"```",
	].join("\n");
	expect(resultFiles(report).map(f => f.name)).toEqual(["공지.md"]);
	expect(resultLinks(report, [dir])).toEqual([
		{ kind: "commit", hash: short, url: `https://github.com/acme/site/commit/${full}` },
		{ kind: "link", url: "https://github.com/acme/site/releases/tag/v1" },
	]);
	expect(resultLinks("할 일만 정리했어요", [dir])).toEqual([]);
	expect(resultLinks("자료는 https://example.com/a에서 봤고 **https://example.com/b** 와 https://en.wikipedia.org/wiki/Foo_(bar)", [dir]).map(l => l.url))
		.toEqual(["https://example.com/a", "https://example.com/b", "https://en.wikipedia.org/wiki/Foo_(bar)"]);
});

test("a remote's web page", () => {
	expect(["git@github.com:a/b.git", "https://github.com/a/b.git", "ssh://git@gitlab.com:22/a/b", "/srv/repo.git"].map(repoWebUrl)).toEqual(["https://github.com/a/b", "https://github.com/a/b", "https://gitlab.com/a/b", undefined]);
});
