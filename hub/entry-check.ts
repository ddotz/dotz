// The gateway's entry check (docs/web-access.ko.md 입구 검사), before any owner check in hub/routes.ts:
//   -> 403 a Host that is not one of this gateway's own names (a DNS-rebound page, a forged Host from a process on this computer)
//   -> the Tailscale identity header counts only when the Host is this node's tailnet name, i.e. the request came through `tailscale serve`
//   -> 403 a state-changing request carried by an ambient credential (tailnet identity, dotz_local cookie, Cloudflare/device session) that
//      another site's page sent, or that posts a non-JSON body to a JSON route (a "simple" text/plain or form post needs no preflight)
// A request with the hub token or a peer token is exempt from the last rule: a browser never sends those headers on its own.
// web.entry_check: false in config.json turns all of it off for one install (an owner locked out by a proxy in front of the gateway).
import { cfg, HUB_TOKEN, log } from "./config.ts";
import { same } from "./peer-auth.ts";
import { tailscaleStatus } from "./peers.ts";
import { sameOrigin } from "./routes-util.ts";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const bare = (host: string): string => host.toLowerCase().replace(/\.$/, "").replace(/\.:/, ":");
const nameOf = (host: string): string => bare(host).replace(/:\d+$/, "");

/** The loopback names on the port the gateway listens on: the CLI, the extension and the `dotz` login link come this way. */
export const loopbackHost = (host: string, port: number): boolean => LOOPBACK.some(h => bare(host) === `${h}:${port}`);

/** Whether `host` is this node's tailnet name (`tailnet`), with no port or the `tailscale serve` port. */
export function tailnetHost(host: string, tailnet: string | undefined, servePort: number | undefined): boolean {
	if (!tailnet) return false;
	const t = bare(tailnet);
	return bare(host) === t || (!!servePort && bare(host) === `${t}:${servePort}`);
}

/** `host` names one of `others` (the Cloudflare hostname, web.public_url's host): the same name, with no port or the one it was given with. */
export const otherHost = (host: string, others: readonly string[]): boolean => others.some(o => !!o && (bare(host) === bare(o) || bare(host) === nameOf(o)));

/**
 * Why a state-changing request with an ambient credential is refused, or undefined when it may go on. The owner's own page sends
 * Sec-Fetch-Site same-origin (none for an address typed or shared from the OS); a browser without fetch metadata sends Origin on every POST,
 * which must then be this same origin (sameOrigin, hub/routes-util.ts); a server-to-server call sends neither. JSON routes (/api/) take only a JSON body, and /api/upload multipart.
 */
export function ambientRefusal(req: Request, path: string): string | undefined {
	if (SAFE.has(req.method)) return undefined;
	const site = req.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return `sec-fetch-site ${site}`;
	// Neither header: no browser sent it (every current browser sends Origin on a POST), e.g. a peer gateway's push relay (hub/push.ts:390).
	if (site === null && !sameOrigin(req)) return "cross-origin";
	if (!path.startsWith("/api/") || req.body === null || req.headers.get("content-length") === "0") return undefined;
	const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
	if (type === "application/json" || (type === "multipart/form-data" && path === "/api/upload")) return undefined;
	return `content-type ${type || "none"}`;
}

const LOG_EVERY_MS = 10_000;
const lastLog = new Map<string, { at: number; skipped: number }>();
const clip = (v: string | null): string => (v === null ? "-" : v.slice(0, 120));

/** A 403 for the entry check, with one log line per reason per 10 s (reason, method, path, Host, Origin; never a token or cookie). */
export function refuse(reason: string, req: Request, now = Date.now()): Response {
	const seen = lastLog.get(reason);
	if (seen && now - seen.at < LOG_EVERY_MS) seen.skipped++;
	else {
		log(`entry: refused (${reason}) ${req.method} ${new URL(req.url).pathname} host=${clip(req.headers.get("host"))} origin=${clip(req.headers.get("origin"))}${seen?.skipped ? ` (+${seen.skipped} more since the last line)` : ""}`);
		lastLog.set(reason, { at: now, skipped: 0 });
	}
	return new Response("forbidden", { status: 403 });
}

/**
 * This node's tailnet name, read once from `tailscale status` and refreshed in the background every 10 minutes; a failed read is retried
 * after 5 s rather than remembered, so a tailscale that starts after the gateway is picked up.
 */
export function rememberName(load: () => Promise<string | undefined>, clock: () => number = Date.now): () => Promise<string | undefined> {
	let name: string | undefined;
	let at = -Infinity;
	let pending: Promise<string | undefined> | undefined;
	const read = (): Promise<string | undefined> => {
		at = clock();
		pending = load()
			.catch(() => {
				// No tailscale (yet): the name stays unknown and is read again in 5 s.
				return undefined;
			})
			.then(n => {
				pending = undefined;
				if (n) name = n;
				return name;
			});
		return pending;
	};
	return async () => {
		if (pending) return name ?? pending;
		const age = clock() - at;
		if (name) {
			if (age > 600_000) void read();
			return name;
		}
		return age < 5_000 ? undefined : read();
	};
}

const entryCheckOn = (): boolean => cfg.web?.entry_check !== false;

/** The hub token, compared in constant time (the CLI, the extension, `dotz` login links). */
// The author of a message an agent posts with the hub token (POST /api/message): never the owner's word for a model change (hub/model-guard.ts).
export const AGENT_AUTHOR = "hub-token";
export const tokenOk = (req: Request): boolean => {
	const sent = req.headers.get("x-dotz-token");
	return sent !== null && same(sent, HUB_TOKEN);
};

export const ownTailnetName = rememberName(async () => (await tailscaleStatus())?.Self?.DNSName?.replace(/\.$/, ""));

const publicHost = (): string => {
	try {
		const u = (cfg.web as { public_url?: string } | undefined)?.public_url;
		return u ? new URL(u).host : "";
	} catch {
		return "";
	}
};

/**
 * The Host part of the entry check: a 403 for a Host that is none of this gateway's names, else whether the Tailscale identity header
 * counts (the Host is this node's tailnet name). No Host header is no browser's request: it passes without tailnet identity.
 */
export async function entryHost(req: Request, port: number, tailnetName: () => Promise<string | undefined>, cloudflareHost: string): Promise<Response | boolean> {
	if (!entryCheckOn()) return true;
	const host = req.headers.get("host");
	if (host === null || loopbackHost(host, port)) return false;
	if (tailnetHost(host, await tailnetName(), cfg.web?.tailscale_https_port)) return true;
	return otherHost(host, [cloudflareHost, publicHost()]) ? false : refuse("host", req);
}

/** The write part, after the owner check of a non-peer request: a 403 when an ambient credential carried a cross-site or non-JSON write. */
export function ambientWrite(req: Request, path: string): Response | undefined {
	if (!entryCheckOn() || tokenOk(req)) return undefined;
	const why = ambientRefusal(req, path);
	return why ? refuse(why, req) : undefined;
}
