// install.sh end to end on temp dirs (DOTZ_HOME, DOTZ_DIR and HOME all under one temp root; no service, no wizard, no network):
// a tarball install stamps itself and then self-updates to a newer local tarball; a --git install stays a git checkout and
// self-updates through git as before. The copy of this repo's files is the "release".
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..");
let root: string, release: string, env: Record<string, string>;

const run = (cmd: string[], extra: Record<string, string> = {}, cwd = root) => {
	const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	return { code: r.exitCode, out: `${r.stdout}${r.stderr}`, stdout: r.stdout.toString() };
};
// The release: this checkout's code (tracked or new, not ignored) without tests, web assets, docs and feature folders, copied once. The
// update flow only needs the files the installer checks for and the code the updater CLI imports.
const releaseFile = (f: string) => !f.endsWith(".test.ts") && (f.startsWith("hub/") || f.startsWith("onboard/") || ["setup.ts", "package.json", "VERSION"].includes(f));
function copyTree(dir: string) {
	const listed = run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {}, REPO);
	// The self-update runs these tests in a tarball install's staging folder, which has no .git: there the folder itself is the release.
	const files = listed.code === 0 ? listed.stdout.split("\0") : readdirSync(REPO, { recursive: true, encoding: "utf8" }).filter(f => !f.startsWith("node_modules/"));
	for (const f of files.filter(releaseFile)) {
		const from = join(REPO, f);
		if (!existsSync(from) || !statSync(from).isFile()) continue;
		mkdirSync(dirname(join(dir, f)), { recursive: true });
		copyFileSync(from, join(dir, f));
	}
}
const tarball = (out: string, marker?: string) => {
	const markerFile = marker ? join(release, "dotz", marker) : undefined;
	if (markerFile) writeFileSync(markerFile, "newer\n");
	const r = run(["tar", "-czf", out, "-C", release, "dotz"]);
	if (markerFile) rmSync(markerFile);
	expect(r.code).toBe(0);
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
	release = join(root, "release-tree");
	copyTree(join(release, "dotz"));
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
}, 60_000);

test("--git installs a clone that updates through git, without a stamp", () => {
	const origin = join(root, "origin");
	copyTree(origin);
	// no background gc after the commit: it repacks the origin while the installer clones it
	const git = (...a: string[]) => {
		const r = run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...a], {}, origin);
		expect(r.code).toBe(0);
		return r.out;
	};
	git("init", "-q", "-b", "main");
	git("add", "-A");
	writeFileSync(join(origin, "VERSION"), "261101.1\n");
	git("add", "VERSION");
	git("commit", "-q", "-m", "release 1");
	git("tag", "v261101.1");
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
	writeFileSync(join(origin, "VERSION"), "261101.2\n");
	git("add", "RELEASE_2", "VERSION");
	git("commit", "-q", "-m", "release 2");
	git("tag", "v261101.2");
	expect(selfupdate(app, "--check").json.incomingTotal).toBe(1);
	const up = selfupdate(app, "--apply", "--test-cmd", "test -f RELEASE_2");
	expect(up.json.status).toBe("updated");
	expect(existsSync(join(app, "RELEASE_2"))).toBe(true);
}, 60_000);
// The web onboarding branch (docs/web-onboarding.md, "설치 스크립트 분기"). launchctl, systemctl, open and xdg-open are stubs first on PATH that only
// log their calls, so no real service, browser or the live label dev.dotz.gateway is ever touched. --no-open keeps the run from waiting for a gateway.
const ADDRESS = /http:\/\/127\.0\.0\.1:(\d+)\/setup\?token=([A-Za-z0-9_-]+)/;
const OPENERS = /^(open|xdg-open) /m;
let webTgz = "";
function scene() {
	const dir = mkdtempSync(join(root, "web-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	// launchctl print failing = "service not loaded", so setup.ts does not wait for an unload
	for (const name of ["launchctl", "systemctl", "open", "xdg-open"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\necho "\$(basename "\$0") \$*" >> "\$STUB_LOG"\n[ "\$1" = print ] && exit 1\nexit 0\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = probe.port;
	void probe.stop(true);
	if (!webTgz) tarball((webTgz = join(root, "web-release.tar.gz")));
	const data = join(dir, "data");
	const calls = join(dir, "stub.log");
	const env = { HOME: join(dir, "home"), DOTZ_DIR: data, DOTZ_HOME: join(dir, "app"), DOTZ_TARBALL: `file://${webTgz}`, DOTZ_PORT: String(port), PATH: `${bin}:${process.env.PATH}`, STUB_LOG: calls, DOTZ_TAILSCALE_BIN: "", SSH_CONNECTION: "", DISPLAY: "", WAYLAND_DISPLAY: "" };
	mkdirSync(env.HOME);
	// detached: no controlling terminal, so a terminal wizard can never read the developer's tty
	const install = (extra: Record<string, string>, ...args: string[]) => {
		const r = Bun.spawnSync(["sh", join(REPO, "install.sh"), "--yes", ...args], { cwd: root, env: { ...process.env, ...env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
		return { code: r.exitCode, out: `${r.stdout}${r.stderr}` };
	};
	const stubCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
	return { data, port, install, stubCalls, marker: join(data, "onboarding", "first-run.json") };
}

test("a fresh install with --no-open writes the seed config and marker, prints a one-use address and opens nothing", () => {
	const s = scene();
	const i = s.install({}, "--no-open");
	if (i.code !== 0) throw new Error(i.out);
	const [, port, token] = i.out.match(ADDRESS) ?? [];
	expect(Number(port)).toBe(s.port);
	expect(JSON.parse(readFileSync(join(s.data, "config.json"), "utf8"))).toEqual({ web: { port: s.port, access: "local" } });
	const marker = readFileSync(s.marker, "utf8");
	expect(JSON.parse(marker).status).toBe("pending");
	expect(marker).not.toContain(token!);
	expect(statSync(s.marker).mode & 0o777).toBe(0o600);
	expect(i.out).toContain("setup.ts");
	expect(s.stubCalls()).not.toMatch(OPENERS);
	expect(i.out).not.toContain("ssh -L");
}, 60_000);

test("over SSH the address comes with the ssh -L line and no browser is opened", () => {
	const s = scene();
	const i = s.install({ SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" });
	if (i.code !== 0) throw new Error(i.out);
	expect(i.out).toMatch(ADDRESS);
	expect(i.out).toContain(`ssh -L ${s.port}:127.0.0.1:${s.port} `);
	expect(s.stubCalls()).not.toMatch(OPENERS);
}, 60_000);

test("a re-run while the marker is pending restarts and prints a new address for the same seed config", () => {
	const s = scene();
	const first = s.install({}, "--no-open");
	if (first.code !== 0) throw new Error(first.out);
	const seed = readFileSync(join(s.data, "config.json"), "utf8");
	const again = s.install({}, "--no-open");
	if (again.code !== 0) throw new Error(again.out);
	const [a, b] = [first.out.match(ADDRESS)?.[2], again.out.match(ADDRESS)?.[2]];
	expect(b).toBeTruthy();
	expect(b).not.toBe(a);
	expect(readFileSync(join(s.data, "config.json"), "utf8")).toBe(seed);
	expect(JSON.parse(readFileSync(s.marker, "utf8")).status).toBe("pending");
}, 60_000);

test("a re-run on an existing config without a marker shows no onboarding", () => {
	const s = scene();
	mkdirSync(s.data);
	writeFileSync(join(s.data, "config.json"), "{}\n");
	const i = s.install({}, "--no-open");
	if (i.code !== 0) throw new Error(i.out);
	expect(i.out).not.toMatch(ADDRESS);
	expect(existsSync(join(s.data, "onboarding"))).toBe(false);
	expect(s.stubCalls()).not.toMatch(OPENERS);
}, 60_000);

test("--no-service and --setup keep the terminal path and create no marker", () => {
	for (const flag of ["--no-service", "--setup"]) {
		const s = scene();
		const i = s.install({}, flag);
		if (i.code !== 0) throw new Error(i.out);
		expect(i.out).toContain("no terminal for the wizard");
		expect(i.out).not.toMatch(ADDRESS);
		expect(existsSync(s.marker)).toBe(false);
		expect(existsSync(join(s.data, "config.json"))).toBe(false);
	}
}, 60_000);

// The open path waits for the gateway with curl on /api/peer-info: a curl stub first on PATH answers that one probe and runs the real curl for everything else (the tarball fetch).
const stubOpenPath = (s: ReturnType<typeof scene>, opener: "works" | "fails") => {
	const bin = join(dirname(s.data), "bin");
	writeFileSync(join(bin, "curl"), `#!/bin/sh\ncase "$*" in *"/api/peer-info"*) exit 0 ;; esac\nexec ${Bun.which("curl")} "$@"\n`);
	chmodSync(join(bin, "curl"), 0o755);
	for (const name of ["open", "xdg-open"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\necho "$(basename "$0") $*" >> "$STUB_LOG"\nexit ${opener === "works" ? 0 : 1}\n`);
		chmodSync(join(bin, name), 0o755);
	}
};

test("a fresh install on a desktop hands the setup address to the opener and does not print it", () => {
	const s = scene();
	stubOpenPath(s, "works");
	const i = s.install({ DISPLAY: ":0" });
	if (i.code !== 0) throw new Error(i.out);
	expect(s.stubCalls()).toMatch(OPENERS);
	expect(s.stubCalls()).toMatch(ADDRESS);
	expect(i.out).toContain("opened the setup page in your browser");
	expect(i.out).not.toMatch(ADDRESS);
}, 60_000);

test("when the opener exits 1 the address is printed instead", () => {
	const s = scene();
	stubOpenPath(s, "fails");
	const i = s.install({ DISPLAY: ":0" });
	if (i.code !== 0) throw new Error(i.out);
	expect(s.stubCalls()).toMatch(OPENERS);
	expect(i.out).toMatch(ADDRESS);
	expect(i.out).not.toContain("opened the setup page");
}, 60_000);
