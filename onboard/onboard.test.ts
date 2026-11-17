// Onboarding on a fresh machine: the harness step defaults to OmO and never lets Codex (no adapter) be picked, the
// the service file fits the platform, and a full `setup.ts --answers`
// run in a throwaway HOME writes the chosen runtime, links the omp plugin only for omp, and refuses an unknown runtime.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priorOf, selectorFor, validateAnswers } from "../firstrun/answers.ts";
import { writeConfig } from "../firstrun/apply.ts";
import { defaultHarness, harness, harnessLine, HARNESSES } from "./harness.ts";
import { launchdPlist, servicePATH, systemdUnit } from "./service.ts";
import { parseStatus } from "./tailscale.ts";

const SETUP = join(import.meta.dir, "..", "setup.ts");

test("OmO is the default; a prior runtime dotz can run is kept; codex never becomes the default", () => {
	expect(defaultHarness(undefined)).toBe("omo");
	expect(defaultHarness("omp")).toBe("omp");
	expect(defaultHarness("claude")).toBe("claude");
	expect(defaultHarness("codex")).toBe("omo");
	expect(defaultHarness("nonsense")).toBe("omo");
	expect(HARNESSES.map(h => h.id)).toEqual(["omo", "omp", "claude", "codex"]);
	expect(harness("codex")?.adapter).toBe(false);
	expect(harness("omo")?.install).toEqual(["bun", "add", "-g", "--trust", "omo-ai"]);
});

test("menu lines carry label and version when installed, flag the default, and mark a harness without adapter", () => {
	const omo = { ...harness("omo")!, found: { installed: true, path: "/x/omo", version: "5.1.38" } };
	const codex = { ...harness("codex")!, found: { installed: true, path: "/x/codex", version: "0.1.0" } };
	const omp = { ...harness("omp")!, found: { installed: false, reason: "not found" } };
	const line = harnessLine(omo, false);
	expect([line.includes(omo.label), line.includes("5.1.38")]).toEqual([true, true]);
	expect(harnessLine(omo, true).startsWith(line)).toBe(true);
	expect(harnessLine(omo, true)).not.toBe(line);
	expect(harnessLine(omp, false).includes(omp.label)).toBe(true);
	expect(harnessLine(omp, false)).not.toBe(harnessLine({ ...omp, found: { installed: true, path: "/x/omp" } }, false));
	expect(harnessLine(codex, false)).not.toBe(harnessLine({ ...codex, adapter: true }, false));
});

test("tailscale status: a signed-in node gives its login and host, a stopped one is not running, garbage keeps its first line", () => {
	const json = (state: string) => JSON.stringify({ BackendState: state, Self: { UserID: 7, DNSName: "mac.tail1.ts.net." }, User: { "7": { LoginName: "me@github" } } });
	expect(parseStatus(json("Running"))).toEqual({ running: true, login: "me@github", host: "mac.tail1.ts.net" });
	expect(parseStatus(json("NeedsLogin")).running).toBe(false);
	expect(parseStatus("failed to connect to local Tailscale service\nmore")).toEqual({ running: false, login: "", host: "", error: "failed to connect to local Tailscale service" });
});

test("service files: launchd plist and systemd unit carry DOTZ_DIR and a PATH with the harness dirs first", () => {
	const s = { home: "/home/u", bun: "/home/u/.bun/bin/bun", pkg: "/opt/dotz", dir: "/home/u/.dotz", pathDirs: ["/home/u/.bun/bin", "/opt/omo/bin"] };
	expect(servicePATH(s).split(":").slice(0, 3)).toEqual(["/home/u/.bun/bin", "/opt/omo/bin", "/home/u/.local/bin"]);
	const plist = launchdPlist(s);
	expect(plist).toContain("<string>/opt/dotz/hub/main.ts</string>");
	expect(plist).toContain("<key>DOTZ_DIR</key><string>/home/u/.dotz</string>");
	const unit = systemdUnit(s);
	expect(unit).toContain('ExecStart="/home/u/.bun/bin/bun" "/opt/dotz/hub/main.ts"');
	expect(unit).toContain('Environment="DOTZ_DIR=/home/u/.dotz"');
	expect(unit).toContain("WantedBy=default.target");
});

test("under WSL the service PATH ends with the Windows shells; off WSL it stays as it was", () => {
	const s = { home: "/home/u", bun: "/home/u/.bun/bin/bun", pkg: "/opt/dotz", dir: "/home/u/.dotz", pathDirs: [] };
	const sys32 = "/mnt/c/Windows/System32";
	const ps = `${sys32}/WindowsPowerShell/v1.0`;
	const windowsDirs = [ps, sys32];
	expect(servicePATH({ ...s, windowsDirs }).split(":").slice(-3)).toEqual(["/bin", ps, sys32]);
	expect(servicePATH(s).split(":").at(-1)).toBe("/bin");
});

// A throwaway machine: HOME, and a PATH with only bun, fake harness CLIs and inert launchctl/open/systemctl.
// launchctl answers `bootstrap` the way the permission probe's job would (an empty result next to the plist, so every
// permission reads "unknown"); a failing bootstrap would make setup retry for 5 s.
function machine(bins: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "dotz-onboard-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	// bun's own folder often holds real harness CLIs (bun add -g omo-ai), so only bun itself is linked in.
	symlinkSync(process.execPath, join(bin, "bun"));
	const inert = { launchctl: `case "$1" in bootstrap) echo '{}' > "$(dirname "$3")/result.json"; exit 0;; esac; exit 1`, open: "exit 0", systemctl: "exit 0", "xdg-open": "exit 0" };
	for (const [name, body] of Object.entries({ ...inert, ...bins })) {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const run = async (answers: Record<string, unknown>) => {
		const file = join(root, "answers.json");
		writeFileSync(file, JSON.stringify(answers));
		const p = Bun.spawn([process.execPath, SETUP, "--answers", file], {
			env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: "C", DOTZ_NO_REAL_UI: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { out: out + err, code };
	};
	return { root, home, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const FAKE_OMO = `case "$1" in --version) echo "omo 5.1.38 (engine: senpi test)";; auth) echo '{"status":"not_ready","accounts":[{"name":"default"}]}';; esac`;
const FAKE_OMP = `case "$1" in --version) echo "omp/18.12.3";; esac`;
const identity = { name: "테스트봇" };

test("setup --answers on a fresh HOME with OmO installed writes runtime omo, no omp plugin, a service PATH with omo", async () => {
	const m = machine({ omo: FAKE_OMO });
	try {
		const r = await m.run({ identity, allow_logins: [] });
		expect(r.code).toBe(0);
		const cfg = JSON.parse(readFileSync(join(m.home, ".dotz", "config.json"), "utf8"));
		expect(cfg.orchestrator.runtime).toBe("omo");
		expect(cfg.lanes.runtime).toBe("omo");
		expect(cfg.discord.guild).toBe("");
		expect(existsSync(join(m.home, ".omp"))).toBe(false);
		const service = readFileSync(join(m.home, ...(process.platform === "darwin" ? ["Library", "LaunchAgents", "dev.dotz.gateway.plist"] : [".config", "systemd", "user", "dotz-gateway.service"])), "utf8");
		expect(service).toContain(join(m.root, "bin"));
		expect(readFileSync(join(m.home, ".dotz", "identity", "IDENTITY.md"), "utf8")).toContain(identity.name);
	} finally {
		m.cleanup();
	}
}, 60_000);

test("without a Tailscale login setup gives the local address; a rerun keeps the saved way in", async () => {
	const m = machine({ omo: FAKE_OMO });
	try {
		const first = await m.run({ identity, allow_logins: [] });
		expect(first.out).toContain("웹 앱 주소: http://127.0.0.1:7420/");
		const file = join(m.home, ".dotz", "config.json");
		const cfg = JSON.parse(readFileSync(file, "utf8"));
		const cloudflare = { hostname: "app.example.com", team: "t", aud: "a" };
		writeFileSync(file, JSON.stringify({ ...cfg, web: { ...cfg.web, access: "cloudflare", cloudflare } }));
		const again = await m.run({ identity, allow_logins: [] });
		expect(again.out).not.toContain("http://127.0.0.1:7420/");
		expect(JSON.parse(readFileSync(file, "utf8")).web).toMatchObject({ access: "cloudflare", cloudflare });
	} finally {
		m.cleanup();
	}
}, 60_000);

test("setup makes a 0600 peer key once, keeps it on a rerun, and takes the other computer's key from the answers", async () => {
	const m = machine({ omo: FAKE_OMO });
	try {
		const key = join(m.home, ".dotz", "secrets", "peer-token");
		expect((await m.run({ identity, allow_logins: [] })).code).toBe(0);
		const made = readFileSync(key, "utf8").trim();
		expect(made).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(key).mode & 0o777).toBe(0o600);
		const again = await m.run({ identity, allow_logins: [] });
		expect(readFileSync(key, "utf8").trim()).toBe(made);
		expect(again.out).not.toContain(made);
		const shared = "s".repeat(40);
		const r = await m.run({ identity, allow_logins: [], peer_token: shared });
		expect(readFileSync(key, "utf8").trim()).toBe(shared);
		expect(r.out).not.toContain(shared);
		expect(readFileSync(join(m.home, ".dotz", "config.json"), "utf8")).not.toContain(shared);
	} finally {
		m.cleanup();
	}
}, 60_000);

test("setup --answers with runtime omp links the omp plugin and is no longer blocked by OmO being absent", async () => {
	const m = machine({ omp: FAKE_OMP });
	try {
		const omp = await m.run({ identity, runtime: "omp" });
		expect(omp.code).toBe(0);
		expect(JSON.parse(readFileSync(join(m.home, ".dotz", "config.json"), "utf8")).lanes.runtime).toBe("omp");
		expect(lstatSync(join(m.home, ".omp", "agent", "extensions", "dotz")).isSymbolicLink()).toBe(true);
	} finally {
		m.cleanup();
	}
}, 60_000);

test("setup --answers naming a harness that is not installed stops with exit 1 and the install hint before writing anything", async () => {
	const m = machine({ omp: FAKE_OMP });
	try {
		const omo = await m.run({ identity, runtime: "omo" });
		expect(omo.code).toBe(1);
		expect(omo.out).toContain(harness("omo")!.installHint);
		expect(existsSync(join(m.home, ".dotz", "config.json"))).toBe(false);
		expect(existsSync(join(m.home, ".dotz", "secrets"))).toBe(false);
		const claude = await m.run({ identity, runtime: "claude" });
		expect(claude.code).toBe(1);
		expect(claude.out).toContain(harness("claude")!.installHint);
		expect(existsSync(join(m.home, ".dotz", "config.json"))).toBe(false);
	} finally {
		m.cleanup();
	}
}, 60_000);

test("a rerun of setup keeps every setting setup does not ask for", async () => {
	const m = machine({ omo: FAKE_OMO });
	try {
		expect((await m.run({ identity, allow_logins: [] })).code).toBe(0);
		const file = join(m.home, ".dotz", "config.json");
		const cfg = JSON.parse(readFileSync(file, "utf8"));
		const extra = {
			runtime: "omo",
			guard: { allow_api_key: false, no_api_key_accounts: ["a@example.com"] },
			self_update: { auto: true },
			omp_update: { at: "04:00" },
			notify: { quiet: true },
			sessions: { max: 3 },
			orchestrator: { ...cfg.orchestrator, rotate_tokens: 123, keep_recent: 7 },
			lanes: { ...cfg.lanes, max_active: 2, compact_at: 90, keep_recent: 5, nightly_at: "03:00" },
			discord: { ...cfg.discord, app_id: "1234567890123456789", extra_setting: "x" },
		};
		writeFileSync(file, JSON.stringify({ ...cfg, ...extra }));
		const again = await m.run({ identity: { name: "새이름" }, allow_logins: [] });
		expect(again.code).toBe(0);
		const kept = JSON.parse(readFileSync(file, "utf8"));
		expect(kept).toMatchObject(extra);
		expect(kept.identity.name).toBe("새이름");
	} finally {
		m.cleanup();
	}
}, 60_000);

test("writeConfig merges into the config on disk at write time, not into the copy read at the start of the run", () => {
	const dir = mkdtempSync(join(tmpdir(), "onboard-merge-"));
	try {
		const env = { dir, home: dir, pkg: dir, say: () => {} };
		writeFileSync(join(dir, "config.json"), JSON.stringify({ guard: { allow_api_key: false } }));
		const prior = priorOf(dir);
		writeFileSync(join(dir, "config.json"), JSON.stringify({ guard: { allow_api_key: false }, self_update: { auto: true }, lanes: { compact_at: 80 } }));
		const checked = validateAnswers({ identity: { name: "Dotty", character: "c", tone: "t" }, runtime: "omo" }, prior, dir);
		if (!checked.ok) throw new Error(checked.errors.join(", "));
		const written = writeConfig(env, checked.answers, prior);
		expect(written).toMatchObject({ guard: { allow_api_key: false }, self_update: { auto: true }, lanes: { runtime: "omo", compact_at: 80 } });
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toMatchObject({ self_update: { auto: true } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a real folder at the omp plugin link is left alone and setup still finishes", async () => {
	const m = machine({ omp: FAKE_OMP });
	try {
		const own = join(m.home, ".omp", "agent", "extensions", "dotz");
		mkdirSync(own, { recursive: true });
		writeFileSync(join(own, "index.ts"), "export {};\n");
		const r = await m.run({ identity, runtime: "omp" });
		expect(r.code).toBe(0);
		expect(r.out).toContain("left alone");
		expect(lstatSync(own).isDirectory()).toBe(true);
		expect(readFileSync(join(own, "index.ts"), "utf8")).toBe("export {};\n");
	} finally {
		m.cleanup();
	}
}, 60_000);

const OMP_MODELS = (models: string, level: string, signedModel = "openai/gpt-6-astra") =>
	`case "$1" in --version) echo "omp/18.12.3";; models) echo '{"models":${models}}';; --mode) read line; echo '{"id":"s","type":"response","data":{"model":{"provider":"${signedModel.split("/")[0]}","id":"${signedModel.split("/")[1]}"},"thinkingLevel":"${level}"}}'; read line;; esac`;
const CHAT = (id: string, thinking: string) => `{"provider":"${id.split("/")[0]}","kind":"chat","id":"${id.split("/")[1]}","thinking":${thinking}}`;

test("omp signed in to a provider other than Anthropic: the default model is omp's own, with the level clamped to what the model lists", async () => {
	const m = machine({ omp: OMP_MODELS(`[${CHAT("openai/gpt-6-astra", '["low","medium","high"]')}]`, "xhigh") });
	try {
		const r = await m.run({ identity, runtime: "omp" });
		expect(r.code).toBe(0);
		const cfg = JSON.parse(readFileSync(join(m.home, ".dotz", "config.json"), "utf8"));
		expect(cfg.models.orchestrator).toEqual({ model: "openai/gpt-6-astra", thinking: "high" });
		expect(cfg.models.lanes).toEqual({ model: "openai/gpt-6-astra", thinking: "high" });
		expect(r.out).toContain("openai/gpt-6-astra:high");
	} finally {
		m.cleanup();
	}
}, 60_000);

test("omp that lists the Anthropic default keeps it; a model the answers name always wins", async () => {
	const m = machine({ omp: OMP_MODELS(`[${CHAT("anthropic/claude-opus-5-5", '["low","medium","high"]')},${CHAT("openai/gpt-6-astra", "null")}]`, "high", "openai/gpt-6-astra") });
	try {
		expect((await m.run({ identity, runtime: "omp" })).code).toBe(0);
		const file = join(m.home, ".dotz", "config.json");
		expect(JSON.parse(readFileSync(file, "utf8")).models.orchestrator).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "medium" });
		expect((await m.run({ identity, runtime: "omp", orchestrator_model: "openai/gpt-6-astra:low" })).code).toBe(0);
		expect(JSON.parse(readFileSync(file, "utf8")).models.orchestrator).toEqual({ model: "openai/gpt-6-astra", thinking: "low" });
	} finally {
		m.cleanup();
	}
}, 60_000);

test("selectorFor: the earlier model while the runtime offers it, else the runtime's default, else the earlier model", () => {
	const dir = mkdtempSync(join(tmpdir(), "onboard-selector-"));
	try {
		writeFileSync(join(dir, "config.json"), JSON.stringify({ models: { orchestrator: { model: "openai/gpt-6-astra", thinking: "high" } } }));
		const prior = priorOf(dir);
		const models = { available: new Set(["openai/gpt-6-astra"]), fallback: "openai/gpt-6.1-sol:medium" };
		expect(selectorFor(prior, "orchestrator", models)).toBe("openai/gpt-6-astra:high");
		expect(selectorFor(prior, "lanes", models)).toBe("openai/gpt-6.1-sol:medium");
		expect(selectorFor(prior, "lanes", { available: models.available })).toBe("anthropic/claude-opus-5-5:medium");
		expect(selectorFor(prior, "lanes")).toBe("anthropic/claude-opus-5-5:medium");
		const checked = validateAnswers({ identity: { name: "Dotty", character: "c", tone: "t" }, runtime: "omp", lane_model: "x/y:low" }, prior, dir, models);
		expect(checked.ok && [checked.answers.orchestrator_model, checked.answers.lane_model]).toEqual(["openai/gpt-6-astra:high", "x/y:low"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("setup --answers refuses codex (no adapter) and writes nothing", async () => {
	const m = machine({ codex: 'echo "codex-cli 0.1.0"' });
	try {
		const r = await m.run({ identity, runtime: "codex" });
		expect(r.code).toBe(1);
		expect(existsSync(join(m.home, ".dotz", "config.json"))).toBe(false);
	} finally {
		m.cleanup();
	}
}, 30_000);

test("validateAnswers fills the defaults; writeConfig writes web.access only when it is passed and a rerun keeps it", () => {
	const dir = mkdtempSync(join(tmpdir(), "onboard-config-"));
	try {
		const env = { dir, home: dir, pkg: dir, say: () => {} };
		const prior = priorOf(dir);
		const checked = validateAnswers({ identity: { name: "Dotty", character: "c", tone: "t" }, runtime: "omo", web_port: 7777, allow_logins: ["me@example.com"] }, prior, dir);
		if (!checked.ok) throw new Error(checked.errors.join(", "));
		expect(checked.answers).toMatchObject({ runtime: "omo", web_port: 7777, tailscale_https_port: 8443, guild: "", allow_logins: ["me@example.com"] });
		const terminal = writeConfig(env, checked.answers, prior);
		expect(terminal).toMatchObject({ identity: { name: "Dotty" }, orchestrator: { runtime: "omo" }, lanes: { runtime: "omo" }, web: { port: 7777, allow_logins: ["me@example.com"] } });
		expect(terminal.web).not.toHaveProperty("access");
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).web).not.toHaveProperty("access");
		expect(writeConfig(env, checked.answers, priorOf(dir), "local").web.access).toBe("local");
		expect(writeConfig(env, checked.answers, priorOf(dir)).web.access).toBe("local");
		expect(validateAnswers({ identity: { name: "x", character: "", tone: "" } }, prior, dir)).toMatchObject({ ok: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
