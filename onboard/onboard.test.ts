// Onboarding on a fresh machine: the harness step defaults to OmO and never lets Codex (no adapter) be picked, the
// login parsers read readiness without credentials, the service file fits the platform, and a full `setup.ts --answers`
// run in a throwaway HOME writes the chosen runtime, links the omp plugin only for omp, and refuses an unknown runtime.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHarness, harness, harnessLine, HARNESSES, parseClaudeAuth, parseOmoAuth } from "./harness.ts";
import { launchdPlist, servicePATH, systemdUnit } from "./service.ts";

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

test("menu lines show install state, version and why codex cannot be picked", () => {
	const omo = { ...harness("omo")!, found: { installed: true, path: "/x/omo", version: "5.1.38" } };
	const codex = { ...harness("codex")!, found: { installed: true, path: "/x/codex", version: "0.1.0" } };
	const omp = { ...harness("omp")!, found: { installed: false, reason: "not found" } };
	expect(harnessLine(omo, true)).toBe("OmO (oh-my-openagent)  설치됨 5.1.38  [기본]");
	expect(harnessLine(omp, false)).toBe("omp (oh-my-pi)  설치 안 됨");
	expect(harnessLine(codex, false)).toContain("고를 수 없어요");
});

test("login parsers: an account pool counts as signed in, garbage is unchecked", () => {
	expect(parseOmoAuth('{"status":"not_ready","provider":"anthropic-subscription","reason":"provider_not_found","accounts":[]}')).toEqual({ checked: true, ready: false, accounts: 0 });
	expect(parseOmoAuth('warn: x\n{"status":"not_ready","accounts":[{"name":"a"},{"name":"b"}]}')).toEqual({ checked: true, ready: true, accounts: 2 });
	expect(parseOmoAuth('{"status":"ready","accounts":[]}').ready).toBe(true);
	expect(parseOmoAuth("Error: unknown command").checked).toBe(false);
	expect(parseClaudeAuth('{\n  "loggedIn": false,\n  "authMethod": "none"\n}')).toEqual({ checked: true, ready: false, accounts: 0 });
	expect(parseClaudeAuth('{"loggedIn": true}').ready).toBe(true);
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

// A throwaway machine: HOME, and a PATH with only bun, fake harness CLIs and inert launchctl/open/systemctl.
function machine(bins: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "dotz-onboard-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	// bun's own folder often holds real harness CLIs (bun add -g omo-ai), so only bun itself is linked in.
	symlinkSync(process.execPath, join(bin, "bun"));
	const inert = { launchctl: "exit 1", open: "exit 0", systemctl: "exit 0", "xdg-open": "exit 0" };
	for (const [name, body] of Object.entries({ ...inert, ...bins })) {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const run = async (answers: Record<string, unknown>) => {
		const file = join(root, "answers.json");
		writeFileSync(file, JSON.stringify(answers));
		const p = Bun.spawn([process.execPath, SETUP, "--answers", file], {
			env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: "C" },
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
		expect(r.out).toContain("하네스: OmO (oh-my-openagent) 5.1.38");
		expect(r.out).toContain("로그인된 계정 1개");
		expect(r.out).toContain("끝! 테스트봇는 OmO (oh-my-openagent)로 돌아가요.");
		expect(existsSync(join(m.home, ".omp"))).toBe(false);
		const service = readFileSync(join(m.home, ...(process.platform === "darwin" ? ["Library", "LaunchAgents", "dev.dotz.gateway.plist"] : [".config", "systemd", "user", "dotz-gateway.service"])), "utf8");
		expect(service).toContain(join(m.root, "bin"));
		expect(readFileSync(join(m.home, ".dotz", "identity", "IDENTITY.md"), "utf8")).toContain("**테스트봇**");
	} finally {
		m.cleanup();
	}
}, 60_000);

test("setup --answers with runtime omp links the omp plugin; a missing OmO is reported, not installed without install_harness", async () => {
	const m = machine({ omp: FAKE_OMP });
	try {
		const omp = await m.run({ identity, runtime: "omp" });
		expect(omp.code).toBe(0);
		expect(JSON.parse(readFileSync(join(m.home, ".dotz", "config.json"), "utf8")).lanes.runtime).toBe("omp");
		expect(lstatSync(join(m.home, ".omp", "agent", "extensions", "dotz")).isSymbolicLink()).toBe(true);
		const omo = await m.run({ identity, runtime: "omo" });
		expect(omo.code).toBe(0);
		expect(omo.out).toContain("OmO (oh-my-openagent) 가 아직 없어요: bun add -g --trust omo-ai");
		expect(JSON.parse(readFileSync(join(m.home, ".dotz", "config.json"), "utf8")).orchestrator.runtime).toBe("omo");
	} finally {
		m.cleanup();
	}
}, 60_000);

test("setup --answers refuses codex (no adapter) and writes nothing", async () => {
	const m = machine({ codex: 'echo "codex-cli 0.1.0"' });
	try {
		const r = await m.run({ identity, runtime: "codex" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("runtime: omo | omp | claude 중 하나");
		expect(existsSync(join(m.home, ".dotz", "config.json"))).toBe(false);
	} finally {
		m.cleanup();
	}
}, 30_000);
