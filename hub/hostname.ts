// This computer's own name for the machine-name default and the backup branch. os.hostname() follows the network: on a VPN (NordVPN on
// the MacBook, 2026-10-29) it became "10.nate.com", so the MacBook showed up as "10" on the Mac mini. macOS keeps its own name apart.
import { hostname } from "node:os";

let cached: string | undefined;
export function machineHost(): string {
	if (cached) return cached;
	if (process.platform === "darwin") {
		try {
			const r = Bun.spawnSync(["scutil", "--get", "LocalHostName"], { stdout: "pipe", stderr: "ignore" });
			const name = r.stdout.toString().trim();
			if (r.exitCode === 0 && name) return (cached = name);
		} catch {}
	}
	return (cached = hostname());
}
