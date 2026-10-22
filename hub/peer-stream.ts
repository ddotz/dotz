// Other computers' new notices, in this computer's own event stream. A page on computer B hears only B's hub, so while the owner looks at B
// a notice on A would never toast. B's hub therefore follows each discovered peer's GET /api/events (the same request the peer's own page
// makes, through the peer's tailnet identity like every peer request in hub/peers.ts, so the page keeps talking to its own origin only) and
// forwards what matters as two frames in its own stream:
//   {kind:"peer_notice", peer:{name,url}, id, key, notice, tone, title}   a new notice worth a toast (web/js/33-peers.js prLive)
//   {kind:"peer_counts", url, name, online, unread, need}                 the peer's counts after any change (the computer chip)
// Frames from a peer are never re-emitted as notices, and a peer's own peer_* frames are ignored here, so nothing loops between N computers.
import { log } from "./config.ts";
import { broadcast } from "./events.ts";
import { type Found, knownComputers, refreshCounts } from "./peers.ts";

type Computer = Pick<Found, "name" | "url" | "self">;
type Item = { id?: unknown; kind?: unknown; tone?: unknown; title?: unknown; read?: unknown; dismissed?: unknown; ignored?: unknown; at?: unknown; decision?: { state?: unknown; reply_to?: unknown } };

const SCAN_MS = 30_000; // how often the list of computers is re-read (hub/peers.ts caches discovery for a minute)
const IDLE_MS = 75_000; // a hub pings every 25 s; silence this long means a dead connection
const BACKOFF_MS = [2000, 5000, 15_000, 60_000];
const COUNTS_DEBOUNCE_MS = 400;
const SEEN_MAX = 500;

// Which notices toast: what the owner is asked or told about (a question, a finished or failed piece of work, an alert), not the progress lines
// (작업내역) or monitor results, and only while unread. A question and its [ask] message twin are one matter: the caller dedupes by `noticeKey`.
export function toastWorthy(n: Item | undefined): boolean {
	if (!n || typeof n.id !== "string" || !n.id || n.read || n.dismissed || n.ignored) return false;
	if (n.kind === "worklog" || n.kind === "watch") return false;
	if (n.kind === "decision") return n.decision?.state === "open";
	return n.tone === "ask" || n.tone === "fail" || n.tone === "done" || n.kind === "alert";
}

// The asking message's event ts names a question and its twin alike; anything else is told apart by id.
export const noticeKey = (n: Item): string => String(n.decision?.reply_to ?? n.at ?? n.id);

const plain = (s: unknown, max = 80): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// One SSE block ("event:" and "data:" lines) as {event, data}; a ping comment or a block without data is undefined.
export function parseBlock(block: string): { event: string; data: unknown } | undefined {
	let event = "message";
	const data: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	}
	if (!data.length) return undefined;
	try {
		return { event, data: JSON.parse(data.join("\n")) };
	} catch {
		return undefined;
	}
}

type Opts = { computers?: () => Promise<Computer[]>; scanMs?: number; idleMs?: number; backoffMs?: number[]; countsDebounceMs?: number };
type Follow = { name: string; abort: AbortController };

// Starts following every other computer; returns a stop function. Opts exist for tests.
export function startPeerStreams(opts: Opts = {}): () => void {
	const computers = opts.computers ?? knownComputers;
	const idleMs = opts.idleMs ?? IDLE_MS;
	const backoff = opts.backoffMs ?? BACKOFF_MS;
	const debounce = opts.countsDebounceMs ?? COUNTS_DEBOUNCE_MS;
	const follows = new Map<string, Follow>();
	const seen = new Set<string>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let stopped = false;

	const pushCounts = async (url: string): Promise<void> => {
		const f = follows.get(url);
		if (!f) return;
		const c = await refreshCounts(url);
		if (stopped || follows.get(url) !== f) return;
		broadcast({ ts: new Date().toISOString(), kind: "peer_counts", source: "gateway", url, name: f.name, online: c !== undefined, unread: c?.unread ?? 0, need: c?.need ?? 0 });
	};
	const countsSoon = (url: string): void => {
		clearTimeout(timers.get(url));
		timers.set(url, setTimeout(() => void pushCounts(url).catch(() => {}), debounce));
	};

	const onFrame = (url: string, name: () => string, event: string, data: unknown): void => {
		if (event === "reset") { countsSoon(url); return; }
		const e = data as { kind?: unknown; item?: Item } | null;
		if (!e) return;
		if (e.kind === "notice_read" || e.kind === "notice_dismiss") { countsSoon(url); return; }
		if (e.kind !== "notice") return;
		countsSoon(url);
		const n = e.item;
		if (!toastWorthy(n)) return;
		const key = `${url}|${noticeKey(n!)}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
		broadcast({ ts: new Date().toISOString(), kind: "peer_notice", source: "gateway", peer: { name: name(), url }, id: n!.id, key: noticeKey(n!), notice: n!.kind, tone: n!.tone ?? "", title: plain(n!.title) });
	};

	// One connection until it ends, then again after a growing pause (reset to the first when a connection delivered something).
	const follow = async (url: string, f: Follow): Promise<void> => {
		let tries = 0;
		while (!stopped && follows.get(url) === f) {
			const ctl = new AbortController();
			f.abort.signal.addEventListener("abort", () => ctl.abort(), { once: true });
			let idle: ReturnType<typeof setTimeout> | undefined;
			const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), idleMs); };
			try {
				arm();
				const r = await fetch(`${url}/api/events`, { signal: ctl.signal, redirect: "manual", headers: { Accept: "text/event-stream" } });
				if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
				const dec = new TextDecoder();
				let buf = "";
				for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
					arm();
					tries = 0;
					buf += dec.decode(chunk, { stream: true });
					let i: number;
					while ((i = buf.indexOf("\n\n")) >= 0) {
						const block = parseBlock(buf.slice(0, i));
						buf = buf.slice(i + 2);
						if (block) onFrame(url, () => f.name, block.event, block.data);
					}
				}
			} catch {
				// a closed, refused or silent connection: try again below
			} finally {
				clearTimeout(idle);
			}
			if (stopped || follows.get(url) !== f) return;
			void pushCounts(url).catch(() => {});   // the chip learns the peer went away (or the counts it missed)
			await new Promise(r => setTimeout(r, backoff[Math.min(tries++, backoff.length - 1)]));
		}
	};

	const scan = async (): Promise<void> => {
		let list: Computer[] = [];
		try {
			list = await computers();
		} catch (error) {
			log(`peer-stream: list failed: ${(error as Error).message}`);
		}
		if (stopped) return;
		const others = list.filter(c => !c.self);
		for (const c of others) {
			const f = follows.get(c.url);
			if (f) { f.name = c.name; continue; }
			const next: Follow = { name: c.name, abort: new AbortController() };
			follows.set(c.url, next);
			void follow(c.url, next);
		}
		for (const [url, f] of follows) {
			if (others.some(c => c.url === url)) continue;
			f.abort.abort();
			follows.delete(url);
		}
	};

	void scan();
	const timer = setInterval(() => void scan(), opts.scanMs ?? SCAN_MS);
	return () => {
		stopped = true;
		clearInterval(timer);
		for (const t of timers.values()) clearTimeout(t);
		for (const f of follows.values()) f.abort.abort();
		follows.clear();
	};
}
