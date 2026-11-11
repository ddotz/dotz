import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markRewrite, commitKey } from "./history-rewrite.ts";
import { publishVersion, type PublishOptions } from "./release.ts";
import { hasSignedRelease, pushAuthArgs, signingKeyPath } from "./release-sign.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-sign-"));
	dirs.push(dir);
	return dir;
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const tagsOn = (repo: string): string[] => git(repo, "tag", "--list", "v*").split("\n").filter(Boolean);
const noon = new Date("2026-11-05T12:00:30+09:00");
const evening = new Date("2026-11-05T18:00:30+09:00");

function makeKey(): { key: string; line: string } {
	const key = join(tmp(), "k");
	execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", key]);
	return { key, line: `dotz-release namespaces="git" ${readFileSync(`${key}.pub`, "utf8").trim()}` };
}

// A bare origin on main with one released-looking history (an old lightweight tag, then work) and a release-signers file listing `trusted`;
// `checkout` is a clone of it, the place a release runs.
function world(trusted: string) {
	const origin = tmp();
	git(origin, "init", "-q", "--bare", "-b", "main");
	const seed = tmp();
	git(seed, "init", "-q", "-b", "main");
	git(seed, "config", "user.name", "test");
	git(seed, "config", "user.email", "test@example.com");
	git(seed, "remote", "add", "origin", origin);
	writeFileSync(join(seed, "release-signers"), `${trusted}\n`);
	git(seed, "add", "release-signers");
	process.env.GIT_COMMITTER_DATE = "2026-11-04T10:00:00+09:00";
	try {
		git(seed, "commit", "-q", "-m", "seed");
		git(seed, "tag", "v261104.1");
		git(seed, "commit", "--allow-empty", "-q", "-m", "work");
	} finally {
		delete process.env.GIT_COMMITTER_DATE;
	}
	git(seed, "push", "-q", "origin", "main", "v261104.1");
	const checkout = tmp();
	git(checkout, "clone", "-q", origin, ".");
	const verify = (repo: string, tag: string) =>
		spawnSync("git", ["-c", `gpg.ssh.allowedSignersFile=${join(seed, "release-signers")}`, "verify-tag", tag], { cwd: repo }).status;
	const publish = (o: Partial<PublishOptions>) =>
		publishVersion({ auto: false, force: false, dryRun: false, cwd: checkout, now: noon, ci: false, print: () => {}, ...o });
	return { origin, seed, checkout, verify, publish };
}

describe("a signed release", () => {
	test("origin gets an annotated tag its own release-signers accepts, tagged and committed as dotz-release", async () => {
		const { key, line } = makeKey();
		const w = world(line);
		expect(await w.publish({ signingKey: key })).toBe(0);
		expect(tagsOn(w.origin)).toEqual(["v261104.1", "v261105.1"]);
		expect(git(w.origin, "cat-file", "-t", "refs/tags/v261105.1").trim()).toBe("tag");
		expect(w.verify(w.origin, "v261105.1")).toBe(0);
		const tagObject = git(w.origin, "cat-file", "tag", "v261105.1");
		expect(tagObject).toContain("tagger dotz-release <dotz-release@users.noreply.github.com>");
		expect(tagObject).toContain("-----BEGIN SSH SIGNATURE-----");
		expect(git(w.origin, "log", "-1", "--format=%an <%ae> / %cn <%ce>", "v261105.1^{commit}").trim()).toBe(
			"dotz-release <dotz-release@users.noreply.github.com> / dotz-release <dotz-release@users.noreply.github.com>",
		);
		expect(await hasSignedRelease(w.checkout)).toBe(true);
	}, 30_000);

	test("a pinned release (--auto --sha) is signed too, and a key outside release-signers pushes nothing", async () => {
		const trusted = makeKey();
		const stranger = makeKey();
		const w = world(trusted.line);
		const head = git(w.checkout, "rev-parse", "HEAD").trim();
		const before = git(w.origin, "rev-parse", "main").trim();
		process.env.GIT_COMMITTER_DATE = noon.toISOString();
		try {
			expect(await w.publish({ auto: true, sha: head, signingKey: stranger.key })).toBe(1);
			expect(tagsOn(w.origin)).toEqual(["v261104.1"]);
			expect(tagsOn(w.checkout)).toEqual(["v261104.1"]);
			expect(git(w.origin, "rev-parse", "main").trim()).toBe(before);
			git(w.checkout, "reset", "-q", "--hard", head);
			expect(await w.publish({ auto: true, sha: head, signingKey: trusted.key })).toBe(0);
		} finally {
			delete process.env.GIT_COMMITTER_DATE;
		}
		expect(w.verify(w.origin, "v261105.1")).toBe(0);
		expect(git(w.origin, "rev-parse", "v261105.1^").trim()).toBe(head);
	}, 30_000);
});

describe("no signing key", () => {
	const cases: [string, Partial<PublishOptions>][] = [
		["manual", {}],
		["--force", { force: true }],
		["--auto --sha", { auto: true }],
	];
	for (const [name, extra] of cases) {
		test(`${name}: returns 1 and writes nothing`, async () => {
			const w = world(makeKey().line);
			const head = git(w.checkout, "rev-parse", "HEAD").trim();
			const opts = { ...extra, ...(extra.auto ? { sha: head } : {}), signingKey: join(tmp(), "absent") };
			expect(await w.publish(opts)).toBe(1);
			expect(await w.publish({ ...opts, dryRun: true })).toBe(1);
			expect(git(w.checkout, "rev-parse", "HEAD").trim()).toBe(head);
			expect(git(w.checkout, "status", "--porcelain", "--untracked-files=no").trim()).toBe("");
			expect(spawnSync("test", ["-e", join(w.checkout, "VERSION")]).status).toBe(1);
			expect(tagsOn(w.checkout)).toEqual(["v261104.1"]);
			expect(tagsOn(w.origin)).toEqual(["v261104.1"]);
		}, 30_000);
	}

	test("the default key path is under DOTZ_DIR/secrets", () => {
		expect(signingKeyPath({ DOTZ_DIR: "/data/dotz" })).toBe("/data/dotz/secrets/release-signing-key");
	});
});

describe("the one unsigned transition release", () => {
	test("on a runner with no signed release yet: a lightweight tag; once one exists: refused", async () => {
		const { key, line } = makeKey();
		const w = world(line);
		const absent = join(tmp(), "absent");
		expect(await w.publish({ ci: true, signingKey: absent })).toBe(0);
		expect(git(w.origin, "cat-file", "-t", "refs/tags/v261105.1").trim()).toBe("commit");
		expect(await hasSignedRelease(w.checkout)).toBe(false);

		expect(await w.publish({ signingKey: key, now: evening })).toBe(0);
		expect(git(w.origin, "cat-file", "-t", "refs/tags/v261105.2").trim()).toBe("tag");
		expect(await hasSignedRelease(w.checkout)).toBe(true);

		const tags = tagsOn(w.origin);
		const head = git(w.checkout, "rev-parse", "HEAD").trim();
		expect(await w.publish({ ci: true, signingKey: absent, force: true })).toBe(1);
		expect(tagsOn(w.origin)).toEqual(tags);
		expect(git(w.checkout, "rev-parse", "HEAD").trim()).toBe(head);
	}, 30_000);
});

describe("push credentials", () => {
	test("none for a local origin or on a runner", async () => {
		const w = world(makeKey().line);
		expect(await pushAuthArgs(w.checkout, false)).toEqual([]);
		expect(await pushAuthArgs(w.checkout, true)).toEqual([]);
	});

	test("gh's login backs an https://github.com origin outside CI", async () => {
		const w = world(makeKey().line);
		git(w.checkout, "remote", "set-url", "origin", "https://github.com/example/example.git");
		const args = await pushAuthArgs(w.checkout, false);
		expect(args.length).toBe(Bun.which("gh") ? 4 : 0);
		expect(await pushAuthArgs(w.checkout, true)).toEqual([]);
	});
});

describe("the history-rewrite marker", () => {
	const shas = ["a".repeat(40), "b".repeat(40)];
	const keys = `${shas.map(commitKey).join("\n")}\n`;
	const repoWithSigners = (line: string) => {
		const repo = tmp();
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "release-signers"), `${line}\n`);
		return repo;
	};

	test("--mark makes a signed annotated tag on the keys blob, and cat-file peels it", async () => {
		const { key, line } = makeKey();
		const repo = repoWithSigners(line);
		expect((await markRewrite(repo, "1", shas, key)).code).toBe(0);
		expect(git(repo, "cat-file", "-t", "refs/tags/history-rewrite-1").trim()).toBe("tag");
		expect(git(repo, "cat-file", "-t", "history-rewrite-1^{}").trim()).toBe("blob");
		expect(git(repo, "cat-file", "blob", "history-rewrite-1")).toBe(keys);
		expect(spawnSync("git", ["-c", `gpg.ssh.allowedSignersFile=${join(repo, "release-signers")}`, "verify-tag", "history-rewrite-1"], { cwd: repo }).status).toBe(0);
	});

	test("the CLI signs with the key under DOTZ_DIR and exits 1 without it", () => {
		const { key, line } = makeKey();
		const repo = repoWithSigners(line);
		const data = tmp();
		const cli = join(import.meta.dir, "history-rewrite.ts");
		const mark = () => spawnSync(process.execPath, [cli, "--mark", "2"], { cwd: repo, input: shas.join("\n"), env: { ...process.env, DOTZ_DIR: data }, timeout: 60_000 });
		expect(mark().status).toBe(1);
		expect(spawnSync("git", ["tag", "--list", "history-rewrite-*"], { cwd: repo, encoding: "utf8" }).stdout.trim()).toBe("");
		mkdirSync(join(data, "secrets"));
		writeFileSync(join(data, "secrets", "release-signing-key"), readFileSync(key));
		spawnSync("chmod", ["600", join(data, "secrets", "release-signing-key")]);
		expect(mark().status).toBe(0);
		expect(git(repo, "cat-file", "blob", "history-rewrite-2")).toBe(keys);
	});
});
