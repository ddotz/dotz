// bun test preload (bunfig.toml): an isolated DOTZ_DIR with a throwaway config, a binary path that cannot exist (so no
// test can ever start a real omo or omp), and the fake clock. Runs before any hub module reads config.ts.
import { beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGitHooks } from "../git-hooks.ts";
import { setMachineProbe } from "../limits.ts";
import { liveDataDir } from "../live-guard.ts";
import { installClock } from "./test-clock.ts";
import { takeSuiteSlot } from "./test-slot.ts";

// A fresh worktree has no node_modules (or an older one after a dependency was added or bumped): the files that import the missing
// package then fail as if they were flaky. Stop the run at once with what to do instead. The pre-push hook's limits run in an exported
// tree with no node_modules and needs none (DOTZ_TEST_NO_DEPS).
if (!process.env.DOTZ_TEST_NO_DEPS) {
	const root = join(import.meta.dir, "..", "..");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	const stale = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name, want]) => {
		const at = join(root, "node_modules", name, "package.json");
		if (!existsSync(at)) return true;
		return /^\d+\.\d+\.\d+$/.test(want) && (JSON.parse(readFileSync(at, "utf8")) as { version?: string }).version !== want;
	}).map(([name, want]) => `${name}@${want}`);
	if (stale.length) {
		console.error(`dotz tests: node_modules does not match package.json (${stale.join(", ")}). Run \`bun install --frozen-lockfile\` in ${root} first.`);
		process.exit(1);
	}
}

installGitHooks(join(import.meta.dir, "..", "..")); // the push gate reaches a developer clone here (hub/git-hooks.ts)

// A whole-suite run waits here for the machine-wide heavy slot, before anything below starts (and before DOTZ_* is cleared).
await takeSuiteSlot(process.env);

// Tuning knobs and lane/hub markers of whatever shell runs the tests must not leak into the code under test.
for (const k of Object.keys(process.env)) if (k.startsWith("DOTZ_") && k !== "DOTZ_TEST_DIR") delete process.env[k];
// A stripped environment (env -i) has no TMPDIR, so tmpdir() falls back to /tmp, which the code treats as a scratch
// folder; on macOS use the per-user temp dir a login shell would have.
if (!process.env.TMPDIR && process.platform === "darwin") process.env.TMPDIR = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
// dotz_auth values are encrypted with a throwaway key here, never the machine's Keychain one (hub/secretbox.ts).
process.env.SECRETBOX_TEST_KEY = require("node:crypto").randomBytes(32).toString("hex");
process.env.DOTZ_WEB_LIVE = "1";   // tests read the working-tree web files; hub/web-committed.test.ts turns this off
if (!process.env.DOTZ_TEST_DIR) {
	const dir = mkdtempSync(join(tmpdir(), "dotz-test-"));
	process.env.DOTZ_TEST_DIR = dir;
	process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
const dir = process.env.DOTZ_TEST_DIR;
if (liveDataDir(dir)) throw new Error(`refused: DOTZ_TEST_DIR ${dir} is not a temp dir`);
// The owner's gateway answers here. No test talks to it, whatever URL a fixture builds.
const LIVE_HUB = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):7420(?:\/|$)/;
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	return LIVE_HUB.test(url) ? Promise.reject(new Error(`refused: a test called the live gateway at ${url}`)) : realFetch(input, init);
}, realFetch);
const data = join(dir, "data");
mkdirSync(data, { recursive: true });
// An empty models.dev cache, so an API-key entry's model lookup (hub/fallback.ts modelsDevDef) never reaches the network.
writeFileSync(join(data, "models-dev.json"), "{}");
process.env.DOTZ_DIR = data;
process.env.DOTZ_OMP = join(dir, "no-such-omp");
process.env.DOTZ_OMO = join(dir, "no-such-omo");
// OmO's agent dir (auth.json pin, rpc hosts) is a throwaway one too, so the machine's real login state cannot change a test.
process.env.OMO_CODING_AGENT_DIR = join(dir, "omo-agent");
delete process.env.PI_AGENT_DIR;
// The Codex CLI's login (hub/codex-usage.ts reads <CODEX_HOME>/auth.json): an empty dir, so no test reads the machine's token or reaches its account.
process.env.CODEX_HOME = join(dir, "codex-home");
// The user omo.json a lane's worker profile is written to (omo.ts writeWorkerProfile); not DOTZ_-prefixed, so spawns do not carry it.
process.env.OMO_USER_CONFIG = join(dir, "omo-home", "omo.json");
delete process.env.OMO_PROFILE;
mkdirSync(process.env.OMO_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
	join(data, "config.json"),
	JSON.stringify({
		identity: { name: "tester", language: "en", timezone: "Asia/Seoul" },
		discord: { token_file: join(dir, "missing-token"), owner_id: "1", guild: "1" },
		web: { port: 47999, tailscale_https_port: 0, allow_logins: [], access: "tailscale" },
		lanes: { compact_at: 300000, keep_recent: 30000 },
		// API-key entries are under test in many files; the default (keys off) has its own test in hub/apikey-policy.test.ts.
		guard: { allow_api_key: true },
		models: { orchestrator: { model: "anthropic/test-orch", thinking: "low" }, lanes: { model: "anthropic/test-lane", thinking: "medium" }, workers: { model: "anthropic/test-worker", thinking: "high" } },
	}),
);
installClock();
setMachineProbe(() => ({ totalGb: 64, availableGb: 56, cpus: 16 }));
// Imported late: diskguard.ts reads config.ts, which must see the DOTZ_DIR set above.
const { setDiskReader } = await import("../diskguard.ts");
setDiskReader(() => ({ freeBytes: 500 * 2 ** 30, totalBytes: 1000 * 2 ** 30 }));
// The page tests describe the Korean screen, but hub/routes.ts sets the web app's language from the config above (en) the moment any test
// file imports it, and that state is shared by every file of the run. Each test starts from Korean; a test about another language sets it itself.
const { setAppLang } = await import("../webapp.ts");
beforeEach(() => setAppLang("ko"));
