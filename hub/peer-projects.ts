// The other computers' project lists for the sidebar's computer groups (GET /api/custom/computers, docs/customization.md).
// Each online computer of this owner (hub/peers.ts listPeers, without relay and public rows) is read at GET /api/peer/projects with
// the peer token, the same trust as the merged 모니터링 view (hub/peer-auth.ts). A computer that cannot be read stays listed without
// projects; an offline one is listed as offline. A computer reached through a messenger (hub/relay-route.ts relayRows) is listed with the projects of its
// last status snapshot (hub/relay-snapshot.ts) and the web target of its chat view. Kept for a short while so a sidebar refresh never waits on the network.
import { get as adapterOf, type RelayRow, type RelayStatus } from "./messenger.ts";
import { cached, listPeers, type Peer } from "./peers.ts";
import { peerHeaders, peerTokenFor } from "./peer-auth.ts";
import { createPairer } from "./peer-pair.ts";
import type { PeerProjects, RemoteProject } from "./custom-computers.ts";
import { relayRows } from "./relay-route.ts";
import { peerFetch } from "./tailnet-fetch.ts";

const GET_MS = 4000;
const MAX_REMOTE = 30;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type PeerProjectsDeps = { peers?: () => Promise<Peer[]>; fetch?: Fetch; token?: (url: string) => string | undefined; pair?: (url: string, force?: boolean) => Promise<{ ok: boolean }>; relays?: () => Promise<RelayRow[]>; relayStatus?: (via: string, key: string) => Promise<RelayStatus | undefined> };

// The peer's answer, checked at the boundary: only entries with a string key and name, cut to plain sizes.
export function remoteList(body: unknown): RemoteProject[] | undefined {
	const list = (body as { projects?: unknown } | null)?.projects;
	if (!Array.isArray(list)) return undefined;
	return list
		.filter((x): x is { key: string; name: string; note?: unknown } => !!x && typeof x.key === "string" && !!x.key && typeof x.name === "string" && !!x.name)
		.slice(0, MAX_REMOTE)
		.map(x => ({ key: x.key.slice(0, 300), name: x.name.slice(0, 80), ...(typeof x.note === "string" && x.note ? { note: x.note.slice(0, 200) } : {}) }));
}

export function createPeerProjects(deps: PeerProjectsDeps = {}): () => Promise<PeerProjects[]> {
	const peers = deps.peers ?? listPeers;
	const f: Fetch = deps.fetch ?? ((u, init) => peerFetch(u, init));
	const token = deps.token ?? peerTokenFor;
	const relays = deps.relays ?? relayRows;
	const relayStatus = deps.relayStatus ?? (async (via: string, key: string) => adapterOf(via)?.relay?.status?.(key));
	const pair = deps.pair ?? createPairer({ fetch: f, selfUrl: async () => (await peers()).find(p => p.self)?.url });
	async function read(url: string): Promise<RemoteProject[] | undefined> {
		try {
			let h = peerHeaders(token(url));
			if (!h && (await pair(url)).ok) h = peerHeaders(token(url));
			if (!h) return undefined;
			const get = (hh: Record<string, string>) => f(`${url}/api/peer/projects`, { headers: hh, signal: AbortSignal.timeout(GET_MS), redirect: "manual" });
			let r = await get(h);
			if (r.status === 403 && (await pair(url, true)).ok) r = await get(peerHeaders(token(url)) ?? h);
			return r.ok ? remoteList(await r.json()) : undefined;
		} catch {
			return undefined;
		}
	}
	// A computer reached through a messenger: the projects of its last status snapshot (none yet, or JANDI out of reach: listed without them).
	async function viaRelay(r: RelayRow): Promise<PeerProjects> {
		const s = await relayStatus(r.via ?? "", r.key).catch(() => undefined);
		const projects = s?.snapshot?.projects.slice(0, MAX_REMOTE).map(p => ({ key: p.key, name: p.name, ...(p.note ? { note: p.note } : {}) }));
		const at = s?.received_at ?? r.status_at;
		return { name: r.name, url: r.url, online: r.online, relay: `relay:${r.via}:${r.key}`, ...(projects ? { projects } : {}), ...(at ? { status_at: at } : {}) };
	}
	return async () => {
		const list = (await peers()).filter(p => !p.self && !p.via && !p.public);
		const rows = (await relays().catch(() => [])).filter(r => r.via && r.key);
		return Promise.all([
			...list.map(async p => {
				const projects = p.online ? await read(p.url) : undefined;
				return { name: p.name, url: p.url, online: p.online, ...(projects ? { projects } : {}) };
			}),
			...rows.map(viaRelay),
		]);
	};
}

// The gateway's own loader: a minute fresh, then handed out for another minute while a new read runs behind it.
export const peerProjects = (() => {
	const load = createPeerProjects();
	return cached(60_000, load, Date.now, 60_000);
})();
