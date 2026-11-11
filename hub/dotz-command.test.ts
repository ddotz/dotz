import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDotzCommand, launcherText } from "./dotz-command.ts";

let home: string;
let bunDir: string;
let dir: string;
const install = (over: Partial<Parameters<typeof installDotzCommand>[0]> = {}) => installDotzCommand({ dir, pkg: "/app/dotz", bun: join(bunDir, "bun"), home, expose: true, shell: "/bin/zsh", platform: "darwin", ...over });
const rc = (name: string) => readFileSync(join(home, name), "utf8");

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dotz-command-"));
	bunDir = join(home, ".bun", "bin");
	dir = join(home, ".dotz");
	mkdirSync(bunDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("installDotzCommand", () => {
	test("links beside bun and leaves a shell file that already has bun's directory alone; a second run changes nothing", () => {
		writeFileSync(join(home, ".zshrc"), 'export BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n');
		expect(install()).toEqual([`dotz: command linked at ${bunDir}/dotz`]);
		expect(readlinkSync(join(bunDir, "dotz"))).toBe(join(dir, "bin", "dotz"));
		expect(statSync(join(dir, "bin", "dotz")).mode & 0o111).toBe(0o111);
		expect(rc(".zshrc")).not.toContain("dotz");
		expect(install()).toEqual([]);
	});

	test("a bun outside home gets no link: the data dir's bin goes on PATH once, in the login shell's file and the others that exist", () => {
		writeFileSync(join(home, ".bashrc"), "# mine\n");
		const lines = install({ bun: "/opt/homebrew/bin/bun" });
		expect(lines).toHaveLength(2);
		for (const f of [".zshrc", ".bashrc"]) expect(rc(f)).toContain(`*:'${dir}/bin':*`);
		expect(rc(".bashrc").startsWith("# mine\n")).toBe(true);
		const before = rc(".zshrc");
		expect(install({ bun: "/opt/homebrew/bin/bun" })).toEqual([]);
		expect(rc(".zshrc")).toBe(before);
	});

	test("zsh and bash both find the command through the block, and it keeps a dotz earlier on PATH first", async () => {
		install({ bun: "/opt/homebrew/bin/bun" });
		writeFileSync(join(home, ".bashrc"), rc(".zshrc"));
		for (const [shell, file] of [["zsh", ".zshrc"], ["bash", ".bashrc"]] as const) {
			const out = await Bun.$`${shell} -c ${`PATH=/usr/bin:/bin; . ${join(home, file)}; . ${join(home, file)}; command -v dotz; printf %s "$PATH"`}`.text();
			expect(out).toBe(`${dir}/bin/dotz\n/usr/bin:/bin:${dir}/bin`);
		}
	});

	test("a commented-out PATH line does not count, and macOS bash keeps its .profile", () => {
		const lines = install({ shell: "/bin/bash" });
		expect(lines).toHaveLength(2);
		rmSync(join(home, ".bash_profile"));
		rmSync(join(bunDir, "dotz"));
		writeFileSync(join(home, ".zshrc"), "# export PATH=$HOME/.bun/bin:$PATH\n");
		writeFileSync(join(home, ".profile"), "# mine\n");
		expect(install({ shell: "/bin/bash" })).toHaveLength(3);
		expect(rc(".zshrc")).toContain("# >>> dotz >>>");
		expect(rc(".profile")).toContain("# >>> dotz >>>");
		expect(lstatSync(join(home, ".bash_profile"), { throwIfNoEntry: false })).toBeUndefined();
	});

	test("another dotz is not clobbered", () => {
		writeFileSync(join(bunDir, "dotz"), "#!/bin/sh\necho theirs\n");
		expect(install()[0]).toContain("left alone");
		expect(readFileSync(join(bunDir, "dotz"), "utf8")).toContain("theirs");
		rmSync(join(bunDir, "dotz"));
		symlinkSync("/nowhere", join(bunDir, "dotz"));
		expect(install()[0]).toContain("left alone");
		expect(lstatSync(join(bunDir, "dotz")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(bunDir, "dotz"))).toBe("/nowhere");
	});

	test("a data dir that is not the user's install writes only its own launcher", () => {
		expect(install({ expose: false })).toEqual([]);
		expect(lstatSync(join(dir, "bin", "dotz")).isFile()).toBe(true);
		expect(lstatSync(join(bunDir, "dotz"), { throwIfNoEntry: false })).toBeUndefined();
		expect(lstatSync(join(home, ".zshrc"), { throwIfNoEntry: false })).toBeUndefined();
	});

	test("a failure is a line to log, not an exception: the gateway starts without the command", () => {
		writeFileSync(join(home, "file"), "");
		expect(install({ dir: join(home, "file", "data") })[0]).toContain("not installed");
	});
});

describe("launcher", () => {
	const run = async (args: string[], data: string, pkg = "/app/dotz") => {
		const script = join(home, "launcher");
		writeFileSync(script, launcherText({ dir: data, pkg, bun: "/bin/echo" }), { mode: 0o755 });
		const p = Bun.spawn([script, ...args], { stdout: "pipe", stderr: "pipe", cwd: home });
		const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
		return { code: await p.exited, out: out.trim(), err: err.trim() };
	};
	const installed = () => {
		const pkg = join(home, "it's app");
		mkdirSync(join(pkg, "hub"), { recursive: true });
		writeFileSync(join(pkg, "hub", "web-login-cli.ts"), "");
		mkdirSync(join(dir, "secrets"), { recursive: true });
		writeFileSync(join(dir, "secrets", "hub-token"), "t");
		return pkg;
	};

	test("no argument opens, --print only prints, anything else is the usage line; a quote in the path survives", async () => {
		const pkg = installed();
		expect(await run([], dir, pkg)).toEqual({ code: 0, out: "hub/web-login-cli.ts --open", err: "" });
		expect(await run(["--print"], dir, pkg)).toEqual({ code: 0, out: "hub/web-login-cli.ts", err: "" });
		expect((await run(["--help"], dir, pkg)).code).toBe(2);
	});

	test("status and restart go to the onboard command with their arguments, with or without a token file; the usage names both", async () => {
		const pkg = installed();
		mkdirSync(join(pkg, "onboard"), { recursive: true });
		writeFileSync(join(pkg, "onboard", "dotz-ctl-cli.ts"), "");
		expect(await run(["status"], dir, pkg)).toEqual({ code: 0, out: "onboard/dotz-ctl-cli.ts status", err: "" });
		expect(await run(["restart", "--force"], dir, pkg)).toEqual({ code: 0, out: "onboard/dotz-ctl-cli.ts restart --force", err: "" });
		const usage = await run(["--help"], dir, pkg);
		expect(usage.code).toBe(2);
		expect(usage.err).toContain("status");
		expect(usage.err).toContain("restart");
	});

	test("an install without the onboard command is one line and exit 1, not a shell error", async () => {
		const r = await run(["status"], dir, join(home, "missing"));
		expect(r.code).toBe(1);
		expect(r.err.trim().split("\n")).toHaveLength(1);
	});

	test("the caller's directory, DOTZ_PORT and proxy settings cannot send the token elsewhere", async () => {
		const pkg = installed();
		const bun = join(home, "fake-bun");
		writeFileSync(bun, '#!/bin/sh\nprintf "%s|%s|%s|%s" "$PWD" "${DOTZ_PORT-unset}" "$DOTZ_DIR" "$NO_PROXY"\n', { mode: 0o755 });
		const script = join(home, "launcher");
		writeFileSync(script, launcherText({ dir, pkg, bun }), { mode: 0o755 });
		const p = Bun.spawn([script], { stdout: "pipe", cwd: home, env: { ...process.env, DOTZ_PORT: "9", DOTZ_DIR: "/elsewhere", NO_PROXY: "" } });
		expect(await new Response(p.stdout).text()).toBe(`${pkg}|unset|${dir}|127.0.0.1`);
	});

	test("a missing install is one Korean line, no stack trace", async () => {
		expect(await run([], dir)).toEqual({ code: 1, out: "", err: "게이트웨이가 실행 중이 아니에요" });
	});
});
