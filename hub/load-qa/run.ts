// One command for the load install: seed, boot the gateway under the sandbox, measure, write results, stop.
//   bun hub/load-qa/run.ts --scale small|large [--out DIR] [--serve] [--port N] [--latency MS]
//   bun hub/load-qa/run.ts --stop --out DIR
// The gateway runs from a copy of this working tree under <out>/repo (the sandbox cannot read ~/.dotz, where the real checkout of an
// install lives, and the copy keeps the run away from the real checkout), on a temp data dir, a fake HOME and the fake CLIs.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bench, type Ctx } from "./bench.ts";
import { ACCOUNTS } from "./names.ts";
import { loginLink, writeInstall } from "./install.ts";
import { launch, REPO, SHIM_DIR, sandboxArgv } from "./sandbox.ts";

const flag = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`);
	return i < 0 ? undefined : process.argv[i + 1];
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const fail = (msg: string): never => {
	console.error(`load-qa run: ${msg}`);
	process.exit(1);
};

const scale = flag("scale") ?? "small";
const out = resolve(flag("out") ?? `/tmp/load-qa/run-${scale}`);
if (!/^\/(private\/)?tmp\/load-qa\/[^/]+/.test(out)) fail(`--out must be a directory under /tmp/load-qa/, got ${out}`);

const alive = (pid: number): boolean => {
	try {
		return process.kill(pid, 0);
	} catch {
		return false;
	}
};
const pidFile = join(out, "gateway.pid");

/** SIGTERM the gateway of a run, SIGKILL after 15 s, then anything left that still runs from the run directory (fake CLIs). */
export async function stop(dir: string): Promise<string> {
	const file = join(dir, "gateway.pid");
	const notes: string[] = [];
	if (existsSync(file)) {
		const pid = Number(readFileSync(file, "utf8").trim());
		if (pid && alive(pid)) {
			process.kill(pid, "SIGTERM");
			for (let i = 0; i < 150 && alive(pid); i++) await Bun.sleep(100);
			if (alive(pid)) (process.kill(pid, "SIGKILL"), notes.push("SIGKILL"));
		}
		rmSync(file);
		notes.push(`stopped ${pid}`);
	}
	await Bun.$`pkill -f ${`${dir}/`}`.quiet().nothrow();
	const left = (await Bun.$`pgrep -f ${`${dir}/`}`.quiet().nothrow().text()).trim();
	if (left) notes.push(`left over: ${left.split("\n").join(" ")}`);
	return notes.join("; ") || "nothing to stop";
}

if (has("stop")) {
	console.log(await stop(out));
	process.exit(0);
}
if (scale !== "small" && scale !== "large") fail("--scale must be small or large");
if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, "utf8").trim()))) fail(`a gateway of ${out} still runs; stop it with: bun hub/load-qa/run.ts --stop --out ${out}`);

const freePort = (): number => {
	const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const p = s.port!;
	s.stop(true);
	return p;
};
const port = Number(flag("port") ?? freePort());
const latency = Number(flag("latency") ?? 0);

async function run(cmd: string[], logName: string, cwd = REPO): Promise<void> {
	const p = Bun.spawn(cmd, { cwd, stdout: Bun.file(join(out, logName)), stderr: Bun.file(join(out, logName)) });
	if ((await p.exited) !== 0) fail(`${cmd.slice(0, 3).join(" ")} failed, see ${join(out, logName)}`);
}

// 1. a clean run directory (the data dir is seeded by the real stores in a fresh process)
await stop(out);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const t0 = performance.now();
await run([process.execPath, join(REPO, "hub/load-qa/seed.ts"), "--dir", join(out, "data"), "--scale", scale], "seed.log");
const seedMs = Math.round(performance.now() - t0);
const seedLog = JSON.parse(readFileSync(join(out, "seed.log"), "utf8").trim().split("\n").at(-1)!) as { counts: Record<string, number>; read: Record<string, unknown>; store: Record<string, unknown> };

// The fake zele serves the mail every reply draft answers (read back from the seeded drafts file), so an approved send finds its mail.
const draftFile = JSON.parse(readFileSync(join(out, "data", "custom", "reply-drafts", "drafts.json"), "utf8")) as { drafts: { kind: string; compose?: boolean; mailId: string; account?: string; created: string; item?: { from?: string; to?: string[]; subject?: string; text?: string } }[] };
const zeleMails = draftFile.drafts
	.filter(d => d.kind === "mail" && !d.compose && d.account && d.item?.from)
	.map(d => ({ id: d.mailId, account: d.account, folder: "inbox", from: d.item!.from, to: (d.item!.to ?? []).join(", "), subject: d.item!.subject ?? "", body: d.item!.text ?? "", date: d.created }));
writeFileSync(join(out, "zele-mail.json"), `${JSON.stringify({ accounts: ACCOUNTS.map(a => a.address), mails: zeleMails, events: [] })}\n`);

// 2. the code under test: tracked plus modified plus new (not ignored) files of this working tree
const files = (await Bun.$`git -C ${REPO} ls-files -c -o --exclude-standard`.text()).split("\n").filter(f => f && existsSync(join(REPO, f)));
writeFileSync(join(out, "repo-files.txt"), `${files.join("\n")}\n`);
mkdirSync(join(out, "repo"), { recursive: true });
await run(["/bin/sh", "-c", `/usr/bin/tar -C ${REPO} -cf - -T ${join(out, "repo-files.txt")} | /usr/bin/tar -C ${join(out, "repo")} -xf -`], "copy.log");
const repo = join(out, "repo");

// 3. the sandboxed gateway
const l = launch({ runDir: out, port, repo, modelLatencyMs: latency });
writeInstall(l.dataDir, { port, accounts: ACCOUNTS.map(a => a.address), scale });
// the fake CLIs come from the copy too, so the run does not depend on where the checkout lives
const shims = join(repo, "hub", "load-qa", "shims");
for (const k of Object.keys(l.env)) l.env[k] = l.env[k]!.split(SHIM_DIR).join(shims);
const tSpawn = performance.now();
const gw = Bun.spawn(l.argv, { cwd: l.cwd, env: l.env, stdin: "ignore", detached: true, stdout: Bun.file(l.logFile), stderr: Bun.file(l.logFile) });
gw.unref();
writeFileSync(pidFile, `${gw.pid}\n`);
writeFileSync(join(out, "run.json"), `${JSON.stringify({ pid: gw.pid, port, url: l.url, scale, out, dataDir: l.dataDir }, null, 2)}\n`);

const tokenFile = join(l.dataDir, "secrets", "hub-token");
let token = "";
let bootMs = -1;
for (let i = 0; i < 1200; i++) {
	if (!alive(gw.pid)) fail(`the gateway exited during boot, see ${l.logFile}`);
	token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
	if (token) {
		const r = await fetch(`${l.url}api/state?limit=0`, { headers: { "x-dotz-token": token } }).catch(() => undefined);
		if (r?.ok) {
			await r.arrayBuffer();
			bootMs = Math.round(performance.now() - tSpawn);
			break;
		}
	}
	await Bun.sleep(100);
}
if (bootMs < 0) (await stop(out), fail(`no API answer within 120 s, see ${l.logFile}`));

if (has("serve")) {
	console.log(`serving ${l.url}\nlogin link (one use, open it in the browser): ${await loginLink(l.dataDir, port)}\npid ${gw.pid}\nstop: bun hub/load-qa/run.ts --stop --out ${out}`);
	process.exit(0);
}

let code = 0;
try {
	const probeProc = Bun.spawn(sandboxArgv(l.profileFile, [process.execPath, join(repo, "hub", "load-qa", "isolation-probe.ts")]), { cwd: l.cwd, env: l.env, stdout: "pipe", stderr: "pipe" });
	const probeText = `${await new Response(probeProc.stdout).text()}${await new Response(probeProc.stderr).text()}`;
	writeFileSync(join(out, "isolation-probe.txt"), probeText);
	const probe = { ok: (await probeProc.exited) === 0 && probeText.includes("[ok]") && !probeText.includes("[FAIL]"), text: probeText };
	const ctx: Ctx = { base: l.url.replace(/\/$/, ""), token, pid: gw.pid, out, dataDir: l.dataDir, scale, latency, bootMs, seedMs, seed: seedLog, repoFiles: files.length, probe };
	code = await bench(ctx);
} catch (e) {
	console.error(e);
	code = 1;
} finally {
	console.log(await stop(out));
}
process.exit(code);
