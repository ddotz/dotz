import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { cached } from "./peers.ts";
import { appAsset, bundle, indexPage } from "./webapp.ts";

const ask = (path: string, encoding: string): Promise<Response> => appAsset(new Request(`http://hub${path}`, { headers: { "Accept-Encoding": encoding } }), path.split("?")[0]!)!;
const inflate = async (r: Response): Promise<string> => {
	const raw = Buffer.from(await r.arrayBuffer());
	const enc = r.headers.get("content-encoding");
	return (enc === "br" ? brotliDecompressSync(raw) : enc === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
};

describe("web script delivery", () => {
	test("/app.js goes out as brotli to a client that takes it, gzip to one that does not, and both decode to the source", async () => {
		const br = await ask("/app.js", "gzip, br");
		expect(br.headers.get("content-encoding")).toBe("br");
		expect(await inflate(br)).toBe(bundle("js").text);
		const gz = await ask("/app.js", "gzip");
		expect(gz.headers.get("content-encoding")).toBe("gzip");
		expect(await inflate(gz)).toBe(bundle("js").text);
	});

	test("the first answers index.html asks for are the exact paths api() asks for", async () => {
		const page = await (await indexPage(new Request("http://hub/"))).text();
		for (const path of ['"/api/state?limit=0"', "/api/history?target=${q}&limit=150", "/api/todo?target=${q}", '"/api/conversations"', "/api/activity?source=${encodeURIComponent("]) expect(page).toContain(path);
		const js = bundle("js").text;
		for (const path of ["/api/history?target=${enc(t)}&limit=150", "/api/todo?target=${enc(t)}", 'api("/api/conversations")', "/api/activity?source=${enc(sourceOf(t))}&limit=300"]) expect(js).toContain(path);
	});
});

describe("cached with staleMs", () => {
	test("hands out a value past its limit at once while the next load runs, and waits once it is too old", async () => {
		let now = 0, calls = 0;
		const releases: Array<() => void> = [];
		const get = cached(10, () => new Promise<number>(res => { calls++; releases.push(() => res(calls)); }), () => now, 100);
		const first = get();
		releases.shift()!();
		expect(await first).toBe(1);
		now = 50;   // stale, inside the stale window: the old value now, a load in flight
		expect(await get()).toBe(1);
		expect(calls).toBe(2);
		expect(await get()).toBe(1);   // the same load is shared, not started twice
		expect(calls).toBe(2);
		releases.shift()!();
		await Promise.resolve();
		await Promise.resolve();
		now = 52;
		expect(await get()).toBe(2);
		now = 500;   // older than the limit plus the stale window: the caller waits for the new value
		const waited = get();
		releases.shift()!();
		expect(await waited).toBe(3);
	});
});
