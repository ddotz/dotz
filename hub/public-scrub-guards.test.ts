// Guards of hub/public-scrub.ts that a mutation probe found removable with every nearby test still green: the line is dropped or
// flipped and one of these fails. Each case is the input the guard exists to turn away.
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksRandom, maskSecrets, publicPostDeny, secretFileValues } from "./public-scrub.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "dotz-scrub-guard-"));
	dirs.push(d);
	return d;
};

test("a post aimed at another repo is not held to the dotz rules just because the checkout's remote is dotz", () => {
	const data = temp();
	const repo = temp();
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["remote", "add", "origin", "https://github.com/ddotz/dotz.git"], { cwd: repo });
	expect(publicPostDeny("gh issue create --title t --body plain", data, repo)).toContain("분류");
	expect(publicPostDeny("gh issue create --repo other/repo --title t --body plain", data, repo)).toBeUndefined();
	expect(publicPostDeny("gh issue create -R other/repo --title t --body plain", data, repo)).toBeUndefined();
	expect(publicPostDeny("gh api repos/other/repo/issues -f title=t -f body=plain", data, repo)).toBeUndefined();
});

test("a value that only looks like a key, a path, a link or a member is no random secret", () => {
	expect(looksRandom("aB3dE9fGh1Jk")).toBe(true);
	for (const v of ["a1b2c3", "$aB3dE9fGh1", "x".repeat(4) + "aB3dE9", "process.env.Ab3dE9", "/tmp/aB3dE9fGh1", "~/aB3dE9fGh1", "https://x.test/aB3dE9"]) expect(looksRandom(v), v).toBe(false);
	for (const text of ["token=process.env.Ab3dE9", "secret=/tmp/aB3dE9fGh1", "password: https://x.test/aB3dE9", "token=$aB3dE9fGh1"]) expect(maskSecrets(text), text).toEqual({ text, hits: {} });
});

test("a key with a known shape is replaced whole by its marker", () => {
	const key = `ghp_${"aB3dE9fGh1".repeat(4)}`;
	expect(maskSecrets(`use ${key} now`)).toEqual({ text: "use [가림:github] now", hits: { github: 1 } });
	expect(maskSecrets("password=aB3dE9fGh1Jk")).toEqual({ text: "password=[가림:pair]", hits: { pair: 1 } });
});

test("secret file values leave out the privacy list, private tools folders, short values, plain words and spaced text", () => {
	const data = temp();
	const secrets = join(data, "secrets");
	mkdirSync(join(secrets, "audit-tools"), { recursive: true });
	writeFileSync(join(secrets, "hub-token"), "Lk5Jh9Gf3Ds7Aq\n");
	writeFileSync(join(secrets, "privacy-terms.txt"), "Qw3Rt7Yu9Io2Pa\n");
	writeFileSync(join(secrets, "audit-tools", "run.sh"), "Zx4Cv8Bn6Mq1Ws\n");
	writeFileSync(join(secrets, "shop.json"), JSON.stringify({ short: "aB3dE9fGh1", word: "just-an-ordinary-setting", address: "서울 어딘가 1번지 길게길게" }));
	expect(secretFileValues(data)).toEqual(["Lk5Jh9Gf3Ds7Aq"]);
});
