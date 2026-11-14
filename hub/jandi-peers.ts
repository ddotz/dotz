import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scrub } from "./activity.ts";
import { writeAtomic } from "./config.ts";
import { msg } from "./i18n.ts";
import { checkStatusRoomOf, commandOf, SelfChatError, startsWord, type SelfChat, type SelfChatConfig, type SelfChatPeer } from "./jandi-selfchat.ts";
import { type AdapterPush, RelayError, type RelayLine, type RelayRow, type RelayStatus } from "./messenger.ts";
import { noticeClass } from "./notice-class.ts";
import { decodeSnapshot, isSnapshotText, type Snapshot } from "./relay-snapshot.ts";
import { parseTone, TONE_EMOJI } from "./tone.ts";

// Computers reached only through the owner's JANDI "나와의 대화" (config `self_chat.peers`): this is the JANDI adapter's `relay` (hub/messenger-jandi.ts), served to the
// web app's chat view by hub/relay-route.ts. They have no URL of their own: this gateway reads the one configured room with the owner's session (hub/jandi-selfchat.ts),
// keeps the owner's `<keyword> …` lines and the `<reply_prefix> …` replies of that computer, and posts `<keyword> <text>` as the owner. Online = a reply was seen in the
// last 24 hours (among the room's last 100 messages). A reply that is a status snapshot (hub/relay-snapshot.ts) is not a chat line: the newest one of each peer is kept
// in `<data dir>/messengers/jandi-peer-status.json` (so it outlives the room's last 100 messages and a restart) and served at GET /api/relay/jandi/<key>/status. JANDI's web client API is not documented: a JANDI change shows as an error here, never as an empty list.

export type Line = RelayLine;
type Rec = { id: number; time?: unknown; createdAt?: unknown; fromEntity: number; message?: { content?: { body?: unknown } } };
type Client = Pick<SelfChat, "get" | "post" | "checkRoom">;
export type PeerChatDeps = { config: () => SelfChatConfig | undefined; client: () => Client | undefined; now?: () => number; log?: (msg: string) => void; listWaitMs?: number; /** Where the last status snapshot of each peer is kept; without it they are only remembered while this runs. */ dataDir?: string };

const PAGE = 100;
const CACHE_MS = 2000;
export const ONLINE_MS = 24 * 3600_000;
/** How long the computer list waits on JANDI before it answers with the last known messages (the read goes on and fills them in). */
export const LIST_WAIT_MS = 1500;

const stamp = (r: Rec): number => {
	const v = r.time ?? r.createdAt;
	if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
	return typeof v === "string" ? Date.parse(v) || 0 : 0;
};
const bodyOf = (r: Rec) => (typeof r.message?.content?.body === "string" ? r.message.content.body.trim() : "");

/** The room's messages of one peer's conversation, oldest first: the owner's `<keyword> …` and any `<reply_prefix> …` reply. */
export function linesOf(records: Rec[], member: number, peer: SelfChatPeer): Line[] {
	const out: Line[] = [];
	for (const r of [...records].sort((a, b) => a.id - b.id)) {
		const body = bodyOf(r);
		const mine = r.fromEntity === member ? commandOf(body, peer.keyword) : undefined;
		if (mine) out.push({ id: r.id, at: stamp(r), me: true, text: mine });
		else if (startsWord(body, peer.reply_prefix)) {
			const text = body.slice(peer.reply_prefix.length).trim();
			if (text && !isSnapshotText(text)) out.push({ id: r.id, at: stamp(r), me: false, text });
		}
	}
	return out;
}

type Kept = { id: number; reply_prefix: string; received_at: number; snapshot: Snapshot };
export const STATUS_FILE = "jandi-peer-status.json";

/** The newest snapshot line of one peer among the room's messages (a line that does not parse is passed over), or undefined. */
export function snapshotOf(records: Rec[], peer: SelfChatPeer): Kept | undefined {
	let best: Kept | undefined;
	for (const r of records) {
		const body = bodyOf(r);
		if (!startsWord(body, peer.reply_prefix) || (best && r.id < best.id)) continue;
		const text = body.slice(peer.reply_prefix.length).trim();
		const snapshot = isSnapshotText(text) ? decodeSnapshot(text) : undefined;
		if (snapshot) best = { id: r.id, reply_prefix: peer.reply_prefix, received_at: stamp(r), snapshot };
	}
	return best;
}

/** Online: a reply of the peer is dated within the last 24 hours. */
export const isOnline = (lines: Line[], now: number): boolean => lines.some(l => !l.me && l.at > 0 && now - l.at <= ONLINE_MS);

/** What the JANDI web client posts for a plain text message. */
export const messageBody = (text: string) => ({ text, richText: [{ type: "text_block", elements: [{ type: "text", body: text, style: {} }] }] });

const PUSH_BODY = 120;
/** The row's address in the web app: its chat view. The key is a single path part. */
const chatAddr = (peer: SelfChatPeer) => `/#chat/relay:jandi:${encodeURIComponent(peer.keyword)}`;
/** A peer's new reply (hub/jandi-selfchat.ts peerReply) as a phone notification: titled with the peer's name, the reply's first 120 characters as the body,
 *  a tap opens the peer's chat view. Its status marker picks the class the gateway's own answers get (hub/push.ts classify): [ask] needs an answer,
 *  [done]/[fail] is a result, an unmarked reply a message; [run] progress never notifies. One notification per reply (the tag carries the line id). */
export function peerReplyPush(peer: SelfChatPeer, text: string, id: number): AdapterPush | undefined {
	const { tone, text: rest } = parseTone(text.trim());
	const cls = tone ? noticeClass({ kind: "result", tone }).cls : "conv";
	if (cls !== "ask" && cls !== "result" && cls !== "conv") return undefined;
	const flat = scrub(rest).replace(/\s+/g, " ").trim() || (tone === "fail" ? TONE_EMOJI.fail : "");
	if (!flat) return undefined;
	const body = flat.length > PUSH_BODY ? `${flat.slice(0, PUSH_BODY - 1)}…` : flat;
	return { kind: cls, title: peer.name, body, url: chatAddr(peer), tag: `relay:jandi:${peer.keyword}:${id}` };
}

export function createPeerChats(deps: PeerChatDeps) {
	const now = deps.now ?? Date.now;
	const say = deps.log ?? (() => {});
	let cache: { key: string; at: number; records: Rec[] } | undefined;
	let checked = "";
	let statusChecked = 0;
	let listed: Rec[] | undefined;   // the last messages the computer list read, for when JANDI is slow
	let reading: Promise<Rec[]> | undefined;
	let kept: Record<string, Kept> | undefined;   // the last snapshot per peer keyword, as saved

	const keptFile = deps.dataDir ? join(deps.dataDir, "messengers", STATUS_FILE) : undefined;
	const loadKept = (): Record<string, Kept> => {
		if (kept) return kept;
		kept = {};
		try {
			if (keptFile && existsSync(keptFile)) kept = JSON.parse(readFileSync(keptFile, "utf8")) as Record<string, Kept>;
		} catch (e) {
			say(`jandi peer status: could not read the saved snapshots (${e instanceof Error ? e.message : e})`);
		}
		return kept;
	};
	/** The peer's snapshot: the newest one in `recs` (saved when it is a new one), else the saved one. A saved one of another reply prefix is another computer's. */
	function statusOf(peer: SelfChatPeer, peers: readonly SelfChatPeer[], recs: Rec[] | undefined): Kept | undefined {
		const all = loadKept();
		const old = all[peer.keyword]?.reply_prefix === peer.reply_prefix ? all[peer.keyword] : undefined;
		const found = recs && snapshotOf(recs, peer);
		if (!found || found.id === old?.id) return old;
		for (const k of Object.keys(all)) if (!peers.some(p => p.keyword === k)) delete all[k];   // a peer removed from the config is forgotten
		all[peer.keyword] = found;
		try {
			if (keptFile) {
				mkdirSync(join(deps.dataDir!, "messengers"), { recursive: true });
				writeAtomic(keptFile, `${JSON.stringify(all)}\n`, 0o600);
			}
		} catch (e) {
			say(`jandi peer ${peer.keyword}: could not save the snapshot (${e instanceof Error ? e.message : e})`);
		}
		return found;
	}

	/** The configured peers, only while the room is fully configured and polling is on. */
	const active = () => {
		const c = deps.config();
		return c?.enabled && c.team_id && c.room_id && c.member_id && c.bot_id && c.peers?.length ? { c, peers: c.peers } : undefined;
	};

	/** The room's latest messages; the room is checked to be the owner's own chat with the JANDI bot before the first read. */
	async function records(c: SelfChatConfig): Promise<Rec[]> {
		const client = deps.client();
		if (!client) throw new SelfChatError("잔디 나와의 대화가 꺼져 있어요");
		const key = `${c.team_id}/${c.room_id}/${c.status_room_id ?? ""}`;
		if (cache?.key === key && now() - cache.at < CACHE_MS) return cache.records;
		if (checked !== key) {
			await client.checkRoom();
			checked = key;
		}
		const j = (await client.get(`message-api/v2/teams/${c.team_id}/rooms/${c.room_id}/messages?count=${PAGE}`, 2)) as { records?: unknown };
		cache = { key, at: now(), records: [...((Array.isArray(j?.records) ? j.records : []) as Rec[]), ...(await statusRecords(client, c))] };
		return cache.records;
	}

	/** The status room's latest messages (none without one): the peers post their snapshots there, out of the owner's chat. A failure there leaves the chat readable. */
	async function statusRecords(client: Client, c: SelfChatConfig): Promise<Rec[]> {
		const room = c.status_room_id;
		if (!room) return [];
		try {
			if (statusChecked !== room) await checkStatusRoomOf(client.get, c, room);
			statusChecked = room;
			const j = (await client.get(`message-api/v2/teams/${c.team_id}/rooms/${room}/messages?count=${PAGE}`, 2)) as { records?: unknown };
			return (Array.isArray(j?.records) ? j.records : []) as Rec[];
		} catch (e) {
			say(`jandi peer status: ${e instanceof SelfChatError ? e.message : "the status room could not be read"}`);
			return [];
		}
	}

	/** The peer behind `key`, and the room's lines, or a RelayError (404: not configured; 502: JANDI could not be reached). */
	async function lookup(key: string) {
		const a = active();
		const peer = a?.peers.find(p => p.keyword === key);
		if (!a || !peer) throw new RelayError(msg().relay.gone, 404);
		return { c: a.c, peer };
	}
	const fail = (peer: SelfChatPeer, e: unknown): never => {
		const msg = e instanceof SelfChatError ? e.message : "잔디에 연결하지 못했어요";
		say(`jandi peer ${peer.keyword}: ${msg}`);
		throw new RelayError(msg);
	};

	return {
		/** One row per configured peer for the computer list; a JANDI failure leaves the row, offline. JANDI gets at most `listWaitMs`:
		 *  past that the rows use the last known messages (none yet: offline), so a slow JANDI never holds up the list. */
		async rows(): Promise<RelayRow[]> {
			const a = active();
			if (!a) return [];
			const fresh = (reading ??= records(a.c)
				.then(r => (listed = r))
				.finally(() => {
					reading = undefined;
				}));
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<Rec[] | undefined>(res => {
				timer = setTimeout(() => res(listed), deps.listWaitMs ?? LIST_WAIT_MS);
			});
			const recs = await Promise.race([fresh.catch(() => undefined), late]);
			clearTimeout(timer);
			return a.peers.map(p => {
				const at = statusOf(p, a.peers, recs)?.received_at;
				return { name: p.name, url: chatAddr(p), self: false, online: !!recs && isOnline(linesOf(recs, a.c.member_id, p), now()), via: "jandi" as const, key: p.keyword, note: msg().relay.note, ...(at ? { status_at: at } : {}) };
			});
		},

		/** One peer's conversation, oldest first. */
		async lines(key: string): Promise<Line[]> {
			const { c, peer } = await lookup(key);
			try {
				return linesOf(await records(c), c.member_id, peer);
			} catch (e) {
				return fail(peer, e);
			}
		},

		/** The peer's last status snapshot (null before the first): the newest one among the room's messages, else the saved one. JANDI out of reach is
		 *  an error only when nothing is saved. */
		async status(key: string): Promise<RelayStatus> {
			const { c, peer } = await lookup(key);
			let recs: Rec[] | undefined;
			try {
				recs = await records(c);
			} catch (e) {
				if (!statusOf(peer, c.peers!, undefined)) return fail(peer, e);
			}
			const k = statusOf(peer, c.peers!, recs);
			return k ? { snapshot: k.snapshot, ...(k.received_at ? { received_at: k.received_at } : {}) } : { snapshot: null };
		},

		/** Posts `<keyword> <text>` to the room as the owner. */
		async send(key: string, text: string): Promise<void> {
			const { c, peer } = await lookup(key);
			try {
				await records(c);
				await deps.client()!.post(`message-api/v3/teams/${c.team_id}/rooms/${c.room_id}/messages`, 3, messageBody(`${peer.keyword} ${text}`));
				cache = undefined;
				say(`jandi peer ${peer.keyword}: sent one message`);
			} catch (e) {
				fail(peer, e);
			}
		},
	};
}
