import { expect, test } from "bun:test";
import { checkPeer, peerToken } from "./peer-auth.ts";
import { type Computer, createPeerMonitor, type PeerMonitor } from "./peer-monitor.ts";

// Two simulated gateways (A and B) in one process: each is a handler function (peer gate, peer routes, then a small fake of the owner's own API),
// wired to the other by an injected fetch. No network, no real clock.
const TOKEN = "t".repeat(24);
const LOGIN = "owner@example.test";
const URL_A = "https://a.example.test";
const URL_B = "https://b.example.test";
let clock = 1_000_000;

type Gateway = { name: string; mon: PeerMonitor; handle: (req: Request) => Promise<Response>; events: Array<{ target: string; text: string; via?: string; files?: unknown }>; uploads: Map<string, Uint8Array>; notes: Array<{ id: string; title: string }>; down: boolean; hang: boolean; statuses: number[]; seen: Request[] };
const nodes = new Map<string, Gateway>();

const netFetch = async (url: string, init?: RequestInit): Promise<Response> => {
	const g = nodes.get(new URL(url).origin);
	if (!g || g.down) throw new Error("connection refused");
	if (g.hang) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
	const req = new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "tailscale-user-login": LOGIN } });
	g.seen.push(req.clone());
	const res = await g.handle(req);
	g.statuses.push(res.status);
	return res;
};

function gateway(name: string, self: string, other: string, otherName: string): Gateway {
	const events: Gateway["events"] = [];
	const notes: Gateway["notes"] = [];
	const uploads = new Map<string, Uint8Array>();
	const local = async (req: Request): Promise<Response> => {
		const path = new URL(req.url).pathname;
		// The gateway's own /api/upload: stores the bytes under this gateway's upload folder and answers with its paths.
		if (req.method === "POST" && path === "/api/upload") {
			const files = (await req.formData()).getAll("file") as File[];
			const out = await Promise.all(files.map(async f => {
				const p = `/${name}/uploads/${f.name}`;
				uploads.set(p, new Uint8Array(await f.arrayBuffer()));
				return { path: p, name: f.name, type: f.type, size: f.size };
			}));
			return Response.json({ ok: true, files: out });
		}
		if (req.method === "POST" && path === "/api/message") {
			const b = (await req.json()) as { mail?: string; lane?: string; project?: string; settings?: string; text: string; via?: string; files?: Array<{ path: string }> };
			// Like routes.ts ownerFiles: only this gateway's own uploads are accepted.
			if (b.files && !b.files.every(f => uploads.has(f.path))) return Response.json({ error: "첨부파일을 찾지 못했어요" }, { status: 400 });
			events.push({ target: b.project ?? (b.settings ? `settings:${b.settings}` : b.mail ? `mail:${b.mail}` : `lane:${b.lane}`), text: b.text, ...(b.project && b.settings ? { settings: b.settings } : {}), ...(b.via ? { via: b.via } : {}), ...(b.files ? { files: b.files } : {}) });
			return Response.json({ ok: true });
		}
		if (req.method === "DELETE" && path.startsWith("/api/kakao/chat/")) {
			const p = path.split("/");
			events.push({ target: `kakao:${p[4]}`, text: `delete ${p[6]}` });
			return Response.json({ ok: true, removed: true });
		}
		if (req.method === "POST" && path.startsWith("/api/kakao/chat/")) {
			const b = (await req.json()) as { text: string };
			events.push({ target: `kakao:${decodeURIComponent(path.split("/")[4]!)}`, text: path.endsWith("/draft") ? `draft ${JSON.stringify(b)}` : b.text });
			return Response.json({ ok: true });
		}
		if (req.method === "POST" && (path.startsWith("/api/comments/") || path.startsWith("/api/kakao/drafts/"))) {
			events.push({ target: "comments", text: `${path} ${JSON.stringify(await req.json())}` });
			return Response.json({ ok: true });
		}
		if (req.method === "GET" && path === "/api/replies") return Response.json({ items: [{ kind: "kakao", app: "kakao", code: `K-${name}`, at: 1 }] });
		if (req.method === "PUT" && path.startsWith("/api/kakao/rooms/")) {
			events.push({ target: `kakao:${decodeURIComponent(path.split("/")[4]!)}`, text: `room ${JSON.stringify(await req.json())}` });
			return Response.json({ ok: true });
		}
		if (req.method === "POST" && path === "/api/notices/reopen") {
			events.push({ target: "notices", text: `reopen ${JSON.stringify(await req.json())}` });
			return Response.json({ reopened: [], unread: 0 });
		}
		if (req.method === "POST" && /^\/api\/drafts\/[A-Za-z0-9._-]+\/files$/.test(path)) {
			events.push({ target: `draft:${path.split("/")[3]}`, text: JSON.stringify(await req.json()) });
			return Response.json({ ok: true });
		}
		if (req.method === "PATCH" && /^\/api\/watches\/[a-z0-9-]+\/settings$/.test(path)) {
			events.push({ target: `settings:${path.split("/")[3]}`, text: JSON.stringify(((await req.json()) as { values: unknown }).values) });
			return Response.json({ ok: true });
		}
		if (req.method === "GET" && /^\/api\/projects\/[^/]+\/delete-plan$/.test(path)) return Response.json({ channel: decodeURIComponent(path.split("/")[3]!), name: "유튜브", monitors: [], logins: [], notices: 2, messages: 0, running: [], archive: "/data/archive" });
		if (req.method === "DELETE" && /^\/api\/projects\/[^/]+$/.test(path)) {
			events.push({ target: `project:${decodeURIComponent(path.split("/")[3]!)}`, text: JSON.stringify(await req.json()) });
			return Response.json({ ok: true, channel: decodeURIComponent(path.split("/")[3]!), name: "유튜브" });
		}
		if (req.method === "PATCH" && /^\/api\/integrations\/[a-z0-9-]+\/settings$/.test(path)) {
			events.push({ target: `app:${path.split("/")[3]}`, text: JSON.stringify(((await req.json()) as { values: unknown }).values) });
			return Response.json({ ok: true });
		}
		if (req.method === "POST" && path === "/api/apps") {
			events.push({ target: "app:new", text: JSON.stringify(await req.json()) });
			return Response.json({ ok: true, id: "mail-2" });
		}
		if (req.method === "DELETE" && /^\/api\/apps\/[a-z0-9-]+$/.test(path)) {
			events.push({ target: `app:${path.split("/")[3]}`, text: `delete${new URL(req.url).search}` });
			return Response.json({ ok: true });
		}
		if (path === "/api/monitors") return Response.json({ items: [{ name: `${name} 감시`, kind: "watch" }] });
		if (path === "/api/notices") return Response.json({ items: [{ id: `n-${name}`, title: `${name} 알림`, read: false }, ...notes], unread: 1 + notes.length });
		if (path === "/api/integrations") return Response.json({ items: [{ key: "mail", unread: events.length }] });
		if (path === "/api/conversations") {
			const last = events.at(-1);
			return Response.json({ items: [{ target: "lane:work", last: null }, { target: "mail:inbox", last: last ? { text: last.text, ...(last.via ? { via: last.via } : {}) } : null }, { target: "kakao:room", last: null }] });
		}
		return new Response("not found", { status: 404 });
	};
	const computers: Computer[] = [{ name, url: self, self: true }, { name: otherName, url: other, self: false }];
	const mon = createPeerMonitor({ name: () => name, local, computers: async () => computers, fetch: netFetch, now: () => clock, token: () => TOKEN, timeoutMs: 20 });
	const handle = async (req: Request): Promise<Response> => {
		if (checkPeer(req, TOKEN) === "denied") return new Response("forbidden", { status: 403 });
		return (await mon.route(req, new URL(req.url))) ?? local(req);
	};
	const g: Gateway = { name, mon, handle, events, uploads, notes, down: false, hang: false, statuses: [], seen: [] };
	nodes.set(self, g);
	return g;
}
const pair = () => {
	nodes.clear();
	return { A: gateway("노트북", URL_A, URL_B, "맥미니"), B: gateway("맥미니", URL_B, URL_A, "노트북") };
};
const req = (path: string, init: RequestInit = {}) => new Request(`${URL_A}${path}`, init);

test("a peer snapshot carries the run state of that gateway's mail conversations", async () => {
	const runs = { "mail:k1": { kind: "working", detail: "흐름도 그리기" } };
	const mon = createPeerMonitor({ name: () => "맥미니", local: async () => Response.json({}), computers: async () => [], runs: () => runs });
	expect((await mon.snapshot()).runs).toEqual(runs);
	const plain = createPeerMonitor({ name: () => "맥미니", local: async () => Response.json({}), computers: async () => [] });
	expect((await plain.snapshot()).runs).toBeUndefined();
});

test("merge: the peer's items come with its name, mail and kakao rows only, and this gateway's own list stays local", async () => {
	const { A, B } = pair();
	const merged = await A.mon.peerMonitoring();
	expect(merged).toHaveLength(1);
	const [m] = merged;
	expect(m).toMatchObject({ name: "맥미니", url: URL_B, online: true, stale: false });
	expect(m!.items!.name).toBe("맥미니");
	expect(m!.items!.monitors).toEqual([{ name: "맥미니 감시", kind: "watch" }]);
	expect(m!.items!.conversations.map(c => (c as { target: string }).target)).toEqual(["mail:inbox", "kakao:room"]);
	const own = await A.mon.snapshot();
	expect(own.monitors).toEqual([{ name: "노트북 감시", kind: "watch" }]);
	expect(JSON.stringify(own)).not.toContain("맥미니");
	expect(B.mon).toBeDefined();
});

// A page read of the merged 모니터링 answers with what the peer says now: a change its stream already reported (invalidatePeer, started but not
// finished) and a cache past its 20 s interval are both read before the answer, so a decision answered on the other computer is not drawn open
// here for another interval.
test("the peer's change reaches the answer: a refresh in flight and a stale cache are both read first", async () => {
	const { A, B } = pair();
	const first = (await A.mon.peerMonitoring())[0]!;
	expect(first.items!.notices).toHaveLength(1);

	B.notes.push({ id: "n-answer", title: "answered: 보내지 않기" });
	A.mon.invalidatePeer(URL_B);   // the peer's stream reported the change: the read runs now
	const inFlight = (await A.mon.peerMonitoring())[0]!;
	expect((inFlight.items!.notices as Array<{ id: string }>).map(n => n.id)).toEqual(["n-맥미니", "n-answer"]);
	expect(inFlight.items!.rev).not.toBe(first.items!.rev);

	B.notes.push({ id: "n-later", title: "answered later" });
	clock += 21_000;   // the cache is past its interval: this answer must carry the read, not just start it
	const later = (await A.mon.peerMonitoring())[0]!;
	expect((later.items!.notices as Array<{ id: string }>).map(n => n.id)).toEqual(["n-맥미니", "n-answer", "n-later"]);
});

test("a peer that is down: offline, answered within the timeout budget, cached items kept as stale", async () => {
	const { A, B } = pair();
	B.hang = true;
	const first = await A.mon.peerMonitoring();
	expect(first).toEqual([{ name: "맥미니", url: URL_B, online: false, stale: false, items: null }]);

	B.hang = false;
	clock += 21_000;
	await A.mon.peerMonitoring();
	await A.mon.idle();
	const up = (await A.mon.peerMonitoring())[0]!;
	expect(up.online).toBe(true);
	const items = up.items;

	B.down = true;
	A.mon.invalidatePeer(URL_B);
	await A.mon.idle();
	const down = (await A.mon.peerMonitoring())[0]!;
	expect(down).toMatchObject({ online: false, stale: true });
	expect(down.items).toBe(items);
});

test("ETag: an unchanged peer answers 304 and the cached snapshot object is kept", async () => {
	const { A, B } = pair();
	const first = (await A.mon.peerMonitoring())[0]!.items!;
	expect(B.statuses).toEqual([200]);
	A.mon.invalidatePeer(URL_B);
	await A.mon.idle();
	expect(B.seen.at(-1)!.headers.get("if-none-match")).toBe(`"${first.rev}"`);
	expect(B.statuses).toEqual([200, 304]);
	const second = (await A.mon.peerMonitoring())[0]!;
	expect(second.items).toBe(first);
	expect(second.online).toBe(true);
	const direct = await B.handle(new Request(`${URL_B}/api/peer/monitoring`, { headers: { "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN, "if-none-match": "W/\"" + first.rev + "\"" } }));
	expect(direct.status).toBe(304);
});

test("no token: the peer is read with the four plain reads, without the peer header, and actions are refused", async () => {
	const { A, B } = pair();
	const quiet = createPeerMonitor({ name: () => "x", local: async () => new Response("no"), computers: async () => [{ name: "맥미니", url: URL_B, self: false }], fetch: netFetch, token: () => undefined, now: () => clock });
	const [v] = await quiet.peerMonitoring();
	expect(v).toMatchObject({ name: "맥미니", online: true, stale: false });
	expect(v!.items!.monitors).toEqual([{ name: "맥미니 감시", kind: "watch" }]);
	expect(B.seen.map(r => new URL(r.url).pathname).sort()).toEqual(["/api/conversations", "/api/integrations", "/api/monitors", "/api/notices"]);
	expect(B.seen.every(r => r.headers.get("x-dotz-peer") === null)).toBe(true);
	const act = await quiet.route(new Request(`${URL_A}/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`, { method: "POST", body: "{}" }), new URL(`${URL_A}/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`));
	expect(act!.status).toBe(503);
	expect(A.name).toBe("노트북");
});

test("an older peer without /api/peer/monitoring (404) is read with the plain reads", async () => {
	const { A, B } = pair();
	const inner = B.handle;
	B.handle = async r => (new URL(r.url).pathname === "/api/peer/monitoring" ? new Response("not found", { status: 404 }) : inner(r));
	const [v] = await A.mon.peerMonitoring();
	expect(v).toMatchObject({ name: "맥미니", online: true });
	expect(v!.items!.notices).toEqual([{ id: "n-맥미니", title: "맥미니 알림", read: false }]);
	expect(v!.items!.conversations.map(c => (c as { target: string }).target)).toEqual(["mail:inbox", "kakao:room"]);
});

test("checkPeer gates", () => {
	const headers = (h: Record<string, string>) => ({ headers: h });
	const good = { "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN };
	const get = (path: string, h: Record<string, string>, method = "GET") => new Request(`${URL_A}${path}`, { method, ...headers(h) });
	expect(checkPeer(get("/api/notices", {}), TOKEN)).toBe("none");
	expect(checkPeer(get("/api/peer/monitoring", good), TOKEN)).toBe("ok");
	expect(checkPeer(get("/api/peer/act", good, "POST"), TOKEN)).toBe("ok");
	expect(checkPeer(get("/api/peer/monitoring", good), peerToken("/nonexistent/peer-token"))).toBe("denied");
	expect(checkPeer(get("/api/peer/monitoring", { ...good, "x-dotz-peer": "w".repeat(24) }), TOKEN)).toBe("denied");
	expect(checkPeer(get("/api/peer/monitoring", { "x-dotz-peer": TOKEN }), TOKEN)).toBe("denied");
	expect(checkPeer(get("/api/message", good, "POST"), TOKEN)).toBe("denied");
	expect(checkPeer(get("/api/state", good), TOKEN)).toBe("denied");
});

test("proxy: only known peers, only the peer lists", async () => {
	const { A, B } = pair();
	const through = (pc: string, p: string, method = "GET", body?: object) =>
		A.handle(req(`/api/peer/proxy?pc=${encodeURIComponent(pc)}&p=${encodeURIComponent(p)}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
	expect((await through("https://evil.example.test", "/api/notices")).status).toBe(400);
	expect((await through(URL_A, "/api/notices")).status).toBe(400);
	expect((await through(URL_B, "/api/state")).status).toBe(400);
	expect((await through(URL_B, "//evil.example.test/api/notices")).status).toBe(400);
	expect((await through(URL_B, "/api/message", "POST", { text: "x" })).status).toBe(400);
	expect(B.seen).toHaveLength(0);
	const ok = await through(URL_B, "/api/notices");
	expect(ok.status).toBe(200);
	expect(ok.headers.get("content-type")).toContain("json");
	expect(((await ok.json()) as { unread: number }).unread).toBe(1);
	B.down = true;
	const gone = await through(URL_B, "/api/notices");
	expect(gone.status).toBe(502);
	expect(await gone.json()).toEqual({ error: "연결 안 됨" });
});

test("a forwarded message is recorded once on the owner with via, and shows once in the sender's merged view", async () => {
	const { A, B } = pair();
	await A.mon.peerMonitoring();
	const sent = await A.handle(req(`/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`, { method: "POST", body: JSON.stringify({ action: "message", args: { target: "mail:inbox", text: "알겠습니다" }, from: "spoofed" }) }));
	expect(sent.status).toBe(200);
	expect(B.events).toEqual([{ target: "mail:inbox", text: "알겠습니다", via: "노트북" }]);
	expect(A.events).toEqual([]);
	A.mon.invalidatePeer(URL_B);
	await A.mon.idle();
	const view = (await A.mon.peerMonitoring())[0]!.items!;
	const rows = view.conversations.filter(c => (c as { target: string }).target === "mail:inbox") as Array<{ last: { text: string; via: string } }>;
	expect(rows).toHaveLength(1);
	expect(rows[0]!.last).toEqual({ text: "알겠습니다", via: "노트북" });
});

test("a file attached to a peer's conversation is uploaded to that peer, and the message carries the peer's own paths", async () => {
	const { A, B } = pair();
	const act = (b: object) => A.handle(req(`/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`, { method: "POST", body: JSON.stringify(b) }));
	const bytes = new TextEncoder().encode("<html>흐름도</html>");
	const up = await act({ action: "upload", args: { files: [{ name: "흐름도.html", type: "text/html", data: Buffer.from(bytes).toString("base64") }] } });
	expect(up.status).toBe(200);
	const { files } = (await up.json()) as { files: Array<{ path: string; name: string; size: number }> };
	expect(files.map(({ path, name, size }) => ({ path, name, size }))).toEqual([{ path: "/맥미니/uploads/흐름도.html", name: "흐름도.html", size: bytes.length }]);
	expect(files[0]!.type).toStartWith("text/html");
	expect(B.uploads.get(files[0]!.path)).toEqual(bytes);
	expect(A.uploads.size).toBe(0);
	const sent = await act({ action: "message", args: { target: "mail:inbox", text: "이걸로 다시 보내놓", files } });
	expect(sent.status).toBe(200);
	expect(B.events).toEqual([{ target: "mail:inbox", text: "이걸로 다시 보내놓", via: "노트북", files }]);
	// A path of the sending computer is refused there, never forwarded as text without its file.
	const foreign = await act({ action: "message", args: { target: "mail:inbox", text: "x", files: [{ path: "/노트북/uploads/a.html", name: "a.html" }] } });
	expect(foreign.status).toBe(400);
	expect(B.events).toHaveLength(1);
	expect((await act({ action: "upload", args: { files: [] } })).status).toBe(400);
	expect((await act({ action: "upload", args: { files: [{ name: "a" }] } })).status).toBe(400);
	// The bubble's chip reads the file back through the proxy: /api/peer/file is on the peer read list (this fake has no such GET: 404, not 400).
	expect((await A.handle(req(`/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent(`/api/peer/file?path=${encodeURIComponent(files[0]!.path)}`)}`))).status).toBe(404);
	expect(checkPeer(new Request(`${URL_B}/api/peer/file?path=x`, { headers: { "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN } }), TOKEN)).toBe("ok");
	expect(checkPeer(new Request(`${URL_B}/api/file?path=x`, { headers: { "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN } }), TOKEN)).toBe("denied");
});

test("act: unknown action, unknown target and a missing sender are refused", async () => {
	const { B } = pair();
	const act = (b: object) => B.handle(new Request(`${URL_B}/api/peer/act`, { method: "POST", headers: { "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN }, body: JSON.stringify(b) }));
	expect((await act({ action: "rm", args: {}, from: "노트북" })).status).toBe(400);
	expect((await act({ action: "message", args: { target: "kakao:room", text: "hi" }, from: "노트북" })).status).toBe(400);
	expect((await act({ action: "message", args: { target: "mail:inbox", text: "hi" } })).status).toBe(400);
	expect(B.events).toEqual([]);
});

test("deleting a failed KakaoTalk send from a peer runs on the owner's own delete route, once", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const r = await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "kakao", args: { op: "send-delete", chatId: "123", sendId: "S1" } }) }));
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ ok: true, removed: true });
	expect(B.events).toEqual([{ target: "kakao:123", text: "delete S1" }]);
	expect(A.events).toEqual([]);
	expect((await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "kakao", args: { op: "send-delete", chatId: "123" } }) }))).status).toBe(400);
});

test("a monitor settings change from a peer is a plain PATCH on the owner, once; its settings read is a proxied GET", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const r = await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "watch", args: { name: "disk-check", op: "settings", values: { every_minutes: 30 } } }) }));
	expect(r.status).toBe(200);
	expect(B.events).toEqual([{ target: "settings:disk-check", text: JSON.stringify({ every_minutes: 30 }) }]);
	expect(A.events).toEqual([]);
	const read = await A.handle(req(`/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/watches/disk-check/settings")}`));
	expect(read.status).toBe(404);   // allowed through to B (this fake has no such route); a path outside the peer read list would be 400
});

test("a peer app's 답장 모델 change is the owner's own plain settings PATCH, once", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const values = { reply_model: "anthropic/claude-sonnet-5-5:high" };
	expect((await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "app", args: { op: "settings", app: "kakao", values } }) }))).status).toBe(200);
	expect(B.events).toEqual([{ target: "app:kakao", text: JSON.stringify(values) }]);
	expect(A.events).toEqual([]);
});

test("a peer mail instance's 디스코드에도 올리기 switch is the owner's own plain settings PATCH, once", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	expect((await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "app", args: { op: "settings", app: "mail-2", values: { discord: true } } }) }))).status).toBe(200);
	expect(B.events).toEqual([{ target: "app:mail-2", text: JSON.stringify({ discord: true }) }]);
	expect(A.events).toEqual([]);
});

test("an app instance's rename, create and delete from a peer are the owner's own plain calls, once each", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const act = (args: object) => A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "app", args }) }));
	expect((await act({ op: "settings", app: "mail-2", values: { label: "개인" } })).status).toBe(200);
	expect((await act({ op: "create", app: "mail", label: "개인", filter: { conv: ["mail:naver-"] } })).status).toBe(200);
	expect((await act({ op: "delete", app: "mail-2", deleteData: true })).status).toBe(200);
	expect((await act({ op: "delete", app: "mail-3" })).status).toBe(200);
	expect(B.events).toEqual([
		{ target: "app:mail-2", text: JSON.stringify({ label: "개인" }) },
		{ target: "app:new", text: JSON.stringify({ app: "mail", label: "개인", filter: { conv: ["mail:naver-"] } }) },
		{ target: "app:mail-2", text: "delete?data=1" },
		{ target: "app:mail-3", text: "delete" },
	]);
	expect(A.events).toEqual([]);
	expect((await act({ op: "rm", app: "mail-2" })).status).toBe(400);
});

test("a KakaoTalk reply from a peer runs on the owner's own kakao send route, once", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const r = await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "kakao", args: { op: "send", chatId: "123", text: "네" } }) }));
	expect(r.status).toBe(200);
	expect(B.events).toEqual([{ target: "kakao:123", text: "네" }]);
	expect(A.events).toEqual([]);
	expect((await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "kakao", args: { op: "rm", chatId: "123" } }) }))).status).toBe(400);
});

test("지켜보기 / 자동 초안 of a peer's KakaoTalk room is the owner's own room PUT, once each", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const act = (args: object) => A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "kakao", args }) }));
	expect((await act({ op: "room", chatId: "123", watched: true })).status).toBe(200);
	expect((await act({ op: "room", chatId: "123", autoDraft: false })).status).toBe(200);
	expect(B.events).toEqual([{ target: "kakao:123", text: `room ${JSON.stringify({ watched: true })}` }, { target: "kakao:123", text: `room ${JSON.stringify({ autoDraft: false })}` }]);
	expect(A.events).toEqual([]);
	expect((await act({ op: "room" })).status).toBe(400);
});

test("되돌리기 of a peer's draft answered 보내지 않기 reopens that notice on its owner, once", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	expect((await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "notice", args: { op: "reopen", id: "d1" } }) }))).status).toBe(200);
	expect(B.events).toEqual([{ target: "notices", text: `reopen ${JSON.stringify({ ids: ["d1"] })}` }]);
	expect(A.events).toEqual([]);
});

test("a 고치기 request for a peer's KakaoTalk draft reaches the owner's draft route with the instruction", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const revise = { code: "d2", change: "더 짧게" };
	const r = await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "kakao", args: { op: "draft", chatId: "123", revise } }) }));
	expect(r.status).toBe(200);
	expect(B.events).toEqual([{ target: "kakao:123", text: `draft ${JSON.stringify({ revise })}` }]);
	expect(A.events).toEqual([]);
});

test("a project delete from a peer reads its plan and runs the owner's own DELETE route, once", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const post = (args: object) => A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "project", args }) }));
	const plan = await post({ op: "delete-plan", key: "ch:77" });
	expect(plan.status).toBe(200);
	expect(await plan.json()).toMatchObject({ channel: "ch:77", notices: 2 });
	expect(B.events).toEqual([]);
	const r = await post({ op: "delete", key: "ch:77", archive: false });
	expect(r.status).toBe(200);
	expect(B.events).toEqual([{ target: "project:ch:77", text: JSON.stringify({ archive: false }) }]);
	expect(A.events).toEqual([]);
	expect((await post({ op: "delete" })).status).toBe(400);
	expect((await post({ op: "rm", key: "ch:77" })).status).toBe(400);
});

test("a message to a peer's monitor conversation is forwarded as the settings target of that watch, with who asked", async () => {
	const { A, B } = pair();
	const pc = encodeURIComponent(URL_B), p = encodeURIComponent("/api/peer/act");
	const r = await A.handle(req(`/api/peer/proxy?pc=${pc}&p=${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "message", args: { target: "settings:w:login-cartier-com", text: "다시 로그인해 줘" } }) }));
	expect(r.status).toBe(200);
	expect(B.events).toEqual([{ target: "settings:w:login-cartier-com", text: "다시 로그인해 줘", via: "노트북" }]);
	expect(A.events).toEqual([]);
});

test("a message to a project target of a peer never carries a monitor name; a settings conversation target ignores it", async () => {
	const { A, B } = pair();
	const pc = encodeURIComponent(URL_B), p = encodeURIComponent("/api/peer/act");
	const post = (body: unknown) => A.handle(req(`/api/peer/proxy?pc=${pc}&p=${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
	expect((await post({ action: "message", args: { target: "ch:1562723146669490227", settings: "w:login-cartier-com", text: "원인 찾아 줘" } })).status).toBe(200);
	expect(B.events).toEqual([{ target: "ch:1562723146669490227", text: "원인 찾아 줘", via: "노트북" }]);
	expect((await post({ action: "message", args: { target: "settings:w:login-cartier-com", settings: "w:other", text: "x" } })).status).toBe(200);
	expect(B.events[1]).toEqual({ target: "settings:w:login-cartier-com", text: "x", via: "노트북" });
});

test("a peer's mail draft gets and loses files through the owner's own draft files route, once; the file list is a proxied GET", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const act = (args: object) => A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "draft-files", args }) }));
	expect((await act({ ref: "RPEER0001", library: "악보/행방불명_공유용.pdf" })).status).toBe(200);
	expect((await act({ ref: "RPEER0001", name: "견적.pdf", data: "JVBERg==" })).status).toBe(200);
	expect((await act({ ref: "RPEER0001", remove: 0 })).status).toBe(200);
	expect((await act({ remove: 0 })).status).toBe(400);
	expect(B.events).toEqual([
		{ target: "draft:RPEER0001", text: JSON.stringify({ library: "악보/행방불명_공유용.pdf" }) },
		{ target: "draft:RPEER0001", text: JSON.stringify({ name: "견적.pdf", data: "JVBERg==" }) },
		{ target: "draft:RPEER0001", text: JSON.stringify({ remove: 0 }) },
	]);
	expect(A.events).toEqual([]);
	const read = await A.handle(req(`/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/drafts/RPEER0001/files")}`));
	expect(read.status).toBe(404);   // allowed through to B (this fake has no such GET); a path outside the peer read list would be 400
	const lib = await A.handle(req(`/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/drafts/RPEER0001/library?q=ost")}`));
	expect(lib.status).toBe(404);
});

test("a peer snapshot carries that gateway's store reply drafts; a handler without them leaves the field out", async () => {
	const { A } = pair();
	const [m] = await A.mon.peerMonitoring();
	expect(m!.items!.replies).toEqual([{ kind: "kakao", app: "kakao", code: "K-맥미니", at: 1 }]);
	const plain = createPeerMonitor({ name: () => "맥미니", local: async () => new Response("not found", { status: 404 }), computers: async () => [] });
	expect((await plain.snapshot().catch(() => null))?.replies).toBeUndefined();
});

test("a peer's comment draft, failed reply and dropped draft are acted on its owner's comment routes, once each", async () => {
	const { A, B } = pair();
	const p = `/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=${encodeURIComponent("/api/peer/act")}`;
	const act = (args: object) => A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "comments", args }) }));
	for (const a of [{ op: "draft-send", code: "D1" }, { op: "draft-drop", code: "D1" }, { op: "draft-restore", code: "D1" }, { op: "draft-revise", code: "D1", change: "더 짧게" }, { op: "send-retry", id: "send:cm:1" }, { op: "send-dismiss", id: "send:cm:1" }, { op: "read", source: "youtube", thread: "v1" }])
		expect((await act(a)).status).toBe(200);
	expect(B.events.map(e => e.text)).toEqual([
		"/api/comments/drafts/D1/send {}", "/api/comments/drafts/D1/drop {}", "/api/comments/drafts/D1/restore {}", `/api/comments/drafts/D1/revise ${JSON.stringify({ change: "더 짧게" })}`,
		"/api/comments/sends/send%3Acm%3A1/retry {}", "/api/comments/sends/send%3Acm%3A1/dismiss {}", "/api/comments/thread/youtube/v1/read {}",
	]);
	expect(A.events).toEqual([]);
	expect((await act({ op: "rm", code: "D1" })).status).toBe(400);
	const k = await A.handle(req(p, { method: "POST", body: JSON.stringify({ action: "kakao", args: { op: "draft-restore", code: "K1" } }) }));
	expect(k.status).toBe(200);
	expect(B.events.at(-1)!.text).toBe("/api/kakao/drafts/K1/restore {}");
});
