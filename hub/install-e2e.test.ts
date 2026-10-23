// install.sh end to end on temp dirs (DOTZ_HOME, DOTZ_DIR and HOME all under one temp root; no service, no wizard, no network):
// a tarball install stamps itself and then self-updates to a newer local tarball; a --git install stays a git checkout and
// self-updates through git as before. The copy of this repo's files is the "release".
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..");
let root: string, env: Record<string, string>;

const run = (cmd: string[], extra: Record<string, string> = {}, cwd = root) => {
	const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	return { code: r.exitCode, out: `${r.stdout}${r.stderr}`, stdout: r.stdout.toString() };
};
// The files of this checkout (tracked or new, not ignored, not node_modules) copied to dir.
function copyTree(dir: string) {
	const list = run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {}, REPO).out.split("\0").filter(Boolean);
	for (const f of list) {
		const from = join(REPO, f);
		if (f.startsWith("node_modules") || !existsSync(from) || !statSync(from).isFile()) continue;
		mkdirSync(dirname(join(dir, f)), { recursive: true });
		copyFileSync(from, join(dir, f));
	}
}
const tarball = (out: string, marker?: string) => {
	const src = mkdtempSync(join(root, "tree-"));
	copyTree(join(src, "dotz"));
	if (marker) writeFileSync(join(src, "dotz", marker), "newer\n");
	expect(run(["tar", "-czf", out, "-C", src, "dotz"]).code).toBe(0);
};
const installer = (extra: Record<string, string>, ...args: string[]) => run(["sh", join(REPO, "install.sh"), "--no-service", "--no-setup", "--no-open", "--yes", ...args], extra);
const selfupdate = (app: string, ...args: string[]) => {
	const r = run(["bun", join(app, "hub", "selfupdate.ts"), ...args, "--dir", app]);
	return { ...r, json: JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) };
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-e2e-"));
	mkdirSync(join(root, "home"));
	env = { HOME: join(root, "home"), DOTZ_DIR: join(root, "data"), DOTZ_HARNESS: "none", GIT_TERMINAL_PROMPT: "0" };
	delete process.env.GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("tarball install writes the stamp, then self-updates to a newer local tarball and keeps the old dir for rollback", () => {
	const app = join(root, "app-tar");
	const tgz = join(root, "release.tar.gz");
	tarball(tgz);
	const i = installer({ DOTZ_HOME: app, DOTZ_TARBALL: `file://${tgz}` });
	if (i.code !== 0) throw new Error(i.out);
	expect(i.out).toContain("installed");
	writeFileSync(join(root, "data", "config.json"), "{}\n");
	const stamp = readFileSync(join(app, ".dotz-install"), "utf8");
	const digest = new Bun.CryptoHasher("sha256").update(readFileSync(tgz)).digest("hex");
	expect(stamp).toContain("kind=url\n");
	expect(stamp).toContain(`tarball=file://${tgz}\n`);
	expect(stamp).toContain(`sha=${digest}\n`);
	expect(existsSync(join(app, ".git"))).toBe(false);
	expect(statSync(join(root, "data")).mode & 0o777).toBe(0o700);

	const same = selfupdate(app, "--check");
	expect(same.json.version).toMatchObject({ kind: "tarball", origin: "url" });
	expect(same.json.ok).toBe(true);
	expect(same.json.incomingTotal).toBe(0);

	tarball(tgz, "E2E_NEWER");
	expect(selfupdate(app, "--check").json.incomingTotal).toBe(1);
	const up = selfupdate(app, "--apply", "--test-cmd", "test -f E2E_NEWER && test -f hub/main.ts");
	expect(up.json.status).toBe("updated");
	expect(existsSync(join(app, "E2E_NEWER"))).toBe(true);
	expect(existsSync(join(`${app}.prev`, "E2E_NEWER"))).toBe(false);
	expect(existsSync(join(`${app}.prev`, "hub", "main.ts"))).toBe(true);
	expect(existsSync(`${app}.update`)).toBe(false);
	expect(readFileSync(join(app, ".dotz-install"), "utf8")).toContain(`sha=${new Bun.CryptoHasher("sha256").update(readFileSync(tgz)).digest("hex")}\n`);
	expect(selfupdate(app, "--check").json.incomingTotal).toBe(0);

	tarball(tgz, "FAIL_MARK");
	const bad = selfupdate(app, "--apply", "--test-cmd", "test ! -f FAIL_MARK");
	expect(bad.json.status).toBe("failed");
	expect(bad.json.message).toContain("테스트 실패");
	expect(existsSync(join(app, "FAIL_MARK"))).toBe(false);
	expect(existsSync(join(app, "E2E_NEWER"))).toBe(true);
});

test("--git installs a clone that updates through git, without a stamp", () => {
	const origin = join(root, "origin");
	copyTree(origin);
	const git = (...a: string[]) => {
		const r = run(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], {}, origin);
		expect(r.code).toBe(0);
		return r.out;
	};
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "release 1");
	const app = join(root, "app-git");
	const i = installer({ DOTZ_HOME: app, DOTZ_GIT_URL: origin, DOTZ_REF: "main" }, "--git");
	if (i.code !== 0) throw new Error(i.out);
	expect(existsSync(join(app, ".git"))).toBe(true);
	expect(existsSync(join(app, ".dotz-install"))).toBe(false);

	const c = selfupdate(app, "--check");
	expect(c.json.version.kind).toBe("git");
	expect(c.json.ok).toBe(true);
	expect(c.json.dirty).toEqual([]);
	expect(c.json.incomingTotal).toBe(0);

	writeFileSync(join(origin, "RELEASE_2"), "2\n");
	git("add", "RELEASE_2");
	git("commit", "-q", "-m", "release 2");
	expect(selfupdate(app, "--check").json.incomingTotal).toBe(1);
	const up = selfupdate(app, "--apply", "--test-cmd", "test -f RELEASE_2");
	expect(up.json.status).toBe("updated");
	expect(existsSync(join(app, "RELEASE_2"))).toBe(true);
});
