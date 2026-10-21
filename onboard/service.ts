// The gateway's service definition: a launchd agent on macOS (dev.dotz.gateway), a systemd user unit on Linux
// (dotz-gateway.service). Both run `bun hub/main.ts` with DOTZ_DIR and a PATH that reaches the harness CLIs.
import { join } from "node:path";

export const LABEL = "dev.dotz.gateway";
export const UNIT = "dotz-gateway.service";

type ServiceSpec = { home: string; bun: string; pkg: string; dir: string; pathDirs: string[] };

export const servicePath = (s: Pick<ServiceSpec, "home">, platform = process.platform) =>
	platform === "darwin" ? join(s.home, "Library", "LaunchAgents", `${LABEL}.plist`) : join(s.home, ".config", "systemd", "user", UNIT);

export function servicePATH(s: ServiceSpec): string {
	const dirs = [...s.pathDirs, join(s.home, ".bun", "bin"), join(s.home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
	return [...new Set(dirs.filter(Boolean))].join(":");
}

const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(s: ServiceSpec): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(s.bun)}</string><string>${xml(join(s.pkg, "hub", "main.ts"))}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${xml(s.home)}</string>
    <key>PATH</key><string>${xml(servicePATH(s))}</string>
    <key>DOTZ_DIR</key><string>${xml(s.dir)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(s.dir, "gateway.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(s.dir, "gateway.err.log"))}</string>
</dict></plist>
`;
}

// systemd splits Environment= values on spaces unless quoted.
const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function systemdUnit(s: ServiceSpec): string {
	return `[Unit]
Description=dotz gateway
After=network-online.target

[Service]
ExecStart=${q(s.bun)} ${q(join(s.pkg, "hub", "main.ts"))}
Environment=${q(`HOME=${s.home}`)}
Environment=${q(`PATH=${servicePATH(s)}`)}
Environment=${q(`DOTZ_DIR=${s.dir}`)}
Restart=always
RestartSec=10
StandardOutput=append:${join(s.dir, "gateway.out.log")}
StandardError=append:${join(s.dir, "gateway.err.log")}

[Install]
WantedBy=default.target
`;
}

export const serviceFile = (s: ServiceSpec, platform = process.platform) => (platform === "darwin" ? launchdPlist(s) : systemdUnit(s));
