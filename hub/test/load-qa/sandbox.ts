// macOS sandbox for the load-qa gateway: `sandbox-exec -f <profile> bun hub/main.ts` with a temp data dir, a fake HOME,
// the fake CLIs (hub/test/load-qa/shims) first on PATH, no outbound network except loopback, and no access to the owner's
// real state. profile() renders the SBPL text, launch() lays out a run directory and returns the argv/env/cwd to spawn.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SHIM_DIR = join(import.meta.dir, "shims");
export const REPO = join(import.meta.dir, "..", "..", "..");
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// Real tools that bypass PATH (absolute-path exec sites of hub/ features/ onboard/ plus the system tools that reach the
// owner's machine): none of them may start inside the sandbox.
export const DENIED_EXEC = [
	"/usr/bin/brctl", "/usr/bin/ssh", "/usr/bin/scp", "/usr/bin/sftp", "/usr/bin/osascript", "/bin/launchctl", "/usr/bin/security", "/usr/bin/open",
	"/usr/bin/pbcopy", "/usr/bin/pbpaste", "/usr/bin/say", "/usr/bin/curl", "/usr/sbin/screencapture", "/usr/sbin/networksetup", "/usr/bin/sudo",
	"/usr/bin/tccutil", "/usr/bin/defaults", "/usr/bin/tmutil", "/usr/bin/caffeinate", "/usr/bin/afplay",
	"/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/brew", "/opt/homebrew/bin/kmsg", "/opt/homebrew/bin/gh", "/opt/homebrew/bin/cloudflared",
];

// The owner's real state, relative to the real home: never written, never read.
export const PROTECTED = [".dotz", ".omo/agent", ".omp", ".claude", ".ssh", ".config", "Library/Mobile Documents", "Library/Keychains", "Library/Application Support", "Library/Preferences", "Library/Group Containers", "Library/Messages"];

export type ProfileOpts = {
	/** The real home directory of the owner (not the fake HOME of the run). */
	home: string;
	/** The run directory: the only place the gateway may write (data dir, fake home, logs, shim records). */
	runDir: string;
	/** Allow writes only under runDir, the user temp folders and /dev; false = every write outside the protected paths is allowed. */
	strictWrites?: boolean;
	extraWrite?: string[];
	extraDenyExec?: string[];
};

// The owner's real account, from the uid: os.userInfo()/homedir() in Bun follow $HOME and $USER, which a fake-HOME shell has changed.
export const realUser = (): string => Bun.spawnSync(["/usr/bin/id", "-un"]).stdout.toString().trim();
export const realHome = (): string => `/Users/${realUser()}`;

const q = (p: string): string => JSON.stringify(p);
const real = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

export function profile(o: ProfileOpts): string {
	const run = real(o.runDir);
	const protectedPaths = PROTECTED.map(p => join(o.home, p));
	const lines = [
		"(version 1)",
		"(allow default)",
		";; network: loopback only (DNS needs the resolver socket, which is outside loopback, so names do not resolve either)",
		"(deny network-outbound)",
		'(allow network-outbound (remote ip "localhost:*"))',
		`(allow network-outbound (remote unix-socket (subpath ${q(run)})))`,
		";; writes",
		...(o.strictWrites === false ? [] : ["(deny file-write*)", `(allow file-write* (subpath ${q(run)}) (subpath "/private/var/folders") (subpath "/dev") ${[...(o.extraWrite ?? [])].map(p => `(subpath ${q(real(p))})`).join(" ")})`]),
		`(deny file-write* ${protectedPaths.map(p => `(subpath ${q(p)})`).join(" ")})`,
		";; the owner's real state is not even readable",
		`(deny file-read* ${protectedPaths.map(p => `(subpath ${q(p)})`).join(" ")})`,
		";; tools that bypass PATH",
		`(deny process-exec ${[...DENIED_EXEC, ...(o.extraDenyExec ?? [])].map(p => `(literal ${q(p)})`).join(" ")})`,
	];
	return `${lines.join("\n")}\n`;
}

/** argv that runs `cmd` inside the profile file. */
export const sandboxArgv = (profileFile: string, cmd: string[]): string[] => [SANDBOX_EXEC, "-f", profileFile, ...cmd];

export type LaunchOpts = {
	/** Run directory, normally /tmp/load-qa/<name>: holds data/, home/, tmp/, profile.sb, gateway.log and the shim records. */
	runDir: string;
	port: number;
	/** JSON file the fake zele serves mail from (LOAD_QA_ZELE_MAIL); default <runDir>/zele-mail.json. */
	zeleMail?: string;
	modelLatencyMs?: number;
	/** Extra environment of the gateway process (after the defaults). */
	env?: Record<string, string>;
	strictWrites?: boolean;
	/** The repo checkout to run; default the one this file lives in. */
	repo?: string;
};

export type Launch = { argv: string[]; env: Record<string, string>; cwd: string; runDir: string; dataDir: string; home: string; profileFile: string; logFile: string; url: string };

/** Lays out the run directory and returns what to spawn: `Bun.spawn(l.argv, { cwd: l.cwd, env: l.env, stdout: Bun.file(l.logFile), stderr: Bun.file(l.logFile) })`. The caller (not the sandbox) writes config.json with writeInstall(l.dataDir, ...). */
export function launch(o: LaunchOpts): Launch {
	const runDir = real(o.runDir);
	if (!/^\/private\/tmp\/load-qa\//.test(runDir) && !/^\/tmp\/load-qa\//.test(o.runDir)) throw new Error(`refused: the load-qa run directory must be under /tmp/load-qa, got ${o.runDir}`);
	const dataDir = join(runDir, "data");
	const home = join(runDir, "home");
	const tmp = join(runDir, "tmp");
	for (const d of [dataDir, home, tmp]) mkdirSync(d, { recursive: true });
	const profileFile = join(runDir, "profile.sb");
	writeFileSync(profileFile, profile({ home: realHome(), runDir, strictWrites: o.strictWrites }));
	const bunDir = dirname(process.execPath);
	const env: Record<string, string> = {
		HOME: home,
		USER: realUser(),
		LANG: process.env.LANG ?? "en_US.UTF-8",
		SHELL: "/bin/zsh",
		PATH: [SHIM_DIR, bunDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
		TMPDIR: `${tmp}/`,
		DOTZ_DIR: dataDir,
		OMO_CODING_AGENT_DIR: join(home, ".omo", "agent"),
		DOTZ_OMO: join(SHIM_DIR, "omo"),
		DOTZ_OMP: join(SHIM_DIR, "omp"),
		DOTZ_TAILSCALE_BIN: "",
		DOTZ_NO_REAL_UI: "1",
		DOTZ_TEST_DIR: dataDir,
		SECRETBOX_TEST_KEY: createHash("sha256").update("load-qa").digest("hex"),
		LOAD_QA_RUN: runDir,
		LOAD_QA_ZELE_MAIL: o.zeleMail ?? join(runDir, "zele-mail.json"),
		LOAD_QA_MODEL_LATENCY_MS: String(o.modelLatencyMs ?? 0),
		...o.env,
	};
	const repo = o.repo ?? REPO;
	return {
		argv: sandboxArgv(profileFile, [process.execPath, join(repo, "hub", "main.ts")]),
		env,
		cwd: repo,
		runDir,
		dataDir,
		home,
		profileFile,
		logFile: join(runDir, "gateway.log"),
		url: `http://127.0.0.1:${o.port}/`,
	};
}
