// The merged 모니터링 across gateways (docs/peer-monitoring.md). Four routes, one cache:
//   GET  /api/peer/monitoring     this gateway's snapshot {name, rev, monitors, notices, integrations, available (the apps switched off there), conversations}, ETag = rev
//   GET  /api/monitoring/peers    every other gateway's snapshot from the cache: [{name, url, online, stale, items}]
//   GET|POST /api/peer/proxy      the page's way to a peer (pc must be a known peer origin; GET only the peer read list, POST only /api/peer/act)
//   POST /api/peer/act            an action forwarded here; it runs through this gateway's own handlers, so the owner's web and history show it
// A peer is read at most once per 20 s (If-None-Match), and again when hub/peer-stream.ts reports a change (invalidatePeer). A page request waits
// only for a read it needs: one it triggers (a cache older than 20 s) or one already running after a peer's change (bounded by the 2.5 s fetch
// timeout, all peers in parallel), so a decision answered on the other computer never shows stale here for the next interval.
// Everything outside (fetch, computers, clock, token, the local handler) is injected, so tests run two gateways in one process.
import { createHash } from "node:crypto";
import { PEER_GET, peerHeaders, peerTokenFor } from "./peer-auth.ts";
import { createPairer, type PairResult } from "./peer-pair.ts";
import { knownComputers } from "./peers.ts";
import { json } from "./routes-util.ts";

export type Computer = { name: string; url: string; self: boolean };
// `orchestrator`: that gateway's bot status ("rate-limited" = paused; pauseKind "owner" = login/billing), for the composer's status line.
// It is part of the rev, so a change of pause reaches a peer holding the older snapshot.
export type OrchestratorPause = { status: string; pauseKind: string };
// `runs`: the run state of that gateway's mail conversations (`mail:<key>`), so a mail opened here shows what its bot is doing there.
export type Snapshot = { name: string; rev: string; monitors: unknown[]; notices: unknown[]; integrations: unknown[]; available: unknown[]; conversations: unknown[]; orchestrator?: OrchestratorPause; runs?: Record<string, unknown> };
export type PeerView = { name: string; url: string; online: boolean; stale: boolean; items: Snapshot | null };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type MonitorDeps = {
	name: () => string;                                       // this gateway's machine name
	local: (req: Request) => Promise<Response>;               // this gateway's own handler chain (the same one the web app talks to)
	localHeaders?: Record<string, string>;                    // what makes a local request pass the owner check
	orchestrator?: () => OrchestratorPause;                   // this gateway's orchestrator status, read when the snapshot is built
	runs?: () => Record<string, unknown>;                     // the run state of this gateway's mail conversations, read when the snapshot is built
	computers?: () => Promise<Computer[]>;
	fetch?: Fetcher;
	now?: () => number;
	token?: (peerUrl: string) => string | undefined;          // what to send to that peer: its own pair token, else the shared one
	pair?: (peerUrl: string, force?: boolean) => Promise<PairResult>;  // asks the peer for a pair token (hub/peer-pair.ts)
	timeoutMs?: number;
	postTimeoutMs?: number;
	refreshMs?: number;
};

const GET_MS = 2500;
const POST_MS = 15_000;
const UPLOAD_MS = 120_000;   // one file's bytes (base64) to the other computer: bigger than an action, so it gets its own budget
// What a proxied read keeps of the peer's answer: a file (GET /api/peer/file) keeps its name, the reason it was refused and its sandbox.
const KEEP = ["content-type", "content-disposition", "content-security-policy", "x-content-type-options", "x-file-note"];
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
	const token = deps.token ?? peerTokenFor;
	const computers = deps.computers ?? knownComputers;
	const pair = deps.pair ?? createPairer({ fetch: f, selfUrl: async () => (await computers()).find(c => c.self)?.url });
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
		const part = { name, monitors: m?.items ?? [], notices: n?.items ?? [], integrations: i?.items ?? [], available: i?.available ?? [], conversations: (c?.items ?? []).filter(isConv), ...(deps.orchestrator ? { orchestrator: deps.orchestrator() } : {}), ...(deps.runs ? { runs: deps.runs() } : {}) };
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
		const url = e.computer.url;
		try {
			let h = peerHeaders(token(url));
			if (!h) {
				await pair(url);
				h = peerHeaders(token(url));
			}
			if (!h) {
				e.items = await legacy(e, {});
				e.online = true;
				e.at = now();
				return;
			}
			const read = (hh: Record<string, string>) => f(`${url}/api/peer/monitoring`, { headers: { ...hh, ...(e.items ? { "if-none-match": `"${e.items.rev}"` } : {}) }, signal: AbortSignal.timeout(getMs), redirect: "manual" });
			let r = await read(h);
			if (r.status === 403 && (await pair(url, true)).ok) {
				h = peerHeaders(token(url)) ?? h;
				r = await read(h);
			}
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
		const pending: Promise<void>[] = [];
		for (const c of others) {
			let e = cache.get(c.url);
			if (!e) {
				e = { computer: c, items: null, online: false, at: 0 };
				cache.set(c.url, e);
				pending.push(refresh(e));
			} else {
				e.computer = c;
				if (now() - e.at >= refreshMs) pending.push(refresh(e));
				else { const running = inflight.get(c.url); if (running) pending.push(running); }
			}
		}
		await Promise.all(pending);
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
		const pc = originOf(url.searchParams.get("pc") ?? "");
		const target = (await computers()).find(c => !c.self && originOf(c.url) === pc);
		if (!target || !pc) return json({ error: "unknown computer" }, 400);
		const p = url.searchParams.get("p") ?? "";
		const parsed = p.startsWith("/") && !p.startsWith("//") ? new URL(p, LOCAL) : undefined;
		const get = req.method === "GET";
		const allowed = !!parsed && parsed.origin === LOCAL && (get ? PEER_GET.some(r => r.test(parsed.pathname)) : parsed.pathname === "/api/peer/act");
		if (!allowed || !parsed) return json({ error: "path not allowed" }, 400);
		const off = (p: PairResult) => json({ error: "peering is off", ...(!p.ok && p.reason ? { reason: p.reason } : {}) }, 503);
		let h = peerHeaders(token(target.url));
		if (!h && !get) {
			const p = await pair(target.url);
			h = peerHeaders(token(target.url));
			if (!h) return off(p);
		}
		let body: string | undefined;
		let upload = false;
		if (!get) {
			// The owner records who asked: the sender's own name replaces whatever the page sent.
			let b: Record<string, unknown>;
			try {
				b = (await req.json()) as Record<string, unknown>;
			} catch {
				return json({ error: "json body required" }, 400);
			}
			upload = b.action === "upload";
			body = JSON.stringify({ ...b, from: deps.name() });
		}
		const send = (hh: Record<string, string> | undefined) =>
			f(`${target.url}${parsed.pathname}${parsed.search}`, { method: req.method, headers: { ...hh, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(get ? getMs : upload ? UPLOAD_MS : postMs), redirect: "manual" });
		try {
			let r = await send(h);
			if (h && r.status === 403) {
				// A stale or unknown token: ask the peer for a fresh pair token once; if it refuses, a write says why.
				const p = await pair(target.url, true);
				if (p.ok) r = await send(peerHeaders(token(target.url)) ?? h);
				else if (!get) return off(p);
			}
			// A forwarded action changed that computer: its snapshot is read again before the answer, so the page's next read shows the change
			// (a switched-off monitor reads 꺼짐 at once, not after the 20 s cache).
			const e = !get && r.ok ? cache.get(target.url) : undefined;
			if (e) {
				await refresh(e);
				await inflight.get(target.url);
			}
			const headers: Record<string, string> = {};
			for (const k of KEEP) { const v = r.headers.get(k); if (v) headers[k] = v; }
			return new Response(r.status === 204 || r.status === 304 ? null : await r.arrayBuffer(), { status: r.status, headers });
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
				// `files` must be uploads of this gateway (the "upload" act below); /api/message refuses any other path, so a message never goes out
				// without the file it was sent with, and a path of the other computer never reaches this one's agent.
				return ask("POST", "/api/message", { ...fields, ...pick("text"), ...pick("mode"), ...pick("reply"), ...pick("reply_to"), ...pick("picks"), ...pick("files"), via: from }, login);
			}
			// A file attached on the other computer to a conversation of this one: its bytes ({name, type, data: base64}) are stored through this
			// gateway's own /api/upload (same size limit and file names), and the answer's paths are what the "message" act then sends.
			case "upload": {
				const list = Array.isArray(a.files) ? a.files : [];
				if (!list.length || list.length > 10 || !list.every(x => x && typeof x.data === "string" && x.data)) return bad("files [{name, type, data}] required (1 to 10)");
				const form = new FormData();
				for (const x of list) form.append("file", new File([Buffer.from(x.data, "base64")], String(x.name ?? "file"), { type: typeof x.type === "string" ? x.type : "" }));
				return deps.local(new Request(`${LOCAL}/api/upload`, { method: "POST", headers: { ...deps.localHeaders, ...(login ? { "tailscale-user-login": login } : {}) }, body: form }));
			}
			case "answer":
				if (typeof a.id !== "string" || !a.id) return bad("id required");
				return ask("POST", `/api/notices/${encodeURIComponent(a.id)}/answer`, { n: a.n, note: a.note, via: from }, login);
			// A notice of this computer seen in the other one's 모니터링: 읽음 처리, the x (무시) and its undo, the same routes the owner's own web uses.
			case "notice":
				if (a.op === "read" && Array.isArray(a.ids)) return ask("POST", "/api/notices/read", { ids: a.ids.map(String) }, login);
				// dismiss: the 지우기 of a handled reply draft folded in a mail's conversation (web/js/30-mail-sent.js); an open question is refused there.
				if ((a.op === "ignore" || a.op === "unignore" || a.op === "dismiss") && typeof a.id === "string" && a.id) return ask("POST", `/api/notices/${encodeURIComponent(a.id)}/${a.op}`, {}, login);
				return bad("op must be read, ignore, unignore or dismiss");
			case "read":
				return ask("POST", "/api/read", { target: a.target, ts: a.ts }, login);
			case "watch": {
				const name = encodeURIComponent(String(a.name ?? ""));
				if (!a.name) return bad("name required");
				if (a.op === "pause" || a.op === "resume") return ask("PATCH", `/api/watches/${name}`, { paused: a.op === "pause" }, login);
				if (a.op === "run") return ask("POST", `/api/watches/${name}/run`, {}, login);
				// A monitor's settings (hub/watch-settings.ts): the same plain PATCH the owner's web sends, with the change set as `values`.
				if (a.op === "settings") return ask("PATCH", `/api/watches/${name}/settings`, { values: a.values }, login);
				// 감시 삭제 from the monitor's settings screen on another computer.
				if (a.op === "delete") return ask("DELETE", `/api/watches/${name}`, undefined, login);
				return bad("op must be pause, resume, run, settings or delete");
			}
			// An app's switch, settings, 제거 and 앱 추가 on the machine that owns the app (hub/app-off.ts): off and remove are per machine, so the web sends them here, never to its own gateway.
			case "app": {
				const app = encodeURIComponent(String(a.app ?? ""));
				if (!a.app) return bad("app required");
				// A new instance of an app (POST /api/apps; `app` = the app key) and the delete of an off one (DELETE /api/apps/<id>; `app` = the instance id).
				if (a.op === "create") return ask("POST", "/api/apps", { app: a.app, label: a.label, filter: a.filter, id: a.id }, login);
				if (a.op === "delete") return ask("DELETE", `/api/apps/${app}${a.deleteData === true ? "?data=1" : ""}`, undefined, login);
				if (a.op === "settings") return ask("PATCH", `/api/integrations/${app}/settings`, { values: a.values }, login);
				// A feature switch and a retry of an internal function (hub/app-features.ts).
				if (a.op === "features") return ask("PATCH", `/api/integrations/${app}/features`, { id: a.id, on: a.on }, login);
				if (a.op === "retry") return ask("POST", `/api/integrations/${app}/retry`, { watch: a.watch }, login);
				if (a.op === "remove") return ask("POST", `/api/integrations/${app}/remove`, { deleteData: a.deleteData === true }, login);
				if (a.op === "add") return ask("POST", `/api/integrations/${app}/add`, {}, login);
				return bad("op must be settings, features, retry, remove, add, create or delete");
			}
			// KakaoTalk rooms (hub/kakao/web.ts): the owning gateway sends through its own single send door, lease included.
			case "kakao": {
				const id = encodeURIComponent(String(a.chatId ?? a.code ?? ""));
				if (!id) return bad("chatId or code required");
				if (a.op === "send" && a.chatId) return ask("POST", `/api/kakao/chat/${id}/send`, { text: a.text }, login);
				if (a.op === "send-delete" && a.chatId && a.sendId) return ask("DELETE", `/api/kakao/chat/${id}/send/${encodeURIComponent(String(a.sendId))}`, undefined, login);
				if (a.op === "read" && a.chatId) return ask("POST", `/api/kakao/chat/${id}/read`, { logId: a.logId }, login);
				if (a.op === "draft" && a.chatId) return ask("POST", `/api/kakao/chat/${id}/draft`, typeof a.choice === "string" ? { choice: a.choice } : a.revise && typeof a.revise === "object" ? { revise: a.revise } : {}, login);
				if (a.op === "ask-drop" && a.chatId) return ask("POST", `/api/kakao/chat/${id}/ask/drop`, {}, login);
				if ((a.op === "draft-send" || a.op === "draft-drop") && a.code) return ask("POST", `/api/kakao/drafts/${id}/${a.op.slice(6)}`, a.text === undefined ? {} : { text: a.text }, login);
				return bad("op must be send, send-delete, read, draft, ask-drop, draft-send or draft-drop");
			}
			// 초안 작성 on a mail the other computer holds: its draft is made and offered there.
			case "mail-draft":
				if (typeof a.key !== "string" || !a.key) return bad("key required");
				return ask("POST", `/api/mail/${encodeURIComponent(a.key)}/draft`, {}, login);
			// 답장 안 함 (hub/unreplied.ts) on the computer that holds the mail or the room, or taking it back (on false).
			case "no-reply": {
				const verb = a.on === false ? "DELETE" : "POST";
				if (a.kind === "mail" && typeof a.key === "string" && a.key) return ask(verb, `/api/mail/${encodeURIComponent(a.key)}/no-reply`, verb === "POST" ? {} : undefined, login);
				if (a.kind === "kakao" && typeof a.chatId === "string" && a.chatId) return ask(verb, `/api/kakao/chat/${encodeURIComponent(a.chatId)}/no-reply`, verb === "POST" ? {} : undefined, login);
				return bad("kind must be mail or kakao");
			}
			// A mail reply draft's files (hub/draft-attach.ts): added from the library folder or as bytes, or taken off, on the computer that owns the draft.
			case "draft-files": {
				const ref = encodeURIComponent(String(a.ref ?? ""));
				if (!a.ref) return bad("ref required");
				return ask("POST", `/api/drafts/${ref}/files`, Number.isInteger(a.remove) ? { remove: a.remove } : typeof a.library === "string" ? { library: a.library } : { name: a.name, data: a.data }, login);
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
