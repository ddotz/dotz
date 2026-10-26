// The update smoke check (hub/update-smoke-run.ts is the gate hub/update-gate.json runs on the owner's machine): start the gateway of the
// folder under test the way the service does (`bun hub/main.ts`), on a throwaway data dir and HOME and a free port, and confirm it answers:
// /api/health, the web page with every script and stylesheet it names, and two read-only API routes. Nothing reaches the owner's services:
// a temp data dir (and DOTZ_DRY_RUN=1) keeps Discord off (hub/live-guard.ts), DOTZ_NO_ORCHESTRATOR=1 starts no agent, the config turns
// off tailscale, zele, peer discovery and the scheduled checks, and HOME points at the temp dir. No WebView, no test suite: the whole
// suite is the developer's gate before pushing (hub/update-gate-run.ts, docs/development.md).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bun test preload replaces Date.now and setTimeout with a manual clock (hub/runtime/test-clock.ts): time here is Bun.nanoseconds.
const ms = () => Bun.nanoseconds() / 1e6;
// The web app and API answer only a tailnet login on web.allow_logins (hub/routes.ts authorized); this one exists only in the temp config.
const LOGIN = "smoke@dotz.local";

export type SmokeResult = { ok: true; ms: number; checked: string[] } | { ok: false; ms: number; why: string; out: string };

const freePort = (): number => {
	const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = s.port as number;
	s.stop(true);
	return port;
};

// Local scripts and stylesheets the page loads (src= of <script>, href= of <link rel="stylesheet">).
export function pageAssets(html: string): string[] {
	const out = new Set<string>();
	for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) out.add(m[1]!);
	for (const m of html.matchAll(/<link\b[^>]*>/g)) if (/\brel="stylesheet"/.test(m[0])) out.add(/\bhref="([^"]+)"/.exec(m[0])?.[1] ?? "");
	return [...out].filter(u => u.startsWith("/") && !u.startsWith("//"));
}

export async function smoke(root: string, o: { startMs?: number } = {}): Promise<SmokeResult> {
	const t0 = ms();
	const tmp = mkdtempSync(join(tmpdir(), "dotz-smoke-"));
	const home = join(tmp, "home"), data = join(tmp, "data");
	mkdirSync(home, { recursive: true });
	mkdirSync(data, { recursive: true });
	const port = freePort();
	writeFileSync(
		join(data, "config.json"),
		JSON.stringify({
			identity: { name: "smoke", language: "ko", timezone: "Asia/Seoul" },
			web: { port, tailscale_https_port: 0, allow_logins: [LOGIN], peer_discovery: false },
			zele: { enabled: false },
			omp_update: { mode: "off" },
			self_update: { auto_check: false },
		}),
	);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("DOTZ_") && !k.startsWith("OMO_") && !k.startsWith("PI_")) env[k] = v;
	Object.assign(env, {
		HOME: home,
		DOTZ_DIR: data,
		DOTZ_PORT: String(port),
		DOTZ_HARNESS: "none",
		DOTZ_NO_ORCHESTRATOR: "1",
		DOTZ_DRY_RUN: "1",
		DOTZ_OMO: join(tmp, "no-omo"),
		DOTZ_OMP: join(tmp, "no-omp"),
		OMO_CODING_AGENT_DIR: join(tmp, "omo-agent"),
		OMO_USER_CONFIG: join(tmp, "omo-home", "omo.json"),
	});
	const logFile = join(tmp, "gateway.out");
	const proc = Bun.spawn([process.execPath, "hub/main.ts"], { cwd: root, env, stdin: "ignore", stdout: Bun.file(logFile), stderr: Bun.file(logFile) });
	let exited = false;
	void proc.exited.then(() => (exited = true));
	const base = `http://127.0.0.1:${port}`;
	const get = (p: string) => fetch(`${base}${p}`, { headers: { "tailscale-user-login": LOGIN }, signal: AbortSignal.timeout(10_000) });
	const checked: string[] = [];
	const output = () => {
		const read = (f: string) => {
			try {
				return readFileSync(f, "utf8");
			} catch {
				return "";
			}
		};
		return `${read(logFile)}\n--- hub.log ---\n${read(join(data, "hub.log"))}`.split("\n").slice(-60).join("\n");
	};
	try {
		const deadline = ms() + (o.startMs ?? 40_000);
		let healthy = false;
		while (!healthy) {
			if (exited) throw new Error(`the gateway exited before it answered (exit ${proc.exitCode})`);
			if (ms() > deadline) throw new Error(`the gateway did not answer /api/health within ${Math.round((o.startMs ?? 40_000) / 1000)} s`);
			healthy = await get("/api/health").then(r => r.status === 200, () => false);
			if (!healthy) await Bun.sleep(100);
		}
		checked.push("/api/health");
		const page = await get("/");
		const html = await page.text();
		if (page.status !== 200 || !html.includes('id="app"')) throw new Error(`GET / answered ${page.status} without the app shell`);
		checked.push("/");
		const assets = pageAssets(html);
		if (!assets.length) throw new Error("the page names no script or stylesheet");
		for (const a of assets) {
			const r = await get(a);
			await r.arrayBuffer();
			if (r.status !== 200) throw new Error(`GET ${a} answered ${r.status}`);
			checked.push(a);
		}
		for (const p of ["/api/state", "/api/notices"]) {
			const r = await get(p);
			const text = await r.text();
			if (r.status !== 200) throw new Error(`GET ${p} answered ${r.status}: ${text.slice(0, 200)}`);
			JSON.parse(text);
			checked.push(p);
		}
		if (exited) throw new Error(`the gateway exited during the check (exit ${proc.exitCode})`);
		return { ok: true, ms: Math.round(ms() - t0), checked };
	} catch (e) {
		return { ok: false, ms: Math.round(ms() - t0), why: (e as Error).message, out: output() };
	} finally {
		if (!exited) {
			proc.kill("SIGTERM");
			const stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(12_000).then(() => false)]);
			if (!stopped) {
				proc.kill("SIGKILL");
				await proc.exited;
			}
		}
		rmSync(tmp, { recursive: true, force: true });
	}
}
