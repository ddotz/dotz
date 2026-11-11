import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CfAccess, createCfAccess } from "./cf-access.ts";
import { startTunnel, stopTunnel, tunnelStatus } from "./cloudflared.ts";
import { cfg, log } from "./config.ts";
import { createDevices, type Devices } from "./devices.ts";
import { body, json } from "./routes-util.ts";
import { runJson, runLimited } from "./run-limited.ts";
import { cfBase, setWebBase } from "./weblink.ts";

// How the web app is reached, switchable at runtime (설정 → 웹 접속). The state is web-access.json in the data dir (0600); an install that never
// saved one keeps what config.json says (web.access, web.cloudflare.*), so nothing changes until its owner uses the screen. The tunnel token lives
// in secrets/ (cloudflared reads it itself from there) and is never returned or logged.

export type WebMode = "tailscale" | "cloudflare" | "local";
export const WEB_MODES: readonly WebMode[] = ["tailscale", "cloudflare", "local"];
export type WebAccessState = { mode: WebMode; hostname: string; team: string; aud: string; token_file: string };
export type WebAccessInput = { mode?: unknown; hostname?: unknown; team?: unknown; aud?: unknown; token?: unknown };
export type WebAccessDeps = {
	dir: string;
	allow: Set<string>;
	notify: (text: string) => void;
	/** Called when the mode changes: the loopback login sessions and codes (hub/local-login.ts) are void from then on. */
	onModeChange?: () => void;
};

const DEFAULT_TOKEN_FILE = "cloudflared-tunnel-token";
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TEAM_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const AUD_RE = /^[A-Za-z0-9]{16,128}$/;
const TOKEN_RE = /^[A-Za-z0-9+/=_.-]{16,4096}$/;
const NO_CLOUDFLARED = "cloudflared를 찾을 수 없어요. `brew install cloudflared` 로 설치해 주세요";

export class WebAccessError extends Error {}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isLoopbackIp = (ip: string): boolean => /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(ip) || ip === "::1";
// Set by a proxy or tunnel in front of the gateway (tailscale serve, cloudflared, a reverse proxy): such a request did not start on this computer.
const FORWARDED = ["forwarded", "x-real-ip", "true-client-ip", "via", "cf-connecting-ip", "cf-ray"];

/**
 * Is this a browser on this computer? web.access "local" (이 컴퓨터만) lets only such a browser even try to log in, and in every mode the `dotz` link and its session count
 * only for such a browser (hub/local-login.ts). The gateway listens on 127.0.0.1 only, so the rule
 * is about what else reaches that socket: the TCP peer must be loopback, the Host loopback (a DNS-rebound name is refused), no proxy or
 * tunnel header may be present (a tailscale serve or cloudflared still running in front of the port relays from loopback too), and the
 * request must not come from another site's page in the same browser (Origin, when sent, is this same origin; Sec-Fetch-Site, when sent,
 * is same-origin or none) so a web page cannot drive the API through the owner's browser.
 */
export function localBrowser(req: Request, peerIp: string | undefined): boolean {
	if (!peerIp || !isLoopbackIp(peerIp)) return false;
	const url = new URL(req.url);
	if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
	for (const k of req.headers.keys()) if (FORWARDED.includes(k) || k.startsWith("x-forwarded-") || k.startsWith("tailscale-")) return false;
	const origin = req.headers.get("origin");
	if (origin !== null && origin !== url.origin) return false;
	const site = req.headers.get("sec-fetch-site");
	return site === null || site === "same-origin" || site === "none";
}

/** DOTZ_TAILSCALE_BIN (colon-separated, empty = none) replaces the lookup list: a test forces "no tailscale" on a host that has the app. */
const tailscaleBins = (): string[] => (process.env.DOTZ_TAILSCALE_BIN !== undefined ? process.env.DOTZ_TAILSCALE_BIN.split(":").filter(Boolean) : ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);

// The web app is reachable only through `tailscale serve`. Setup sets it up once, but an upgrade, a scripted install or a
// skipped step left the port with no proxy (2026-10-20, a second Mac). The gateway restores it on start, and never takes
// over a port another service already serves.
const TAILSCALE_STATUS_MS = 10_000; // a status read from the local daemon: seconds
const TAILSCALE_SERVE_MS = 30_000; // `serve --bg` writes the serve config (and may wait on the daemon): a few seconds, 30 s at most
async function ensureServe(bin: string, httpsPort: number, localPort: number): Promise<void> {
	const st = (await runJson([bin, "serve", "status", "--json"], TAILSCALE_STATUS_MS)) as { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | undefined;
	if (!st) return log("web: tailscale serve status unreadable; not touching the serve config");
	if (st.TCP?.[String(httpsPort)]) {
		const proxy = Object.entries(st.Web ?? {}).find(([k]) => k.endsWith(`:${httpsPort}`))?.[1]?.Handlers?.["/"]?.Proxy ?? "";
		if (!new RegExp(`:${localPort}/?$`).test(proxy)) log(`web: tailnet port ${httpsPort} already serves ${proxy || "something else"}; set web.tailscale_https_port to a free port`);
		return;
	}
	const r = await runLimited([bin, "serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], TAILSCALE_SERVE_MS);
	log(r.code === 0 ? `web: tailscale serve was missing; opened port ${httpsPort} -> ${localPort}` : `web: tailscale serve failed: ${`${r.stdout}${r.stderr}`.trim().slice(0, 300)}`);
}

/** The tailnet address of this computer; undefined when tailscale is not there. Sets up `tailscale serve` when allow_logins is configured. */
async function tailscaleBase(): Promise<string | undefined> {
	const port = cfg.web?.tailscale_https_port;
	if (!port) return undefined;
	for (const bin of tailscaleBins()) {
		const status = (await runJson([bin, "status", "--json"], TAILSCALE_STATUS_MS)) as { Self?: { DNSName?: unknown } } | undefined;
		const dns = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
		if (!dns) continue;
		if (cfg.web?.allow_logins?.length) await ensureServe(bin, port, cfg.web.port);
		return `https://${dns}${port === 443 ? "" : `:${port}`}`;
	}
	log("files: no tailnet address found (set web.public_url); files too big to attach are named, not linked");
	return undefined;
}

export function createWebAccess(deps: WebAccessDeps) {
	const file = join(deps.dir, "web-access.json");
	const secrets = join(deps.dir, "secrets");
	const publicUrl = (): string | undefined => (cfg.web as { public_url?: string } | undefined)?.public_url?.replace(/\/+$/, "") || undefined;

	const fromConfig = (): WebAccessState => ({
		mode: WEB_MODES.includes(cfg.web?.access as WebMode) ? (cfg.web!.access as WebMode) : deps.allow.size ? "tailscale" : "local", // nobody can log in through Tailscale without a login, so such an install starts on this computer
		hostname: cfg.web?.cloudflare?.hostname ?? "",
		team: cfg.web?.cloudflare?.team ?? "",
		aud: cfg.web?.cloudflare?.aud ?? "",
		token_file: cfg.web?.cloudflare?.tunnel_token_file ?? DEFAULT_TOKEN_FILE,
	});
	function load(): WebAccessState {
		const base = fromConfig();
		if (!existsSync(file)) return base;
		try {
			const v = JSON.parse(readFileSync(file, "utf8")) as Partial<WebAccessState>;
			const s = (x: unknown, d: string): string => (typeof x === "string" ? x : d);
			return { mode: WEB_MODES.includes(v.mode as WebMode) ? (v.mode as WebMode) : base.mode, hostname: s(v.hostname, base.hostname), team: s(v.team, base.team), aud: s(v.aud, base.aud), token_file: s(v.token_file, base.token_file) };
		} catch (e) {
			log(`web-access.json unreadable, using config.json: ${e}`);
			return base;
		}
	}

	let state = load();
	let cf: CfAccess | undefined;
	let dev: Devices | undefined;
	let devHost: string | undefined;
	let generation = 0;
	let chain: Promise<unknown> = Promise.resolve();

	const tokenPath = (s: WebAccessState = state): string => resolve(secrets, s.token_file);
	const tokenSet = (s: WebAccessState = state): boolean => existsSync(tokenPath(s));
	const found = (): boolean => !!(process.env.DOTZ_CLOUDFLARED_BIN || Bun.which("cloudflared"));

	function persist(s: WebAccessState): void {
		mkdirSync(deps.dir, { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	}
	function writeToken(path: string, token: string): void {
		mkdirSync(secrets, { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	}

	/** Makes `s` the live behavior: the gates routes.ts reads, the web app's address and the tunnel. Not persisted. */
	async function go(s: WebAccessState): Promise<void> {
		const mine = ++generation;
		state = s;
		if (s.mode === "cloudflare") {
			cf = s.team && s.aud ? createCfAccess({ team: s.team, aud: s.aud, allow: deps.allow }) : undefined;
			const host = cfBase(s.hostname.toLowerCase());
			if (!dev || devHost !== host) {
				dev = createDevices({ dir: deps.dir, hostname: s.hostname, notify: deps.notify });
				devHost = host;
			}
			const url = cfBase(s.hostname);
			if (!url) log("web: web.cloudflare.hostname is missing or invalid; links to the web app are left out");
			setWebBase(url);
			// The device gate is on whenever this mode is: the tunnel never serves the app to everyone.
			startTunnel({ tokenFile: tokenPath(s), deviceGate: true });
			return;
		}
		cf = undefined;
		dev = undefined;
		devHost = undefined;
		await stopTunnel();
		if (mine !== generation) return;
		const url = publicUrl();
		setWebBase(url);
		if (!url && s.mode === "tailscale") {
			const tailnet = await tailscaleBase();
			if (tailnet && mine === generation) setWebBase(tailnet);
		}
	}

	/** Validates the whole body before anything is touched; returns the state it would make live and what to do with the token. */
	function plan(b: WebAccessInput): { next: WebAccessState; token: string | undefined } {
		if (typeof b.mode !== "string" || !WEB_MODES.includes(b.mode as WebMode)) throw new WebAccessError("접속 방식이 올바르지 않아요");
		const str = (x: unknown, label: string): string | undefined => {
			if (x === undefined) return undefined;
			if (typeof x !== "string") throw new WebAccessError(`${label}이(가) 올바르지 않아요`);
			return x.trim();
		};
		const next: WebAccessState = { ...state, mode: b.mode as WebMode };
		const host = str(b.hostname, "주소");
		if (host !== undefined) {
			const h = host.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
			if (h && !HOST_RE.test(h)) throw new WebAccessError("주소는 dotz.example.com 처럼 도메인 이름만 적어 주세요");
			next.hostname = h;
		}
		const team = str(b.team, "팀 이름");
		if (team !== undefined) {
			const t = team.replace(/\.cloudflareaccess\.com$/i, "").toLowerCase();
			if (t && !TEAM_RE.test(t)) throw new WebAccessError("팀 이름은 영문 소문자, 숫자, 하이픈만 쓸 수 있어요");
			next.team = t;
		}
		const aud = str(b.aud, "AUD");
		if (aud !== undefined) {
			if (aud && !AUD_RE.test(aud)) throw new WebAccessError("AUD 태그가 올바르지 않아요");
			next.aud = aud;
		}
		if (!!next.team !== !!next.aud) throw new WebAccessError("팀 이름과 AUD는 함께 적거나 둘 다 비워 주세요");
		const token = str(b.token, "터널 토큰");
		if (token) {
			if (!TOKEN_RE.test(token)) throw new WebAccessError("터널 토큰이 올바르지 않아요");
			// A token entered here goes to the default file; a custom token_file from config.json is left as it was.
			next.token_file = DEFAULT_TOKEN_FILE;
		}
		if (next.mode === "cloudflare") {
			if (!next.hostname) throw new WebAccessError("Cloudflare를 쓰려면 주소를 먼저 적어 주세요");
			if (!(token || (token === undefined && tokenSet(next)))) throw new WebAccessError("Cloudflare를 쓰려면 터널 토큰이 필요해요");
			if (!found()) throw new WebAccessError(NO_CLOUDFLARED);
		}
		return { next, token };
	}

	/** Switches live and persists. Throws WebAccessError for a bad body (nothing changed). */
	function change(b: WebAccessInput): Promise<void> {
		const run = chain.then(async () => {
			const { next, token } = plan(b);
			if (token !== undefined) {
				if (token) writeToken(tokenPath(next), token);
				else rmSync(tokenPath(next), { force: true });
			}
			const modeChanged = state.mode !== next.mode;
			persist(next);
			if (modeChanged) deps.onModeChange?.();
			await go(next);
			log(`web: access is now ${next.mode}${next.mode === "cloudflare" ? ` on ${next.hostname}` : ""}`);
		});
		chain = run.catch(() => undefined);
		return run;
	}

	return {
		cfAccess: (): CfAccess | undefined => cf,
		devices: (): Devices | undefined => dev,
		mode: (): WebMode => state.mode,
		/** The Cloudflare hostname while that mode is on, else "": a Host the gateway's entry check (hub/entry-check.ts) accepts. */
		hostname: (): string => (state.mode === "cloudflare" ? state.hostname : ""),
		/** The state at start-up (config.json or the saved web-access.json). */
		start: (): Promise<void> => go(state),
		stop: (): Promise<void> => stopTunnel(),
		change,
		/** For GET /api/web-access: never the token, only whether one is stored. */
		view: () => ({ mode: state.mode, hostname: state.hostname, team: state.team, aud: state.aud, token_set: tokenSet(), tunnel: tunnelStatus(), cloudflared_found: found(), devices: dev?.list().length ?? countDevices(deps.dir) }),
	};
}

/** GET|PUT /api/web-access, mounted behind the owner check (routes.ts). */
export async function webAccessRoute(req: Request, url: URL, wa: ReturnType<typeof createWebAccess>): Promise<Response | undefined> {
	if (url.pathname !== "/api/web-access") return undefined;
	if (req.method === "GET") return json(wa.view());
	if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
	try {
		await wa.change(await body(req));
	} catch (e) {
		if (e instanceof WebAccessError) return json({ error: e.message }, 400);
		throw e;
	}
	return json(wa.view());
}

/** Paired devices while the gate is off (the file survives a switch away from cloudflare). */
function countDevices(dir: string): number {
	try {
		const p = join(dir, "web-devices.json");
		if (!statSync(p, { throwIfNoEntry: false })) return 0;
		const v = JSON.parse(readFileSync(p, "utf8")) as { devices?: unknown };
		return Array.isArray(v.devices) ? v.devices.length : 0;
	} catch {
		return 0;
	}
}
