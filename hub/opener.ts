// How this machine opens a URL in the owner's browser. Under WSL the browser is on the Windows side, so xdg-open (often absent there)
// and a Linux display do not matter: wslview when it is installed, else PowerShell through WSL interop.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

type Which = (bin: string) => string | null;
const procVersion = () => {
	try {
		return readFileSync("/proc/version", "utf8");
	} catch {
		return "";
	}
};

export const isWsl = (platform: string = process.platform, distro = process.env.WSL_DISTRO_NAME, version = procVersion) => platform === "linux" && (Boolean(distro) || /microsoft/i.test(version()));

export function openerCommand(url: string, o: { platform?: string; wsl?: boolean; which?: Which } = {}): string[] {
	const platform = o.platform ?? process.platform;
	if (platform === "darwin") return ["open", url];
	if (!(o.wsl ?? isWsl(platform))) return ["xdg-open", url];
	if ((o.which ?? Bun.which)("wslview")) return ["wslview", url];
	return ["powershell.exe", "-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`];
}

/** Where the Windows shells live under WSL: the gateway's service PATH does not inherit the login shell's, so the agents would not find them. */
export const windowsToolDirs = (wsl = isWsl(), which: Which = Bun.which) => (wsl ? [...new Set(["powershell.exe", "cmd.exe"].flatMap(b => which(b) ?? []).map(p => dirname(p)))] : []);
