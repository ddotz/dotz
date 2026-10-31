import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindPeer, boundPeer } from "./peer-pair.ts";
import { baseUrl, cached, candidatePorts, countsFrom, extraUrls, friendlyName, isDotz, pool, resolveNode, sameUserNodes, uniqueNames } from "./peers.ts";

const roots: string[] = [];
afterAll(() => roots.forEach(d => rmSync(d, { recursive: true, force: true })));

// resolveNode with a temp binding dir and a fake network: `dotz` lists the URLs that answer as dotz; `probed` records every isDotz call.
function rigResolve(dotz: string[], names: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "peers-bind-"));
	roots.push(dir);
	const probed: string[] = [];
	const o = {
		isDotz: async (u: string) => { probed.push(u); return dotz.includes(u); },
		peerName: async (u: string) => names[u],
		bound: (h: string) => boundPeer(h, dir),
		bind: (h: string, u: string, n?: string) => bindPeer(h, u, n, dir),
	};
	return { dir, probed, o };
}
const MINI = "mini.ts.net.";
const PORTS = [8443, 8445, 8444];

test("friendlyName maps known Mac hostnames and keeps others", () => {
	expect(friendlyName("hyuns-macbookpro")).toBe("맥북");
	expect(friendlyName("hyuns-macbookpro.tailbcf3ef.ts.net.")).toBe("맥북");
	expect(friendlyName("hyuns-mac-mini.tailbcf3ef.ts.net")).toBe("맥미니");
	expect(friendlyName("Macmini")).toBe("맥미니");
	expect(friendlyName("studio-imac")).toBe("아이맥");
	expect(friendlyName("nas.tailbcf3ef.ts.net")).toBe("nas");
});

test("uniqueNames falls back to hostnames for duplicates only", () => {
	const r = uniqueNames([{ name: "맥북", host: "work-macbook" }, { name: "맥북", host: "home-macbookpro" }, { name: "맥미니", host: "mini" }]);
	expect(r.map(i => i.name)).toEqual(["work-macbook", "home-macbookpro", "맥미니"]);
});

test("sameUserNodes keeps online nodes of this user, not self, not other users", () => {
	const st = {
		Self: { DNSName: "me.ts.net.", UserID: 1, Online: true },
		Peer: {
			a: { DNSName: "mini.ts.net.", UserID: 1, Online: true },
			b: { DNSName: "phone.ts.net.", UserID: 1, Online: false },
			c: { DNSName: "theirs.other.ts.net.", UserID: 2, Online: true },
			d: { DNSName: "me.ts.net.", UserID: 1, Online: true },
			e: { UserID: 1, Online: true },
		},
	};
	expect(sameUserNodes(st).map(n => n.DNSName)).toEqual(["mini.ts.net."]);
	expect(sameUserNodes({ Peer: st.Peer })).toEqual([]);
});

test("sameUserNodes can also keep offline nodes of this user", () => {
	const st = { Self: { DNSName: "me.ts.net.", UserID: 1 }, Peer: { a: { DNSName: "mini.ts.net.", UserID: 1, Online: false }, b: { DNSName: "x.ts.net.", UserID: 2, Online: false }, c: { DNSName: "t.ts.net.", UserID: 1, Tags: ["tag:s"] } } };
	expect(sameUserNodes(st)).toEqual([]);
	expect(sameUserNodes(st, true).map(n => n.DNSName)).toEqual(["mini.ts.net."]);
});

test("resolveNode uses the bound URL and scans no ports while it answers as dotz", async () => {
	const r = rigResolve(["https://mini.ts.net:8445"], { "https://mini.ts.net:8445": "맥미니" });
	bindPeer(MINI, "https://mini.ts.net:8445", undefined, r.dir);
	const got = await resolveNode({ DNSName: MINI, Online: true }, PORTS, r.o);
	expect(got).toEqual({ host: MINI, url: "https://mini.ts.net:8445", name: "맥미니" });
	expect(r.probed).toEqual(["https://mini.ts.net:8445"]);
	expect(boundPeer(MINI, r.dir)?.name).toBe("맥미니");
});

test("resolveNode rescans when the bound URL is no longer dotz and the record follows the new port", async () => {
	const r = rigResolve(["https://mini.ts.net:8444"]);
	bindPeer(MINI, "https://mini.ts.net:8445", "맥미니", r.dir);
	const got = await resolveNode({ DNSName: MINI, Online: true }, PORTS, r.o);
	expect(got?.url).toBe("https://mini.ts.net:8444");
	expect(r.probed).toContain("https://mini.ts.net:8443");
	expect(boundPeer("MINI.ts.net", r.dir)?.url).toBe("https://mini.ts.net:8444");
	expect(boundPeer(MINI, r.dir)?.name).toBe("맥미니");
});

test("resolveNode scan skips a non-dotz service on 8443 and binds dotz on 8445", async () => {
	const r = rigResolve(["https://mini.ts.net:8445"]);
	const got = await resolveNode({ DNSName: MINI, Online: true }, PORTS, r.o);
	expect(got?.url).toBe("https://mini.ts.net:8445");
	expect(boundPeer(MINI, r.dir)?.url).toBe("https://mini.ts.net:8445");
	expect(await resolveNode({ DNSName: "other.ts.net.", Online: true }, PORTS, r.o)).toBeUndefined();
	expect(boundPeer("other.ts.net", r.dir)).toBeUndefined();
});

test("resolveNode lists an offline bound node with its record and probes nothing; an unbound one is dropped", async () => {
	const r = rigResolve([]);
	bindPeer(MINI, "https://mini.ts.net:8445", "맥미니", r.dir);
	expect(await resolveNode({ DNSName: MINI, Online: false }, PORTS, r.o)).toEqual({ host: MINI, url: "https://mini.ts.net:8445", name: "맥미니" });
	expect(await resolveNode({ DNSName: "nas.ts.net.", Online: false }, PORTS, r.o)).toBeUndefined();
	expect(r.probed).toEqual([]);
});

test("bindPeer keeps at most 32 peers, dropping the oldest", () => {
	const r = rigResolve([]);
	for (let i = 0; i < 34; i++) bindPeer(`h${i}.ts.net`, `https://h${i}.ts.net`, undefined, r.dir, i);
	expect(boundPeer("h0.ts.net", r.dir)).toBeUndefined();
	expect(boundPeer("h1.ts.net", r.dir)).toBeUndefined();
	expect(boundPeer("h33.ts.net", r.dir)?.url).toBe("https://h33.ts.net");
});

test("baseUrl and candidatePorts build probe targets", () => {
	expect(baseUrl("a.ts.net.", 8443)).toBe("https://a.ts.net:8443");
	expect(baseUrl("a.ts.net", 443)).toBe("https://a.ts.net");
	expect(candidatePorts(8443)).toEqual([8443, 8445, 8444]);
	expect(candidatePorts(8445, [8445, 70000, 9000])).toEqual([8445, 9000]);
});

test("extraUrls accepts http(s) origins only, deduplicated and capped", () => {
	expect(extraUrls(["https://a.example:8443/x", "https://a.example:8443", "ftp://b", "nope", 5])).toEqual(["https://a.example:8443"]);
	expect(extraUrls(Array.from({ length: 20 }, (_, i) => `https://h${i}.example`))).toHaveLength(8);
	expect(extraUrls(undefined)).toEqual([]);
});

test("countsFrom counts unread and open decisions", () => {
	const body = { unread: 3, items: [{ kind: "decision", decision: { state: "open" } }, { kind: "decision", decision: { state: "answered" } }, { kind: "alert" }] };
	expect(countsFrom(body)).toEqual({ unread: 3, need: 1 });
	expect(countsFrom({ unread: 0 })).toEqual({ unread: 0, need: 0 });
	expect(countsFrom({ error: "x" })).toBeUndefined();
	expect(countsFrom(null)).toBeUndefined();
});

test("cached reuses a value inside the ttl, reloads after it, and shares one load in flight", async () => {
	let t = 0, loads = 0;
	const get = cached(1000, async () => ++loads, () => t);
	const [a, b] = await Promise.all([get(), get()]);
	expect([a, b, loads]).toEqual([1, 1, 1]);
	t = 999;
	expect(await get()).toBe(1);
	t = 1000;
	expect(await get()).toBe(2);
});

test("cached does not keep a failed load", async () => {
	let n = 0;
	const get = cached(1000, async () => { if (++n === 1) throw new Error("boom"); return n; }, () => 0);
	await expect(get()).rejects.toThrow("boom");
	expect(await get()).toBe(2);
});

test("pool bounds parallelism and turns a throwing item into undefined", async () => {
	let running = 0, peak = 0;
	const r = await pool([1, 2, 3, 4, 5, 6], 2, async n => {
		running++; peak = Math.max(peak, running);
		await Promise.resolve();
		running--;
		if (n === 3) throw new Error("x");
		return n * 2;
	});
	expect(r).toEqual([2, 4, undefined, 8, 10, 12]);
	expect(peak).toBeLessThanOrEqual(2);
});

test("isDotz accepts only a dotz manifest", async () => {
	expect(await isDotz("https://a", async () => ({ name: "dotz" }))).toBe(true);
	expect(await isDotz("https://a", async () => ({ name: "herdr web ui" }))).toBe(false);
	expect(await isDotz("https://a", async () => { throw new Error("timeout"); })).toBe(false);
});

test("a gateway is recognised by the manifest's gateway marker (its name is the owner's assistant's) or, from an older gateway, by its name", async () => {
	expect(await isDotz("https://a", async () => ({ name: "땃쥐", gateway: "dotz" }))).toBe(true);
	expect(await isDotz("https://b", async () => ({ name: "dotz" }))).toBe(true);
	expect(await isDotz("https://c", async () => ({ name: "Other app" }))).toBe(false);
});
