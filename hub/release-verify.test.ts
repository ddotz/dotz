// hub/release-verify.ts against real SSH keys and real signed tags in a temp git repo: the five verdicts, both readers (git checkout, GitHub API).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchJson, splitTag, verifyGithubTag, verifyGitTag, verifyTag } from "./release-verify.ts";
import { commit, git, head } from "./selfupdate-fixture.ts";
import { defaultExec } from "./selfupdate.ts";
import { type Key, newKey, rawTag, signersText, signTag } from "./test-signing.ts";

setDefaultTimeout(30_000);

const TAG = "v261101.1";
let dir: string, repo: string, signers: string, sha: string, A: Key, B: Key;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-relverify-"));
	A = newKey(dir, "a");
	B = newKey(dir, "b");
	signers = join(dir, "signers");
	writeFileSync(signers, signersText(A));
	repo = join(dir, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	commit(repo, "f.txt", "1\n", "first");
	sha = head(repo);
	signTag(repo, TAG, A);
	signTag(repo, "v261101.2", B);
	git(repo, "tag", "-a", "-m", "no signature", "v261101.3");
	git(repo, "tag", "light");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const want = (over: Partial<Parameters<typeof verifyTag>[0]> = {}) => ({ tag: TAG, commit: sha, signersFile: signers, ...over });
const signed = (tag = TAG) => splitTag(rawTag(repo, tag));

test("splitTag cuts the signature block off the signed bytes", () => {
	const raw = rawTag(repo, TAG);
	const { payload, signature } = splitTag(raw);
	expect(signature?.startsWith("-----BEGIN SSH SIGNATURE-----")).toBe(true);
	expect(signature?.endsWith("-----END SSH SIGNATURE-----")).toBe(true);
	expect(payload + signature + "\n").toBe(raw);
	expect(payload.startsWith(`object ${sha}\ntype commit\ntag ${TAG}\n`)).toBe(true);
	const plain = rawTag(repo, "v261101.3");
	expect(splitTag(plain)).toEqual({ payload: plain, signature: null });
});

test("verifyTag: a tag signed by an allowed key naming this tag and commit is verified", async () => {
	expect(await verifyTag({ ...signed(), ...want() })).toMatchObject({ status: "verified", signer: "dotz-release" });
});

test("verifyTag: no signature is unsigned", async () => {
	expect((await verifyTag({ ...splitTag(rawTag(repo, "v261101.3")), ...want({ tag: "v261101.3" }) })).status).toBe("unsigned");
});

test("verifyTag: a key the signers file does not list is bad", async () => {
	expect((await verifyTag({ ...signed("v261101.2"), ...want({ tag: "v261101.2" }) })).status).toBe("bad");
});

test("verifyTag: changed signed bytes are bad", async () => {
	const s = signed();
	const v = await verifyTag({ ...s, payload: s.payload.replace("release", "Release"), ...want() });
	expect(v).toMatchObject({ status: "bad", signer: "dotz-release" });
});

test("verifyTag: a good signature for another tag name, another commit, a prefix of the commit or a non-commit object is a mismatch", async () => {
	const s = signed();
	expect((await verifyTag({ ...s, ...want({ tag: "v261101.9" }) })).status).toBe("mismatch");
	expect((await verifyTag({ ...s, ...want({ commit: "c".repeat(40) }) })).status).toBe("mismatch");
	expect((await verifyTag({ ...s, ...want({ commit: sha.slice(0, 12) }) })).status).toBe("mismatch");
	signTag(repo, "tree-tag", A, "HEAD^{tree}");
	expect((await verifyTag({ ...signed("tree-tag"), ...want({ tag: "tree-tag" }) })).status).toBe("mismatch");
});

test("verifyTag: no signers file or no runnable ssh-keygen is unverifiable", async () => {
	expect((await verifyTag({ ...signed(), ...want({ signersFile: join(dir, "absent") }) })).status).toBe("unverifiable");
	expect((await verifyTag({ ...signed(), ...want({ sshKeygen: join(dir, "no-such-ssh-keygen") }) })).status).toBe("unverifiable");
});

test("verifyGitTag reads the tag object from a checkout: signed, lightweight, absent", async () => {
	expect((await verifyGitTag(defaultExec, repo, TAG, want())).status).toBe("verified");
	expect((await verifyGitTag(defaultExec, repo, "light", want({ tag: "light" }))).status).toBe("unsigned");
	expect((await verifyGitTag(defaultExec, repo, "v261101.404", want())).status).toBe("unverifiable");
	expect((await verifyGitTag(defaultExec, repo, "v261101.3", want({ tag: "v261101.3" }))).status).toBe("unsigned");
});

const api = (routes: Record<string, unknown>): FetchJson => async <T>(path: string) =>
	path in routes ? { ok: true as const, value: routes[path] as T } : { ok: false as const, error: { reason: "404" } };
const REF = `/repos/o/r/git/ref/tags/${TAG}`;
const OBJ = "/repos/o/r/git/tags/abc";
const annotated = { [REF]: { object: { type: "tag", sha: "abc" } } };

test("verifyGithubTag uses the payload and signature GitHub returns, never its own verified flag", async () => {
	const { payload, signature } = signed();
	const ok = api({ ...annotated, [OBJ]: { verification: { verified: false, payload, signature } } });
	expect(await verifyGithubTag(ok, "o/r", want())).toMatchObject({ status: "verified", signer: "dotz-release" });
	const other = signed("v261101.2");
	const flagged = api({ ...annotated, [OBJ]: { verification: { verified: true, payload: other.payload, signature: other.signature } } });
	expect((await verifyGithubTag(flagged, "o/r", want())).status).toBe("bad");
});

test("verifyGithubTag: a lightweight ref is unsigned, a missing signature too, a signature without payload or an API error is unverifiable", async () => {
	const { payload, signature } = signed();
	expect((await verifyGithubTag(api({ [REF]: { object: { type: "commit", sha: sha } } }), "o/r", want())).status).toBe("unsigned");
	expect((await verifyGithubTag(api({ ...annotated, [OBJ]: { verification: { verified: false, payload: null, signature: null } } }), "o/r", want())).status).toBe("unsigned");
	expect((await verifyGithubTag(api({ ...annotated, [OBJ]: { verification: { verified: false, payload: null, signature } } }), "o/r", want())).status).toBe("unverifiable");
	expect((await verifyGithubTag(api({}), "o/r", want())).status).toBe("unverifiable");
	expect((await verifyGithubTag(api({ ...annotated }), "o/r", want())).status).toBe("unverifiable");
	expect(payload.length).toBeGreaterThan(0);
});
