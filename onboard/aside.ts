// Aside is the bot's browser (Discord bot provisioning, logins it keeps alive, web tasks), so onboarding checks the app,
// the CLI and the CLI sign-in first and installs what is missing with the official installers:
// app = Homebrew cask "aside" (or aside.com/download), CLI = releases.aside.com/install.sh -> ~/.local/bin/aside.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const LOCAL_BIN = join(HOME, ".local", "bin");
// The CLI installer puts `aside` in ~/.local/bin, which a default macOS login PATH does not include.
if (!(process.env.PATH ?? "").split(":").includes(LOCAL_BIN)) process.env.PATH = `${LOCAL_BIN}:${process.env.PATH ?? ""}`;

type AsideState = { app: boolean; cli: string; signedIn: boolean; account: string };

export async function asideState(): Promise<AsideState> {
	const app = ["/Applications/Aside.app", join(HOME, "Applications", "Aside.app")].some(existsSync);
	const cli = Bun.which("aside", { PATH: process.env.PATH }) ?? "";
	let signedIn = false;
	let account = "";
	if (cli) {
		const r = await Bun.$`${cli} account status`.nothrow().quiet();
		const line = r.stdout.toString().split("\n").find(l => /signed in|signed out/.test(l)) ?? "";
		signedIn = r.exitCode === 0 && /\bsigned in\b/.test(line);
		account = line.replace(/^\*?\s*\S+\s+/, "").split(/\s{2,}/)[0] ?? "";
	}
	return { app, cli, signedIn, account };
}

const run = async (cmd: string[]) => (await Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited) === 0;

export async function installApp(): Promise<boolean> {
	if (Bun.which("brew")) return run(["brew", "install", "--cask", "aside"]);
	await run(["open", "https://aside.com/download"]);
	return false;
}

export const installCli = () => run(["bash", "-c", "curl -fsSL https://releases.aside.com/install.sh | bash"]);
export const loginCli = (cli: string) => run([cli, "login"]);
export const openApp = () => run(["open", "-a", "Aside"]);
