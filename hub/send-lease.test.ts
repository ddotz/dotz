import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance } from "./runtime/test-clock.ts";
import { handleLease, sendOnce, type LeaseReply, type LeaseReq } from "./send-lease.ts";

const dirs: string[] = [];
const store = () => {
	const d = mkdtempSync(join(tmpdir(), "lease-"));
	dirs.push(d);
	return join(d, "state", "send-leases.json");
};
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

const K = "kakao:r1";

test("claim, re-claim by the same holder, refusal for another, release only by the holder", () => {
	const p = store();
	expect(handleLease({ op: "claim", key: K, holder: "a", until: 1000 }, 0, p)).toEqual({ ok: true, holder: "a" });
	expect(handleLease({ op: "claim", key: K, holder: "b", until: 2000 }, 10, p)).toEqual({ ok: false, holder: "a", reason: "held" });
	expect(handleLease({ op: "claim", key: K, holder: "a", until: 3000 }, 10, p).ok).toBe(true);
	expect(handleLease({ op: "claim", key: K, holder: "b" }, 2000, p).reason).toBe("held");
	expect(handleLease({ op: "release", key: K, holder: "b" }, 20, p)).toEqual({ ok: false, holder: "a", reason: "held" });
	expect(handleLease({ op: "release", key: K, holder: "a" }, 20, p).ok).toBe(true);
	expect(handleLease({ op: "claim", key: K, holder: "b", until: 5000 }, 30, p).ok).toBe(true);
});

test("an expired lease lets the other holder claim", () => {
	const p = store();
	handleLease({ op: "claim", key: K, holder: "a", until: 1000 }, 0, p);
	expect(handleLease({ op: "claim", key: K, holder: "b", until: 2000 }, 999, p).ok).toBe(false);
	expect(handleLease({ op: "claim", key: K, holder: "b", until: 2000 }, 1000, p)).toEqual({ ok: true, holder: "b" });
});

test("a claim for an id that was recorded sent is refused", () => {
	const p = store();
	handleLease({ op: "sent", key: K, holder: "a", id: "d1" }, 0, p);
	expect(handleLease({ op: "claim", key: K, holder: "b", id: "d1" }, 1, p)).toEqual({ ok: false, reason: "already_sent" });
	expect(handleLease({ op: "claim", key: K, holder: "b", id: "d2" }, 1, p).ok).toBe(true);
});

test("the store keeps 500 sent ids per key, drops expired leases and leaves no tmp file", () => {
	const p = store();
	for (let i = 0; i < 520; i++) handleLease({ op: "sent", key: K, holder: "a", id: `d${i}` }, 0, p);
	handleLease({ op: "claim", key: "other", holder: "a", until: 10 }, 0, p);
	handleLease({ op: "sent", key: "x", holder: "a", id: "z" }, 50, p);
	const s = JSON.parse(readFileSync(p, "utf8")) as { leases: Record<string, unknown>; sent: Record<string, string[]> };
	expect(s.sent[K]).toHaveLength(500);
	expect(s.sent[K]![0]).toBe("d20");
	expect(s.leases.other).toBeUndefined();
	expect(readdirSync(join(p, "..")).filter(f => f.endsWith(".tmp"))).toEqual([]);
});

test("bad requests are refused", () => {
	const p = store();
	expect(handleLease({ op: "claim", key: "", holder: "a" }, 0, p).reason).toBe("bad_request");
	expect(handleLease({ op: "nope" as "claim", key: K, holder: "a" }, 0, p).reason).toBe("bad_request");
	expect(handleLease({ op: "sent", key: K, holder: "a" }, 0, p).reason).toBe("bad_request");
});

// Two in-process "computers": each has its own store; post() reaches the other one's handleLease.
function pair() {
	const paths = { a: store(), b: store() };
	let t = 1000;
	const now = () => t;
	const reach = (to: "a" | "b"): ((peer: "a" | "b", path: string, body: LeaseReq) => Promise<LeaseReply>) =>
		async (peer, path, body) => {
			expect(path).toBe("/api/peer/lease");
			expect(peer).toBe(to);
			return handleLease(body, now(), paths[to]);
		};
	return { paths, now, advance: (ms: number) => { t += ms; }, postFromA: reach("b"), postFromB: reach("a") };
}

test("two machines race on one key: exactly one send call", async () => {
	const w = pair();
	const sends: string[] = [];
	let inner: Awaited<ReturnType<typeof sendOnce>> | undefined;
	const a = await sendOnce({
		key: K, id: "d1", self: "a", ttlMs: 60_000, peers: ["b" as const], post: w.postFromA, now: w.now, path: w.paths.a,
		send: async () => {
			sends.push("a");
			// While a is sending, b tries the same draft and must be refused without sending.
			inner = await sendOnce({ key: K, id: "d1", self: "b", ttlMs: 60_000, peers: ["a" as const], post: w.postFromB, now: w.now, path: w.paths.b, send: async () => { sends.push("b"); } });
			return "ok";
		},
	});
	expect(a).toEqual({ ok: true, result: "ok" });
	expect(inner).toEqual({ ok: false, reason: "held", holder: "a" });
	expect(sends).toEqual(["a"]);
	// b's failed attempt left no lease behind on a: a's lease was released and the id is recorded sent on both.
	expect(handleLease({ op: "claim", key: K, holder: "b", id: "d2" }, w.now(), w.paths.a).ok).toBe(true);
	expect(handleLease({ op: "claim", key: K, holder: "b", id: "d1" }, w.now(), w.paths.b).reason).toBe("already_sent");
});

test("a peer that holds the lease refuses; the local claim is released and send is not called", async () => {
	const w = pair();
	handleLease({ op: "claim", key: K, holder: "b", until: w.now() + 5000 }, w.now(), w.paths.b);
	let called = 0;
	const r = await sendOnce({ key: K, id: "d1", self: "a", ttlMs: 60_000, peers: ["b" as const], post: w.postFromA, now: w.now, path: w.paths.a, send: async () => { called++; } });
	expect(r).toEqual({ ok: false, reason: "held", holder: "b" });
	expect(called).toBe(0);
	expect(handleLease({ op: "claim", key: K, holder: "c", until: w.now() + 10 }, w.now(), w.paths.a).ok).toBe(true);
});

test("after the peer lease expires the other machine can send", async () => {
	const w = pair();
	handleLease({ op: "claim", key: K, holder: "b", until: w.now() + 5000 }, w.now(), w.paths.b);
	w.advance(5000);
	let called = 0;
	const r = await sendOnce({ key: K, id: "d1", self: "a", ttlMs: 60_000, peers: ["b" as const], post: w.postFromA, now: w.now, path: w.paths.a, send: async () => { called++; return 1; } });
	expect(r).toEqual({ ok: true, result: 1 });
	expect(called).toBe(1);
});

test("a second sendOnce with the same id is already_sent and does not send", async () => {
	const w = pair();
	let called = 0;
	const run = () => sendOnce({ key: K, id: "d1", self: "a", ttlMs: 60_000, peers: ["b" as const], post: w.postFromA, now: w.now, path: w.paths.a, send: async () => { called++; } });
	expect((await run()).ok).toBe(true);
	expect(await run()).toEqual({ ok: false, reason: "already_sent" });
	expect(called).toBe(1);
});

test("a peer that already recorded the id as sent makes sendOnce already_sent", async () => {
	const w = pair();
	handleLease({ op: "sent", key: K, holder: "b", id: "d1" }, w.now(), w.paths.b);
	let called = 0;
	const r = await sendOnce({ key: K, id: "d1", self: "a", ttlMs: 60_000, peers: ["b" as const], post: w.postFromA, now: w.now, path: w.paths.a, send: async () => { called++; } });
	expect(r).toEqual({ ok: false, reason: "already_sent" });
	expect(called).toBe(0);
	expect(handleLease({ op: "claim", key: K, holder: "z", until: w.now() + 10 }, w.now(), w.paths.a).ok).toBe(true);
});

test("an unreachable peer does not block sending unless requireAllPeers", async () => {
	const down = async (): Promise<LeaseReply> => { throw new Error("offline"); };
	const w = pair();
	let called = 0;
	const send = async () => { called++; };
	const ok = await sendOnce({ key: K, id: "d1", self: "a", ttlMs: 1000, peers: ["b"], post: down, now: w.now, path: w.paths.a, send });
	expect(ok.ok).toBe(true);
	expect(called).toBe(1);

	const strict = await sendOnce({ key: K, id: "d2", self: "a", ttlMs: 1000, peers: ["b"], post: down, now: w.now, path: w.paths.a, send, requireAllPeers: true });
	expect(strict).toEqual({ ok: false, reason: "unreachable" });
	expect(called).toBe(1);
	expect(handleLease({ op: "claim", key: K, holder: "z", until: w.now() + 10 }, w.now(), w.paths.a).ok).toBe(true);
});

test("a peer that never answers counts as unreachable after the 2.5 s timeout", async () => {
	const w = pair();
	let called = 0;
	const run = sendOnce({ key: K, id: "d1", self: "a", ttlMs: 1000, peers: ["b"], post: () => new Promise<LeaseReply>(() => {}), now: w.now, path: w.paths.a, send: async () => { called++; } });
	await advance(2499);
	expect(called).toBe(0);
	await advance(1);
	expect((await run).ok).toBe(true);
	expect(called).toBe(1);
});

test("when send throws the lease is released everywhere and the error is returned", async () => {
	const w = pair();
	const r = await sendOnce({ key: K, id: "d1", self: "a", ttlMs: 60_000, peers: ["b" as const], post: w.postFromA, now: w.now, path: w.paths.a, send: async () => { throw new Error("kmsg failed"); } });
	expect(r).toEqual({ ok: false, reason: "error", error: "kmsg failed" });
	expect(handleLease({ op: "claim", key: K, holder: "c", id: "d1", until: w.now() + 10 }, w.now(), w.paths.a).ok).toBe(true);
	expect(handleLease({ op: "claim", key: K, holder: "c", id: "d1", until: w.now() + 10 }, w.now(), w.paths.b).ok).toBe(true);
});
