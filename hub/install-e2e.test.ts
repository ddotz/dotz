// install.sh end to end on temp dirs (DOTZ_HOME, DOTZ_DIR and HOME all under one temp root; no service, no wizard, no network):
// a tarball install stamps itself and then self-updates to a newer local tarball; a --git install stays a git checkout and
// self-updates through git as before. The copy of this repo's files is the "release".
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installDotzCommand } from "./dotz-command.ts";
import { git } from "./selfupdate-fixture.ts";
import { newKey, signTag } from "./test-signing.ts";

const REPO = join(import.meta.dir, "..");
let root: string, release: string, env: Record<string, string>;

const run = (cmd: string[], extra: Record<string, string> = {}, cwd = root) => {
	const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	return { code: r.exitCode, out: `${r.stdout}${r.stderr}`, stdout: r.stdout.toString() };
};
// The release: this checkout's code (tracked or new, not ignored) without tests, web assets, docs and feature folders, copied once. The
// update flow only needs the files the installer checks for and the code the updater CLI imports.
const releaseFile = (f: string) => !f.endsWith(".test.ts") && (f.startsWith("hub/") || f.startsWith("onboard/") || f.startsWith("firstrun/") || ["setup.ts", "package.json", "VERSION"].includes(f));
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
// The root holds some twenty installs by now: removing it took 7 to 11 s on a busy machine, more than a hook may take. An `rm` that outlives
// this process removes it, so the removal is on no test's clock. A shell that exits at once starts it, and the hook waits for that shell
// (milliseconds): a --parallel worker kills the children it still has when it ends, detached or not, and an `rm` started directly left the
// whole root (1.1 GB) behind in a full run.
afterAll(async () => {
	await Bun.spawn(["/bin/sh", "-c", 'rm -rf "$1" &', "sh", root], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).exited;
});

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
// A fresh install without DOTZ_REF gets the newest release tag, not the commits main has gained since (local origin, no network).
const originWith = (name: string, tags: string[]) => {
	const origin = join(root, name);
	copyTree(origin);
	const git = (...a: string[]) => {
		const r = run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...a], {}, origin);
		expect(r.code).toBe(0);
		return r.out;
	};
	git("init", "-q", "-b", "main");
	git("add", "-A");
	tags.forEach((tag, i) => {
		writeFileSync(join(origin, "VERSION"), `${tag.slice(1)}\n`);
		writeFileSync(join(origin, `AT_${i}`), "x\n");
		git("add", "-A");
		git("commit", "-q", "-m", `release ${tag}`);
		git("tag", tag);
	});
	writeFileSync(join(origin, "UNRELEASED"), "x\n");
	git("add", "-A");
	git("commit", "-q", "-m", "work after the last tag");
	return origin;
};

test("without DOTZ_REF the install is the newest release tag (a hotfix counts, order does not), not main", () => {
	const origin = originWith("origin-tags", ["v261101.1", "v261101.2", "v261101.2.1", "v261101.1.1"]);
	const app = join(root, "app-tag");
	const i = installer({ DOTZ_HOME: app, DOTZ_GIT_URL: origin }, "--git");
	if (i.code !== 0) throw new Error(i.out);
	expect(readFileSync(join(app, "VERSION"), "utf8").trim()).toBe("261101.2.1");
	expect(existsSync(join(app, "UNRELEASED"))).toBe(false);
}, 60_000);

test("without DOTZ_REF and with no release tag the install falls back to main", () => {
	const origin = originWith("origin-no-tags", []);
	const app = join(root, "app-main");
	const i = installer({ DOTZ_HOME: app, DOTZ_GIT_URL: origin }, "--git");
	if (i.code !== 0) throw new Error(i.out);
	expect(existsSync(join(app, "UNRELEASED"))).toBe(true);
}, 60_000);

// The GitHub tarball path with curl and gh stubbed first on PATH (no network, no real gh): `tags` is what the tags API answers (a failing answer
// when null), and every URL curl was asked for lands in the log, so the test sees which ref the install resolved and downloaded.
const githubInstall = (name: string, tags: string[] | null, extra: Record<string, string> = {}) => {
	const bin = join(root, `${name}-bin`), log = join(root, `${name}.log`), tgz = join(root, `${name}.tar.gz`);
	mkdirSync(bin);
	tarball(tgz);
	const sha = "a".repeat(40);
	writeFileSync(join(bin, "tags.json"), JSON.stringify((tags ?? []).map(t => ({ name: t }))));
	writeFileSync(join(bin, "curl"), `#!/bin/sh\nout=; prev=; for a; do [ "$prev" = -o ] && out=$a; prev=$a; last=$a; done\nprintf '%s\\n' "$*" >> "${log}"\ncase $last in\n*/tags*) ${tags ? `cat "${bin}/tags.json"` : "exit 22"} ;;\n*/commits/*) printf '%s' ${sha} ;;\nhttps://codeload.github.com/*|*/tarball/*) cp "${tgz}" "$out" ;;\n*) exit 22 ;;\nesac\n`);
	writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(bin, "curl"), 0o755);
	chmodSync(join(bin, "gh"), 0o755);
	const app = join(root, `app-${name}`);
	const i = installer({ DOTZ_HOME: app, PATH: `${bin}:${process.env.PATH}`, ...extra });
	if (i.code !== 0) throw new Error(i.out);
	return { requests: readFileSync(log, "utf8"), stamp: readFileSync(join(app, ".dotz-install"), "utf8") };
};

test("a GitHub install without DOTZ_REF downloads the newest release tag, whatever order the tags API lists them in", () => {
	const s = githubInstall("gh-tag", ["v261101.1", "v261101.2.1", "v261101.2", "v261030.9", "not-a-release"]);
	expect(s.requests).toContain("/commits/v261101.2.1");
	expect(s.requests).not.toContain("/commits/main");
	expect(s.stamp).toContain("ref=v261101.2.1\n");
}, 60_000);

test("a GITHUB_TOKEN install asks for the tags with the token and downloads the tag", () => {
	const s = githubInstall("gh-token", ["v261101.1"], { GITHUB_TOKEN: "stub-token" });
	expect(s.requests).toMatch(/Authorization: Bearer stub-token .*\/tags/);
	expect(s.requests).toContain("/tarball/" + "a".repeat(40));
	expect(s.stamp).toContain("ref=v261101.1\n");
	expect(s.stamp).toContain("auth=token\n");
}, 60_000);

test("a GitHub install where no tag can be read falls back to main, and DOTZ_REF still wins over the tags", () => {
	expect(githubInstall("gh-none", null).requests).toContain("/commits/main");
	const pinned = githubInstall("gh-pinned", ["v261101.1"], { DOTZ_REF: "v261030.9" });
	expect(pinned.requests).toContain("/commits/v261030.9");
	expect(pinned.requests).not.toContain("/tags?");
}, 60_000);

// The release signature at install time (the key in install.sh is the real one, so only failures can be made here; the verified path is
// hub/selfupdate-signature.test.ts): warn goes on with a warning, DOTZ_VERIFY=enforce stops before anything is installed.
test("git install: an unsigned tag warns and installs, enforce stops; a tag signed by another key stops under enforce", () => {
	const origin = originWith("origin-sig", ["v261101.1"]);
	const warn = installer({ DOTZ_HOME: join(root, "app-sig-warn"), DOTZ_GIT_URL: origin }, "--git");
	if (warn.code !== 0) throw new Error(warn.out);
	expect(warn.out).toContain("warning: cannot verify the release signature");
	const hard = installer({ DOTZ_HOME: join(root, "app-sig-hard"), DOTZ_GIT_URL: origin, DOTZ_VERIFY: "enforce" }, "--git");
	expect(hard.code).not.toBe(0);
	expect(existsSync(join(root, "app-sig-hard", "hub"))).toBe(false);

	const keys = mkdtempSync(join(root, "sigkeys-"));
	git(origin, "tag", "-d", "v261101.1");
	signTag(origin, "v261101.1", newKey(keys, "other"));
	const other = installer({ DOTZ_HOME: join(root, "app-sig-other"), DOTZ_GIT_URL: origin, DOTZ_VERIFY: "enforce" }, "--git");
	expect(other.code).not.toBe(0);
	expect(other.out).toContain("not signed by an allowed key");
	expect(existsSync(join(root, "app-sig-other", "hub"))).toBe(false);
}, 60_000);

test("GitHub tarball install: a tag with no signed tag object stops under enforce", () => {
	expect(() => githubInstall("gh-sig-hard", ["v261101.1"], { DOTZ_VERIFY: "enforce" })).toThrow("DOTZ_VERIFY=enforce");
	expect(existsSync(join(root, "app-gh-sig-hard", "hub"))).toBe(false);
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
	// the macOS language list the installer reads: STUB_LANGS is its first entry (English unless a test says otherwise)
	writeFileSync(join(bin, "defaults"), `#!/bin/sh\n[ "\$*" = "read -g AppleLanguages" ] || exit 1\nprintf '(\\n    "%s",\\n    "en-US"\\n)\\n' "\${STUB_LANGS:-en-US}"\n`);
	chmodSync(join(bin, "defaults"), 0o755);
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = probe.port;
	void probe.stop(true);
	if (!webTgz) tarball((webTgz = join(root, "web-release.tar.gz")));
	const data = join(dir, "data");
	const calls = join(dir, "stub.log");
	const env = { HOME: join(dir, "home"), DOTZ_DIR: data, DOTZ_HOME: join(dir, "app"), DOTZ_TARBALL: `file://${webTgz}`, DOTZ_PORT: String(port), PATH: `${bin}:${process.env.PATH}`, STUB_LOG: calls, DOTZ_TAILSCALE_BIN: "", SSH_CONNECTION: "", DISPLAY: "", WAYLAND_DISPLAY: "", LANG: "C", LC_ALL: "", LC_MESSAGES: "" };
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

const HANGUL = /[\uAC00-\uD7AF]/;

test("on a Korean computer the closing guidance is Korean, with the address and commands unchanged; on an English one it is not", () => {
	const ko = scene().install({ STUB_LANGS: "ko-KR" }, "--no-open");
	if (ko.code !== 0) throw new Error(ko.out);
	expect(ko.out).toMatch(HANGUL);
	expect(ko.out).toMatch(ADDRESS);
	expect(ko.out).toContain("setup.ts");
	const en = scene().install({}, "--no-open");
	if (en.code !== 0) throw new Error(en.out);
	expect(en.out).not.toMatch(HANGUL);
	const noSetup = scene().install({ STUB_LANGS: "ko-KR" }, "--no-setup");
	expect(noSetup.out).toMatch(HANGUL);
}, 120_000);

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

// WSL on any host: uname says Linux, the distro variable marks WSL, no Linux display, and only the Windows side can open a browser.
const wslStubs = (s: ReturnType<typeof scene>, systemd: boolean) => {
	const bin = join(dirname(s.data), "bin");
	writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Linux\n");
	writeFileSync(join(bin, "powershell.exe"), '#!/bin/sh\necho "powershell.exe $*" >> "$STUB_LOG"\n');
	if (!systemd) writeFileSync(join(bin, "systemctl"), "#!/bin/sh\necho 'System has not been booted with systemd' >&2\nexit 1\n");
	for (const name of ["uname", "powershell.exe", "systemctl"]) chmodSync(join(bin, name), 0o755);
};
const WSL_ENV = { WSL_DISTRO_NAME: "Ubuntu", DISPLAY: "", WAYLAND_DISPLAY: "" };

test("under WSL with no Linux display the setup address goes to the Windows browser", () => {
	const s = scene();
	stubOpenPath(s, "works");
	wslStubs(s, true);
	const i = s.install(WSL_ENV);
	if (i.code !== 0) throw new Error(i.out);
	expect(s.stubCalls()).toMatch(/^powershell\.exe -NoProfile -Command Start-Process 'http:\/\/127\.0\.0\.1:\d+\/setup\?token=[A-Za-z0-9_-]+'$/m);
	expect(s.stubCalls()).not.toMatch(OPENERS);
	expect(i.out).toContain("opened the setup page in your browser");
	expect(i.out).not.toMatch(ADDRESS);
}, 60_000);

test("under WSL without systemd the install stops first and names the fix", () => {
	const s = scene();
	wslStubs(s, false);
	const i = s.install(WSL_ENV);
	expect(i.code).toBe(1);
	expect(i.out).toContain("systemd=true in /etc/wsl.conf");
	expect(existsSync(s.marker)).toBe(false);
	expect(i.out).not.toContain("installed");
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

// Like the install tests above they run install.sh as a child process: 60s, not the default 5s, so a busy machine running other work does not fail them.
// --uninstall takes the `dotz` command with it: the link the gateway made and the PATH block it appended to the shell files, and nothing else of the owner's.
test("--uninstall removes the dotz command link and the shell file block, keeps everything else of the owner's; a foreign dotz stays", () => {
	for (const purge of [true, false]) {
		const home = mkdtempSync(join(root, "uninstall-"));
		const data = join(home, ".dotz");
		const bunDir = join(home, ".bun", "bin");
		const rc = join(home, ".zshrc");
		const mine = '# mine\nexport EDITOR=vim\n\nalias ll="ls -l"\n';
		mkdirSync(bunDir, { recursive: true });
		writeFileSync(rc, mine);
		// a bun outside home: no link, the block goes into the shell file; then the same with a link beside bun
		installDotzCommand({ dir: data, pkg: "/nowhere", bun: "/opt/none/bun", home, expose: true, shell: "/bin/zsh", platform: "darwin" });
		expect(readFileSync(rc, "utf8")).toContain("# >>> dotz >>>");
		installDotzCommand({ dir: data, pkg: "/nowhere", bun: join(bunDir, "bun"), home, expose: true, shell: "/bin/zsh", platform: "darwin" });
		expect(lstatSync(join(bunDir, "dotz")).isSymbolicLink()).toBe(true);
		const other = join(home, ".local", "bin");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "dotz"), "#!/bin/sh\necho not ours\n");
		const r = run(["sh", join(REPO, "install.sh"), "--uninstall", ...(purge ? ["--purge"] : [])], { HOME: home, DOTZ_HOME: join(home, "app"), DOTZ_DIR: data });
		expect(r.code).toBe(0);
		expect(lstatSync(join(bunDir, "dotz"), { throwIfNoEntry: false })).toBeUndefined();
		expect(readFileSync(rc, "utf8")).toBe(mine);
		expect(readFileSync(join(other, "dotz"), "utf8")).toContain("not ours");
		expect(existsSync(data)).toBe(!purge);
	}
}, 60_000);

test("--uninstall leaves a dotz link that points somewhere else, and a shell file with no dotz block", () => {
	const home = mkdtempSync(join(root, "uninstall-"));
	const bunDir = join(home, ".bun", "bin");
	mkdirSync(bunDir, { recursive: true });
	writeFileSync(join(home, "elsewhere"), "x\n");
	symlinkSync(join(home, "elsewhere"), join(bunDir, "dotz"));
	writeFileSync(join(home, ".zshrc"), "# only mine\n");
	const r = run(["sh", join(REPO, "install.sh"), "--uninstall"], { HOME: home, DOTZ_HOME: join(home, "app"), DOTZ_DIR: join(home, ".dotz") });
	expect(r.code).toBe(0);
	expect(lstatSync(join(bunDir, "dotz")).isSymbolicLink()).toBe(true);
	expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# only mine\n");
}, 60_000);
