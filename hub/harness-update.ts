// In-app update of the execution harness (settings → 업데이트 → 실행 하네스). The nightly job in hub/update.ts installs a
// newer harness by itself; this module is the owner's button: it knows how each harness on this Mac is installed, asks the
// registry at most every 6 hours (or on demand), and installs only the version it can put back.
//
// How the harnesses are installed (checked 2026-10-26):
// - OmO: a bun global package. `~/.bun/bin/omo` is a symlink into `~/.bun/install/global/node_modules/omo-ai`, so the update
//   is `bun add -g omo-ai@<version>` run with the gateway's own bun (process.execPath, no PATH guesswork). The senpi engine
//   is pinned by omo-ai and moves with it. An OmO desktop copy (/Applications/OmO.app) is never touched: that install has no
//   method we own, so it is reported and left alone.
// - omp: `omp update --check` says whether another program owns it ("installed and kept up to date by Tern"). When it does,
//   nothing here can update it and the row says so. Otherwise the install is `omp update`, verified with `omp --version`.
//
// A running turn is never cut: when the gateway reports busy work the install waits for idle (the same gate dotz's own
// self-update uses for its restart, hub/restart.ts), then installs, checks the new `--version`, and asks that gate for one
// restart so the orchestrator, the lanes and their omo rpc hosts start on the new binary. A failed or unverified install
// keeps the old version and says so; the cached check still shows what was known before (offline-safe).
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, OMP, writeAtomic } from "./config.ts";
import { activeHarness, HARNESS_NAMES } from "./runtime/index.ts";
import { OMO } from "./runtime/omo-hosts.ts";
import { trackTimer } from "./shutdown.ts";
import { newer } from "./update.ts";

export type InstallMethod = "bun-global" | "omp-update" | "managed" | "app" | "unknown";
export type JobStatus = "running" | "deferred" | "updated" | "failed" | "current";
export type Job = {
	id: number;
	harness: string;
	startedAt: string;
	endedAt?: string;
	status: JobStatus;
	phase: string;
	message: string;
	from?: string;
	to?: string;
	steps: { at: string; text: string }[];
};
export type HarnessState = {
	id: string;
	name: string;
	current: string | null;
	latest: string | null;
	available: boolean;
	checkedAt: string | null;
	error?: string;
	installMethod: InstallMethod;
	managedBy?: string;
	path?: string;
	job?: Job;
};
export type Run = (cmd: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;
export type Registry = (pkg: string) => Promise<{ version?: string; error?: string }>;

export type Tools = {
	run: Run;
	registry: Registry;
	which: (bin: string) => string | undefined;
	realpath: (path: string) => string | undefined;
	busy: () => string[];
	// Asks the gateway's restart gate for one restart; it waits for idle itself, so a busy turn is never cut here.
	restart: () => string;
	dataDir: string;
	bins?: Partial<Record<string, string>>;
	// Where the gateway's bun lives (the update command's argv[0]).
	bun?: string;
	schedule?: (fn: () => void, ms: number) => void;
};

export const CACHE_FILE = "harness-update.json";
export const CHECK_MS = 6 * 60 * 60_000;
export const RETRY_MS = 15_000;
const VERSION = /(\d+\.\d+\.\d+[^\s)]*)/;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 120_000;
const SUPPORTED = ["omo", "omp"];

const ANSI = /\x1b\[[0-9;]*m/g;
const lastLine = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean).pop()?.slice(0, 240) ?? "";

const defaultRun: Run = async (cmd, timeoutMs) => {
	try {
		const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { code, out: `${out}${err ? `\n${err}` : ""}`.replace(ANSI, "").trim() };
	} catch (e) {
		return { code: -1, out: String(e) };
	}
};

// What npm calls latest for a package, or why it could not be read. Never throws; a slow or offline registry ends the wait.
const npmLatest: Registry = async pkg => {
	try {
		const r = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
		if (!r.ok) return { error: `레지스트리 응답 ${r.status}` };
		const v = (await r.json() as { version?: unknown }).version;
		return typeof v === "string" && VERSION.test(v) ? { version: v } : { error: "레지스트리에 버전이 없어요" };
	} catch (e) {
		return { error: lastLine(String(e)) || "네트워크에 연결하지 못했어요" };
	}
};

export const tools = (o: { busy: () => string[]; restart: () => string; dataDir?: string }): Tools => ({
	run: defaultRun,
	registry: npmLatest,
	which: bin => (bin.includes("/") ? (existsSync(bin) ? bin : undefined) : Bun.which(bin)),
	realpath: path => {
		try {
			return realpathSync(path);
		} catch {
			return undefined;
		}
	},
	busy: o.busy,
	restart: o.restart,
	dataDir: o.dataDir ?? DATA_DIR,
	bun: process.execPath,
});

const binOf = (id: string, t: Tools) => t.bins?.[id] ?? (id === "omo" ? OMO : OMP);
// The harnesses the gateway actually runs, in the order settings lists them.
export function harnessIds(): string[] {
	return activeHarness().ids.filter(id => SUPPORTED.includes(id));
}

type Cached = {
	current?: string;
	latest?: string;
	checkedAt: string;
	installMethod: InstallMethod;
	managedBy?: string;
	path?: string;
	pkg?: string;
	available: boolean;
	error?: string;
};
type Cache = Record<string, Cached>;

function readCache(dir: string): Cache {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(dir, CACHE_FILE), "utf8"));
		return raw && typeof raw === "object" ? (raw as Cache) : {};
	} catch {
		return {};
	}
}
const writeCache = (dir: string, cache: Cache) => writeAtomic(join(dir, CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);

function record(dir: string, text: string): void {
	try {
		mkdirSync(join(dir, "logs"), { recursive: true });
		appendFileSync(join(dir, "logs", `harness-update-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`), `${new Date().toISOString()} ${text}\n`);
	} catch (e) {
		log(`harness update: log write failed: ${e}`);
	}
}

async function versionWith(t: Tools, bin: string): Promise<string | undefined> {
	const r = await t.run([bin, "--version"], 15_000).catch(() => undefined);
	if (!r || r.code !== 0) return undefined;
	return VERSION.exec(r.out)?.[1];
}

// How this copy is installed, from the real path of the binary. Only methods we can put back are updatable here.
export function installMethodOf(id: string, path: string | undefined, t: Pick<Tools, "realpath">): { installMethod: InstallMethod; pkg?: string } {
	if (!path) return { installMethod: "unknown" };
	const real = t.realpath(path) ?? path;
	// The owner's OmO desktop app is a separate copy whose updates belong to the app, never to dotz.
	if (/\.app\/Contents\//.test(real)) return { installMethod: "app" };
	if (id === "omo") {
		const m = /\/install\/global\/node_modules\/(omo-ai)\//.exec(real);
		return m ? { installMethod: "bun-global", pkg: m[1]! } : { installMethod: "unknown" };
	}
	return { installMethod: "omp-update" };
}

const fresh = (c: Cached | undefined) => !!c?.checkedAt && Date.now() - Date.parse(c.checkedAt) < CHECK_MS;

// One harness: the version the binary reports now, how it was installed, and (unless the cache is fresh) the latest.
async function detectOne(id: string, t: Tools, prev: Cached | undefined, force: boolean): Promise<Cached> {
	const bin = binOf(id, t);
	const current = await versionWith(t, bin);
	const path = t.which(bin);
	const { installMethod, pkg } = installMethodOf(id, path, t);
	const updatable = installMethod === "bun-global" || installMethod === "omp-update";
	const at = new Date().toISOString();
	if (!current) return { ...prev, current: undefined, checkedAt: at, installMethod, path, available: false, error: `\`${bin} --version\`을 실행하지 못했어요` };
	if (fresh(prev) && !force && prev?.current === current) return { ...prev!, path: path ?? prev.path, installMethod, available: prev!.available };
	if (id === "omp") {
		const r = await t.run([bin, "update", "--check"], CHECK_TIMEOUT_MS).catch(e => ({ code: -1, out: String(e) }));
		const text = r.out.replace(ANSI, "");
		const managedBy = /kept up to date by (\S+?)[;.]/i.exec(text)?.[1];
		if (managedBy) return { current, checkedAt: at, installMethod: "managed", managedBy, path, available: false };
		const latest = /New version available:\s*(\S+)/.exec(text)?.[1];
		const upToDate = /Already up to date/i.test(text);
		if (!latest && !upToDate && r.code !== 0) return { ...prev, current, checkedAt: at, installMethod, path, available: false, error: `최신 버전을 확인하지 못했어요: ${lastLine(text) || `exit ${r.code}`}` };
		const to = latest ?? (upToDate ? current : undefined);
		return { current, latest: to, checkedAt: at, installMethod, path, available: updatable && !!latest && newer(latest, current) };
	}
	// OmO: the npm registry holds omo-ai; the engine moves with it.
	const reg = await t.registry(pkg ?? "omo-ai");
	const latest = reg.version ?? prev?.latest;
	const error = reg.error ? `최신 버전을 확인하지 못했어요 (${reg.error}). 지난 확인값을 보여줘요.` : undefined;
	return { current, latest, checkedAt: at, installMethod, path, pkg, available: updatable && !!latest && newer(latest, current), ...(error ? { error } : {}) };
}

export async function checkHarness(t: Tools, o: { force?: boolean; ids?: string[] } = {}): Promise<HarnessState[]> {
	const ids = o.ids ?? harnessIds();
	const cache = readCache(t.dataDir);
	const out: HarnessState[] = [];
	for (const id of ids) {
		const st = await detectOne(id, t, cache[id], o.force === true).catch((e): Cached => ({ ...cache[id], checkedAt: new Date().toISOString(), installMethod: "unknown", available: false, error: lastLine(String(e)) }));
		cache[id] = st;
		out.push(stateOf(id, st, jobs.get(id)));
	}
	writeCache(t.dataDir, cache);
	return out;
}

// What settings shows without waiting for the network: the cached check plus the current job.
export function viewHarness(t: Tools): { harnesses: HarnessState[]; stale: boolean; busy: string[] } {
	const cache = readCache(t.dataDir);
	const ids = harnessIds();
	return { harnesses: ids.map(id => stateOf(id, cache[id], jobs.get(id))), stale: ids.some(id => !fresh(cache[id])), busy: t.busy() };
}

function stateOf(id: string, c: Cached | undefined, job: Job | undefined): HarnessState {
	return {
		id,
		name: HARNESS_NAMES[id] ?? id,
		current: c?.current ?? null,
		latest: c?.latest ?? null,
		available: !!c?.available,
		checkedAt: c?.checkedAt ?? null,
		...(c?.error ? { error: c.error } : {}),
		installMethod: c?.installMethod ?? "unknown",
		...(c?.managedBy ? { managedBy: c.managedBy } : {}),
		...(c?.path ? { path: c.path } : {}),
		...(job ? { job } : {}),
	};
}

// One check at a time: the badge poll and the owner's 확인 button share it. 확인 pressed while a poll's check runs waits
// for it and then checks again, so the button always answers a fresh registry read.
let checking: Promise<HarnessState[]> | undefined;
export const isChecking = () => !!checking;
export async function ensureChecked(t: Tools, force = false): Promise<HarnessState[]> {
	if (checking) {
		if (!force) return checking;
		await checking.catch(() => []);
	}
	checking ??= checkHarness(t, { force }).finally(() => (checking = undefined));
	return checking;
}

const jobs = new Map<string, Job>();
export const jobOf = (id: string) => jobs.get(id);
// Between tests and a standalone run: forget in-memory jobs (the cache file under the data dir stays).
export const resetHarnessJobs = () => void jobs.clear();

let jobSeq = 0;

// `apply`: install the checked new version, or wait for the gateway to go idle first. Never throws; always settles a job.
export async function applyHarness(id: string, t: Tools): Promise<Job> {
	const running = jobs.get(id);
	if (running && (running.status === "running" || running.status === "deferred")) return running;
	const j: Job = { id: ++jobSeq, harness: id, startedAt: new Date().toISOString(), status: "running", phase: "확인", message: "새 버전을 확인하고 있어요", steps: [] };
	jobs.set(id, j);
	const step = (phase: string, text: string) => {
		j.phase = phase;
		j.message = text;
		j.steps.push({ at: new Date().toISOString(), text });
		record(t.dataDir, `${id} #${j.id}: ${text}`);
	};
	const end = (status: JobStatus, text: string) => {
		j.status = status;
		j.endedAt = new Date().toISOString();
		j.phase = status === "updated" ? "완료" : status === "deferred" ? "대기" : status === "running" ? j.phase : "끝";
		j.message = text;
		j.steps.push({ at: j.endedAt, text });
		record(t.dataDir, `${id} #${j.id}: ${status}: ${text}`);
		log(`harness update ${id} #${j.id}: ${status}: ${text}`);
		return j;
	};
	try {
		const st = (await checkHarness(t, { force: true, ids: [id] }))[0];
		if (!st) return end("failed", "업데이트할 실행 하네스를 찾지 못했어요.");
		j.from = st.current ?? undefined;
		if (st.installMethod === "managed") return end("failed", `${st.name}는 ${st.managedBy ?? "다른 프로그램"}이 관리해서 여기서 바꾸지 않아요. 그 프로그램에서 업데이트해 주세요.`);
		if (st.installMethod === "app") return end("failed", `${st.name}는 앱으로 설치돼 있어서 여기서 바꾸지 않아요. 앱에서 업데이트해 주세요.`);
		if (st.error && !st.latest) return end("failed", st.error);
		if (!st.available || !st.latest) return end("current", st.current ? `이미 최신이에요 (${st.current}).` : (st.error ?? "새 버전을 확인하지 못했어요."));
		j.to = st.latest;
		if (st.installMethod !== "bun-global" && st.installMethod !== "omp-update") return end("failed", `${st.name}의 설치 방식을 알 수 없어 업데이트하지 않았어요 (${st.path ?? "경로 없음"}).`);
		return await installWhenIdle(id, st, j, t, step, end);
	} catch (e) {
		return end("failed", `업데이트하지 못했어요: ${lastLine(String(e))}`);
	}
}

async function installWhenIdle(id: string, st: HarnessState, j: Job, t: Tools, step: (phase: string, text: string) => void, end: (status: JobStatus, text: string) => Job): Promise<Job> {
	const install = async (): Promise<Job> => {
		const bin = binOf(id, t);
		const pkg = st.installMethod === "bun-global" ? "omo-ai" : undefined;
		const cmd = pkg ? [t.bun ?? process.execPath, "add", "-g", `${pkg}@${st.latest}`] : [st.path ?? bin, "update"];
		step("설치", `${st.name} ${st.current} → ${st.latest} 설치 중`);
		const r = await t.run(cmd, INSTALL_TIMEOUT_MS).catch(e => ({ code: -1, out: String(e) }));
		if (r.code !== 0) {
			record(t.dataDir, `${id} install failed: ${r.out.slice(-800)}`);
			return end("failed", `${st.name} ${st.latest}를 설치하지 못했어요. 지금 버전(${st.current})을 그대로 써요: ${lastLine(r.out) || `exit ${r.code}`}`);
		}
		const now = await versionWith(t, bin);
		const moved = !!now && (st.installMethod === "bun-global" ? newer(now, st.current ?? "0.0.0") : now === st.latest || newer(now, st.current ?? "0.0.0"));
		if (!moved) {
			// A half-done install must not leave a version we cannot verify: put the old one back when we know how.
			const back = st.installMethod === "bun-global" && st.current ? await t.run([t.bun ?? process.execPath, "add", "-g", `omo-ai@${st.current}`], INSTALL_TIMEOUT_MS).catch(e => ({ code: -1, out: String(e) })) : undefined;
			record(t.dataDir, `${id} install did not verify (now ${now ?? "?"})${back ? `; rollback exit ${back.code}` : ""}`);
			const kept = back ? (back.code === 0 ? `이전 버전(${st.current})으로 되돌렸어요` : `이전 버전으로 되돌리지 못했어요 (지금 ${now ?? "?"})`) : `지금 ${now ?? "?"}`;
			return end("failed", `${st.name}를 설치했지만 새 버전이 확인되지 않아요. ${kept}.`);
		}
		const cache = readCache(t.dataDir);
		cache[id] = { current: now, latest: now, checkedAt: new Date().toISOString(), installMethod: st.installMethod, path: st.path, pkg, available: false };
		writeCache(t.dataDir, cache);
		const busy = t.busy();
		step("재시작", `${st.current} → ${now} 설치를 확인했어요${busy.length ? ` (작업 중: ${busy.join(", ")})` : ""}`);
		const asked = t.restart();
		return end("updated", `${st.current} → ${now} 올렸어요. ${busy.length ? "하던 일이 끝나면" : "곧"} 다시 시작해서 새 버전으로 켜요. (${asked})`);
	};
	const busy = t.busy();
	if (!busy.length) return install();
	step("대기", `작업 중이라 업데이트를 미뤄요: ${busy.join(", ")}`);
	j.status = "deferred";
	j.message = `작업이 끝나면 ${st.name} ${st.current} → ${st.latest} 업데이트해요 (${busy.join(", ")})`;
	const sched = t.schedule ?? ((fn: () => void, ms: number) => trackTimer("harness update retry", setTimeout(fn, ms)));
	const retry = (): void => {
		const cur = jobs.get(id);
		if (!cur || cur.status !== "deferred") return;
		const still = t.busy();
		if (still.length) {
			cur.message = `작업이 끝나면 ${st.name} ${st.current} → ${st.latest} 업데이트해요 (${still.join(", ")})`;
			return sched(retry, RETRY_MS);
		}
		cur.status = "running";
		step("설치", `작업이 끝나서 ${st.name} ${st.current} → ${st.latest} 설치를 시작해요`);
		void install().catch(e => end("failed", `업데이트하지 못했어요: ${lastLine(String(e))}`));
	};
	sched(retry, RETRY_MS);
	return j;
}

type RouteDeps = { busy: () => string[]; restartIdle: () => string; dataDir?: string; tools?: Tools };
const json = (data: unknown, status = 200) => Response.json(data, { status });

// /api/harness/update: settings → 업데이트 → 실행 하네스. Same tailnet auth as every other /api route (main.ts).
export async function harnessUpdateRoute(req: Request, url: URL, deps: RouteDeps): Promise<Response | undefined> {
	const p = url.pathname;
	if (p !== "/api/harness/update" && !p.startsWith("/api/harness/update/")) return undefined;
	const t = deps.tools ?? tools(deps);
	if (req.method === "GET" && p === "/api/harness/update") {
		const v = viewHarness(t);
		const stale = v.stale && !isChecking();
		if (stale) void ensureChecked(t).catch(e => log(`harness update check failed: ${e}`));
		return json({ harnesses: v.harnesses, busy: v.busy, checking: isChecking(), checkEveryHours: CHECK_MS / 3_600_000 });
	}
	if (req.method === "POST" && p === "/api/harness/update/check") {
		const harnesses = await ensureChecked(t, true);
		return json({ harnesses: harnesses.map(s => ({ ...s, job: jobOf(s.id) })), busy: t.busy(), checking: false });
	}
	if (req.method === "POST" && p === "/api/harness/update/apply") {
		const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		const id = typeof b.id === "string" ? b.id : "";
		if (!SUPPORTED.includes(id)) return json({ error: "알 수 없는 실행 하네스예요" }, 400);
		// A background badge check may still be reading the registry: let it finish, then the apply's own check runs.
		if (isChecking()) await ensureChecked(t).catch(() => []);
		const running = jobOf(id);
		if (running && (running.status === "running" || running.status === "deferred")) return json({ error: "업데이트가 이미 진행 중이에요", job: running }, 409);
		void applyHarness(id, t).catch(e => log(`harness update ${id} failed: ${e}`));
		return json({ job: jobOf(id) ?? null }, 202);
	}
	return json({ error: "unknown harness update route" }, 404);
}
