import { log } from "./config.ts";
import { commandOf, SelfChatError, type SelfChat, type SelfChatConfig, type SelfChatPeer } from "./jandi-selfchat.ts";
import { jandiAdapter, loadJandiConfig } from "./messenger-jandi.ts";
import type { Peer } from "./peers.ts";

// Computers reached only through the owner's JANDI "나와의 대화" (config `self_chat.peers`) listed next to the Tailscale ones, and the chat page that serves them.
// They have no URL of their own: this gateway reads the one configured room with the owner's session (hub/jandi-selfchat.ts), keeps the owner's
// `<keyword> …` lines and the `<reply_prefix> …` replies of that computer, and posts `<keyword> <text>` as the owner. Online = a reply was seen in the
// last 24 hours (among the room's last 100 messages). The routes sit behind the owner / device gate of hub/routes.ts and are not in the peer path lists
// of hub/peer-auth.ts. JANDI's web client API is not documented: a JANDI change shows as an error here, never as an empty list.

export type Line = { id: number; at: number; me: boolean; text: string };
type Rec = { id: number; time?: unknown; createdAt?: unknown; fromEntity: number; message?: { content?: { body?: unknown } } };
type Client = Pick<SelfChat, "get" | "post" | "checkRoom">;
export type PeerChatDeps = { config: () => SelfChatConfig | undefined; client: () => Client | undefined; now?: () => number; log?: (msg: string) => void; listWaitMs?: number };

const MAX_TEXT = 4000;
const MAX_BODY = 64 * 1024;
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
const startsWord = (body: string, word: string) => body === word || body.startsWith(`${word} `) || body.startsWith(`${word}\n`);
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
			if (text) out.push({ id: r.id, at: stamp(r), me: false, text });
		}
	}
	return out;
}

/** Online: a reply of the peer is dated within the last 24 hours. */
export const isOnline = (lines: Line[], now: number): boolean => lines.some(l => !l.me && l.at > 0 && now - l.at <= ONLINE_MS);

/** What the JANDI web client posts for a plain text message. */
export const messageBody = (text: string) => ({ text, richText: [{ type: "text_block", elements: [{ type: "text", body: text, style: {} }] }] });

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const pagePath = (p: SelfChatPeer) => `/jandi-peer/${encodeURIComponent(p.keyword)}`;

/** The old stand-alone chat page: kept as a fallback only. The web app's own chat view (web/js/42-jandi-chat.js) uses the JSON endpoints below and no longer links here. */
export function page(peer: SelfChatPeer): string {
	const api = JSON.stringify(`/api${pagePath(peer)}`).replace(/</g, "\\u003c");
	return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(peer.name)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;display:flex;flex-direction:column;height:100vh;background:Canvas;color:CanvasText}
header{padding:10px 14px;border-bottom:1px solid #8884;font-weight:600}header a{color:inherit;text-decoration:none;margin-right:10px}header small{font-weight:400;opacity:.7;margin-left:6px}
#log{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.m{max-width:85%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;word-break:break-word}
.me{align-self:flex-end;background:#2f6fed;color:#fff}.it{align-self:flex-start;background:#8882}
.t{font-size:11px;opacity:.6;margin-top:2px}#err{color:#d33;padding:0 14px;min-height:1em}
form{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #8884}textarea{flex:1;font:inherit;resize:none;height:44px;padding:8px;border-radius:10px;border:1px solid #8886;background:Canvas;color:CanvasText}
button{font:inherit;padding:0 16px;border-radius:10px;border:0;background:#2f6fed;color:#fff}button:disabled{opacity:.5}
</style></head><body>
<header><a href="/" aria-label="돌아가기">←</a>${esc(peer.name)}<small>잔디 나와의 대화로 주고받아요</small></header>
<div id="log"></div><div id="err"></div>
<form id="f"><textarea id="t" maxlength="${MAX_TEXT}" placeholder="${esc(peer.name)}에 시킬 일을 적어 주세요" required></textarea><button id="b">보내기</button></form>
<script>
const API=${api},log=document.getElementById("log"),err=document.getElementById("err"),t=document.getElementById("t"),b=document.getElementById("b");
let last="";
const fmt=a=>a?new Date(a).toLocaleString("ko-KR",{hour12:false,month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):"";
const fail=async r=>{throw new Error((await r.json().catch(()=>({}))).error||("HTTP "+r.status))};
async function load(){try{const r=await fetch(API+"/messages",{cache:"no-store"});if(!r.ok)await fail(r);
const lines=await r.json();const key=lines.map(l=>l.id).join(",");if(key===last){err.textContent="";return}last=key;
const stick=log.scrollTop+log.clientHeight>=log.scrollHeight-40;log.replaceChildren(...lines.map(l=>{const d=document.createElement("div");d.className="m "+(l.me?"me":"it");d.textContent=l.text;const s=document.createElement("div");s.className="t";s.textContent=fmt(l.at);d.append(s);return d}));
if(stick)log.scrollTop=log.scrollHeight;err.textContent=""}catch(e){err.textContent="불러오지 못했어요: "+e.message}}
document.getElementById("f").onsubmit=async e=>{e.preventDefault();const text=t.value.trim();if(!text)return;b.disabled=true;
try{const r=await fetch(API+"/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});if(!r.ok)await fail(r);t.value="";last="";await load();log.scrollTop=log.scrollHeight}
catch(e){err.textContent="보내지 못했어요: "+e.message}finally{b.disabled=false}};
t.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();document.getElementById("f").requestSubmit()}};
load();setInterval(()=>{if(!document.hidden)load()},3000);
</script></body></html>`;
}

const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
const PAGE_RE = /^\/jandi-peer\/([^/]+)\/?$/;
const API_RE = /^\/api\/jandi-peer\/([^/]+)\/(messages|send)$/;

export function createPeerChats(deps: PeerChatDeps) {
	const now = deps.now ?? Date.now;
	const say = deps.log ?? (() => {});
	let cache: { key: string; at: number; records: Rec[] } | undefined;
	let checked = "";
	let listed: Rec[] | undefined;   // the last messages the computer list read, for when JANDI is slow
	let reading: Promise<Rec[]> | undefined;

	/** The configured peers, only while the room is fully configured and polling is on. */
	const active = () => {
		const c = deps.config();
		return c?.enabled && c.team_id && c.room_id && c.member_id && c.bot_id && c.peers?.length ? { c, peers: c.peers } : undefined;
	};

	/** The room's latest messages; the room is checked to be the owner's own chat with the JANDI bot before the first read. */
	async function records(c: SelfChatConfig): Promise<Rec[]> {
		const client = deps.client();
		if (!client) throw new SelfChatError("잔디 나와의 대화가 꺼져 있어요");
		const key = `${c.team_id}/${c.room_id}`;
		if (cache?.key === key && now() - cache.at < CACHE_MS) return cache.records;
		if (checked !== key) {
			await client.checkRoom();
			checked = key;
		}
		const j = (await client.get(`message-api/v2/teams/${c.team_id}/rooms/${c.room_id}/messages?count=${PAGE}`, 2)) as { records?: unknown };
		cache = { key, at: now(), records: (Array.isArray(j?.records) ? j.records : []) as Rec[] };
		return cache.records;
	}

	return {
		/** One row per configured peer for the computer list; a JANDI failure leaves the row, offline. JANDI gets at most `listWaitMs`:
		 *  past that the rows use the last known messages (none yet: offline), so a slow JANDI never holds up the list. */
		async rows(): Promise<Peer[]> {
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
			return a.peers.map(p => ({ name: p.name, url: pagePath(p), self: false, online: !!recs && isOnline(linesOf(recs, a.c.member_id, p), now()), via: "jandi" as const }));
		},

		/** The Tailscale list as it is, then the JANDI rows. */
		async append(list: Peer[]): Promise<Peer[]> {
			return [...list, ...(await this.rows())];
		},

		/** The chat page and its JSON endpoints, or undefined for any other path. Call it only after the owner / device gate. */
		async route(req: Request, url: URL): Promise<Response | undefined> {
			const pm = PAGE_RE.exec(url.pathname);
			const am = pm ? null : API_RE.exec(url.pathname);
			if (!pm && !am) return undefined;
			let keyword: string;
			try {
				keyword = decodeURIComponent((pm ?? am)![1]!);
			} catch {
				return json({ error: "not found" }, 404);
			}
			const a = active();
			const peer = a?.peers.find(p => p.keyword === keyword);
			if (!a || !peer) return json({ error: "not found" }, 404);
			if (pm) {
				if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
				return new Response(req.method === "HEAD" ? null : page(peer), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
			}
			const isSend = am![2] === "send";
			if (req.method !== (isSend ? "POST" : "GET")) return json({ error: "method not allowed" }, 405);
			try {
				if (!isSend) return json(linesOf(await records(a.c), a.c.member_id, peer));
				if (!(req.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "JSON으로 보내 주세요" }, 415);
				const raw = await req.text();
				if (raw.length > MAX_BODY) return json({ error: "너무 길어요" }, 413);
				let text = "";
				try {
					const b = JSON.parse(raw) as { text?: unknown };
					if (typeof b?.text === "string") text = b.text.trim();
				} catch {}
				if (!text || text.length > MAX_TEXT) return json({ error: `1~${MAX_TEXT}자로 적어 주세요` }, 400);
				await records(a.c);
				await deps.client()!.post(`message-api/v3/teams/${a.c.team_id}/rooms/${a.c.room_id}/messages`, 3, messageBody(`${peer.keyword} ${text}`));
				cache = undefined;
				say(`jandi peer ${peer.keyword}: sent one message`);
				return json({ ok: true });
			} catch (e) {
				const msg = e instanceof SelfChatError ? e.message : "잔디에 연결하지 못했어요";
				say(`jandi peer ${peer.keyword}: ${msg}`);
				return json({ error: msg }, 502);
			}
		},
	};
}

/** This gateway's own: the config of DATA_DIR and the session of the running self-chat adapter. */
export const jandiPeerChats = createPeerChats({ config: () => loadJandiConfig().self_chat, client: () => jandiAdapter.selfChat(), log });
