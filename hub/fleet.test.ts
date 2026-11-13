import { expect, test } from "bun:test";
import { checkPeer } from "./peer-auth.ts";
import { type Computer, createFleet, FLEET_V, type FleetRow, fleetState, type Fleet, type Load, type LoadCore, loadCore } from "./fleet.ts";

const TOKEN = "t".repeat(24);
const LOGIN = "owner@example.test";
const URL_A = "https://a.example.test";
const URL_B = "https://b.example.test";
const URL_C = "https://c.example.test";
const URL_D = "https://d.example.test";

const core = (over: Partial<LoadCore> = {}): LoadCore => ({
	sessions: { live: 0, cap: 4, reason: "" },
	lanes: { active: 0, cap: 3, waiting: 0 },
	waitlist: 0,
	paused: false,
	working: false,
	running: [],
	...over,
});
const load = (over: Partial<LoadCore> = {}): Load => ({ v: FLEET_V, name: "x", at: 1, ...core(over) });

test("fleetState follows the States table", () => {
	expect(fleetState(null, false)).toBe("offline");
	expect(fleetState(load(), false)).toBe("offline");
	expect(fleetState(load(), true)).toBe("idle");
	expect(fleetState(load({ working: true }), true)).toBe("busy");
	expect(fleetState(load({ lanes: { active: 3, cap: 3, waiting: 0 } }), true)).toBe("full");
	expect(fleetState(load({ lanes: { active: 1, cap: 3, waiting: 2 } }), true)).toBe("full");
	expect(fleetState(load({ paused: true }), true)).toBe("full");
	expect(fleetState(load({ paused: true, working: true }), true)).toBe("full");
	expect(fleetState(load({ lanes: { active: 3, cap: 3, waiting: 0 }, working: true }), true)).toBe("full");
	expect(fleetState(null, true)).toBe("busy");
});

test("loadCore carries counts and titles only", () => {
	const out = loadCore({
		sessions: { live: 1, max: 4, reason: "여유 메모리" },
		capacity: { active: 2, lanes: 3, waiting: 1, wait_reason: "메모리가 부족해요", caps: { lanes: 3 } },
		waitlist: 2,
		orchestrator: "rate-limited",
		lanes: [
			{ name: "fleet", title: "컴퓨터 상태", cwd: "/srv/work/repo", repo: "/srv/repo", status: "working", live: true, lastText: "보고 본문", claim: "secret brief", account: "acct-1" },
			{ name: "done", title: "끝난 일", cwd: "/tmp/x", status: "idle", live: false },
		],
		convs: [{ status: "idle" }],
	});
	expect(out.running).toEqual([{ kind: "lane", title: "컴퓨터 상태", status: "working" }]);
	expect(loadCore({ sessions: { live: 1, max: 4 }, capacity: {}, waitlist: 0, orchestrator: "idle", lanes: [], convs: [{ status: "working" }] })).toMatchObject({ working: true, running: [] });
	expect(out.paused).toBe(true);
	expect(out.working).toBe(true);
	expect(out.lanes).toEqual({ active: 2, cap: 3, waiting: 1, reason: "메모리가 부족해요" });
	const values: string[] = [];
	const walk = (x: unknown): void => { if (typeof x === "string") values.push(x); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
	walk(out);
	expect(values.filter(v => v.startsWith("/") || v.startsWith("~"))).toEqual([]);
	expect(JSON.stringify(out)).not.toMatch(/account|acct-1|secret brief|보고 본문/);
});

test("loadCore caps the running list at 20", () => {
	const lanes = Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, status: "working", live: true }));
	expect(loadCore({ sessions: { live: 0, max: 1 }, capacity: {}, waitlist: 0, orchestrator: "idle", lanes, convs: [] }).running).toHaveLength(20);
});

// A gateway: the peer gate, then the fleet routes. `fetch` is the other gateways' view of it, with the tailnet login the proxy adds.
type Node = { fleet: Fleet; handle: (req: Request) => Promise<Response>; calls: Request[]; mode: "ok" | "legacy" | "down" | "stale-token" };
let clock = 1_000_000;
const nodes = new Map<string, Node>();
const netFetch = async (url: string, init?: RequestInit): Promise<Response> => {
	const n = nodes.get(new URL(url).origin);
	if (!n || n.mode === "down") throw new Error("connection refused");
	const req = new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "tailscale-user-login": LOGIN } });
	n.calls.push(req.clone());
	return n.handle(req);
};
function node(url: string, name: string, local: LoadCore, computers: () => Promise<Computer[]>, mode: Node["mode"] = "ok"): Node {
	const self: Node = { mode, calls: [] } as unknown as Node;
	const fleet = createFleet({ name: () => name, local: () => local, computers, fetch: netFetch, now: () => clock, token: () => TOKEN, pair: async () => ({ ok: true }) as never });
	self.fleet = fleet;
	self.handle = async req => {
		const gate = checkPeer(req, TOKEN, true);
		if (gate === "denied") return new Response("denied", { status: 403 });
		if (self.mode === "legacy" && new URL(req.url).pathname === "/api/peer/load") return new Response("not found", { status: 404 });
		return (await fleet.route(req, new URL(req.url))) ?? new Response("not found", { status: 404 });
	};
	nodes.set(url, self);
	return self;
}
const list = (...rest: Array<[string, string]>) => async (): Promise<Computer[]> => [{ name: "맥미니", url: URL_A, self: true }, ...rest.map(([name, url]) => ({ name, url, self: false }))];
const loads = (n: Node) => n.calls.filter(r => new URL(r.url).pathname === "/api/peer/load");

test("/api/peer/load is refused without the peer token or the tailnet login", async () => {
	const req = (headers: Record<string, string>) => new Request(`${URL_B}/api/peer/load`, { headers });
	expect(checkPeer(req({ "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN }), TOKEN, true)).toBe("ok");
	expect(checkPeer(req({ "x-dotz-peer": "w".repeat(24), "tailscale-user-login": LOGIN }), TOKEN, true)).toBe("denied");
	expect(checkPeer(req({ "x-dotz-peer": TOKEN }), TOKEN, true)).toBe("denied");
	expect(checkPeer(req({ "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN }), TOKEN, false)).toBe("denied");
});

test("/api/peer/load answers the body and 304 for an unchanged load, whatever the clock says", async () => {
	nodes.clear();
	const b = node(URL_B, "맥북", core({ working: true, running: [{ kind: "lane", title: "정리", status: "working" }] }), list());
	const get = (etag?: string) => b.handle(new Request(`${URL_B}/api/peer/load`, { headers: { "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN, ...(etag ? { "if-none-match": etag } : {}) } }));
	const first = await get();
	expect(first.status).toBe(200);
	const body = (await first.json()) as Load;
	expect(body).toMatchObject({ v: FLEET_V, name: "맥북", working: true, running: [{ kind: "lane", title: "정리", status: "working" }] });
	expect(Object.keys(body).sort()).toEqual(["at", "lanes", "name", "paused", "running", "sessions", "v", "waitlist", "working"]);
	const etag = first.headers.get("etag")!;
	clock += 5000;
	const again = await get(etag);
	expect(again.status).toBe(304);
	expect(again.headers.get("etag")).toBe(etag);
});

test("/api/fleet lists this computer first, then a peer with load, an older peer and an unreachable one", async () => {
	nodes.clear();
	clock += 1_000_000;
	const a = node(URL_A, "맥미니", core({ working: true, running: [{ kind: "lane", title: "여기 일", status: "working" }] }), list(["맥북", URL_B], ["서버", URL_C], ["노트", URL_D]));
	node(URL_B, "맥북", core({ lanes: { active: 3, cap: 3, waiting: 0 } }), list());
	node(URL_C, "서버", core(), list(), "legacy");
	node(URL_D, "노트", core(), list(), "down");
	const rows = (await (await a.handle(new Request(`${URL_A}/api/fleet`))).json()) as FleetRow[];
	expect(rows.map(r => [r.name, r.self, r.online, r.state])).toEqual([["맥미니", true, true, "busy"], ["맥북", false, true, "full"], ["서버", false, true, "busy"], ["노트", false, false, "offline"]]);
	expect(rows[1]!.load).toMatchObject({ name: "맥북", lanes: { active: 3, cap: 3 } });
	expect(rows[2]).toMatchObject({ load: null, legacy: true });
	expect(rows[3]).toMatchObject({ load: null });
	expect(rows[3]!.legacy).toBeUndefined();
});

test("a peer's load is read once per 20 s, again when stale, and again after peer_counts drops it", async () => {
	nodes.clear();
	clock += 1_000_000;
	const a = node(URL_A, "맥미니", core(), list(["맥북", URL_B]));
	const b = node(URL_B, "맥북", core(), list());
	await a.fleet.fleet();
	await a.fleet.fleet();
	expect(loads(b)).toHaveLength(1);
	clock += 21_000;
	await a.fleet.fleet();
	await a.fleet.idle();
	expect(loads(b)).toHaveLength(2);
	await a.fleet.fleet();
	expect(loads(b)).toHaveLength(2);
	a.fleet.invalidatePeer(URL_B);
	await a.fleet.fleet();
	expect(loads(b)).toHaveLength(3);
	expect(loads(b)[2]!.headers.get("if-none-match")).toBeTruthy();
});

test("a 403 pairs again and asks once more", async () => {
	nodes.clear();
	clock += 1_000_000;
	let token = "stale".repeat(5);
	let pairs = 0;
	const b = node(URL_B, "맥북", core(), list());
	const fleet = createFleet({
		name: () => "맥미니",
		local: () => core(),
		computers: list(["맥북", URL_B]),
		fetch: (url, init) => netFetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>) } }),
		now: () => clock,
		token: () => token,
		pair: async (_url, force) => { if (force) { pairs++; token = TOKEN; } return { ok: true } as never; },
	});
	const rows = await fleet.fleet();
	expect(pairs).toBe(1);
	expect(loads(b)).toHaveLength(2);
	expect(rows[1]).toMatchObject({ online: true, state: "idle" });
});
