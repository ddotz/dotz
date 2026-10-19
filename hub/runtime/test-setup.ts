// bun test preload (bunfig.toml): an isolated DOTZ_DIR with a throwaway config, a binary path that cannot exist (so no
// test can ever start a real omo or omp), and the fake clock. Runs before any hub module reads config.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClock } from "./test-clock.ts";

// Tuning knobs and lane/hub markers of whatever shell runs the tests must not leak into the code under test.
for (const k of Object.keys(process.env)) if (k.startsWith("DOTZ_") && k !== "DOTZ_TEST_DIR") delete process.env[k];
if (!process.env.DOTZ_TEST_DIR) {
	const dir = mkdtempSync(join(tmpdir(), "dotz-test-"));
	process.env.DOTZ_TEST_DIR = dir;
	process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
const dir = process.env.DOTZ_TEST_DIR;
const data = join(dir, "data");
mkdirSync(data, { recursive: true });
process.env.DOTZ_DIR = data;
process.env.DOTZ_OMP = join(dir, "no-such-omp");
process.env.DOTZ_OMO = join(dir, "no-such-omo");
writeFileSync(
	join(data, "config.json"),
	JSON.stringify({
		identity: { name: "tester", language: "en" },
		discord: { token_file: join(dir, "missing-token"), owner_id: "1", guild: "1" },
		web: { port: 47999, tailscale_https_port: 0, allow_logins: [] },
		orchestrator: { model: "anthropic/test-orch", thinking: "low" },
		lanes: { model: "anthropic/test-lane", thinking: "medium", worker_model: "anthropic/test-worker:high", compact_at: 300000, keep_recent: 30000 },
	}),
);
installClock();
