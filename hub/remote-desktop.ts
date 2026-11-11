// Owner (2026-11-04): "https://github.com/tembo/voxl 이거 붙여서 해당 게이트웨이가 설치된 컴퓨터 화면 띄우고 조작 가능하게 가능하냐? 전체모드로 하면 로컬화면처럼 전체로 사용가능하게 하고"
// Owner: "크롬으로 되네. 크롬이 설치되어있으면 크롬에서 띄우는걸로 구현하자"
// Owner (2026-11-05): "조작은 상시 가능해야하니까 on/off 필요 없음"
// Owner (2026-11-05): "중간에 한번 더 거치는거 필요 없고 / 그리고 각 접속하는 기기의 해상도에 맞춰서 전체화면으로 되어야해"
// Remote desktop (features/remote-desktop/DESIGN.md): the gateway runs voxl (a screen streamer) on loopback only while someone watches,
// and is its only door: /desk/ proxies the allow-listed paths with the Bearer added here, the websocket goes through a raw TCP client so
// a slow viewer can stop the reading (backpressure), and every other path of voxl (screenshot, files, record...) stays unreachable.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { grantPermission, realHost, type Host } from "../onboard/selfserve.ts";
import { DATA_DIR, log } from "./config.ts";
import { loadFeatureDirs } from "./featuredirs.ts";
import { PEER_HEADER, peerHeaders, peerTokenFor } from "./peer-auth.ts";
import { knownComputers, tailscaleStatus } from "./peers.ts";
import { Bridge } from "./remote-desktop-ws.ts";
import { peerFetch } from "./tailnet-fetch.ts";
import { json, sameOrigin } from "./routes-util.ts";

const IDLE_MS = 60_000; // no viewer for this long -> stop voxl
const KILL_MS = 3_000; // SIGTERM, then SIGKILL after this
const READY_MS = 10_000; // /healthz must answer within this after the spawn
const OPEN_GAP_MS = 5_000; // at most one Chrome open per this
const TICKET_MS = 30_000; // a ticket covers one tap on another computer's button, not a saved link
const TICKETS_MAX = 8;
const VIEWER = join(import.meta.dir, "..", "features", "remote-desktop", "viewer.js");

export type Child = { pid: number; exited: Promise<number>; kill(sig?: NodeJS.Signals): void; stderr?: ReadableStream<Uint8Array> | null };
export type Clock = { now(): number; after(ms: number, fn: () => void): () => void };
export type Settings = { on: boolean; allow_public: boolean };
type Computer = { name: string; host: string; url: string; self: boolean };
type TsStatus = { Self?: { TailscaleIPs?: string[] }; Peer?: Record<string, { TailscaleIPs?: string[]; DNSName?: string }> };
export type PeerDesk = { available: boolean; on?: boolean; public_blocked?: boolean; unsupported?: boolean; old?: boolean; ticket?: string };
export type Viewer = { self: true } | { unknown: true } | { dns: string; name?: string; url?: string };
type Ensure = "ok" | "rebuilding" | "failed";
type Closable = { close(code?: number, reason?: string): void };
type ViewerRec = { who: string; device?: string; since: number };
export type DeskWsData = { kind: "desk"; who: string; search: string; device?: string; bridge?: Bridge };

export type DeskDeps = {
	dataDir: string;
	platform: NodeJS.Platform;
	featureOn(): boolean;
	spawn(argv: string[], env: Record<string, string>): Child;
	/** Kills `pid` when the returned stopper has not been called and this process is gone (a pipe the gateway holds). */
	watch(pid: number): () => void;
	freePort(): Promise<number>;
	clock: Clock;
	rebuild(): Promise<boolean>;
	tailscale(): Promise<TsStatus | undefined>;
	computers(): Promise<Computer[]>;
	/** The viewer computer's gateway opens `deskUrl` in its Chrome; true when it did. */
	peerOpen(gatewayUrl: string, deskUrl: string): Promise<boolean>;
	/** That computer's own answer about its screen; `old` = a gateway from before this route, undefined = unreachable. */
	peerDesk(gatewayUrl: string): Promise<PeerDesk | undefined>;
	/** Runs a program, returns its exit code (the Chrome opener). */
	run(argv: string[]): Promise<number>;
	host: Host;
};

const dirOf = (dataDir: string) => join(dataDir, "remote-desktop");
export const binOf = (dataDir: string) => join(dirOf(dataDir), "bin", "voxl");
const settingsFile = (dataDir: string) => join(dirOf(dataDir), "settings.json");
export function readSettings(dataDir: string): Settings {
	try {
		const o = JSON.parse(readFileSync(settingsFile(dataDir), "utf8")) as Partial<Settings>;
		return { on: o.on !== false, allow_public: o.allow_public === true };
	} catch {
		return { on: true, allow_public: false };
	}
}
function writeSettings(dataDir: string, s: Settings): void {
	mkdirSync(dirOf(dataDir), { recursive: true });
	const tmp = `${settingsFile(dataDir)}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(s));
	renameSync(tmp, settingsFile(dataDir));
}

/** The lifecycle of one voxl process. Spawn, clock and ports are injected so a test runs a fake server script. */
export class DeskHost {
	port = 0;
	password = ""; // in the child's env and the Bearer to it; never logged, never in an answer
	ready = false;
	viewers = new Map<Closable, ViewerRec>();
	relay = { bytes: 0, paused_ms: 0, pauses: 0, max_buffered: 0 };
	private child?: Child;
	private starting?: Promise<Ensure>;
	private rebuilding?: Promise<void>;
	private rebuilt = false;
	private cancelIdle?: () => void;
	private stopWatch?: () => void;
	private tail = "";
	constructor(private d: DeskDeps) {}

	get isRebuilding(): boolean {
		return !!this.rebuilding;
	}
	/** Resolves when no start or rebuild is in flight. */
	async settled(): Promise<void> {
		await this.starting?.catch(() => undefined);
		await this.rebuilding;
	}

	async ensure(): Promise<Ensure> {
		if (this.rebuilding) return "rebuilding";
		if (this.ready) {
			if (!this.viewers.size) this.armIdle();
			return "ok";
		}
		this.starting ??= this.start().finally(() => (this.starting = undefined));
		return this.starting;
	}

	private async start(): Promise<Ensure> {
		await this.kill();
		const first = await this.launch();
		if (first === "ok") return this.up();
		// A voxl that cannot link its libraries (a brew upgrade moved x264) is rebuilt once; the page tells the viewer to wait.
		if (first === "failed" || this.rebuilt) return "failed";
		this.rebuilt = true;
		log("remote-desktop: voxl does not link, rebuilding");
		this.rebuilding = this.d
			.rebuild()
			.then(async ok => void (ok && (await this.launch()) === "ok" && this.up()))
			.catch(e => log(`remote-desktop: rebuild failed: ${e}`))
			.finally(() => (this.rebuilding = undefined));
		return "rebuilding";
	}
	private up(): Ensure {
		this.rebuilt = false;
		this.armIdle(); // a page that never connects still ends
		return "ok";
	}

	private async launch(): Promise<"ok" | "failed" | "dyld"> {
		const port = await this.d.freePort();
		const password = randomBytes(32).toString("hex");
		const argv = [binOf(this.d.dataDir), "--addr=127.0.0.1", `--port=${port}`, "--file-transfers=none", "--stripes=4"];
		const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "USER", "LANG"].flatMap(k => (process.env[k] ? [[k, process.env[k]!]] : [])));
		let child: Child;
		try {
			child = this.d.spawn(argv, { ...env, VOXL_PASSWORD: password });
		} catch (e) {
			log(`remote-desktop: spawn failed: ${e}`);
			return "failed";
		}
		Object.assign(this, { child, port, password, tail: "" });
		const drained = this.drain(child.stderr);
		this.stopWatch = this.d.watch(child.pid);
		void child.exited.then(() => this.child === child && this.cleanup());
		if (await this.waitReady(child)) return (this.ready = true), "ok";
		await this.kill();
		await drained;
		return /dyld|Library not loaded/i.test(this.tail) ? "dyld" : "failed";
	}
	private async drain(s?: ReadableStream<Uint8Array> | null): Promise<void> {
		if (!s) return;
		const dec = new TextDecoder();
		try {
			for await (const c of s) this.tail = (this.tail + dec.decode(c, { stream: true })).slice(-4096);
		} catch {}
	}
	private async waitReady(child: Child): Promise<boolean> {
		let dead = false;
		void child.exited.then(() => (dead = true));
		const end = performance.now() + READY_MS;
		while (!dead && performance.now() < end) {
			const r = await this.fetchUp("/healthz").catch(() => undefined);
			if (r?.status === 200) return true;
			await Bun.sleep(50);
		}
		return false;
	}

	fetchUp(path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<Response> {
		const headers = new Headers({ ...init.headers, authorization: `Bearer ${this.password}`, "accept-encoding": "identity" });
		return fetch(`http://127.0.0.1:${this.port}${path}`, { method: init.method ?? "GET", headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
	}

	private armIdle(): void {
		this.cancelIdle?.();
		this.cancelIdle = this.d.clock.after(IDLE_MS, () => void this.stop());
	}
	addViewer(ws: Closable, v: { who: string; device?: string }): void {
		this.cancelIdle?.();
		this.cancelIdle = undefined;
		this.viewers.set(ws, { who: v.who, ...(v.device ? { device: v.device } : {}), since: this.d.clock.now() });
	}
	dropViewer(ws: Closable): void {
		this.viewers.delete(ws);
		if (!this.viewers.size && this.ready) this.armIdle();
	}
	/** Turning `on` off takes effect now. */
	settingsChanged(prev: Settings, next: Settings): Promise<void> {
		return prev.on !== next.on ? this.stop() : Promise.resolve();
	}

	async stop(): Promise<void> {
		await this.starting?.catch(() => undefined);
		await this.kill();
	}
	// Detaches first (nothing proxies to a dying process, the watchdog goes before the signal), then SIGTERM, SIGKILL after KILL_MS.
	private async kill(): Promise<void> {
		const c = this.child;
		if (!c) return;
		this.cleanup();
		c.kill("SIGTERM");
		const hard = this.d.clock.after(KILL_MS, () => c.kill("SIGKILL"));
		await c.exited;
		hard();
	}
	private cleanup(): void {
		this.child = undefined;
		this.ready = false;
		this.password = "";
		this.cancelIdle?.();
		this.cancelIdle = undefined;
		this.stopWatch?.();
		this.stopWatch = undefined;
		for (const ws of [...this.viewers.keys()]) ws.close(1012, "restart");
		this.viewers.clear();
	}
}

const text = (s: string, status: number) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const page = (s: string, status: number, refresh = false) =>
	new Response(`<!doctype html><meta charset="utf-8">${refresh ? '<meta http-equiv="refresh" content="3">' : ""}<title>화면 공유</title><p>${s}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
// A link from another site must not start capture by itself, so it lands here: nothing runs until a tap on this page, whose own link is
// same-origin. The switcher of another computer skips it with a one-time ticket; a gateway too old to send one still lands here.
// Framing it is refused like every /desk answer.
const tapPage = (name: string) =>
	new Response(
		`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>화면 공유</title><style>:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{margin:0;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;box-sizing:border-box;text-align:center}h1{margin:0;font-size:20px}p{margin:0 0 16px;opacity:.65}a{display:block;width:100%;max-width:320px;box-sizing:border-box;padding:14px;border-radius:12px;background:#2563eb;color:#fff;font-weight:600;text-decoration:none}</style><h1>${Bun.escapeHTML(name)} 화면</h1><p>보고 조작할 수 있어요</p><a href="/desk/">화면 열기</a>`,
		{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
	);
const PUBLIC_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-access-jwt-assertion"];
const FILES = new Set(["", "index.html", "client.js", "worker.js", "audio.js", "mic.js", "favicon.ico", "inter.woff2", "ws", "viewer.js"]);
// voxl takes its password as ?token= too; only the Bearer added here may authenticate. `go` is this gateway's own ticket, never voxl's.
export function voxlQuery(url: URL): string {
	const q = new URLSearchParams(url.search);
	q.delete("token");
	q.delete("go");
	return q.size ? `?${q}` : "";
}
// voxl's page forbids zoom in its viewport tag and knows nothing of safe areas, and its binary is built from a pinned commit, so the two
// lines change here: the view itself is features/remote-desktop/viewer.js.
export const deskPage = (html: string): string =>
	html.replace(/<meta\s+name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">').replace("</head>", '<script src="viewer.js"></script></head>');

const SEND_HEADERS = ["accept", "accept-language", "if-none-match", "if-modified-since", "range", "user-agent"];
const DROP_HEADERS = new Set(["set-cookie", "www-authenticate", "connection", "keep-alive", "transfer-encoding", "content-encoding"]);
const NOTE = "단축키(Cmd+W 같은)는 이 컴퓨터로 가요";
export const JXA = {
	// Not in CoreGraphics' JXA bridge, so it has to be bound by hand.
	screen: 'ObjC.import("CoreGraphics"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); $.CGPreflightScreenCaptureAccess()',
	accessibility: 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()',
};

/** Who is looking: the tailnet address tailscale serve sets (a client cannot forge it), matched to this computer or a peer. */
export async function viewerOf(req: Request, d: Pick<DeskDeps, "tailscale" | "computers">): Promise<Viewer> {
	const login = req.headers.get("tailscale-user-login");
	const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
	if (!login || !ip) return { unknown: true };
	const st = await d.tailscale();
	if (st?.Self?.TailscaleIPs?.includes(ip)) return { self: true };
	const peer = Object.values(st?.Peer ?? {}).find(p => p.TailscaleIPs?.includes(ip));
	if (!peer?.DNSName) return { unknown: true };
	const dns = peer.DNSName.replace(/\.$/, "");
	const c = (await d.computers()).find(x => !x.self && x.host.replace(/\.$/, "") === dns);
	return { dns, ...(c ? { name: c.name, url: c.url } : {}) };
}

export function createDesk(d: DeskDeps) {
	const host = new DeskHost(d);
	const available = () => d.platform === "darwin" && existsSync(binOf(d.dataDir)) && d.featureOn();
	let lastOpen: number | undefined;
	const tickets = new Map<string, number>(); // ticket -> when it ends; asked only on a tap, so no timer sweeps it
	const mintTicket = () => {
		if (tickets.size >= TICKETS_MAX) tickets.delete(tickets.keys().next().value!);
		const t = randomBytes(32).toString("hex");
		tickets.set(t, d.clock.now() + TICKET_MS);
		return t;
	};
	const takeTicket = (t: string | null) => {
		const end = t === null ? undefined : tickets.get(t);
		if (end === undefined) return false;
		tickets.delete(t!);
		return d.clock.now() < end;
	};
	const status = (mode: string) => {
		const s = readSettings(d.dataDir);
		return { available: true, ...s, running: host.ready, rebuilding: host.isRebuilding, viewers: [...host.viewers.values()], relay: host.relay, public_blocked: mode === "cloudflare" && !s.allow_public };
	};
	const isPublic = (req: Request, mode: string) => mode === "cloudflare" || PUBLIC_HEADERS.some(h => req.headers.has(h));
	const body = async (req: Request): Promise<Record<string, unknown> | undefined> => {
		if (!req.headers.get("content-type")?.includes("application/json")) return undefined;
		const b = await req.json().catch(() => undefined);
		return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : undefined;
	};

	async function proxy(req: Request, url: URL, srv: Server<unknown> | undefined, mode: string): Promise<Response | null> {
		const s = readSettings(d.dataDir);
		if (!available()) return text("not found", 404);
		if (!s.on) return text("화면 공유가 꺼져 있어요", 403);
		if (isPublic(req, mode) && !s.allow_public) return text("공개 접속으로는 화면 공유를 쓸 수 없어요", 403);
		const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
		if ((upgrade || (req.method !== "GET" && req.method !== "HEAD")) && !sameOrigin(req)) return text("cross-origin request refused", 403);
		const site = req.headers.get("sec-fetch-site");
		if (site && site !== "same-origin" && site !== "none") {
			if (req.method !== "GET" || url.pathname !== "/desk/" || upgrade || req.headers.get("sec-fetch-dest") !== "document") return text("cross-site request refused", 403);
			if (!takeTicket(url.searchParams.get("go"))) return tapPage((await d.computers().catch(() => [])).find(c => c.self)?.name ?? "이 컴퓨터");
		}
		// Relative: this server sees http behind tailscale serve, an absolute URL would leave https.
		if (url.pathname === "/desk") return new Response(null, { status: 301, headers: { location: "/desk/" } });
		const name = url.pathname.slice("/desk/".length);
		if (!FILES.has(name)) return text("not found", 404);
		if (req.method !== "GET" && req.method !== "HEAD") return text("method not allowed", 405);
		if (name === "viewer.js") return new Response(Bun.file(VIEWER), { headers: { "content-type": "text/javascript; charset=utf-8" } });
		const viewer = await viewerOf(req, d);
		if ("self" in viewer) return page("이 컴퓨터의 화면을 이 컴퓨터에서 보면 화면 안에 화면이 계속 겹쳐 보여요. 다른 컴퓨터에서 열어 주세요.", 409);
		const ready = await host.ensure().catch(() => "failed" as const);
		if (ready === "rebuilding") return page("화면 공유를 다시 만드는 중이에요. 잠시 뒤 자동으로 다시 열려요.", 503, true);
		if (ready === "failed") return text("화면 공유를 시작하지 못했어요", 502);
		if (name === "ws") {
			if (!upgrade || !srv) return text("websocket only", 400);
			// Only tailscale serve sets this header; on a public door anyone could write a name into it.
			const who = (isPublic(req, mode) ? undefined : req.headers.get("tailscale-user-login")) ?? "기기";
			const device = "name" in viewer ? viewer.name : undefined;
			return srv.upgrade(req, { data: { kind: "desk", who, search: voxlQuery(url), ...(device ? { device } : {}) } }) ? null : text("websocket upgrade failed", 400);
		}
		const headers = Object.fromEntries(SEND_HEADERS.flatMap(h => (req.headers.has(h) ? [[h, req.headers.get(h)!]] : [])));
		const up = await host.fetchUp(`/${name}${voxlQuery(url)}`, { method: req.method, headers }).catch(() => undefined);
		if (!up) return text("화면 공유가 응답하지 않아요", 502);
		const out = new Headers([...up.headers].filter(([k]) => !DROP_HEADERS.has(k.toLowerCase())));
		if (req.method === "GET" && up.status === 200 && out.get("content-type")?.includes("text/html")) {
			out.delete("content-length");
			out.delete("etag");
			return new Response(deskPage(await up.text()), { status: 200, headers: out });
		}
		return new Response(req.method === "HEAD" ? null : up.body, { status: up.status, statusText: up.statusText, headers: out });
	}
	// This computer's Chrome, at most once per OPEN_GAP_MS. Only ever called with a /desk/ address of the owner's own computers.
	async function launch(href: string): Promise<"ok" | "rate" | "unsupported" | "no-chrome"> {
		if (lastOpen !== undefined && d.clock.now() - lastOpen < OPEN_GAP_MS) return "rate";
		lastOpen = d.clock.now();
		if (d.platform !== "darwin") return "unsupported";
		if ((await d.run(["open", "-Ra", "Google Chrome"])) !== 0) return "no-chrome";
		return (await d.run(["open", "-a", "Google Chrome", href])) === 0 ? "ok" : "no-chrome";
	}
	// The button of another computer in the switcher. That computer answers for itself, asked on the tap: nothing is read while nobody taps.
	// Only its owner's gateway can switch it on, so an off computer gets the one step (`to`: where in its app), never a remote switch.
	async function openPeer(req: Request, mode: string, b: Record<string, unknown>): Promise<Response> {
		const blocked = (reason: string, to?: string) => json({ action: "blocked", reason, ...(to === undefined ? {} : { to }) });
		const origin = typeof b.peer === "string" ? URL.parse(b.peer)?.origin : undefined;
		const computers = await d.computers().catch(() => []);
		const c = computers.find(x => !x.self && URL.parse(x.url)?.origin === origin);
		if (!c) return blocked("그 컴퓨터를 찾지 못했어요");
		if (isPublic(req, mode) && !readSettings(d.dataDir).allow_public) return blocked("공개 접속으로는 화면 공유를 쓸 수 없어요");
		const st = await d.peerDesk(c.url).catch(() => undefined);
		if (!st) return blocked(`${c.name}에 연결할 수 없어요`);
		if (st.old) return blocked(`${c.name}의 dotz를 업데이트한 뒤 다시 눌러 주세요`, "#settings");
		if (st.unsupported) return blocked("화면 공유는 macOS에서만 돼요");
		if (!st.available) return blocked(`${c.name}에서 아직 켜지 않았어요. ${c.name} 대화에서 "화면 공유 켜줘"라고 말해 주세요`, "");
		if (!st.on) return blocked(`${c.name} 설정에서 화면 공유를 켜 주세요`, "#settings");
		if (st.public_blocked) return blocked(`${c.name}은 공개 접속이라 화면 공유가 막혀 있어요`);
		const viewer = await viewerOf(req, d);
		if ("url" in viewer && viewer.url && URL.parse(viewer.url)?.origin === origin) return blocked("이 컴퓨터의 화면을 이 컴퓨터에서 보면 화면 안에 화면이 겹쳐 보여요. 다른 컴퓨터에서 열어 주세요");
		// The browser sits on a computer with a gateway: that gateway opens Chrome, whose address-bar kind of open needs no second tap.
		const deskUrl = new URL("/desk/", c.url).href;
		if ("self" in viewer) {
			if ((await launch(deskUrl)) === "ok") return json({ action: "opened", name: computers.find(x => x.self)?.name });
		} else if ("url" in viewer && viewer.url && (await d.peerOpen(viewer.url, deskUrl).catch(() => false))) return json({ action: "opened", name: viewer.name });
		const go = /^[0-9a-f]{64}$/.test(st.ticket ?? "") ? { go: st.ticket } : {};
		return json({ action: "here", ...go, ...(b.chrome === true ? {} : { note: NOTE }) });
	}
	// Chrome is the keyboard-lock browser; the viewer's own gateway opens it, the page never calls another computer.
	async function open(req: Request, url: URL, mode: string): Promise<Response> {
		const b = await body(req);
		const s = readSettings(d.dataDir);
		const blocked = (reason: string) => json({ action: "blocked", reason });
		if (!b) return json({ error: "JSON body required" }, 400);
		if (b.peer !== undefined) return openPeer(req, mode, b);
		if (!available()) return blocked("화면 공유가 꺼져 있어요");
		if (isPublic(req, mode) && !s.allow_public) return blocked("공개 접속으로는 화면 공유를 쓸 수 없어요");
		const viewer = await viewerOf(req, d);
		if ("self" in viewer) return blocked("이 컴퓨터의 화면을 이 컴퓨터에서 보면 화면 안에 화면이 겹쳐 보여요. 다른 컴퓨터에서 열어 주세요");
		// `on`: the button of an off computer switches it on and opens. After the gates, so a refused open changes nothing.
		if (!s.on) {
			if (b.on !== true) return blocked("화면 공유가 꺼져 있어요");
			writeSettings(d.dataDir, { ...s, on: true });
		}
		if (b.chrome === true) return json({ action: "here" });
		if (b.phone === true) return json({ action: "here", note: NOTE });
		const self = (await d.computers().catch(() => [])).find(c => c.self);
		if ("url" in viewer && viewer.url && self) {
			const opened = await d.peerOpen(viewer.url, new URL("/desk/", self.url).href).catch(() => false);
			if (opened) return json({ action: "opened", name: viewer.name });
		}
		return json({ action: "here", note: NOTE });
	}
	// On the viewer's gateway: open that one path of an owner's other computer in Chrome. No voxl needed here.
	async function peerOpen(req: Request): Promise<Response> {
		if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
		if (!req.headers.has(PEER_HEADER)) return text("forbidden", 403);
		const raw = (await body(req))?.url;
		const u = typeof raw === "string" ? URL.parse(raw) : null;
		const known = (await d.computers()).filter(c => !c.self).map(c => URL.parse(c.url)?.origin);
		if (!u || u.protocol !== "https:" || u.pathname !== "/desk/" || u.search || u.hash || u.username || u.password || !known.includes(u.origin)) return json({ ok: false, reason: "bad-url" }, 400);
		const r = await launch(u.href);
		return r === "ok" ? json({ ok: true }) : json({ ok: false, reason: r }, r === "rate" ? 429 : 200);
	}
	// What the switcher on another computer asks before it shows this screen. The same facts /api/desk/status has, without the viewers, and
	// when the screen can be opened a one-time ticket past the cross-site gate. It replaces only that gate: the browser that spends it still
	// passes the owner check here, and a site that wants to start capture cannot get one.
	function peerDesk(req: Request, mode: string): Response {
		if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
		if (!req.headers.has(PEER_HEADER)) return text("forbidden", 403);
		if (d.platform !== "darwin") return json({ available: false, unsupported: true });
		if (!available()) return json({ available: false });
		const s = readSettings(d.dataDir);
		const blocked = mode === "cloudflare" && !s.allow_public;
		return json({ available: true, on: s.on, public_blocked: blocked, ...(s.on && !blocked ? { ticket: mintTicket() } : {}) });
	}
	// Runs in the gateway's own process chain: macOS grants screen recording to the program that asks, never to a terminal.
	async function probe(req: Request): Promise<Response> {
		const b = await body(req);
		if (!b) return json({ error: "JSON body required" }, 400);
		if (b.trial === true) {
			if ((await host.ensure().catch(() => "failed")) !== "ok") return json({ ok: false, reason: "start" });
			try {
				const shot = await host.fetchUp("/screenshot");
				const png = new Uint8Array(await shot.arrayBuffer());
				const magic = [0x89, 0x50, 0x4e, 0x47].every((v, i) => png[i] === v);
				return json({ ok: shot.ok && magic && png.length > 1000, bytes: png.length });
			} finally {
				await host.stop();
			}
		}
		const check = async (k: keyof typeof JXA) => (await d.host.exec(["osascript", "-l", "JavaScript", "-e", JXA[k]], { timeoutMs: 15_000 })).stdout.trim() === "true";
		let step: string | undefined;
		if (b.grant === true)
			for (const key of ["screen", "accessibility"] as const) {
				const g = await grantPermission(d.host, { key, row: "bun", path: process.execPath, check: () => check(key) });
				step ??= g.step;
			}
		return json({ screen: await check("screen"), accessibility: await check("accessibility"), ...(step ? { step } : {}) });
	}
	async function api(req: Request, url: URL, mode: string): Promise<Response> {
		const act = url.pathname.slice("/api/desk/".length);
		if (act === "open" && req.method === "POST") return sameOrigin(req) ? open(req, url, mode) : json({ error: "cross-origin request" }, 403);
		if (!available()) return json({ available: false });
		if (act === "status" && req.method === "GET") return json(status(mode));
		if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "cross-origin request" }, 403);
		if (act === "probe" && req.method === "POST") return probe(req);
		if (act === "settings" && req.method === "PUT") {
			const b = await body(req);
			const keys = ["on", "allow_public"] as const;
			if (!b || keys.some(k => k in b && typeof b[k] !== "boolean")) return json({ error: "on, allow_public must be booleans" }, 400);
			const prev = readSettings(d.dataDir);
			const next = { ...prev, ...Object.fromEntries(keys.filter(k => k in b).map(k => [k, b[k]])) } as Settings;
			writeSettings(d.dataDir, next);
			await host.settingsChanged(prev, next);
			return json(status(mode));
		}
		return json({ error: "not found" }, 404);
	}

	return {
		host,
		available,
		/** undefined: not mine; null: upgraded to a websocket (the caller answers nothing). */
		async route(req: Request, url: URL, srv: Server<unknown> | undefined, mode: string): Promise<Response | null | undefined> {
			const p = url.pathname;
			if (p === "/api/peer/desk-open") return peerOpen(req);
			if (p === "/api/peer/desk") return peerDesk(req, mode);
			if (p.startsWith("/api/desk/")) return api(req, url, mode);
			if (p !== "/desk" && !p.startsWith("/desk/")) return undefined;
			const res = await proxy(req, url, srv, mode);
			if (!res) return res;
			res.headers.set("X-Frame-Options", "DENY");
			res.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
			res.headers.set("Cache-Control", "no-store");
			res.headers.set("Referrer-Policy", "no-referrer");
			return res;
		},
		/** /api/state: only on an install that has it. */
		summary: () => {
			if (!available()) return undefined;
			const s = readSettings(d.dataDir);
			return { on: s.on, running: host.ready, viewers: [...host.viewers.values()] };
		},
		stop: () => host.stop(),
		socket: {
			open(ws: ServerWebSocket<DeskWsData>) {
				if (!host.ready) return void ws.close(1012, "restart");
				host.addViewer(ws, ws.data);
				ws.data.bridge = new Bridge(ws, host, d.clock, ws.data.search);
			},
			message(ws: ServerWebSocket<DeskWsData>, msg: string | Uint8Array) {
				ws.data.bridge?.send(msg);
			},
			drain(ws: ServerWebSocket<DeskWsData>) {
				ws.data.bridge?.resume();
			},
			close(ws: ServerWebSocket<DeskWsData>) {
				ws.data.bridge?.close();
				host.dropViewer(ws);
			},
		},
	};
}

export function defaultDeps(): DeskDeps {
	const memo = <T>(ms: number, fn: () => Promise<T>) => {
		let hit: { at: number; v: T } | undefined;
		return async () => (hit && Date.now() - hit.at < ms ? hit.v : (hit = { at: Date.now(), v: await fn() }).v);
	};
	// Asked on every /api/state: the folder scan runs only when the personal copy that switches the feature changed.
	const personal = join(DATA_DIR, "features", "remote-desktop", "feature.md");
	let seen: { mtime: number; on: boolean } | undefined;
	return {
		dataDir: DATA_DIR,
		platform: process.platform,
		featureOn: () => {
			const mtime = statSync(personal, { throwIfNoEntry: false })?.mtimeMs;
			if (mtime === undefined) return false; // shipped off
			if (seen?.mtime !== mtime) seen = { mtime, on: loadFeatureDirs(DATA_DIR).features.find(f => f.id === "remote-desktop")?.enabled === true };
			return seen.on;
		},
		spawn: (argv, env) => Bun.spawn(argv, { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }),
		watch: pid => {
			const w = Bun.spawn(["sh", "-c", `cat >/dev/null; kill -TERM ${pid}`], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
			return () => (w.kill("SIGKILL"), void w.stdin.end());
		},
		freePort: async () => {
			const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
			const p = l.port;
			l.stop(true);
			return p;
		},
		clock: { now: () => Date.now(), after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } },
		rebuild: async () => (await Bun.spawn([process.execPath, join(import.meta.dir, "..", "features", "remote-desktop", "bin", "onboard.ts"), "--rebuild"], { stdout: "ignore", stderr: "ignore" }).exited) === 0,
		tailscale: memo(60_000, tailscaleStatus),
		computers: knownComputers,
		peerOpen: async (gateway, deskUrl) => {
			const h = peerHeaders(peerTokenFor(gateway));
			if (!h) return false;
			const r = await peerFetch(new URL("/api/peer/desk-open", gateway), { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ url: deskUrl }), signal: AbortSignal.timeout(5_000) });
			return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
		},
		peerDesk: async gateway => {
			const h = peerHeaders(peerTokenFor(gateway));
			if (!h) return undefined;
			const r = await peerFetch(new URL("/api/peer/desk", gateway), { headers: h, signal: AbortSignal.timeout(3_000) });
			return r.ok ? ((await r.json()) as PeerDesk) : { available: false, old: true };
		},
		run: async argv => await Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).exited,
		host: realHost,
	};
}

export const desk = createDesk(defaultDeps());
