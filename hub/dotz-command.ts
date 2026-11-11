// The `dotz` terminal command: opens this computer's gateway web app through 127.0.0.1, already logged in (hub/web-login-cli.ts mints the one-time link), whatever
// web.access is. `dotz --print` only prints the link. setup and every gateway start (so an update needs no step) call installDotzCommand. No import of config.ts: setup
// runs before there is a config. Windows is reached through WSL (docs/windows.md), which is Linux here.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sq } from "./runtime/claude-cli-shim.ts";

const MARK = "# dotz-launcher";
const RC_BEGIN = "# >>> dotz >>>";

export type DotzCommand = { dir: string; pkg: string; bun: string; home: string; /** Put it on the shell's PATH too; off for a data dir that is not this user's install (a test gateway). */ expose: boolean; shell?: string; platform?: string };

/** The hub token must reach this gateway and nothing else: the caller's working directory could hold a .env, its environment a DOTZ_PORT or a proxy. */
export function launcherText(o: Pick<DotzCommand, "dir" | "pkg" | "bun">): string {
	return `#!/bin/sh
${MARK}: rewritten on every gateway start (hub/dotz-command.ts)
DOTZ_DIR=${sq(o.dir)}
export DOTZ_DIR
unset DOTZ_PORT
NO_PROXY=127.0.0.1 no_proxy=127.0.0.1
export NO_PROXY no_proxy
bun=${sq(o.bun)}
[ -x "$bun" ] || bun=bun
if [ ! -f ${sq(join(o.pkg, "hub", "web-login-cli.ts"))} ] || [ ! -f "$DOTZ_DIR/secrets/hub-token" ]; then
	echo "게이트웨이가 실행 중이 아니에요" >&2
	exit 1
fi
cd ${sq(o.pkg)} || exit 1
case "$*" in
"") exec "$bun" hub/web-login-cli.ts --open ;;
--print) exec "$bun" hub/web-login-cli.ts ;;
last) exec "$bun" hub/dotz-last-cli.ts ;;
*)
	echo "사용법: dotz [--print|last]" >&2
	exit 2
	;;
esac
`;
}

function read(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function writeLauncher(file: string, text: string): void {
	if (read(file) === text) return;
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	chmodSync(tmp, 0o755);
	renameSync(tmp, file);
}

const linkPresent = (file: string): boolean => lstatSync(file, { throwIfNoEntry: false }) !== undefined;

/** A link beside bun or in ~/.local/bin works at once in open terminals too. Only under home: a directory outside it is shared with other users and installs. */
function linkFrom(o: DotzCommand, launcher: string): { state: "there" | "new" | "foreign" | "none"; dir?: string } {
	for (const dir of [dirname(o.bun), join(o.home, ".local", "bin")]) {
		if (!dir.startsWith(`${o.home}/`) || !existsSync(dir)) continue;
		const link = join(dir, "dotz");
		if (linkPresent(link) && !read(link)?.includes(MARK)) return { state: "foreign", dir };
		try {
			if (read(link) === read(launcher) && linkPresent(link)) return { state: "there", dir };
			rmSync(link, { force: true });
			symlinkSync(launcher, link);
			return { state: "new", dir };
		} catch {
			continue; // not writable: the next place, or the shell files below
		}
	}
	return { state: "none" };
}

/** Creating .bash_profile would stop bash from reading an existing .profile. */
const bashLogin = (home: string): string => (!existsSync(join(home, ".bash_profile")) && existsSync(join(home, ".profile")) ? ".profile" : ".bash_profile");

/** The shell files to reach: those that exist, and the login shell's own even if it has none yet. */
function shellFiles(o: DotzCommand): string[] {
	const own = (o.shell ?? "").endsWith("/bash") ? ((o.platform ?? process.platform) === "darwin" ? bashLogin(o.home) : ".bashrc") : (o.shell ?? "").endsWith("/zsh") || (o.platform ?? process.platform) === "darwin" ? ".zshrc" : ".bashrc";
	return [...new Set([own, ...[".zshrc", ".bashrc", ".bash_profile"].filter(f => existsSync(join(o.home, f)))])].map(f => join(o.home, f));
}

/** Does this shell file already put `dir` on PATH? Read, never run: a gateway must not execute the owner's shell start-up. */
function onPath(text: string, dir: string, home: string): boolean {
	const relative = dir.slice(home.length + 1);
	const live = text.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");
	return live.includes(relative) || (relative === ".bun/bin" && live.includes("BUN_INSTALL"));
}

/** Idempotent, and quick when there is nothing to do (it runs on every gateway start). Never throws: a gateway must start without its terminal command. Returns what to log. */
export function installDotzCommand(o: DotzCommand): string[] {
	try {
		const launcher = join(o.dir, "bin", "dotz");
		writeLauncher(launcher, launcherText(o));
		if (!o.expose) return [];
		const link = linkFrom(o, launcher);
		if (link.state === "there") return [];
		if (link.state === "foreign") return [`dotz: ${link.dir}/dotz is another program, left alone; this gateway's command is ${launcher}`];
		const bin = dirname(launcher);
		const lines = link.state === "new" ? [`dotz: command linked at ${link.dir}/dotz`] : [];
		for (const file of shellFiles(o)) {
			const text = read(file) ?? "";
			if (text.includes(RC_BEGIN) || (link.dir && onPath(text, link.dir, o.home))) continue;
			appendFileSync(file, `\n${RC_BEGIN}\ncase ":$PATH:" in *:${sq(bin)}:*) ;; *) PATH="$PATH":${sq(bin)}; export PATH ;; esac\n# <<< dotz <<<\n`);
			lines.push(`dotz: ${bin} added to PATH in ${file}`);
		}
		return lines;
	} catch (e) {
		return [`dotz: terminal command not installed: ${e}`];
	}
}
