// Nightly omp update, ported from 오모냥's nightly.ts. `omp update --check` runs once a day at omp_update.at ("04:20").
// omp_update.mode: "check" (default) posts one worklog line per new version and never installs; "install" runs
// `omp update`, then restarts the gateway once it is idle; "off" does nothing. Install is never the default.
// `bun hub/update.ts --check-now` runs the check path once and prints the result without posting.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, DEFAULTS, log, writeAtomic } from "./config.ts";
import { trackTimer } from "./shutdown.ts";

export type Mode = "check" | "install" | "off";
export type Check =
	| { status: "current"; current: string }
	| { status: "new"; current: string; latest: string }
	// omp is installed and kept up to date by another program (Tern); `omp update` prints that and no versions.
	| { status: "managed"; current: string; by: string }
	| { status: "error"; current: string; detail: string };
export type Run = (args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;

const STATE = join(DATA_DIR, "omp-update.json");
const ANSI = /\x1b\[[0-9;]*m/g;

export const defaultRun: Run = async (args, timeoutMs) => {
	const p = Bun.spawn(["omp", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out: `${out}\n${err}`.replace(ANSI, "").trim() };
};

// `omp --version` prints "omp/18.12.1".
async function currentVersion(run: Run): Promise<string> {
	const r = await run(["--version"], 30_000).catch(() => undefined);
	return r?.out.match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? "?";
}

// Output shapes (omp 18.12): "Current version: X" then "New version available: Y" or "<mark> Already up to date";
// "<name> is installed and kept up to date by <manager>; update it from <manager>." when another program owns the install.
export async function checkOmp(run: Run = defaultRun): Promise<Check> {
	const r = await run(["update", "--check"], 120_000).catch(e => ({ code: -1, out: String(e) }));
	const current = r.out.match(/Current version:\s*(\S+)/)?.[1] ?? (await currentVersion(run));
	const by = r.out.match(/kept up to date by (\S+?);/)?.[1];
	if (by) return { status: "managed", current, by };
	const latest = r.out.match(/New version available:\s*(\S+)/)?.[1];
	if (latest) return { status: "new", current, latest };
	if (r.code === 0 && /Already up to date/i.test(r.out)) return { status: "current", current };
	return { status: "error", current, detail: r.out.split("\n").pop()?.slice(0, 200) || `exit ${r.code}` };
}

export const describe = (c: Check): string =>
	c.status === "new" ? `omp 새 버전 ${c.latest} 있어요(지금 ${c.current}).`
		: c.status === "current" ? `omp ${c.current} 최신이에요.`
		: c.status === "managed" ? `omp ${c.current}는 ${c.by}가 관리해서 omp update로는 새 버전을 알 수 없어요.`
		: `omp 업데이트 확인 실패(지금 ${c.current}): ${c.detail}`;

type State = { notified?: string };
const readState = (file: string): State => {
	try {
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	} catch {
		return {};
	}
};

export type Deps = { mode: Mode; post: (text: string) => void; restart: () => string; run?: Run; stateFile?: string };

// One pass of the nightly job. Returns the worklog line it posted, if any.
export async function runOmpUpdate({ mode, post, restart, run = defaultRun, stateFile = STATE }: Deps): Promise<string | undefined> {
	if (mode === "off") return undefined;
	const c = await checkOmp(run);
	if (c.status === "error") log(`omp update: ${describe(c)}`);
	if (c.status !== "new") return undefined;
	if (mode === "check") {
		if (readState(stateFile).notified === c.latest) return undefined;
		const line = `${describe(c)} 설치는 오너 확인 후.`;
		writeAtomic(stateFile, JSON.stringify({ notified: c.latest }));
		post(line);
		return line;
	}
	const u = await run(["update"], 15 * 60_000).catch(e => ({ code: -1, out: String(e) }));
	const now = await currentVersion(run);
	if (u.code !== 0 || now !== c.latest) {
		const line = `omp ${c.current} → ${c.latest} 설치 실패했어요(지금 ${now}): ${u.out.split("\n").pop()?.slice(0, 160) || `exit ${u.code}`}`;
		log(`omp update: ${line}`);
		post(line);
		return line;
	}
	const line = `omp ${c.current} → ${now} 설치했어요. 게이트웨이는 하던 일이 끝나면 다시 켤게요.`;
	log(`omp update: ${line}`);
	post(line);
	log(`omp update: ${restart()}`);
	return line;
}

export function startOmpUpdate(post: (text: string) => void, restart: () => string): void {
	const raw: unknown = "omp_update" in cfg ? cfg.omp_update : undefined;
	const o = raw && typeof raw === "object" ? raw : {};
	const mode: Mode = "mode" in o && (o.mode === "install" || o.mode === "off") ? o.mode : "check";
	const at = "at" in o && typeof o.at === "string" ? o.at : DEFAULTS.update_at;
	if (mode === "off" || at === "off") return;
	const [h, m] = at.split(":").map(Number);
	const next = () => {
		const d = new Date();
		d.setHours(h, m, 0, 0);
		if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
		return d.getTime() - Date.now();
	};
	const run = async () => {
		await runOmpUpdate({ mode, post, restart }).catch(e => log(`omp update failed: ${e}`));
		trackTimer("omp update", setTimeout(run, next()));
	};
	trackTimer("omp update", setTimeout(run, next()));
}

if (import.meta.main) {
	if (process.argv.includes("--check-now")) console.log(describe(await checkOmp()));
	else console.log("usage: bun hub/update.ts --check-now");
}
