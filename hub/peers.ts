// Other dotz gateways of the same owner on the tailnet (the web app's computer switcher and the bell's other-computer lines).
// Discovery: `tailscale status --json`, online nodes of this node's own login, each probed at https://<DNSName>:<port>/ and kept
// only when it answers as dotz (its manifest says so). The requests go through the other node's `tailscale serve`, which
// takes this node's tailnet identity as the login, so the allow-list check passes. Config: web.peers (extra URLs),
// web.peer_discovery (default true), web.peer_ports (extra ports to try on every node; default 8445 and 8444).
// Pure parts (names, filtering, counting, cache) are exported for tests; only listPeers() touches the network.
import { cfg, log } from "./config.ts";

export type Peer = { name: string; url: string; self: boolean; online: boolean; unread?: number; need?: number };
export type TsNode = { DNSName?: string; HostName?: string; UserID?: number; Online?: boolean };
export type TsStatus = { Self?: TsNode; Peer?: Record<string, TsNode> };

const PROBE_MS = 3000;
const PROBE_PARALLEL = 4;
const MAX_PEERS = 16;
const DISCOVERY_TTL_MS = 60_000;
const COUNTS_TTL_MS = 15_000;
const DEFAULT_PORTS = [8445, 8444];

const label = (dns: string) => dns.replace(/\.$/, "").split(".")[0] ?? "";

// "hyuns-macbookpro" -> 맥북, "hyuns-mac-mini" -> 맥미니; any other host keeps its hostname.
export function friendlyName(host: string): string {
	const h = label(host).toLowerCase();
	if (/mac[\s-]?mini/.test(h)) return "맥미니";
	if (/mac[\s-]?studio/.test(h)) return "맥 스튜디오";
	if (/mac[\s-]?book/.test(h)) return "맥북";
	if (/imac/.test(h)) return "아이맥";
	return label(host) || host;
}

// Two computers that map to the same friendly name keep their hostnames instead, so the list never shows two identical rows.
export function uniqueNames<T extends { name: string; host: string }>(items: T[]): T[] {
	const seen = new Map<string, number>();
	for (const i of items) seen.set(i.name, (seen.get(i.name) ?? 0) + 1);
	return items.map(i => ((seen.get(i.name) ?? 0) > 1 ? { ...i, name: label(i.host) || i.host } : i));
}

// Online nodes of the same user as `self`, other than self, with a DNS name. Other users' machines, the phone off the network and self never pass.
export function sameUserNodes(st: TsStatus): TsNode[] {
	const me = st.Self;
	if (!me || me.UserID == null) return [];
	return Object.values(st.Peer ?? {}).filter(p => p.Online === true && p.UserID === me.UserID && !!p.DNSName && p.DNSName !== me.DNSName);
}

export function baseUrl(dns: string, port: number): string {
	return `https://${dns.replace(/\.$/, "")}${port === 443 ? "" : `:${port}`}`;
}

// Ports to try on a node: the gateway's own tailnet port first, then the configured extras; no duplicates.
export function candidatePorts(own: number, extra?: number[]): number[] {
	const list = [own, ...(extra ?? DEFAULT_PORTS)].filter(p => Number.isInteger(p) && p > 0 && p < 65536);
	return [...new Set(list)];
}

// Extra URLs from config: http(s) only, origin only, de-duplicated, at most 8.
export function extraUrls(list: unknown): string[] {
	if (!Array.isArray(list)) return [];
	const out = new Set<string>();
	for (const s of list) {
		try {
			const u = new URL(String(s));
			if (u.protocol === "https:" || u.protocol === "http:") out.add(u.origin);
		} catch {}
	}
	return [...out].slice(0, 8);
}

// Unread bell items and open decisions out of a GET /api/notices answer (older hubs answer the same shape).
export function countsFrom(body: unknown): { unread: number; need: number } | undefined {
	const b = body as { items?: Array<{ kind?: string; decision?: { state?: string } }>; unread?: unknown } | null;
	if (!b || typeof b.unread !== "number") return undefined;
	const need = Array.isArray(b.items) ? b.items.filter(n => n?.kind === "decision" && n.decision?.state === "open").length : 0;
	return { unread: Math.max(0, Math.floor(b.unread)), need };
}

// One-slot cache with a time limit; concurrent callers share the load in flight. A failed load is not kept.
export function cached<T>(ttlMs: number, load: () => Promise<T>, clock: () => number = Date.now): () => Promise<T> {
	let value: { at: number; v: T } | undefined;
	let inflight: Promise<T> | undefined;
	return () => {
		if (value && clock() - value.at < ttlMs) return Promise.resolve(value.v);
		inflight ??= load().then(v => { value = { at: clock(), v }; return v; }).finally(() => { inflight = undefined; });
		return inflight;
	};
}

// Runs fn over items, at most `limit` at a time; a throwing item yields undefined.
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<Array<R | undefined>> {
	const out: Array<R | undefined> = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!).catch(() => undefined);
		}
	}));
	return out;
}

type Fetcher = (url: string) => Promise<unknown>;
const getJson: Fetcher = async url => {
	const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS), redirect: "manual" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
};

// A URL is a dotz gateway when its manifest is dotz's. /manifest.webmanifest is public and exists on every hub version.
export async function isDotz(url: string, get: Fetcher = getJson): Promise<boolean> {
	try {
		return (await get(`${url}/manifest.webmanifest`) as { name?: unknown } | null)?.name === "dotz";
	} catch {
		return false;
	}
}

async function counts(url: string, get: Fetcher = getJson): Promise<{ unread: number; need: number } | undefined> {
	try {
		return countsFrom(await get(`${url}/api/notices?limit=100`));
	} catch {
		return undefined;
	}
}

async function tailscaleStatus(): Promise<TsStatus | undefined> {
	for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
		const st = await Bun.$`${bin} status --json`.quiet().json().catch(() => undefined) as TsStatus | undefined;
		if (st?.Self?.DNSName) return st;
	}
	return undefined;
}

type Found = { name: string; host: string; url: string; self: boolean };

// Which gateways exist (slow part: tailscale status and the probes). Self comes first.
export async function discover(): Promise<Found[]> {
	const w = cfg.web as { tailscale_https_port?: number; peers?: string[]; peer_discovery?: boolean; peer_ports?: number[] } | undefined;
	const found: Found[] = [];
	const urls = new Set<string>();
	const add = (host: string, url: string, self: boolean) => {
		if (urls.has(url) || found.length >= MAX_PEERS) return;
		urls.add(url);
		found.push({ name: friendlyName(host), host, url, self });
	};
	const own = w?.tailscale_https_port ?? 0;
	const st = w?.peer_discovery === false && !w?.peers?.length ? undefined : await tailscaleStatus();
	if (st?.Self?.DNSName && own) add(st.Self.DNSName, baseUrl(st.Self.DNSName, own), true);
	if (st && own && w?.peer_discovery !== false) {
		const ports = candidatePorts(own, w?.peer_ports);
		const nodes = sameUserNodes(st);
		const hits = await pool(nodes, PROBE_PARALLEL, async n => {
			const base = n.DNSName!;
			const ok = await Promise.all(ports.map(p => isDotz(baseUrl(base, p))));
			const i = ok.indexOf(true);
			return i < 0 ? undefined : { host: base, url: baseUrl(base, ports[i]!) };
		});
		for (const h of hits) if (h) add(h.host, h.url, false);
	}
	const manual = extraUrls(w?.peers).filter(u => !urls.has(u));
	const okManual = await pool(manual, PROBE_PARALLEL, async u => ((await isDotz(u)) ? u : undefined));
	for (const u of okManual) if (u) add(new URL(u).hostname, u, false);
	return uniqueNames(found);
}

const discovered = cached(DISCOVERY_TTL_MS, () => discover().catch(error => { log(`peers: discovery failed: ${(error as Error).message}`); return [] as Found[]; }));
const countsCache = new Map<string, { at: number; v: { unread: number; need: number } | undefined }>();

// The list for GET /api/peers. One entry or none: the web app hides the switcher (it needs two gateways).
export async function listPeers(): Promise<Peer[]> {
	const list = await discovered();
	const t = Date.now();
	return pool(list, PROBE_PARALLEL, async f => {
		if (f.self) return { name: f.name, url: f.url, self: true, online: true } as Peer;
		let c = countsCache.get(f.url);
		if (!c || t - c.at >= COUNTS_TTL_MS) {
			c = { at: t, v: await counts(f.url) };
			countsCache.set(f.url, c);
		}
		const p: Peer = { name: f.name, url: f.url, self: false, online: c.v !== undefined };
		if (c.v) { p.unread = c.v.unread; p.need = c.v.need; }
		return p;
	}).then(r => {
		for (const k of countsCache.keys()) if (!list.some(f => f.url === k)) countsCache.delete(k);
		return r.filter((p): p is Peer => !!p);
	});
}
