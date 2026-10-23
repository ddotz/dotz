// The merged 모니터링 across gateways (docs/peer-monitoring.md). Four routes, one cache:
//   GET  /api/peer/monitoring     this gateway's snapshot {name, rev, monitors, notices, integrations, available (the apps switched off there), conversations}, ETag = rev
//   GET  /api/monitoring/peers    every other gateway's snapshot from the cache: [{name, url, online, stale, items}]
//   GET|POST /api/peer/proxy      the page's way to a peer (pc must be a known peer origin; GET only the peer read list, POST only /api/peer/act)
//   POST /api/peer/act            an action forwarded here; it runs through this gateway's own handlers, so the owner's web and history show it
// A peer is read at most once per 20 s (If-None-Match), and again when hub/peer-stream.ts reports a change (invalidatePeer). The page's request
// never waits on a refresh, except the very first read of a peer (bounded by the 2.5 s fetch timeout, all peers in parallel).
// Everything outside (fetch, computers, clock, token, the local handler) is injected, so tests run two gateways in one process.
import { createHash } from "node:crypto";
import { PEER_GET, peerHeaders, peerToken } from "./peer-auth.ts";
import { knownComputers } from "./peers.ts";
import { json } from "./routes-util.ts";

export type Computer = { name: string; url: string; self: boolean };
export type Snapshot = { name: string; rev: string; monitors: unknown[]; notices: unknown[]; integrations: unknown[]; available: unknown[]; conversations: unknown[] };
export type PeerView = { name: string; url: string; online: boolean; stale: boolean; items: Snapshot | null };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type MonitorDeps = {
	name: () => string;                                       // this gateway's machine name
	local: (req: Request) => Promise<Response>;               // this gateway's own handler chain (the same one the web app talks to)
	localHeaders?: Record<string, string>;                    // what makes a local request pass the owner check
	computers?: () => Promise<Computer[]>;
	fetch?: Fetcher;
	now?: () => number;
	token?: () => string | undefined;
	timeoutMs?: number;
	postTimeoutMs?: number;
	refreshMs?: number;
};

const GET_MS = 2500;
const POST_MS = 15_000;
const REFRESH_MS = 20_000;
const FROM_MAX = 40;
const LOCAL = "http://local";
const OFFLINE = { error: "연결 안 됨" };

const isConv = (c: unknown) => /^(mail|kakao):/.test(String((c as { target?: unknown })?.target ?? ""));
const originOf = (u: string): string | undefined => {
	try {
		return new URL(u).origin;
	} catch {
		return undefined;
	}
};
// A message target of the web ("lane:x", "mail:k", "ch:id", "alert", "worklog", "main") as the fields /api/message takes.
function targetFields(target: unknown): Record<string, string> | undefined {
	const t = typeof target === "string" ? target : "main";
	if (t === "main" || t === "chat") return {};
	if (t === "alert" || t === "worklog") return { conv: t };
	const [kind, rest] = [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)];
	if (!rest || t.indexOf(":") < 0) return undefined;
	if (kind === "lane") return { lane: rest };
	if (kind === "mail") return { mail: rest };
	if (kind === "ch") return { project: t };
	if (kind === "settings") return { settings: rest };
	return undefined;
}

type Entry = { computer: Computer; items: Snapshot | null; online: boolean; at: number };
export type PeerMonitor = {
	snapshot: () => Promise<Snapshot>;
	peerMonitoring: () => Promise<PeerView[]>;
	invalidatePeer: (url: string) => void;
	idle: () => Promise<void>;   // resolves when no refresh is running (tests)
	route: (req: Request, url: URL) => Promise<Response | undefined>;
};

export function createPeerMonitor(deps: MonitorDeps): PeerMonitor {
	const f: Fetcher = deps.fetch ?? ((u, init) => fetch(u, init));
	const now = deps.now ?? Date.now;
	const token = deps.token ?? (() => peerToken());
	const computers = deps.computers ?? knownComputers;
	const getMs = deps.timeoutMs ?? GET_MS;
	const postMs = deps.postTimeoutMs ?? POST_MS;
	const refreshMs = deps.refreshMs ?? REFRESH_MS;
	const cache = new Map<string, Entry>();
	const inflight = new Map<string, Promise<void>>();
	const dirty = new Set<string>();

	const ask = (method: string, path: string, data?: unknown, login?: string) =>
		deps.local(new Request(`${LOCAL}${path}`, {
			method,
			headers: { ...deps.localHeaders, ...(login ? { "tailscale-user-login": login } : {}), ...(data === undefined ? {} : { "content-type": "application/json" }) },
			...(data === undefined ? {} : { body: JSON.stringify(data) }),
		}));
	const read = async (path: string): Promise<any> => (await ask("GET", path)).json();

	const PARTS = ["/api/monitors", "/api/notices?limit=100", "/api/integrations", "/api/conversations"];
	const build = (name: string, [m, n, i, c]: any[]): Snapshot => {
		const part = { name, monitors: m?.items ?? [], notices: n?.items ?? [], integrations: i?.items ?? [], available: i?.available ?? [], conversations: (c?.items ?? []).filter(isConv) };
		return { ...part, rev: createHash("sha1").update(JSON.stringify(part)).digest("hex").slice(0, 12) };
	};
	const snapshot = async (): Promise<Snapshot> => build(deps.name(), await Promise.all(PARTS.map(read)));

	// An older peer (404 on /api/peer/monitoring) or no shared token here: the four plain reads, which the peer allows through the owner's
	// tailnet identity like the computer switcher's reads. Read-only: forwarded actions always need the token.
	async function legacy(e: Entry, h: Record<string, string>): Promise<Snapshot> {
		const parts = await Promise.all(PARTS.map(async p => {
			const r = await f(`${e.computer.url}${p}`, { headers: h, signal: AbortSignal.timeout(getMs), redirect: "manual" });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.json();
		}));
		return build(e.computer.name, parts);
	}

	// One read of a peer. Never throws: any failure leaves the last items in place and marks the peer offline.
	async function load(e: Entry): Promise<void> {
		const h = peerHeaders(token());
		try {
			if (!h) {
				e.items = await legacy(e, {});
				e.online = true;
				e.at = now();
				return;
			}
			const r = await f(`${e.computer.url}/api/peer/monitoring`, { headers: { ...h, ...(e.items ? { "if-none-match": `"${e.items.rev}"` } : {}) }, signal: AbortSignal.timeout(getMs), redirect: "manual" });
			if (r.status === 304 && e.items) e.online = true;
			else if (r.ok) {
				const s = (await r.json()) as Snapshot;
				if (!s || typeof s !== "object" || typeof s.rev !== "string") throw new Error("not a snapshot");
				e.items = s;
				e.online = true;
			} else if (r.status === 404) {
				const s = await legacy(e, h);
				if (s.rev !== e.items?.rev) e.items = s;
				e.online = true;
			} else throw new Error(`HTTP ${r.status}`);
		} catch {
			e.online = false;
		}
		e.at = now();
	}
	function refresh(e: Entry): Promise<void> {
		const url = e.computer.url;
		const running = inflight.get(url);
		if (running) { dirty.add(url); return running; }
		const p = load(e).finally(() => {
			inflight.delete(url);
			if (dirty.delete(url) && cache.get(url) === e) void refresh(e);
		});
		inflight.set(url, p);
		return p;
	}

	async function peerMonitoring(): Promise<PeerView[]> {
		const others = (await computers()).filter(c => !c.self);
		for (const url of cache.keys()) if (!others.some(c => c.url === url)) cache.delete(url);
		const fresh: Promise<void>[] = [];
		for (const c of others) {
			let e = cache.get(c.url);
			if (!e) {
				e = { computer: c, items: null, online: false, at: 0 };
				cache.set(c.url, e);
				fresh.push(refresh(e));
			} else {
				e.computer = c;
				if (now() - e.at >= refreshMs) void refresh(e);
			}
		}
		await Promise.all(fresh);
		return others.map(c => {
			const e = cache.get(c.url)!;
			return { name: c.name, url: c.url, online: e.online, stale: !e.online && e.items !== null, items: e.items };
		});
	}

	function invalidatePeer(url: string): void {
		const e = cache.get(url);
		if (e) void refresh(e);
	}

	const etagMatch = (header: string | null, rev: string) => !!header && header.split(",").some(t => t.trim().replace(/^W\//, "").replace(/"/g, "") === rev);

	async function proxy(req: Request, url: URL): Promise<Response> {
		const h = peerHeaders(token());
		const pc = originOf(url.searchParams.get("pc") ?? "");
		const target = (await computers()).find(c => !c.self && originOf(c.url) === pc);
		if (!target || !pc) return json({ error: "unknown computer" }, 400);
		const p = url.searchParams.get("p") ?? "";
		const parsed = p.startsWith("/") && !p.startsWith("//") ? new URL(p, LOCAL) : undefined;
		const get = req.method === "GET";
		const allowed = !!parsed && parsed.origin === LOCAL && (get ? PEER_GET.some(r => r.test(parsed.pathname)) : parsed.pathname === "/api/peer/act");
		if (!allowed || !parsed) return json({ error: "path not allowed" }, 400);
		if (!h && !get) return json({ error: "peering is off" }, 503);
		let init: RequestInit = { method: req.method, headers: h ?? {}, signal: AbortSignal.timeout(get ? getMs : postMs), redirect: "manual" };
		if (!get) {
			// The owner records who asked: the sender's own name replaces whatever the page sent.
			let b: Record<string, unknown>;
			try {
				b = (await req.json()) as Record<string, unknown>;
			} catch {
				return json({ error: "json body required" }, 400);
			}
			init = { ...init, headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ ...b, from: deps.name() }) };
		}
		try {
			const r = await f(`${target.url}${parsed.pathname}${parsed.search}`, init);
			const type = r.headers.get("content-type");
			return new Response(r.status === 204 || r.status === 304 ? null : await r.arrayBuffer(), { status: r.status, ...(type ? { headers: { "content-type": type } } : {}) });
		} catch {
			return json(OFFLINE, 502);
		}
	}

	// A forwarded action, run through the same local handlers as the owner's own web app; `via` records who asked.
	async function act(req: Request): Promise<Response> {
		const b = (await req.json().catch(() => ({}))) as { action?: unknown; args?: unknown; from?: unknown };
		const from = String(b.from ?? "").replace(/\s+/g, " ").trim().slice(0, FROM_MAX);
		const a = (b.args && typeof b.args === "object" ? b.args : {}) as Record<string, any>;
		if (!from) return json({ error: "from required" }, 400);
		const login = req.headers.get("tailscale-user-login") ?? undefined;
		const bad = (error: string) => json({ error }, 400);
		switch (b.action) {
			case "message": {
				const fields = targetFields(a.target);
				if (!fields) return bad("unknown target");
				const pick = (k: string) => (a[k] === undefined ? {} : { [k]: a[k] });
				return ask("POST", "/api/message", { ...fields, ...pick("text"), ...pick("mode"), ...pick("reply"), ...pick("reply_to"), ...pick("picks"), via: from }, login);
			}
			case "answer":
				if (typeof a.id !== "string" || !a.id) return bad("id required");
				return ask("POST", `/api/notices/${encodeURIComponent(a.id)}/answer`, { n: a.n, note: a.note, via: from }, login);
			case "read":
				return ask("POST", "/api/read", { target: a.target, ts: a.ts }, login);
			case "watch": {
				const name = encodeURIComponent(String(a.name ?? ""));
				if (!a.name) return bad("name required");
				if (a.op === "pause" || a.op === "resume") return ask("PATCH", `/api/watches/${name}`, { paused: a.op === "pause" }, login);
				if (a.op === "run") return ask("POST", `/api/watches/${name}/run`, {}, login);
				// A monitor's settings (hub/watch-settings.ts): the same plain PATCH the owner's web sends, with the change set as `values`.
				if (a.op === "settings") return ask("PATCH", `/api/watches/${name}/settings`, { values: a.values }, login);
				return bad("op must be pause, resume, run or settings");
			}
			// An app's switch, settings, 제거 and 앱 추가 on the machine that owns the app (hub/app-off.ts): off and remove are per machine, so the web sends them here, never to its own gateway.
			case "app": {
				const app = encodeURIComponent(String(a.app ?? ""));
				if (!a.app) return bad("app required");
				// A new instance of an app (POST /api/apps; `app` = the app key) and the delete of an off one (DELETE /api/apps/<id>; `app` = the instance id).
				if (a.op === "create") return ask("POST", "/api/apps", { app: a.app, label: a.label, filter: a.filter, id: a.id }, login);
				if (a.op === "delete") return ask("DELETE", `/api/apps/${app}${a.deleteData === true ? "?data=1" : ""}`, undefined, login);
				if (a.op === "settings") return ask("PATCH", `/api/integrations/${app}/settings`, { values: a.values }, login);
				if (a.op === "remove") return ask("POST", `/api/integrations/${app}/remove`, { deleteData: a.deleteData === true }, login);
				if (a.op === "add") return ask("POST", `/api/integrations/${app}/add`, {}, login);
				return bad("op must be settings, remove, add, create or delete");
			}
			// KakaoTalk rooms (hub/kakao/web.ts): the owning gateway sends through its own single send door, lease included.
			case "kakao": {
				const id = encodeURIComponent(String(a.chatId ?? a.code ?? ""));
				if (!id) return bad("chatId or code required");
				if (a.op === "send" && a.chatId) return ask("POST", `/api/kakao/chat/${id}/send`, { text: a.text }, login);
				if (a.op === "send-delete" && a.chatId && a.sendId) return ask("DELETE", `/api/kakao/chat/${id}/send/${encodeURIComponent(String(a.sendId))}`, undefined, login);
				if (a.op === "read" && a.chatId) return ask("POST", `/api/kakao/chat/${id}/read`, { logId: a.logId }, login);
				if (a.op === "draft" && a.chatId) return ask("POST", `/api/kakao/chat/${id}/draft`, typeof a.choice === "string" ? { choice: a.choice } : {}, login);
				if (a.op === "ask-drop" && a.chatId) return ask("POST", `/api/kakao/chat/${id}/ask/drop`, {}, login);
				if ((a.op === "draft-send" || a.op === "draft-drop") && a.code) return ask("POST", `/api/kakao/drafts/${id}/${a.op.slice(6)}`, a.text === undefined ? {} : { text: a.text }, login);
				return bad("op must be send, send-delete, read, draft, ask-drop, draft-send or draft-drop");
			}
			// A project on this machine (hub/projectdelete.ts): what deleting it removes, and the delete itself.
			case "project": {
				const key = encodeURIComponent(String(a.key ?? ""));
				if (!a.key) return bad("key required");
				if (a.op === "delete-plan") return ask("GET", `/api/projects/${key}/delete-plan`, undefined, login);
				if (a.op === "delete") return ask("DELETE", `/api/projects/${key}`, { archive: a.archive !== false }, login);
				return bad("op must be delete-plan or delete");
			}
			default:
				return bad("unknown action");
		}
	}

	async function route(req: Request, url: URL): Promise<Response | undefined> {
		const get = req.method === "GET" || req.method === "HEAD";
		if (get && url.pathname === "/api/peer/monitoring") {
			const s = await snapshot();
			const headers = { ETag: `"${s.rev}"` };
			return etagMatch(req.headers.get("if-none-match"), s.rev) ? new Response(null, { status: 304, headers }) : Response.json(s, { headers });
		}
		if (get && url.pathname === "/api/monitoring/peers") return json(await peerMonitoring());
		if (url.pathname === "/api/peer/proxy" && (req.method === "GET" || req.method === "POST")) return proxy(req, url);
		if (req.method === "POST" && url.pathname === "/api/peer/act") return act(req);
		return undefined;
	}

	async function idle(): Promise<void> {
		while (inflight.size) await Promise.all([...inflight.values()]);
	}

	return { snapshot, peerMonitoring, invalidatePeer, idle, route };
}

// The running gateway's monitor (set by routes.ts); hub/peer-stream.ts calls invalidatePeer when it forwards a peer's counts.
let active: PeerMonitor | undefined;
export const activatePeerMonitor = (m: PeerMonitor): void => { active = m; };
export const invalidatePeer = (url: string): void => active?.invalidatePeer(url);
