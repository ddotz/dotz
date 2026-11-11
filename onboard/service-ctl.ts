// What `dotz status` and `dotz restart` (onboard/dotz-ctl.ts) say to the service manager: ask whether the gateway's service is loaded and has a process,
// start it, or (only with the owner at a terminal) force-restart it. The names and the service file path come from onboard/service.ts, the one place that
// installs them. Linux and WSL are the systemd user service; WSL needs systemd switched on (docs/windows.md). Pure builders and parsers plus one `Exec`
// the caller supplies, so every platform branch is tested without a service manager.
import { LABEL, servicePath, UNIT } from "./service.ts";

export type Exec = (argv: string[], env?: Record<string, string>) => Promise<{ code: number; out: string }>;
export type Manager = "launchd" | "systemd";
/** `uid` matters on macOS: over SSH the agent lives in the gui/<uid> domain, which only an explicit target reaches (a bare `launchctl list` or `start <label>` asks the SSH session's own domain). */
export type ServiceEnv = { platform: string; uid: number; home: string };
export type ServiceState = { manager: Manager; loaded: boolean; pid?: number; state?: string; lastExit?: string; error?: string };

export const managerOf = (platform: string): Manager => (platform === "darwin" ? "launchd" : "systemd");
const target = (e: ServiceEnv) => `gui/${e.uid}/${LABEL}`;

export function queryCall(e: ServiceEnv): string[] {
	return managerOf(e.platform) === "launchd"
		? ["launchctl", "print", target(e)]
		: ["systemctl", "--user", "show", UNIT, "--no-pager", "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "ExecMainStatus", "-p", "Result"];
}

/** Starts a service with no process. launchd: kickstart (no -k, so it never kills) when loaded, bootstrap of the installed plist when not. */
export function startCall(e: ServiceEnv, loaded: boolean): string[] {
	if (managerOf(e.platform) === "systemd") return ["systemctl", "--user", "start", UNIT];
	return loaded ? ["launchctl", "kickstart", target(e)] : ["launchctl", "bootstrap", `gui/${e.uid}`, servicePath({ home: e.home }, "darwin")];
}

/** Kills the running process and starts a new one: only the typed-confirmation path of `dotz restart --force` uses it. */
export function forceCall(e: ServiceEnv): string[] {
	return managerOf(e.platform) === "launchd" ? ["launchctl", "kickstart", "-k", target(e)] : ["systemctl", "--user", "restart", UNIT];
}

/** An SSH shell has no user bus address; systemctl --user finds it through these two (the user manager runs as long as the user is logged in or lingers). */
export function callEnv(e: ServiceEnv, env: Record<string, string | undefined>): Record<string, string> {
	if (managerOf(e.platform) === "launchd") return {};
	const runtime = env.XDG_RUNTIME_DIR || `/run/user/${e.uid}`;
	return { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus` };
}

const lastLine = (out: string) => out.trim().split("\n").pop()?.trim() ?? "";

export function parseState(manager: Manager, r: { code: number; out: string }): ServiceState {
	if (manager === "launchd") {
		if (r.code !== 0) return { manager, loaded: false, error: lastLine(r.out) || undefined };
		const pid = r.out.match(/^\s*pid = (\d+)/m)?.[1];
		return { manager, loaded: true, pid: pid ? Number(pid) : undefined, state: r.out.match(/^\s*state = (.+)$/m)?.[1]?.trim(), lastExit: r.out.match(/^\s*last exit (?:code|status) = (.+)$/m)?.[1]?.trim() };
	}
	if (r.code !== 0) return { manager, loaded: false, error: lastLine(r.out) || undefined };
	const f = Object.fromEntries(r.out.split("\n").map(l => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
	const pid = Number(f.MainPID);
	const exit = [f.ExecMainStatus, f.Result].filter(v => v && v !== "success" && v !== "0").join(" ");
	return { manager, loaded: f.LoadState === "loaded", pid: pid > 0 ? pid : undefined, state: [f.ActiveState, f.SubState].filter(Boolean).join("/"), lastExit: exit || undefined };
}

export async function serviceState(exec: Exec, e: ServiceEnv, env: Record<string, string | undefined>): Promise<ServiceState> {
	return parseState(managerOf(e.platform), await exec(queryCall(e), callEnv(e, env)));
}
