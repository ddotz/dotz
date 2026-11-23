import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_PORT, REPO, type Run, call, runDir, sh } from "./lib.ts";

const [runId, flag, treeArg] = process.argv.slice(2);
const tree = flag === "--tree" ? treeArg : "worktree";
if (!runId || (flag !== undefined && flag !== "--tree") || (tree !== "worktree" && tree !== "head")) {
	console.error("usage: bun .omp/skills/verify-dotz/scripts/launch.ts <run-id> [--tree worktree|head]");
	process.exit(2);
}
const dir = runDir(runId);
if (existsSync(join(dir, "run.json"))) {
	console.error(`run ${runId} already launched (${dir}/run.json); pick a new run id`);
	process.exit(2);
}
const data = join(dir, "data"), home = join(dir, "home"), bin = join(dir, "bin"), outbound = join(dir, "outbound");
for (const d of [join(data, "secrets"), join(data, "custom", "reply-drafts"), home, bin, outbound]) mkdirSync(d, { recursive: true });

let code = REPO;
if (tree === "head") {
	code = join(dir, "tree");
	mkdirSync(code);
	const archive = Bun.spawnSync(["sh", "-c", `git -C '${REPO}' archive HEAD | tar -x -C '${code}'`], { stderr: "pipe" });
	if (archive.exitCode !== 0) {
		console.error(`git archive HEAD failed: ${archive.stderr.toString()}`);
		process.exit(1);
	}
	symlinkSync(join(REPO, "node_modules"), join(code, "node_modules"));
}

const freePort = (): number => {
	for (;;) {
		const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
		const port = s.port;
		s.stop(true);
		if (port !== undefined && port !== OWNER_PORT) return port;
	}
};
const port = freePort();
const hubToken = randomBytes(24).toString("hex");
const loginCookie = randomBytes(24).toString("hex");

writeFileSync(join(data, "secrets", "hub-token"), hubToken, { mode: 0o600 });
writeFileSync(
	join(data, "config.json"),
	JSON.stringify(
		{
			identity: { name: "verify", language: "ko", timezone: "Asia/Seoul" },
			web: { port, tailscale_https_port: 0, allow_logins: [], peer_discovery: false, access: "local" },
			zele: { enabled: false },
			omp_update: { mode: "off" },
			self_update: { auto_check: false, auto_apply: false, keep_local: true },
		},
		null,
		1,
	),
);
writeFileSync(
	join(data, "web-local-sessions.json"),
	JSON.stringify({ sessions: [{ hash: createHash("sha256").update(loginCookie).digest("hex"), expires_at: Date.now() + 86_400_000, mode: "local" }] }),
	{ mode: 0o600 },
);
writeFileSync(join(data, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true, apps: { mail: { auto: false } } }));
writeFileSync(join(data, "models-dev.json"), "{}");

const record = (name: string): string => `printf '%s\\t%s\\n' "$(date -u +%FT%TZ)" "${name} $*" >> '${outbound}/calls.log'`;
const zele = [
	"#!/bin/sh",
	record("zele"),
	'case "$1 $2" in',
	'  "whoami "*) echo "verify@example.invalid"; exit 0;;',
	'  "mail read") echo "From: sender@example.invalid"; echo "verify stub thread"; exit 0;;',
	'  "mail reply"|"mail send") echo "stub: nothing sent"; exit 0;;',
	"esac",
	'echo "zele stub: refused $*" >&2',
	"exit 1",
	"",
].join("\n");
writeFileSync(join(bin, "zele"), zele);
chmodSync(join(bin, "zele"), 0o755);
for (const name of ["aside", "osascript", "open", "say", "afplay", "gh", "kmsg", "tailscale", "cloudflared", "omp", "claude", "terminal-notifier"]) {
	writeFileSync(join(bin, name), `#!/bin/sh\n${record(name)}\necho "verify-dotz stub: ${name} refused" >&2\nexit 1\n`);
	chmodSync(join(bin, name), 0o755);
}

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DOTZ_|OMO_|PI_)/.test(k)) env[k] = v;
Object.assign(env, {
	HOME: home,
	PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
	DOTZ_DIR: data,
	DOTZ_PORT: String(port),
	DOTZ_HARNESS: "none",
	DOTZ_NO_ORCHESTRATOR: "1",
	DOTZ_DRY_RUN: "1",
	DOTZ_WEB_LIVE: "1",
	DOTZ_TAILSCALE_BIN: "",
	DOTZ_CLOUDFLARED_BIN: join(bin, "cloudflared"),
	DOTZ_DISCORD_API: "http://127.0.0.1:9/discord-off",
	DOTZ_OMO: join(dir, "no-omo"),
	DOTZ_OMP: join(dir, "no-omp"),
	DOTZ_CLAUDE: join(bin, "claude"),
	OMO_CODING_AGENT_DIR: join(dir, "omo-agent"),
	OMO_USER_CONFIG: join(dir, "omo-home", "omo.json"),
});

const logFd = openSync(join(dir, "gateway.out"), "a");
const proc = Bun.spawn([process.execPath, "hub/main.ts"], { cwd: code, env, stdin: "ignore", stdout: logFd, stderr: logFd, detached: true });
proc.unref();
const run: Run = {
	runId,
	dir,
	data,
	home,
	port,
	url: `http://127.0.0.1:${port}`,
	pid: proc.pid,
	pgid: proc.pid,
	hubToken,
	loginCookie,
	commit: sh(["git", "rev-parse", "--short", "HEAD"]),
	tree,
	code,
	dirty: sh(["git", "status", "--porcelain", "--untracked-files=no"]).split("\n").filter(Boolean).length,
	startedAt: new Date().toISOString(),
};
writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 1)}\n`, { mode: 0o600 });

const notListening = (error: unknown): undefined => {
	if (error instanceof Error && "code" in error && (error.code === "ECONNREFUSED" || error.code === "ConnectionRefused")) return undefined;
	throw error;
};
const deadline = Date.now() + 60_000;
for (;;) {
	if (proc.exitCode !== null || proc.signalCode !== null) {
		console.error(`gateway exited before it was usable (exit ${proc.exitCode}); see ${dir}/gateway.out`);
		process.exit(1);
	}
	if (Date.now() > deadline) {
		console.error(`gateway not usable within 60 s; see ${dir}/gateway.out. Run cleanup.ts ${runId}`);
		process.exit(1);
	}
	const page = await call(run, "/", { as: "owner" }).catch(notListening);
	const html = page?.status === 200 ? await page.text() : "";
	const state = html.includes('id="app"') ? await call(run, "/api/state", { as: "owner" }).catch(notListening) : undefined;
	if (state?.status === 200) break;
	await Bun.sleep(250);
}
console.log(JSON.stringify({ runId, url: run.url, pid: run.pid, port, data, dir }));
