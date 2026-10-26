import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkPreview } from "./linkpreview.ts";

const IMG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
let fetches: string[] = [];
let dir: string;

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		fetches.push(p);
		if (p === "/og") {
			return new Response(
				`<!doctype html><html><head>
				<title>fallback title</title>
				<meta property="og:site_name" content="Example &amp; Co">
				<meta property="og:title" content="맛집 지도">
				<meta property="og:description" content="강남 근처   맛집">
				<meta property="og:image" content="/img/card.png">
				</head><body>hello</body></html>`,
				{ headers: { "Content-Type": "text/html; charset=utf-8" } },
			);
		}
		if (p === "/twitter") return new Response(`<html><head><meta name="twitter:title" content="트위터 제목"><meta name="description" content="설명입니다"></head></html>`, { headers: { "Content-Type": "text/html" } });
		if (p === "/plain") return new Response(`<html><head><title>그냥 제목</title></head></html>`, { headers: { "Content-Type": "application/xhtml+xml" } });
		if (p === "/json") return new Response(`{"title":"no"}`, { headers: { "Content-Type": "application/json" } });
		if (p === "/img/card.png") return new Response(IMG, { headers: { "Content-Type": "image/png" } });
		if (p === "/img/html.png") return new Response("<html>", { headers: { "Content-Type": "text/html" } });
		if (p === "/big") return new Response(`<html><head><meta property="og:title" content="큰 페이지"></head><body>${"가".repeat(400_000)}</body></html>`, { headers: { "Content-Type": "text/html" } });
		if (p === "/slow") {
			await new Promise(r => setTimeout(r, 300));
			return new Response("<html><head><title>느림</title></head></html>", { headers: { "Content-Type": "text/html" } });
		}
		const hop = /^\/r\/(\d+)$/.exec(p);
		if (hop) {
			const n = Number(hop[1]);
			if (n === 0) return new Response(null, { status: 302, headers: { Location: "/r/1" } });
			if (n >= 6) return new Response("<html><head><title>끝</title></head></html>", { headers: { "Content-Type": "text/html" } });
			return new Response(null, { status: 302, headers: { Location: `/r/${n + 1}` } });
		}
		if (p === "/to-private") return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
		return new Response("not found", { status: 404 });
	},
});
afterAll(() => server.stop(true));
const base = () => `http://127.0.0.1:${server.port}`;

beforeEach(() => {
	fetches = [];
	dir = mkdtempSync(join(tmpdir(), "lp-"));
});

const make = (over: Record<string, unknown> = {}) =>
	createLinkPreview({
		dir,
		now: () => Date.parse("2026-10-26T00:00:00Z"),
		allowHosts: ["127.0.0.1"],
		resolve: async host => (host === "internal.test" ? ["10.1.2.3"] : host === "public.test" ? ["127.0.0.1"] : ["93.184.216.34"]),
		...over,
	});

const ask = async (lp: ReturnType<typeof make>, target: string) => {
	const url = new URL(`http://local/api/link-preview?url=${encodeURIComponent(target)}`);
	const res = (await lp.route(new Request(url), url, ["api", "link-preview"]))!;
	return { status: res.status, json: (await res.json()) as any };
};

describe("og parsing", () => {
	test("og: site, title, description and an absolute image through the gateway's image route", async () => {
		const lp = make();
		const r = await ask(lp, `${base()}/og`);
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ ok: true, url: `${base()}/og`, site: "Example & Co", title: "맛집 지도", description: "강남 근처 맛집" });
		expect(r.json.image).toBe(`/api/link-preview/image?url=${encodeURIComponent(`${base()}/img/card.png`)}`);
	});

	test("twitter: cards and meta description; a bare page falls back to its <title> and the host as the site", async () => {
		const lp = make();
		expect((await ask(lp, `${base()}/twitter`)).json).toMatchObject({ ok: true, title: "트위터 제목", description: "설명입니다", site: "127.0.0.1" });
		expect((await ask(lp, `${base()}/plain`)).json).toMatchObject({ ok: true, title: "그냥 제목" });
	});

	test("a page that is not HTML is not previewed", async () => {
		expect((await ask(make(), `${base()}/json`)).json).toMatchObject({ ok: false });
	});

	test("a body larger than the cap is cut at the cap and its <head> is still read", async () => {
		const r = await ask(make(), `${base()}/big`);
		expect(r.json).toMatchObject({ ok: true, title: "큰 페이지" });
	});
});

describe("SSRF", () => {
	test("loopback, private and link-local literals are refused before any fetch", async () => {
		const lp = make({ allowHosts: [] });
		for (const target of ["http://127.0.0.1/", "http://10.0.0.5/x", "http://172.16.3.4/", "http://192.168.0.9/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://0.0.0.0/"]) {
			const r = await ask(lp, target);
			expect(r.status).toBe(403);
			expect(r.json.ok).toBe(false);
		}
		expect(fetches).toEqual([]);
	});

	test("a name whose DNS answer is a private address is refused before any fetch", async () => {
		const blocked = make({ allowHosts: [] });
		expect((await ask(blocked, "http://internal.test/page")).status).toBe(403);
		expect(fetches).toEqual([]);
	});

	test("only http/https without credentials", async () => {
		const lp = make({ allowHosts: [] });
		expect((await ask(lp, "ftp://public.test/x")).json.ok).toBe(false);
		expect((await ask(lp, "file:///etc/passwd")).json.ok).toBe(false);
		expect((await ask(lp, "http://user:pw@public.test/x")).json.ok).toBe(false);
	});

	test("a redirect off the allowed addresses is refused at that hop", async () => {
		const r = await ask(make(), `${base()}/to-private`);
		expect(r.json.ok).toBe(false);
		expect(fetches).toEqual(["/to-private"]);
	});
});

describe("fetch limits", () => {
	test("the whole request is cut at the timeout", async () => {
		const lp = make({ timeoutMs: 60 });
		const t0 = performance.now();
		const r = await ask(lp, `${base()}/slow`);
		expect(r.json.ok).toBe(false);
		expect(performance.now() - t0).toBeLessThan(250);
	});

	test("at most 5 redirects are followed", async () => {
		expect((await ask(make(), `${base()}/r/1`)).json).toMatchObject({ ok: true, title: "끝" });
		fetches = [];
		expect((await ask(make(), `${base()}/r/0`)).json).toMatchObject({ ok: false });
	});
});

describe("cache", () => {
	test("one fetch per URL within 24 h, memory first, then the disk file for a new instance; a stale entry is fetched again", async () => {
		let at = Date.parse("2026-10-26T00:00:00Z");
		const lp = make({ now: () => at });
		await ask(lp, `${base()}/og`);
		await ask(lp, `${base()}/og`);
		expect(fetches).toEqual(["/og"]);
		const second = make();
		expect((await ask(second, `${base()}/og`)).json.title).toBe("맛집 지도");
		expect(fetches).toEqual(["/og"]);
		at += 24 * 3600 * 1000 + 1;
		await ask(lp, `${base()}/og`);
		expect(fetches).toEqual(["/og", "/og"]);
	});

	test("a failure is remembered briefly, not served from disk", async () => {
		let at = Date.parse("2026-10-26T00:00:00Z");
		const lp = make({ now: () => at });
		expect((await ask(lp, `${base()}/json`)).json.ok).toBe(false);
		expect((await ask(lp, `${base()}/json`)).json.ok).toBe(false);
		expect(fetches).toEqual(["/json"]);
		at += 6 * 60 * 1000;
		await ask(lp, `${base()}/json`);
		expect(fetches).toEqual(["/json", "/json"]);
	});
});

describe("image proxy", () => {
	const get = async (lp: ReturnType<typeof make>, target: string) => {
		const url = new URL(`http://local/api/link-preview/image?url=${encodeURIComponent(target)}`);
		return (await lp.route(new Request(url), url, ["api", "link-preview", "image"]))!;
	};

	test("an image is streamed back with a long private cache and a sandbox; a non-image is refused", async () => {
		const lp = make();
		const ok = await get(lp, `${base()}/img/card.png`);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toBe("image/png");
		expect(ok.headers.get("cache-control")).toBe("private, max-age=86400");
		expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await ok.arrayBuffer())).toEqual(IMG);
		expect((await get(lp, `${base()}/img/html.png`)).status).toBe(404);
	});

	test("the image address goes through the same private-address check", async () => {
		const lp = make({ allowHosts: [] });
		expect((await get(lp, "http://169.254.169.254/a.png")).status).toBe(403);
		expect(fetches).toEqual([]);
	});
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
