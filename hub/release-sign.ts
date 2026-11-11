// Release tag signing (docs/releases.md): release tags are SSH-signed annotated tags made on the owner's machine. The key is never read here:
// only its path goes to git. Not hub/config.ts: it needs a data dir at load, and CI has none. Not hub/release.ts either (it imports this module).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RELEASE_NAME = "dotz-release";
export const RELEASE_EMAIL = "dotz-release@users.noreply.github.com";
// The identity of every commit and tag a release makes: nothing personal reaches a public commit.
export const RELEASE_IDENTITY = ["-c", `user.name=${RELEASE_NAME}`, "-c", `user.email=${RELEASE_EMAIL}`] as const;
const SIGNERS_FILE = "release-signers";
const SSH_SIGNATURE = "-----BEGIN SSH SIGNATURE-----";
const RELEASE_TAG = /^v\d{6}\.[1-3](?:\.\d+)?$/;
const GIT_TIMEOUT_MS = 60_000;

export type SignMode = "sign" | "transition" | "no-key" | "ci-refused";

export function signingKeyPath(env: Record<string, string | undefined>): string {
	return join(env.DOTZ_DIR ?? join(homedir(), ".dotz"), "secrets", "release-signing-key");
}

export const keyMissing = (keyPath: string): boolean => !existsSync(keyPath);

export async function gitCapture(args: readonly string[], cwd: string, input?: string): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["git", "--no-pager", ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		stdin: input === undefined ? "ignore" : Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
		timeout: GIT_TIMEOUT_MS,
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out: `${out}${err}`.trim() };
}

// An annotated tag `tag` signed with the key at `keyPath`, on HEAD or on `object`.
export function signTag(root: string, tag: string, keyPath: string, object?: string): Promise<{ code: number; out: string }> {
	return gitCapture(["-c", "gpg.format=ssh", "-c", `user.signingKey=${keyPath}`, ...RELEASE_IDENTITY, "tag", "-s", "-m", tag, tag, ...(object ? [object] : [])], root);
}

// The tag checked against the repo's own release-signers: a key that file does not list cannot release.
export function verifyOwnTag(root: string, tag: string): Promise<{ code: number; out: string }> {
	return gitCapture(["-c", `gpg.ssh.allowedSignersFile=${join(root, SIGNERS_FILE)}`, "verify-tag", tag], root);
}

// Whether any local release tag is an annotated tag that carries an SSH signature.
export async function hasSignedRelease(root: string): Promise<boolean> {
	const listed = await gitCapture(["for-each-ref", "--format=%(objecttype) %(refname:short)", "refs/tags/v*"], root);
	if (listed.code !== 0) return false;
	for (const line of listed.out.split("\n")) {
		const [type, name] = line.trim().split(" ");
		if (type !== "tag" || !name || !RELEASE_TAG.test(name)) continue;
		if ((await gitCapture(["cat-file", "tag", name], root)).out.includes(SSH_SIGNATURE)) return true;
	}
	return false;
}

// How this run may release: with the key; without it only as the one unsigned transition release (CI, no signed release yet).
export async function signMode(root: string, keyPath: string, ci: boolean): Promise<SignMode> {
	if (!keyMissing(keyPath)) return "sign";
	if (!ci) return "no-key";
	return (await hasSignedRelease(root)) ? "ci-refused" : "transition";
}

// `-c` options that give a push to a github.com https origin the owner's `gh` login. None in CI (the runner has its own token), without `gh`, or for any other origin.
export async function pushAuthArgs(root: string, ci: boolean): Promise<string[]> {
	if (ci || !Bun.which("gh")) return [];
	const origin = await gitCapture(["remote", "get-url", "origin"], root);
	if (origin.code !== 0 || !origin.out.startsWith("https://github.com")) return [];
	return ["-c", "credential.https://github.com.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential"];
}
