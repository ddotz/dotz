import { expect, test } from "bun:test";
import { baseUrl, cached, candidatePorts, countsFrom, extraUrls, friendlyName, isDotz, pool, sameUserNodes, uniqueNames } from "./peers.ts";

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
