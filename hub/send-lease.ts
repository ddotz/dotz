// Send exactly once across computers (docs/peer-monitoring.md, "App messages across computers"). A lease per `<app>:<room key>`
// says which gateway may send now, and a list of sent ids says what was already sent. Store: <data dir>/state/send-leases.json,
// written by tmp file + rename. handleLease answers POST /api/peer/lease; sendOnce is the sender side.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";

const MAX_SENT = 500; // sent ids kept per key
const MAX_LEASE_MS = 10 * 60_000; // a lease never reaches further than this, so a wrong peer clock cannot lock a room
const DEFAULT_LEASE_MS = 60_000;
const POST_TIMEOUT_MS = 2500;

export const leasePath = (dataDir: string = DATA_DIR) => join(dataDir, "state", "send-leases.json");

export type LeaseReq = { op: "claim" | "release" | "sent"; key: string; holder: string; until?: number; id?: string };
export type LeaseReply = { ok: boolean; holder?: string; reason?: string };
type Store = { leases: Record<string, { holder: string; until: number }>; sent: Record<string, string[]> };

function load(path: string): Store {
	try {
		const o = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
		return { leases: o.leases && typeof o.leases === "object" ? o.leases : {}, sent: o.sent && typeof o.sent === "object" ? o.sent : {} };
	} catch {
		return { leases: {}, sent: {} };
	}
}

function save(path: string, s: Store, now: number): void {
	for (const [k, l] of Object.entries(s.leases)) if (l.until <= now) delete s.leases[k];
	for (const [k, ids] of Object.entries(s.sent)) s.sent[k] = ids.slice(-MAX_SENT);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(s));
	renameSync(tmp, path);
}

// One lease request. Synchronous, so two requests in one process never interleave.
export function handleLease(req: LeaseReq, now: number, path: string = leasePath()): LeaseReply {
	if (!req || typeof req.key !== "string" || !req.key || typeof req.holder !== "string" || !req.holder) return { ok: false, reason: "bad_request" };
	const s = load(path);
	const cur = s.leases[req.key];
	const held = cur && cur.until > now && cur.holder !== req.holder ? cur : undefined;
	let reply: LeaseReply;
	if (req.op === "claim") {
		if (req.id && s.sent[req.key]?.includes(req.id)) return { ok: false, reason: "already_sent" };
		if (held) return { ok: false, holder: held.holder, reason: "held" };
		const until = Math.min(typeof req.until === "number" && Number.isFinite(req.until) ? req.until : now + DEFAULT_LEASE_MS, now + MAX_LEASE_MS);
		s.leases[req.key] = { holder: req.holder, until };
		reply = { ok: true, holder: req.holder };
	} else if (req.op === "release") {
		if (held) return { ok: false, holder: held.holder, reason: "held" };
		if (cur?.holder === req.holder) delete s.leases[req.key];
		reply = { ok: true };
	} else if (req.op === "sent") {
		if (typeof req.id !== "string" || !req.id) return { ok: false, reason: "bad_request" };
		const ids = (s.sent[req.key] ??= []);
		if (!ids.includes(req.id)) ids.push(req.id);
		reply = { ok: true };
	} else return { ok: false, reason: "bad_request" };
	save(path, s, now);
	return reply;
}

export type SendOnceOpts<P, T> = {
	key: string;
	id: string;
	self: string;
	ttlMs: number;
	send: () => Promise<T>;
	peers: P[]; // the online peers
	post: (peer: P, path: string, body: LeaseReq) => Promise<LeaseReply>; // rejects when the peer cannot be reached
	now: () => number;
	// Default false: a peer that cannot be reached does not hold the lease, because an offline computer cannot be the logged-in
	// sender, so one dead peer must not stop all sending. Set true to refuse (reason "unreachable") unless every peer answers.
	requireAllPeers?: boolean;
	path?: string; // lease store file; default <data dir>/state/send-leases.json
	timeoutMs?: number;
	keep?: boolean; // claimLease: keep the granted lease until it expires instead of releasing it after send
};
export type SendOnceResult<T> = { ok: true; result: T } | { ok: false; reason: "held"; holder?: string } | { ok: false; reason: "already_sent" } | { ok: false; reason: "unreachable" } | { ok: false; reason: "error"; error: string };

// Claims the lease here and on every online peer, then sends. Any refusal releases what was claimed and does not send.
export async function sendOnce<P, T>(o: SendOnceOpts<P, T>): Promise<SendOnceResult<T>> {
	const { key, id, self } = o;
	const lease = (op: LeaseReq["op"], extra: Partial<LeaseReq> = {}): LeaseReq => ({ op, key, holder: self, ...extra });
	const ask = (p: P, req: LeaseReq): Promise<LeaseReply | undefined> =>
		new Promise(resolve => {
			const timer = setTimeout(() => resolve(undefined), o.timeoutMs ?? POST_TIMEOUT_MS);
			const done = (r: LeaseReply | undefined) => { clearTimeout(timer); resolve(r); };
			try {
				o.post(p, "/api/peer/lease", req).then(done, () => done(undefined));
			} catch {
				done(undefined);
			}
		});
	const local = (req: LeaseReq) => handleLease(req, o.now(), o.path);

	const mine = local(lease("claim", { until: o.now() + o.ttlMs, id }));
	if (!mine.ok) return mine.reason === "already_sent" ? { ok: false, reason: "already_sent" } : { ok: false, reason: "held", holder: mine.holder };

	const replies = await Promise.all(o.peers.map(async p => ({ p, r: await ask(p, lease("claim", { until: o.now() + o.ttlMs, id })) })));
	const claimed = replies.filter(x => x.r?.ok).map(x => x.p);
	const release = async () => {
		local(lease("release"));
		await Promise.all(claimed.map(p => ask(p, lease("release"))));
	};
	const refused = replies.find(x => x.r && !x.r.ok);
	if (refused?.r) {
		await release();
		return refused.r.reason === "already_sent" ? { ok: false, reason: "already_sent" } : { ok: false, reason: "held", holder: refused.r.holder };
	}
	if (o.requireAllPeers && replies.some(x => !x.r)) {
		await release();
		return { ok: false, reason: "unreachable" };
	}

	let result: T;
	try {
		result = await o.send();
	} catch (error) {
		await release();
		return { ok: false, reason: "error", error: (error as Error).message };
	}
	if (o.keep) return { ok: true, result };
	local(lease("sent", { id }));
	await Promise.all(claimed.map(p => ask(p, lease("sent", { id }))));
	await release();
	return { ok: true, result };
}

// The claim half of sendOnce for a sender that has its own send path (KakaoTalk's dispatchSend lease hook): claim here and on every online
// peer, release on any refusal. A granted lease is kept until it expires, so the other computer cannot send into that room meanwhile.
export async function claimLease<P>(o: Omit<SendOnceOpts<P, void>, "send" | "id"> & { id?: string }): Promise<{ ok: true } | { ok: false; reason: string; holder?: string }> {
	const r = await sendOnce({ ...o, id: o.id ?? "", send: async () => {}, keep: true });
	return r.ok ? { ok: true } : { ok: false, reason: r.reason, ...(r.reason === "held" ? { holder: r.holder } : {}) };
}

// Posts a lease request to a peer gateway with the shared peer token (hub/peer-auth.ts); rejects when it cannot be reached or refuses the token.
export async function postLease(url: string, path: string, body: LeaseReq, headers: Record<string, string> | undefined, timeoutMs = POST_TIMEOUT_MS): Promise<LeaseReply> {
	if (!headers) throw new Error("no peer token");
	const r = await fetch(`${url}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return (await r.json()) as LeaseReply;
}
