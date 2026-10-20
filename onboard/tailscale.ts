// Tailscale is how the web app is reached from the owner's other devices (`tailscale serve` adds the login header the hub
// checks). On macOS the app ships its CLI inside the bundle and puts nothing on PATH unless the owner opts in, so a
// signed-in Mac without `tailscale` on PATH used to read as "no Tailscale". The bundle binary works as the CLI.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAC = process.platform === "darwin";
const APP_BINS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", join(homedir(), "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale")];

export type TailscaleState = { bin: string; running: boolean; login: string; host: string; error?: string };

export function tailscaleBin(): string {
	return Bun.which("tailscale", { PATH: process.env.PATH }) ?? (MAC ? (APP_BINS.find(existsSync) ?? "") : "");
}

// Pure: what `tailscale status --json` says about this machine.
export function parseStatus(json: string): Omit<TailscaleState, "bin"> {
	try {
		const d = JSON.parse(json);
		const login = String(d.User?.[String(d.Self?.UserID)]?.LoginName ?? "");
		return { running: d.BackendState === "Running", login, host: String(d.Self?.DNSName ?? "").replace(/\.$/, "") };
	} catch {
		return { running: false, login: "", host: "", error: json.trim().split("\n")[0]?.slice(0, 200) || "no output" };
	}
}

export async function tailscaleState(): Promise<TailscaleState> {
	const bin = tailscaleBin();
	if (!bin) return { bin, running: false, login: "", host: "" };
	const r = await Bun.$`${bin} status --json`.nothrow().quiet();
	return { bin, ...parseStatus(r.stdout.toString() || r.stderr.toString()) };
}

const run = async (cmd: string[]) => (await Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited) === 0;

// macOS: Homebrew cask (tailscale-app), else the download page. Linux: the official install script.
export async function installTailscale(): Promise<boolean> {
	if (!MAC) return run(["bash", "-c", "curl -fsSL https://tailscale.com/install.sh | sh"]);
	if (Bun.which("brew")) return run(["brew", "install", "--cask", "tailscale-app"]);
	await run(["open", "https://tailscale.com/download/mac"]);
	return false;
}

// Sign-in: the macOS app owns it (opening the app shows its login); on Linux `tailscale up` prints a login link.
export async function startTailscale(bin: string): Promise<void> {
	if (MAC) await run(["open", "-a", "Tailscale"]);
	else await run(["sudo", bin || "tailscale", "up"]);
}

export async function serveWeb(bin: string, httpsPort: number, localPort: number): Promise<{ ok: boolean; out: string }> {
	const r = await Bun.$`${bin} serve --bg --https=${httpsPort} http://127.0.0.1:${localPort}`.nothrow().quiet();
	return { ok: r.exitCode === 0, out: `${r.stdout.toString()}\n${r.stderr.toString()}`.trim() };
}
