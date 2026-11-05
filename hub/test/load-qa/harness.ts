// Boot, restart and stop of the sandboxed load-qa gateway, shared by run.ts (the big measured run) and hub/load-qa.test.ts (the regression test).
// prepare() lays out a run directory (seed, fake mail, copy of the working tree, install), start() spawns the gateway and waits for the API,
// stop() ends it. waitFor() is the one place that polls: tests wait on a condition with a deadline instead of sleeping.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeInstall } from "./install.ts";
import { ACCOUNTS } from "./names.ts";
import { launch, REPO, SHIM_DIR, sandboxArgv, type Launch } from "./sandbox.ts";

export type SeedLog = { counts: Record<string, number>; read: Record<string, unknown>; store: Record<string, unknown> };
export type Gateway = {
	out: string;
	scale: "small" | "large";
	l: Launch;
	port: number;
	repo: string;
	files: string[];
	seedMs: number;
	seed: SeedLog;
	/** Set by start(): the current process, the API token and the boot time. */
	pid: number;
	token: string;
	bootMs: number;
	base: string;
};

export const alive = (pid: number): boolean => {
	try {
		return process.kill(pid, 0);
	} catch {
		return false;
	}
};

export function freePort(): number {
	const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const p = s.port!;
	s.stop(true);
	return p;
}

/** Polls `probe` until it returns a truthy value; throws with `what` and the last value when `ms` run out. */
export async function waitFor<T>(what: string, probe: () => T | Promise<T>, ms = 30_000): Promise<NonNullable<T>> {
	const end = Date.now() + ms;
	let last: T | undefined;
	do {
		last = await probe();
		if (last) return last as NonNullable<T>;
		await Bun.sleep(100);
	} while (Date.now() < end);
	throw new Error(`timed out after ${ms} ms waiting for ${what}; last state: ${JSON.stringify(last)?.slice(0, 400)}`);
}

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

async function run(cmd: string[], out: string, logName: string, cwd = REPO): Promise<void> {
	const p = Bun.spawn(cmd, { cwd, stdout: Bun.file(join(out, logName)), stderr: Bun.file(join(out, logName)) });
	if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed, see ${join(out, logName)}`);
}

/** A clean run directory with a seeded data dir, the fake mail, a copy of the working tree and the install; no process is started. */
export async function prepare(o: { out: string; scale: "small" | "large"; port?: number; latency?: number }): Promise<Gateway> {
	const { out, scale } = o;
	await stop(out);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const t0 = performance.now();
	await run([process.execPath, join(REPO, "hub/test/load-qa/seed.ts"), "--dir", join(out, "data"), "--scale", scale], out, "seed.log");
	const seedMs = Math.round(performance.now() - t0);
	const seed = JSON.parse(readFileSync(join(out, "seed.log"), "utf8").trim().split("\n").at(-1)!) as SeedLog;

	// The fake zele serves the mail every reply draft answers (read back from the seeded drafts file), so an approved send finds its mail.
	const draftFile = JSON.parse(readFileSync(join(out, "data", "custom", "reply-drafts", "drafts.json"), "utf8")) as { drafts: { kind: string; compose?: boolean; mailId: string; account?: string; created: string; item?: { from?: string; to?: string[]; subject?: string; text?: string } }[] };
	const zeleMails = draftFile.drafts
		.filter(d => d.kind === "mail" && !d.compose && d.account && d.item?.from)
		.map(d => ({ id: d.mailId, account: d.account, folder: "inbox", from: d.item!.from, to: (d.item!.to ?? []).join(", "), subject: d.item!.subject ?? "", body: d.item!.text ?? "", date: d.created }));
	writeFileSync(join(out, "zele-mail.json"), `${JSON.stringify({ accounts: ACCOUNTS.map(a => a.address), mails: zeleMails, events: [] })}\n`);

	// The code under test: tracked plus modified plus new (not ignored) files of this working tree.
	const files = (await Bun.$`git -C ${REPO} ls-files -c -o --exclude-standard`.text()).split("\n").filter(f => f && existsSync(join(REPO, f)));
	writeFileSync(join(out, "repo-files.txt"), `${files.join("\n")}\n`);
	mkdirSync(join(out, "repo"), { recursive: true });
	await run(["/bin/sh", "-c", `/usr/bin/tar -C ${REPO} -cf - -T ${join(out, "repo-files.txt")} | /usr/bin/tar -C ${join(out, "repo")} -xf -`], out, "copy.log");
	const repo = join(out, "repo");

	const port = o.port ?? freePort();
	const l = launch({ runDir: out, port, repo, modelLatencyMs: o.latency ?? 0 });
	writeInstall(l.dataDir, { port, accounts: ACCOUNTS.map(a => a.address), scale });
	// The fake CLIs come from the copy too, so the run does not depend on where the checkout lives.
	const shims = join(repo, "hub", "test", "load-qa", "shims");
	for (const k of Object.keys(l.env)) l.env[k] = l.env[k]!.split(SHIM_DIR).join(shims);
	return { out, scale, l, port, repo, files, seedMs, seed, pid: 0, token: "", bootMs: -1, base: l.url.replace(/\/$/, "") };
}

/** Spawns the gateway with the env of prepare() (again after a kill: same data dir, same env) and returns once /api/state answers. */
export async function start(g: Gateway): Promise<void> {
	const { l } = g;
	const t0 = performance.now();
	const gw = Bun.spawn(l.argv, { cwd: l.cwd, env: l.env, stdin: "ignore", detached: true, stdout: Bun.file(l.logFile), stderr: Bun.file(l.logFile) });
	gw.unref();
	g.pid = gw.pid;
	writeFileSync(join(g.out, "gateway.pid"), `${gw.pid}\n`);
	writeFileSync(join(g.out, "run.json"), `${JSON.stringify({ pid: gw.pid, port: g.port, url: l.url, scale: g.scale, out: g.out, dataDir: l.dataDir }, null, 2)}\n`);
	const tokenFile = join(l.dataDir, "secrets", "hub-token");
	await waitFor(`the gateway API (log ${l.logFile})`, async () => {
		if (!alive(gw.pid)) throw new Error(`the gateway exited during boot, see ${l.logFile}`);
		g.token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
		if (!g.token) return false;
		const r = await fetch(`${l.url}api/state?limit=0`, { headers: { "x-dotz-token": g.token } }).catch(() => undefined);
		if (!r?.ok) return false;
		await r.arrayBuffer();
		return true;
	}, 120_000);
	g.bootMs = Math.round(performance.now() - t0);
}

/** Runs hub/test/load-qa/isolation-probe.ts inside the sandbox of the run; ok = exit 0, an [ok] line and no [FAIL] line. */
export async function probe(g: Gateway): Promise<{ ok: boolean; text: string }> {
	const p = Bun.spawn(sandboxArgv(g.l.profileFile, [process.execPath, join(g.repo, "hub", "test", "load-qa", "isolation-probe.ts")]), { cwd: g.l.cwd, env: g.l.env, stdout: "pipe", stderr: "pipe" });
	const text = `${await new Response(p.stdout).text()}${await new Response(p.stderr).text()}`;
	writeFileSync(join(g.out, "isolation-probe.txt"), text);
	return { ok: (await p.exited) === 0 && text.includes("[ok]") && !text.includes("[FAIL]"), text };
}

type Json = Record<string, any>;

/** The HTTP client of a started gateway (token header, JSON in and out). */
export const client = (g: Gateway) => {
	const headers = { "x-dotz-token": g.token, "content-type": "application/json" };
	return {
		get: async (path: string): Promise<Json> => (await fetch(g.base + path, { headers })).json() as Promise<Json>,
		post: async (path: string, body: unknown): Promise<{ status: number; body: Json }> => {
			const r = await fetch(g.base + path, { method: "POST", headers, body: JSON.stringify(body) });
			return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
		},
	};
};

/** The lines of a run's JSONL record (shim-calls.jsonl, net-calls.jsonl, model-calls.jsonl); [] while the file does not exist. */
export function records(g: Gateway, name: string): Json[] {
	const file = join(g.out, name);
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Json) : [];
}
