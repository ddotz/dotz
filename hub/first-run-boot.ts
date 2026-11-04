import { DATA_DIR, HOST, log, paths, PORT, writeAtomic } from "./config.ts";
import { firstRunPending } from "./first-run.ts";

// While <data dir>/onboarding/first-run.json is pending (a seed install that has not finished its web onboarding), the gateway is only a web server:
// no orchestrator, Discord, watches or mail polling. hub/main.ts imports this module right after the single-instance lock; when the marker is
// pending it never settles, so the rest of main.ts (which starts all of those) does not run. The onboarding's last step exits the process once
// and the service manager (launchd, systemd) starts the real gateway.
if (firstRunPending(DATA_DIR)) {
	const { makeRoute } = await import("./routes.ts");
	const server = Bun.serve({
		hostname: HOST,
		port: PORT,
		idleTimeout: 0,
		async fetch(req, srv) {
			return route(req, srv);
		},
	});
	const exit = (): string => {
		server.stop();
		setTimeout(() => process.exit(0), 200);
		return "restarting";
	};
	const route = makeRoute({ busyNow: () => [], restartGateway: exit, restartGatewayNow: exit });
	writeAtomic(paths.pid, String(process.pid));
	log(`hub listening on 127.0.0.1:${server.port} in first-run mode (web onboarding; no orchestrator, Discord, watches or mail polling)`);
	for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void exit());
	await new Promise<never>(() => {});
}
