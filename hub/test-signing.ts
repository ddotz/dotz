// Test support for the release signature tests: throwaway SSH keys, signed tags in temp git repos, the raw tag object.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./selfupdate-fixture.ts";

export type Key = { file: string; pub: string };

export function newKey(dir: string, name: string): Key {
	const file = join(dir, name);
	const r = Bun.spawnSync(["ssh-keygen", "-t", "ed25519", "-N", "", "-q", "-C", name, "-f", file]);
	if (r.exitCode !== 0) throw new Error(`ssh-keygen: ${r.stderr}`);
	return { file, pub: readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ") };
}

// An allowed_signers file: one `dotz-release` principal per key, valid for the git namespace.
export const signersText = (...keys: Key[]) => keys.map(k => `dotz-release namespaces="git" ${k.pub}\n`).join("");

export const signTag = (repo: string, tag: string, key: Key, rev = "HEAD") =>
	git(repo, "-c", "gpg.format=ssh", "-c", `user.signingkey=${key.file}`, "tag", "-s", "-m", `release ${tag}`, tag, rev);

// The tag object exactly as stored (git() trims, which would break the signature).
export function rawTag(repo: string, ref: string): string {
	const r = Bun.spawnSync(["git", "cat-file", "tag", ref], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git cat-file tag ${ref}: ${r.stderr}`);
	return r.stdout.toString();
}
