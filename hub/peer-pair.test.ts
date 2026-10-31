import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPeer } from "./peer-auth.ts";
import { createPeerMonitor } from "./peer-monitor.ts";
import { acceptedTokens, boundPeer, createPairer, handlePair, outToken, PAIR_PATH, REASON } from "./peer-pair.ts";
import { loginOf, sameUserNodes } from "./peers.ts";

// Gateway A asks gateway B in one process: B's handler is the pair door, the peer gate and the peer routes; the network is an injected fetch
// that stamps the tailscale login the way `tailscale serve` does. Each gateway has its own tmp secrets dir.
const roots: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "peer-pair-"));
	roots.push(d);
	return d;
};
afterAll(() => roots.forEach(d => rmSync(d, { recursive: true, force: true })));

const URL_A = "https://a.example.test";
const URL_B = "https://b.example.test";
const MANUAL = "m".repeat(24);
const mode = (p: string) => statSync(p).mode & 0o777;

function rig(o: { aLogin?: string | null; bOwn?: string | undefined; manualOnB?: boolean; manualOnA?: boolean } = {}) {
	const dirA = tmp();
	const dirB = tmp();
	const seen = { pair: 0, events: [] as string[] };
	const bOwn = "bOwn" in o ? o.bOwn : "owner@example.test";
	const aLogin = o.aLogin === undefined ? "Owner@Example.test" : o.aLogin;
	const local = (name: string) => async (req: Request): Promise<Response> => {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path === "/api/message") {
			const b = (await req.json()) as { text: string; via?: string };
			if (name === "B") seen.events.push(`${b.text}|${b.via}`);
			return Response.json({ ok: true });
		}
		return Response.json({ items: [], unread: 0 });
	};
	const computers = (self: "A" | "B") => async () => [
		{ name: "A", url: URL_A, self: self === "A" },
		{ name: "B", url: URL_B, self: self === "B" },
	];
	const monB = createPeerMonitor({ name: () => "B", local: local("B"), computers: computers("B"), fetch: async () => { throw new Error("B does not call out"); } });
	const handleB = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === PAIR_PATH) {
			seen.pair++;
			return handlePair(req, { ownLogin: async () => bOwn, dir: dirB });
		}
		if (checkPeer(req, [...(o.manualOnB ? [MANUAL] : []), ...acceptedTokens(dirB)]) === "denied") return new Response("forbidden", { status: 403 });
		return (await monB.route(req, url)) ?? new Response("not found", { status: 404 });
	};
	const net = async (url: string, init?: RequestInit): Promise<Response> => {
		if (new URL(url).origin !== URL_B) throw new Error("connection refused");
		const headers = { ...(init?.headers as Record<string, string>), ...(aLogin ? { "tailscale-user-login": aLogin } : {}) };
		return handleB(new Request(url, { ...init, headers }));
	};
	let clock = 1_000_000;
	const monA = createPeerMonitor({
		name: () => "A",
		local: local("A"),
		computers: computers("A"),
		fetch: net,
		token: u => outToken(u, dirA) ?? (o.manualOnA ? MANUAL : undefined),
		pair: createPairer({ fetch: net, selfUrl: async () => URL_A, dir: dirA, now: () => clock }),
	});
	const act = async () => {
		const res = await monA.route(new Request(`http://local/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=/api/peer/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "message", args: { target: "lane:x", text: "hi" } }) }), new URL(`http://local/api/peer/proxy?pc=${encodeURIComponent(URL_B)}&p=/api/peer/act`));
		return res!;
	};
	return { dirA, dirB, seen, monA, act, tick: (ms: number) => (clock += ms) };
}

test("same tailscale login: the first act pairs by itself and writes", async () => {
	const r = rig();
	const res = await r.act();
	expect(res.status).toBe(200);
	expect(r.seen.events).toEqual(["hi|A"]);
	expect(r.seen.pair).toBe(1);
	const [outFile] = readdirSync(join(r.dirA, "out"));
	const [inFile] = readdirSync(join(r.dirB, "in"));
	expect(mode(join(r.dirA, "out", outFile!))).toBe(0o600);
	expect(mode(join(r.dirB, "in", inFile!))).toBe(0o600);
	expect(outToken(URL_B, r.dirA)).toBe(acceptedTokens(r.dirB)[0]!);
	expect((await r.act()).status).toBe(200);
	expect(r.seen.pair).toBe(1);
});

test("pairing binds each side to the other's URL (0600) and a refused pairing binds nothing", async () => {
	const r = rig();
	await r.act();
	expect(boundPeer("b.example.test", r.dirA)?.url).toBe(URL_B);
	expect(boundPeer("a.example.test", r.dirB)?.url).toBe(URL_A);
	expect(mode(join(r.dirA, "bound.json"))).toBe(0o600);
	expect(mode(join(r.dirB, "bound.json"))).toBe(0o600);
	const refused = rig({ aLogin: "stranger@example.test" });
	await refused.act();
	expect(boundPeer("b.example.test", refused.dirA)).toBeUndefined();
	expect(boundPeer("a.example.test", refused.dirB)).toBeUndefined();
});

test("discovery alone pairs and the peer reads online", async () => {
	const r = rig();
	const peers = await r.monA.peerMonitoring();
	expect(peers.map(p => [p.name, p.online])).toEqual([["B", true]]);
	expect(r.seen.pair).toBe(1);
	expect(acceptedTokens(r.dirB)).toHaveLength(1);
});

test("a different tailscale login is refused with a Korean reason and stores nothing", async () => {
	const r = rig({ aLogin: "stranger@example.test" });
	const res = await r.act();
	expect(res.status).toBe(503);
	expect(((await res.json()) as { reason: string }).reason).toBe(REASON.otherUser);
	expect(r.seen.events).toEqual([]);
	expect(acceptedTokens(r.dirB)).toEqual([]);
	expect(outToken(URL_B, r.dirA)).toBeUndefined();
});

test("no tailscale identity (tagged node or not via the tailnet) or a tagged receiver is refused", async () => {
	const none = rig({ aLogin: null });
	const res = await none.act();
	expect(res.status).toBe(503);
	expect(((await res.json()) as { reason: string }).reason).toBe(REASON.notTailnet);
	const tagged = rig({ bOwn: undefined });
	expect(((await (await tagged.act()).json()) as { reason: string }).reason).toBe(REASON.unknownSelf);
	expect(acceptedTokens(tagged.dirB)).toEqual([]);
});

test("a failed pairing is not retried on every act", async () => {
	const r = rig({ aLogin: "stranger@example.test" });
	await r.act();
	await r.act();
	expect(r.seen.pair).toBe(1);
	r.tick(61_000);
	await r.act();
	expect(r.seen.pair).toBe(2);
});

test("the hand-copied shared token still works and needs no pairing", async () => {
	const r = rig({ manualOnA: true, manualOnB: true });
	expect((await r.act()).status).toBe(200);
	expect(r.seen.events).toEqual(["hi|A"]);
	expect(r.seen.pair).toBe(0);
	expect(acceptedTokens(r.dirB)).toEqual([]);
});

test("a stale token is replaced by a fresh pairing", async () => {
	const r = rig();
	mkdirSync(join(r.dirA, "out"), { recursive: true });
	await r.act();
	const good = outToken(URL_B, r.dirA)!;
	const file = join(r.dirA, "out", readdirSync(join(r.dirA, "out"))[0]!);
	writeFileSync(file, "x".repeat(32), { mode: 0o600 });
	r.tick(11_000);
	expect((await r.act()).status).toBe(200);
	expect(outToken(URL_B, r.dirA)).not.toBe("x".repeat(32));
	expect(outToken(URL_B, r.dirA)).not.toBe(good);
	expect(r.seen.events).toHaveLength(2);
});

test("an issued token passes the peer gate only with a tailscale identity", () => {
	const dir = tmp();
	const req = (headers: Record<string, string>) => new Request("http://x/api/peer/act", { method: "POST", headers });
	expect(checkPeer(req({ "x-dotz-peer": "z".repeat(32), "tailscale-user-login": "a@b.c" }), acceptedTokens(dir))).toBe("denied");
	return Promise.resolve(handlePair(new Request("http://x" + PAIR_PATH, { method: "POST", headers: { "tailscale-user-login": "a@b.c" }, body: JSON.stringify({ origin: URL_A }) }), { ownLogin: async () => "a@b.c", dir })).then(async res => {
		const { token } = (await res.json()) as { token: string };
		expect(checkPeer(req({ "x-dotz-peer": token, "tailscale-user-login": "a@b.c" }), acceptedTokens(dir))).toBe("ok");
		expect(checkPeer(req({ "x-dotz-peer": token }), acceptedTokens(dir))).toBe("denied");
	});
});

test("own login and same-user nodes: tagged nodes never count", () => {
	const st = { Self: { UserID: 1, DNSName: "me.ts.net." }, User: { "1": { LoginName: "Owner@Example.test" } }, Peer: { a: { UserID: 1, Online: true, DNSName: "a.ts.net." }, b: { UserID: 1, Online: true, DNSName: "b.ts.net.", Tags: ["tag:server"] } } };
	expect(loginOf(st)).toBe("owner@example.test");
	expect(loginOf({ ...st, Self: { ...st.Self, Tags: ["tag:x"] } })).toBeUndefined();
	expect(loginOf(undefined)).toBeUndefined();
	expect(sameUserNodes(st).map(n => n.DNSName)).toEqual(["a.ts.net."]);
});
