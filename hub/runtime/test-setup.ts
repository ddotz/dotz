// bun test preload (bunfig.toml): an isolated DOTZ_DIR with a throwaway config, a binary path that cannot exist (so no
// test can ever start a real omo or omp), and the fake clock. Runs before any hub module reads config.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setMachineProbe } from "../limits.ts";
import { installClock } from "./test-clock.ts";

// Tuning knobs and lane/hub markers of whatever shell runs the tests must not leak into the code under test.
for (const k of Object.keys(process.env)) if (k.startsWith("DOTZ_") && k !== "DOTZ_TEST_DIR") delete process.env[k];
// A stripped environment (env -i) has no TMPDIR, so tmpdir() falls back to /tmp, which the code treats as a scratch
// folder; on macOS use the per-user temp dir a login shell would have.
if (!process.env.TMPDIR && process.platform === "darwin") process.env.TMPDIR = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
// dotz_auth values are encrypted with a throwaway key here, never the machine's Keychain one (hub/secretbox.ts).
process.env.DOTZ_TEST_SECRET_KEY = require("node:crypto").randomBytes(32).toString("hex");
process.env.DOTZ_WEB_LIVE = "1";   // tests read the working-tree web files; hub/web-committed.test.ts turns this off
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
// OmO's agent dir (auth.json pin, rpc hosts) is a throwaway one too, so the machine's real login state cannot change a test.
process.env.OMO_CODING_AGENT_DIR = join(dir, "omo-agent");
delete process.env.PI_AGENT_DIR;
// The user omo.json a lane's worker profile is written to (omo.ts writeWorkerProfile); not DOTZ_-prefixed, so spawns do not carry it.
process.env.OMO_USER_CONFIG = join(dir, "omo-home", "omo.json");
delete process.env.OMO_PROFILE;
mkdirSync(process.env.OMO_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
	join(data, "config.json"),
	JSON.stringify({
		identity: { name: "tester", language: "en", timezone: "Asia/Seoul" },
		discord: { token_file: join(dir, "missing-token"), owner_id: "1", guild: "1" },
		web: { port: 47999, tailscale_https_port: 0, allow_logins: [] },
		lanes: { compact_at: 300000, keep_recent: 30000 },
		models: { orchestrator: { model: "anthropic/test-orch", thinking: "low" }, lanes: { model: "anthropic/test-lane", thinking: "medium" }, workers: { model: "anthropic/test-worker", thinking: "high" } },
	}),
);
installClock();
setMachineProbe(() => ({ totalGb: 64, availableGb: 56, cpus: 16 }));
