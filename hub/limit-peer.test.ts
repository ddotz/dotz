// A 리셋권 spent here is told to the owner's other gateways at once, and a gateway that gets the notice checks its own usage before it lifts.
// Injected peer list, sender, usage and sessions; the bounding signal is a controller the test aborts itself; no sleeps, no network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resetFallbackState } from "./fallback.ts";
import { type Rest, liftEnv, resetLiftMemory, stuckAfterLift } from "./limit-lift.ts";
import { liftAfterReset, PEER_LIMIT_PATH, peerEnv, peerLimitNotice, tellPeers } from "./limit-peer.ts";
import { limitAlertsFile } from "./limit-alert.ts";
import { checkPeer, PEER_HEADER } from "./peer-auth.ts";

const realLift = { ...liftEnv };
const realPeer = { ...peerEnv };
let posts: Array<{ url: string; body: unknown }> = [];
let peers: string[] = [];
let answer: (url: string) => Promise<Response> = async () => Response.json({ ok: true });
let calls: string[] = [];
let paused = true;
let usable = true;
let stuck: Rest[] = [];
let stuckLanes: string[] = [];
const session = { liftLimit: () => (calls.push("session lifted"), paused && ((paused = false), true)), limitPaused: () => paused, limitModel: () => "anthropic-subscription/claude-main-model" };

beforeEach(() => {
	posts = [];
	peers = ["https://b.example.test", "https://c.example.test"];
	answer = async () => Response.json({ ok: true });
	calls = [];
	paused = true;
	usable = true;
	stuck = [];
	stuckLanes = [];
	rmSync(limitAlertsFile(), { force: true });
	resetFallbackState();
	resetLiftMemory();
	Object.assign(peerEnv, {
		peers: async () => peers.map(url => ({ url })),
		post: (url: string, body: string) => {
			posts.push({ url, body: JSON.parse(body) });
			return answer(url);
		},
	});
	Object.assign(liftEnv, {
		usage: async () => (calls.push("usage read"), { account: "acct-a", omo: true, usable, spentScopes: [] }),
		unblock: async () => "unblocked",
		sessions: () => [session],
		lanes: { paused: () => 0, models: () => [], lift: () => 0 },
		left: { sessions: () => stuck, lanes: () => stuckLanes, resumeLane: (n: string) => void calls.push(`lane resumed ${n}`) },
		refresh: () => {},
		stateFiles: () => [],
		tell: () => {},
	});
});
afterEach(() => {
	Object.assign(liftEnv, realLift);
	Object.assign(peerEnv, realPeer);
	resetFallbackState();
	rmSync(limitAlertsFile(), { force: true });
});

const rest = (o: Partial<Rest["orch"]> = {}, held = 0): Rest => ({
	orch: { status: "rate-limited", pauseKind: "rate", resuming: false, ctx: { compaction: { state: "idle" } }, ...o },
	heldCount: () => held,
	resumeNow: why => void calls.push(`resumed (${why})`),
});

test("a reset spent here goes to each other gateway once, with a body that names no account and no token", async () => {
	const r = await tellPeers();
	expect(r).toEqual({ told: 2, failed: 0 });
	expect(posts.map(p => p.url)).toEqual(["https://b.example.test", "https://c.example.test"]);
	for (const p of posts) expect(p.body).toEqual({ kind: "limit-reset" });
});

test("a peer listed twice is told once", async () => {
	peers = ["https://b.example.test", "https://b.example.test"];
	expect(await tellPeers()).toEqual({ told: 1, failed: 0 });
	expect(posts).toHaveLength(1);
});

test("a failing, refusing or silent peer is counted and never throws; the answer waits for no longer than the signal", async () => {
	const stop = new AbortController();
	answer = url => {
		if (posts.length === 2) stop.abort();
		return url.includes("b.") ? Promise.reject(new Error("ECONNREFUSED")) : new Promise<Response>(() => {});
	};
	expect(await tellPeers(peerEnv, stop.signal)).toEqual({ told: 0, failed: 2 });
	answer = async () => Response.json({ error: "no" }, { status: 403 });
	expect(await tellPeers()).toEqual({ told: 0, failed: 2 });
});

test("a peer list that does not come in time ends the notice without a throw", async () => {
	Object.assign(peerEnv, { peers: () => new Promise<Array<{ url: string }>>(() => {}) });
	const stop = new AbortController();
	const pending = tellPeers(peerEnv, stop.signal);
	stop.abort();
	expect(await pending).toEqual({ told: 0, failed: 0 });
	expect(posts).toEqual([]);
});

test("no other gateway: nothing is sent and nothing fails", async () => {
	peers = [];
	expect(await tellPeers()).toEqual({ told: 0, failed: 0 });
});

test("the reset route's lift tells the peers while it lifts here, and answers what went on", async () => {
	stuck = [rest()];
	stuckLanes = ["web-i18n"];
	const r = await liftAfterReset("acct-a");
	expect(r).toEqual({ resumed: { sessions: 2, lanes: 1 }, peers: { told: 2, failed: 0 } });
	expect(posts).toHaveLength(2);
});

test("a failing peer does not fail the lift here", async () => {
	answer = () => Promise.reject(new Error("down"));
	const r = await liftAfterReset("acct-a");
	expect(r.peers).toEqual({ told: 0, failed: 2 });
	expect(r.resumed.sessions).toBe(1);
});

test("a session still paused on a usage limit after the lift is resumed by the same call; a lane too", async () => {
	paused = false;
	stuck = [rest()];
	stuckLanes = ["web-i18n"];
	const r = await liftAfterReset("acct-a");
	expect(r.resumed).toEqual({ sessions: 1, lanes: 1 });
	expect(calls).toContain("resumed (usage limit lifted)");
	expect(calls).toContain("lane resumed web-i18n");
});

test("after the lift: a session still paused on a limit is left behind; one that was paused and idles with held messages and nothing under way is too; a retry in flight, an error, a compaction, an owner's billing pause or nothing held is not", () => {
	const idle = (o: Partial<Rest["orch"]> = {}, held = 2) => rest({ status: "idle", ...o }, held);
	expect(stuckAfterLift(rest(), false)).toBe(true);
	expect(stuckAfterLift(idle(), true)).toBe(true);
	expect(stuckAfterLift(idle(), false)).toBe(false);
	expect(stuckAfterLift(idle({ resuming: true }), true)).toBe(false);
	expect(stuckAfterLift(idle({ error: { waiting: true } }), true)).toBe(false);
	expect(stuckAfterLift(idle({ ctx: { compaction: { state: "compacting" } } }), true)).toBe(false);
	expect(stuckAfterLift(idle({}, 0), true)).toBe(false);
	expect(stuckAfterLift(rest({ pauseKind: "owner" }), true)).toBe(false);
});

test("nothing paused after the lift: nothing is resumed and nothing fails", async () => {
	paused = false;
	const r = await liftAfterReset("acct-a");
	expect(r.resumed).toEqual({ sessions: 0, lanes: 0 });
	expect(calls.filter(c => c.startsWith("resumed") || c.startsWith("lane"))).toEqual([]);
});

test("a resume that throws is logged and the other sessions still go", async () => {
	paused = false;
	const bad = rest();
	bad.resumeNow = () => { throw new Error("no process"); };
	stuck = [bad, rest()];
	const r = await liftAfterReset("acct-a");
	expect(r.resumed.sessions).toBe(1);
});

test("a notice makes the receiver read its own usage: it lifts when usable and not when the window is still full", async () => {
	usable = false;
	expect(await peerLimitNotice()).toEqual({ ok: true, lifted: false });
	expect(calls).toEqual(["usage read"]);
	expect(paused).toBe(true);
	usable = true;
	expect(await peerLimitNotice()).toEqual({ ok: true, lifted: true });
	expect(paused).toBe(false);
});

test("a notice with nothing paused here reads no usage at all", async () => {
	paused = false;
	expect(await peerLimitNotice()).toEqual({ ok: true, lifted: false });
	expect(calls).toEqual([]);
});

test("a lift caused by a notice is not sent on", async () => {
	expect(await peerLimitNotice()).toEqual({ ok: true, lifted: true });
	expect(posts).toEqual([]);
});

test("notices that arrive together share one usage read", async () => {
	const both = await Promise.all([peerLimitNotice(), peerLimitNotice()]);
	expect(both.map(b => b.lifted)).toEqual([true, true]);
	expect(calls.filter(c => c === "usage read")).toHaveLength(1);
});

test("the notice route is open to a peer with the token and to nothing else a peer could post", () => {
	const peer = (path: string) => new Request(`https://a.example.test${path}`, { method: "POST", headers: { [PEER_HEADER]: "t".repeat(24), "tailscale-user-login": "o@example.test" } });
	expect(checkPeer(peer(PEER_LIMIT_PATH), "t".repeat(24))).toBe("ok");
	expect(checkPeer(peer("/api/quota/reset-credit"), "t".repeat(24))).toBe("denied");
});
