import { expect, test } from "bun:test";
import { isWsl, openerCommand, windowsToolDirs } from "./opener.ts";

test("WSL is told from the distro variable or the kernel, never on macOS", () => {
	expect(isWsl("linux", "Ubuntu", () => "")).toBe(true);
	expect(isWsl("linux", undefined, () => "Linux version 6.6.87.2-microsoft-standard-WSL2")).toBe(true);
	expect(isWsl("linux", undefined, () => "Linux version 6.8.0-generic")).toBe(false);
	expect(isWsl("darwin", "Ubuntu", () => "")).toBe(false);
});

test("the browser opener fits the machine: Windows side under WSL, with quotes in the URL kept inside the PowerShell string", () => {
	const url = "http://127.0.0.1:7420/local-login?code=a&b='c";
	const none = () => null;
	expect(openerCommand(url, { platform: "darwin" })).toEqual(["open", url]);
	expect(openerCommand(url, { platform: "linux", wsl: false })).toEqual(["xdg-open", url]);
	expect(openerCommand(url, { platform: "linux", wsl: true, which: b => (b === "wslview" ? "/usr/bin/wslview" : null) })).toEqual(["wslview", url]);
	expect(openerCommand(url, { platform: "linux", wsl: true, which: none })).toEqual(["powershell.exe", "-NoProfile", "-Command", "Start-Process 'http://127.0.0.1:7420/local-login?code=a&b=''c'"]);
});

test("the Windows shell dirs are found once under WSL and not looked for elsewhere", () => {
	const sys32 = "/mnt/c/Windows/System32";
	const ps = `${sys32}/WindowsPowerShell/v1.0`;
	const which = (b: string) => (b === "cmd.exe" ? `${sys32}/cmd.exe` : b === "powershell.exe" ? `${ps}/powershell.exe` : null);
	expect(windowsToolDirs(true, which)).toEqual([ps, sys32]);
	expect(windowsToolDirs(false, which)).toEqual([]);
});
