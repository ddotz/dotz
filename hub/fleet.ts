// Fleet (docs/fleet.md): each gateway tells a paired peer how busy it is, and this gateway lists every computer with a plain state.
//   GET /api/peer/load   this gateway's load (peer gates in hub/peer-auth.ts), ETag over the body without its clock
//   GET /api/fleet       this computer first, then every paired computer: [{name, url, self, online, state, load, legacy?, sent?}] (sent: what this computer sent there)
// A peer's load is kept 20 s and read again behind the request once stale (`cached` of hub/peers.ts); a peer_counts frame from its event
// stream drops it (hub/peer-stream.ts). No timer of its own and no model call. Everything outside (fetch, computers, clock, token, pair, the
// local load source) is injected, so tests run two gateways in one process or a fake peer.
import { createHash } from "node:crypto";
import { peerFetch } from "./tailnet-fetch.ts";
import { peerHeaders, peerTokenFor } from "./peer-auth.ts";
import { createPairer, type PairResult } from "./peer-pair.ts";
import { cached, knownComputers } from "./peers.ts";
import { json } from "./routes-util.ts";

export const FLEET_V = 1;
export type FleetState = "offline" | "full" | "busy" | "idle";
export type RunningRow = { kind: string; title: string; status: string };
export type Load = {
	v: number;
	name: string;
	at: number;
	sessions: { live: number; cap: number; reason: string };
	lanes: { active: number; cap: number; waiting: number; reason?: string };
	waitlist: number;
	paused: boolean;
	working: boolean;
	running: RunningRow[];
};
export type LoadCore = Omit<Load, "v" | "name" | "at">;
export type FleetRow = { name: string; url: string; self: boolean; online: boolean; state: FleetState; load: Load | null; legacy?: true; sent?: Array<{ lane: string; title: string }> };
export type Computer = { name: string; url: string; self: boolean; via?: string; public?: boolean };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const RUNNING_MAX = 20;
const TITLE_MAX = 80;
const REASON_MAX = 120;
const GET_MS = 2500;
const REFRESH_MS = 20_000;
const STALE_OK_MS = 60_000;

// The one function for the computer sheet and for placement (docs/fleet.md "States").
// A computer that answers but sends no load (older than Fleet) is "busy": it is listed, and nothing is placed on it.
export function fleetState(load: Load | null, online: boolean): FleetState {
	if (!online) return "offline";
	if (!load) return "busy";
	if (load.paused || load.lanes.waiting > 0 || load.lanes.active >= load.lanes.cap) return "full";
	return load.working ? "busy" : "idle";
}

const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0);
const text = (x: unknown, max: number): string => (typeof x === "string" ? x.slice(0, max) : "");

// What the local gateway knows, in its own shapes (hub/routes.ts passes them): the conversation-session view, laneCapacity(), the waitlist length,
// the orchestrator's status, laneSummary() rows and the live conversation sessions.
export type LoadSource = {
	sessions: { live: number; max: number; reason?: unknown };
	capacity: Record<string, unknown>;
	waitlist: number;
	orchestrator: string;
	lanes: Array<Record<string, unknown>>;
	convs: Array<{ status: string }>;
};
// Only counts, the caps' reasons and session titles leave: a lane's folder, brief, report and chat text stay on this computer.
// Conversation sessions (mail, Kakao...) count in `working` and `sessions.live` but are never listed: their names are mail subjects and room names.
export function loadCore(s: LoadSource): LoadCore {
	const lanes = s.lanes
		.filter(l => l.live === true || l.status === "working")
		.map(l => ({ kind: "lane", title: text(l.title, TITLE_MAX) || text(l.name, TITLE_MAX), status: text(l.status, 20) }));
	const reason = text(s.capacity.wait_reason, REASON_MAX);
	return {
		sessions: { live: count(s.sessions.live), cap: count(s.sessions.max), reason: text(s.sessions.reason, REASON_MAX) },
		lanes: { active: count(s.capacity.active), cap: count(s.capacity.lanes), waiting: count(s.capacity.waiting), ...(reason ? { reason } : {}) },
		waitlist: count(s.waitlist),
		paused: s.orchestrator === "rate-limited",
		working: s.orchestrator === "working" || lanes.some(l => l.status === "working") || s.convs.some(c => c.status === "working"),
		running: lanes.slice(0, RUNNING_MAX),
	};
}

// A peer's answer, checked at the boundary and cut to plain sizes; undefined = not a load.
export function loadFrom(body: unknown): Load | undefined {
	const b = body as Partial<Load> | null;
	if (!b || typeof b !== "object" || typeof b.v !== "number" || !b.sessions || !b.lanes || typeof b.lanes !== "object" || !Array.isArray(b.running)) return undefined;
	const reason = text(b.lanes.reason, REASON_MAX);
	return {
		v: b.v,
		name: text(b.name, TITLE_MAX),
		at: count(b.at),
		sessions: { live: count(b.sessions.live), cap: count(b.sessions.cap), reason: text(b.sessions.reason, REASON_MAX) },
		lanes: { active: count(b.lanes.active), cap: count(b.lanes.cap), waiting: count(b.lanes.waiting), ...(reason ? { reason } : {}) },
		waitlist: count(b.waitlist),
		paused: b.paused === true,
		working: b.working === true,
		running: b.running.slice(0, RUNNING_MAX).map(r => ({ kind: text(r?.kind, 20), title: text(r?.title, TITLE_MAX), status: text(r?.status, 20) })),
	};
}

export type FleetDeps = {
	name: () => string;
	local: () => LoadCore;
	computers?: () => Promise<Computer[]>;
	/** What this computer sent to others (hub/fleet-launch.ts `sent`, wired by routes.ts): each other computer's row lists its own. */
	sent?: () => Array<{ lane: string; computer: string; title: string }>;
	fetch?: Fetcher;
	now?: () => number;
	token?: (peerUrl: string) => string | undefined;
	pair?: (peerUrl: string, force?: boolean) => Promise<PairResult>;
	timeoutMs?: number;
	refreshMs?: number;
};
export type Fleet = {
	load: () => Load;
	fleet: () => Promise<FleetRow[]>;
	invalidatePeer: (url: string) => void;
	idle: () => Promise<void>;   // resolves when no read is running (tests)
	route: (req: Request, url: URL) => Promise<Response | undefined>;
};
type Read = { online: boolean; load: Load | null; legacy: boolean };

export function createFleet(deps: FleetDeps): Fleet {
	const f: Fetcher = deps.fetch ?? ((u, init) => peerFetch(u, init));
	const now = deps.now ?? Date.now;
	const token = deps.token ?? peerTokenFor;
	const computers = deps.computers ?? knownComputers;
	const pair = deps.pair ?? createPairer({ fetch: f, selfUrl: async () => (await computers()).find(c => c.self)?.url });
	const getMs = deps.timeoutMs ?? GET_MS;
	const reads = new Map<string, ReturnType<typeof cached<Read>>>();
	const last = new Map<string, { etag: string; load: Load }>();   // the last answer, for If-None-Match
	const running = new Set<Promise<unknown>>();

	const load = (): Load => ({ v: FLEET_V, name: deps.name(), at: now(), ...deps.local() });
	// The ETag covers everything but the clock, so an unchanged load answers 304.
	const etagOf = (l: Load): string => {
		const { at: _at, ...rest } = l;
		return `"${createHash("sha1").update(JSON.stringify(rest)).digest("hex").slice(0, 12)}"`;
	};
	const etagMatch = (header: string | null, etag: string) => !!header && header.split(",").some(t => t.trim().replace(/^W\//, "") === etag);

	// One read of a peer. Never throws: a refusal or silence is offline, a 404 or an answer that is not a load is an older gateway.
	async function readPeer(c: Computer): Promise<Read> {
		const url = c.url;
		try {
			let h = peerHeaders(token(url));
			if (!h && (await pair(url)).ok) h = peerHeaders(token(url));
			const prev = last.get(url);
			const get = (hh: Record<string, string>) => f(`${url}/api/peer/load`, { headers: { ...hh, ...(prev ? { "if-none-match": prev.etag } : {}) }, signal: AbortSignal.timeout(getMs), redirect: "manual" });
			let r = await get(h ?? {});
			if (r.status === 403 && (await pair(url, true)).ok) {
				h = peerHeaders(token(url)) ?? h;
				r = await get(h ?? {});
			}
			if (r.status === 304 && prev) return { online: true, load: prev.load, legacy: false };
			if (r.status === 404) { last.delete(url); return { online: true, load: null, legacy: true }; }
			if (!r.ok) return { online: false, load: null, legacy: false };
			const l = loadFrom(await r.json());
			if (!l) { last.delete(url); return { online: true, load: null, legacy: true }; }
			const etag = r.headers.get("etag");
			if (etag) last.set(url, { etag, load: l }); else last.delete(url);
			return { online: true, load: l, legacy: false };
		} catch {
			return { online: false, load: null, legacy: false };   // no answer inside the timeout, or the connection failed: the sheet shows it as not connected
		}
	}
	const readOf = (c: Computer): Promise<Read> => {
		let r = reads.get(c.url);
		if (!r) {
			r = cached(deps.refreshMs ?? REFRESH_MS, () => { const p = readPeer(c); running.add(p); void p.finally(() => running.delete(p)); return p; }, now, STALE_OK_MS);
			reads.set(c.url, r);
		}
		return r();
	};

	async function fleet(): Promise<FleetRow[]> {
		const list = await computers();
		const others = list.filter(c => !c.self && !c.via && !c.public);
		for (const url of reads.keys()) if (!others.some(c => c.url === url)) { reads.delete(url); last.delete(url); }
		const self = list.find(c => c.self);
		const mine = load();
		const rows: FleetRow[] = [{ name: mine.name, url: self?.url ?? "", self: true, online: true, state: fleetState(mine, true), load: mine }];
		const answers = await Promise.all(others.map(readOf));
		const sentRows = deps.sent?.() ?? [];
		others.forEach((c, i) => {
			const a = answers[i]!;
			const sent = sentRows.filter(s => s.computer === c.name).map(({ lane, title }) => ({ lane, title }));
			rows.push({ name: c.name, url: c.url, self: false, online: a.online, state: fleetState(a.load, a.online), load: a.load, ...(a.legacy ? { legacy: true as const } : {}), sent });
		});
		return rows;
	}

	async function route(req: Request, url: URL): Promise<Response | undefined> {
		if (req.method !== "GET" && req.method !== "HEAD") return undefined;
		if (url.pathname === "/api/peer/load") {
			const l = load();
			const etag = etagOf(l);
			return etagMatch(req.headers.get("if-none-match"), etag) ? new Response(null, { status: 304, headers: { ETag: etag } }) : Response.json(l, { headers: { ETag: etag } });
		}
		if (url.pathname === "/api/fleet") return json(await fleet());
		return undefined;
	}

	const invalidatePeer = (url: string): void => reads.get(url)?.reset();
	const idle = async (): Promise<void> => { while (running.size) await Promise.all([...running]); };
	return { load, fleet, invalidatePeer, idle, route };
}

// The running gateway's fleet (set by routes.ts); hub/peer-stream.ts calls invalidatePeer when it forwards a peer's counts.
let active: Fleet | undefined;
export const activateFleet = (m: Fleet): void => { active = m; };
export const invalidateFleetPeer = (url: string): void => active?.invalidatePeer(url);
