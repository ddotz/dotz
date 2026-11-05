// Fake CLIs that only record: tools that must never run for real during a load run, and the few the gateway probes by name.
import { begin } from "./_lib.ts";

const NETWORK_GIT = new Set(["fetch", "pull", "push", "clone", "ls-remote", "remote", "submodule"]);

/** The tool exists on PATH but refuses: the call is recorded and exits 127. */
export function deny(tool: string, argv: string[]): never {
	begin(tool, argv, { denied: true });
	console.error(`${tool}: disabled by the load-qa shim`);
	process.exit(127);
}

export function aside(argv: string[]): never {
	begin("aside", argv);
	console.error("aside: no browser in the load-qa sandbox");
	process.exit(1);
}

export function tailscale(argv: string[]): never {
	begin("tailscale", argv);
	console.error("tailscale: not running (load-qa shim)");
	process.exit(argv[0] === "status" ? 1 : 0);
}

export function kakaocli(argv: string[]): never {
	begin("kakaocli", argv);
	console.error("kakaocli: not available in the load-qa sandbox");
	process.exit(1);
}

export function cloudflared(argv: string[]): never {
	begin("cloudflared", argv);
	console.error("cloudflared: tunnels are off in the load-qa sandbox");
	process.exit(1);
}

/** Local git runs for real; anything that talks to a remote is refused. */
export async function git(argv: string[]): Promise<never> {
	const sub = argv.find((a, i) => !a.startsWith("-") && !["-C", "-c"].includes(argv[i - 1] ?? "")) ?? "";
	begin("git", argv, NETWORK_GIT.has(sub) ? { denied: true } : {});
	if (NETWORK_GIT.has(sub)) {
		console.error(`git ${sub}: network git is disabled by the load-qa shim`);
		process.exit(128);
	}
	const proc = Bun.spawn(["/usr/bin/git", ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	process.exit(await proc.exited);
}
