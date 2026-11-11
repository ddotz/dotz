// A 리셋권 spent here ends the usage limit for the whole account, so the owner's other dotz gateways on the tailnet are told at once instead of
// waiting for their 5-minute check (hub/limit-watch.ts) or the owner's 재개 there. No model call anywhere in this flow.
//   sender:   liftAfterReset (the reset route): the notice goes out while the local lift runs, one POST per other gateway, bounded by NOTICE_MS in all
//             (the peer list included); a peer that does not answer is logged, never an error of the reset.
//   receiver: peerLimitNotice (POST /api/peer/limit-lift): the gateway may run on another account, so it lifts nothing blindly: it runs its own
//             usage check (hub/limit-lift.ts checkUsageLimit) and lifts only when its own read says the limit is over.
// The body says only that a reset was spent (no account, no token): what peers already share is the limit. A lift caused by a notice goes through
// the usage check, which never sends a notice, so a notice is never passed on.
import { log } from "./config.ts";
import { checkUsageLimit, liftUsageLimit, type Resumed } from "./limit-lift.ts";
import { peerHeaders, peerTokenFor } from "./peer-auth.ts";
import { knownComputers } from "./peers.ts";
import { peerFetch } from "./tailnet-fetch.ts";

export const PEER_LIMIT_PATH = "/api/peer/limit-lift";
export const NOTICE_MS = 2000;
export type Told = { told: number; failed: number };

// Swapped by the tests; nothing else reads it.
export const peerEnv = {
	peers: async (): Promise<Array<{ url: string }>> => (await knownComputers()).filter(f => !f.self),
	post: (url: string, body: string, signal: AbortSignal): Promise<Response> =>
		peerFetch(`${url}${PEER_LIMIT_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...peerHeaders(peerTokenFor(url)) }, body, signal, redirect: "manual" }),
};

// Never rejects. `signal` ends the whole fan-out (list and posts); the default allows NOTICE_MS.
export async function tellPeers(env = peerEnv, signal: AbortSignal = AbortSignal.timeout(NOTICE_MS)): Promise<Told> {
	const late = new Promise<never>((_, no) => {
		const stop = () => no(new Error("no answer in time"));
		if (signal.aborted) stop();
		else signal.addEventListener("abort", stop, { once: true });
	});
	late.catch(() => {}); // only read through the races below
	try {
		const urls = [...new Set((await Promise.race([env.peers(), late])).map(p => p.url))];
		const body = JSON.stringify({ kind: "limit-reset" });
		const sent = await Promise.all(urls.map(async url => {
			try {
				const r = await Promise.race([env.post(url, body, signal), late]);
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return true;
			} catch (e) {
				log(`limit reset: ${new URL(url).host} not told (${(e as Error).message})`);
				return false;
			}
		}));
		return { told: sent.filter(Boolean).length, failed: sent.filter(ok => !ok).length };
	} catch (e) {
		log(`limit reset: other gateways not told (${(e as Error).message})`);
		return { told: 0, failed: 0 };
	}
}

// The reset route's lift: the peers are told while this gateway lifts, and the answer says what went on here and how many peers took the notice.
export async function liftAfterReset(account: string, env = peerEnv): Promise<{ resumed: Resumed; peers: Told }> {
	const peers = tellPeers(env);
	const resumed = await liftUsageLimit(account, "limit reset spent here", true, true);
	return { resumed, peers: await peers };
}

// Notices that arrive together share one check (one usage read).
let checking: Promise<boolean> | undefined;
export async function peerLimitNotice(): Promise<{ ok: true; lifted: boolean }> {
	checking ??= checkUsageLimit().catch(e => {
		log(`usage check asked by another gateway failed: ${(e as Error).message}`);
		return false;
	}).finally(() => { checking = undefined; });
	const lifted = await checking;
	log(`another gateway spent a limit reset: usage check ${lifted ? "lifted the limit here" : "lifted nothing here"}`);
	return { ok: true, lifted };
}
