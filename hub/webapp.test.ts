import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { compressResponse } from "./compress.ts";
import { appAsset, bundle, indexPage, moduleFiles, named } from "./webapp.ts";

// An in-memory stand-in for Cache Storage, shared by the service worker and the page like the real one.
function fakeCaches() {
	const stores = new Map<string, Map<string, Response>>();
	const open = async (name: string) => {
		const m = stores.get(name) ?? new Map<string, Response>();
		stores.set(name, m);
		return {
			put: async (k: string, r: Response) => { m.set(k, r); },
			match: async (k: string) => m.get(k)?.clone(),
			keys: async () => [...m.keys()],
			delete: async (k: string) => m.delete(k),
		};
	};
	const match = async (k: string) => { for (const m of stores.values()) { const r = m.get(k); if (r) return r.clone(); } return undefined; };
	return { open, match, delete: async (n: string) => stores.delete(n), stores };
}

describe("web share target", () => {
	const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", f), "utf8");

	test("the manifest declares a POST multipart share_target for photos and videos, and the page links the bumped manifest", () => {
		const st = JSON.parse(web("manifest.webmanifest")).share_target;
		expect(st).toMatchObject({ action: "/share-target", method: "POST", enctype: "multipart/form-data" });
		expect(st.params.files).toEqual([{ name: "files", accept: ["image/*", "video/*"] }]);
		expect(web("index.html")).toContain("/manifest.webmanifest?v=3");
	});

	test("a share POST is stashed by the service worker, redirected 303 to the chat, and taken into the composer by the page", async () => {
		const caches = fakeCaches();
		const handlers: Record<string, (ev: unknown) => void> = {};
		const location = { origin: "https://dotz.test", pathname: "/", search: "", hash: "#chat" };
		new Function("self", "caches", "location", "Response", "URL", web("sw.js"))({ addEventListener: (t: string, h: (ev: unknown) => void) => { handlers[t] = h; } }, caches, location, Response, URL);

		const form = new FormData();
		form.append("title", "여행");
		form.append("text", "해변 https://x.test/a");
		form.append("url", "https://x.test/a");
		form.append("files", new File(["AAA"], "사진 1.jpg", { type: "image/jpeg" }));
		form.append("files", new File(["BBBB"], "b.png", { type: "image/png" }));
		const req = new Request("https://dotz.test/share-target", { method: "POST", body: form });
		let answer: Promise<Response> | undefined;
		handlers.fetch!({ request: req, respondWith: (p: Promise<Response>) => { answer = p; } });
		expect(answer).toBeDefined();
		const res = await answer!;
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("https://dotz.test/?shared=1#chat");

		// a plain GET is not claimed by the share branch
		let claimed = false;
		handlers.fetch!({ request: new Request("https://dotz.test/api/state"), respondWith: () => { claimed = true; } });
		expect(claimed).toBe(false);

		// the page side: pull sharedIntake out of the module and run it against the same cache
		const src = web("js/23-installable-app-web.js");
		const fn = src.slice(src.indexOf("async function sharedIntake"), src.indexOf('window.addEventListener("load", sharedIntake)'));
		const added: File[][] = [], toasts: string[] = [], views: string[] = [];
		const ta = { value: "", dispatchEvent: () => true, focus: () => {} };
		const win = { caches };
		const page = { search: "?shared=1", pathname: "/", hash: "#chat" };
		const run = new Function("caches", "location", "history", "window", "File", "URLSearchParams", "ta", "go", "toast", "addFiles", "ATT", "Event", `${fn}; return sharedIntake;`)(caches, page, { replaceState: (_a: unknown, _b: string, u: string) => { page.search = u.includes("?") ? page.search : ""; } }, win, File, URLSearchParams, ta, (v: string) => views.push(v), (m: string) => toasts.push(m), (f: File[]) => added.push(f), [], Event);
		await run();
		expect(views).toEqual(["chat"]);
		expect(toasts).toEqual(["사진 2장을 붙였어요"]);
		expect(ta.value).toBe("여행\n해변 https://x.test/a");
		expect(added).toHaveLength(1);
		expect(added[0]!.map(f => [f.name, f.type, f.size])).toEqual([["사진 1.jpg", "image/jpeg", 3], ["b.png", "image/png", 4]]);
		expect(await added[0]![0]!.text()).toBe("AAA");
		expect(caches.stores.has("dotz-share")).toBe(false);
	});
});

describe("shell update", () => {
	const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", f), "utf8");

	test("the worker posts shell-updated to every window only when a background refresh brings a changed shell", async () => {
		const caches = fakeCaches();
		const handlers: Record<string, (ev: unknown) => void> = {};
		const got: unknown[] = [];
		const self = { addEventListener: (t: string, h: (ev: unknown) => void) => { handlers[t] = h; }, clients: { matchAll: async () => [{ postMessage: (m: unknown) => got.push(m) }, { postMessage: (m: unknown) => got.push(m) }] } };
		let etag = "v1";
		const fetchShell = async (p: string) => new Response(`${p}@${etag}`, { headers: { ETag: etag } });
		new Function("self", "caches", "location", "Response", "URL", "fetch", web("sw.js"))(self, caches, { origin: "https://dotz.test" }, Response, URL, fetchShell);
		const refresh = async () => { let p: Promise<unknown> = Promise.resolve(); handlers.message!({ data: { type: "refresh-shell" }, waitUntil: (x: Promise<unknown>) => { p = x; } }); await p; };
		await refresh();   // nothing cached yet: no baseline to differ from
		expect(got).toEqual([]);
		await refresh();   // same ETag
		expect(got).toEqual([]);
		etag = "v2";
		await refresh();
		expect(got).toEqual([{ type: "shell-updated" }, { type: "shell-updated" }]);   // both windows
		expect(await (await caches.match("/app.js"))!.text()).toBe("/app.js@v2");   // the cache holds the new script
		await refresh();
		expect(got).toHaveLength(2);
		handlers.message!({ data: { type: "other" }, waitUntil: () => { throw new Error("not a refresh"); } });
	});

	test("every cached icon is fetched again in the background refresh, so a changed icon reaches the phone without a CACHE bump and without a reload", async () => {
		const sw = web("sw.js");
		const icons = [...new Set([...sw.matchAll(/"(\/icons\/[^"]+)"/g)].map(m => m[1]!))];
		expect(icons).toContain("/icons/badge-96.png");
		const caches = fakeCaches();
		const handlers: Record<string, (ev: unknown) => void> = {};
		const got: unknown[] = [];
		const self = { addEventListener: (t: string, h: (ev: unknown) => void) => { handlers[t] = h; }, clients: { matchAll: async () => [{ postMessage: (m: unknown) => got.push(m) }] } };
		let icon = "old";
		const fetchShell = async (p: string) => (p.startsWith("/icons/") ? new Response(`${p}@${icon}`) : new Response(p, { headers: { ETag: "same" } }));
		new Function("self", "caches", "location", "Response", "URL", "fetch", sw)(self, caches, { origin: "https://dotz.test" }, Response, URL, fetchShell);
		const refresh = async () => { let p: Promise<unknown> = Promise.resolve(); handlers.message!({ data: { type: "refresh-shell" }, waitUntil: (x: Promise<unknown>) => { p = x; } }); await p; };
		await refresh();
		for (const p of icons) expect(await (await caches.match(p))!.text()).toBe(`${p}@old`);
		icon = "new";
		await refresh();
		for (const p of icons) expect(await (await caches.match(p))!.text()).toBe(`${p}@new`);
		expect(got).toEqual([]);   // an icon change alone does not reload the open pages
	});

	test("the page reloads only while hidden and nothing is open, otherwise offers a chip, never loops, and asks the worker after a long absence", () => {
		const src = web("js/23-installable-app-web.js");
		const block = src.slice(src.indexOf("const SHELL_KEY"), src.indexOf("// A tap that had to start the app"));
		const mem = new Map<string, string>(), chips: { onclick: () => void }[] = [], docH: Record<string, () => void> = {};
		let swMsg: ((ev: unknown) => void) | undefined, reloads = 0, now = 1_000_000;
		const posted: unknown[] = [];
		const doc = { visibilityState: "visible", body: { append: (n: { onclick: () => void }) => chips.push(n) }, querySelector: (s: string) => (s === ".shell-chip" ? chips[0] ?? null : null), addEventListener: (t: string, h: () => void) => { docH[t] = h; } };
		const ui = { ta: { value: "" }, ATT: [] as unknown[], OV: [] as unknown[], NT: { open: false }, SUBD: null as unknown };
		const nav = { serviceWorker: { addEventListener: (_t: string, h: (ev: unknown) => void) => { swMsg = h; }, controller: { postMessage: (m: unknown) => posted.push(m) } } };
		const loc = { hash: "#chat/main", reload: () => { reloads++; } };
		new Function("sessionStorage", "location", "Date", "ta", "ATT", "OV", "NT", "SUBD", "document", "el", "$", "current", "target", "chatStick", "chatAnchor", "convListing", "navigator", "PWA", "homeTop", block)(
			{ getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) }, loc, { now: () => now },
			ui.ta, ui.ATT, ui.OV, ui.NT, ui.SUBD, doc, (_t: string, p: { onclick: () => void }) => p, () => ({ scrollTop: 42 }), "chat", "main", false, () => ({ ts: "2026-10-21T06:00:00Z", off: 7 }), () => false, nav, { reg: null }, () => {});
		const post = () => swMsg!({ data: { type: "shell-updated" } });

		swMsg!({ data: { type: "something-else" } });
		expect(reloads).toBe(0);
		post();   // visible: never an automatic reload, even with an empty composer (it would close the phone keyboard)
		expect(reloads).toBe(0);
		expect(chips).toHaveLength(1);
		doc.visibilityState = "hidden";
		post();   // hidden and safe: reloads, keeping route and place
		expect(reloads).toBe(1);
		expect(JSON.parse(mem.get("dotz-shell-reload")!)).toMatchObject({ hash: "#chat/main", views: 42, key: "main", stick: false, anchor: { ts: "2026-10-21T06:00:00Z", off: 7 } });
		now += 10_000;
		post();   // 10 s later: the loop guard turns it into a chip
		expect(reloads).toBe(1);
		expect(chips).toHaveLength(1);
		chips[0]!.onclick();   // a tap is the owner's own choice
		expect(reloads).toBe(2);
		now += 120_000;
		ui.ta.value = "half written";   // composer not empty: never an automatic reload
		post();
		expect(reloads).toBe(2);
		ui.ta.value = "";
		ui.OV.push({});   // a sheet, dialog or bell panel is open
		post();
		expect(reloads).toBe(2);
		ui.OV.length = 0;
		ui.ATT.push({});   // an attachment waits to be sent / uploads
		post();
		expect(reloads).toBe(2);
		ui.ATT.length = 0;
		post();
		expect(reloads).toBe(3);

		// a short absence asks nothing; one over three minutes asks the worker for a shell check
		doc.visibilityState = "hidden"; docH.visibilitychange!();
		now += 60_000;
		doc.visibilityState = "visible"; docH.visibilitychange!();
		expect(posted).toEqual([]);
		doc.visibilityState = "hidden"; docH.visibilitychange!();
		now += 4 * 60_000;
		doc.visibilityState = "visible"; docH.visibilitychange!();
		expect(posted).toEqual([{ type: "refresh-shell" }]);
	});
});

describe("web app modules", () => {
	test("the joined script compiles as one classic script", () => {
		expect(moduleFiles("js").length).toBeGreaterThan(10);
		expect(() => new Function(bundle("js").text)).not.toThrow();
	});

	test("/app.js and /app.css are served with an ETag and answer 304 when unchanged", async () => {
		for (const [path, type] of [["/app.js", "text/javascript"], ["/app.css", "text/css"]]) {
			const res = await appAsset(new Request(`http://x${path}`), path);
			expect(res?.status).toBe(200);
			expect(res?.headers.get("content-type")).toContain(type);
			expect((await res?.text())?.length).toBeGreaterThan(1000);
			const etag = res?.headers.get("etag") ?? "";
			expect((await appAsset(new Request(`http://x${path}`, { headers: { "if-none-match": etag } }), path))?.status).toBe(304);
		}
		expect(appAsset(new Request("http://x/other.js"), "/other.js")).toBeUndefined();
	});

	test("page, script and styles go out gzipped to a client that accepts it, with the same validator, and plain to one that does not", async () => {
		const gz = { "accept-encoding": "gzip" };
		for (const [path, get] of [["/app.js", (r: Request) => appAsset(r, "/app.js")!], ["/app.css", (r: Request) => appAsset(r, "/app.css")!], ["/", (r: Request) => indexPage(r)]] as const) {
			const plain = await get(new Request(`http://x${path}`));
			const zipped = await get(new Request(`http://x${path}`, { headers: gz }));
			expect(plain.headers.get("content-encoding")).toBeNull();
			expect(zipped.headers.get("content-encoding")).toBe("gzip");
			expect(zipped.headers.get("vary")).toContain("Accept-Encoding");
			expect(zipped.headers.get("etag")).toBe(plain.headers.get("etag"));
			const body = new Uint8Array(await zipped.arrayBuffer());
			expect(body.length).toBeLessThan((await plain.text()).length / 2);
			expect(gunzipSync(body).toString("utf8")).toBe(await (await get(new Request(`http://x${path}`))).text());
			const etag = zipped.headers.get("etag") ?? "";
			expect((await get(new Request(`http://x${path}`, { headers: { ...gz, "if-none-match": etag } }))).status).toBe(304);
		}
	});

	test("compression leaves event streams, small answers, images and non-200 answers alone", async () => {
		const req = new Request("http://x/a", { headers: { "accept-encoding": "gzip" } });
		const big = "x".repeat(5000);
		const same = async (res: Response) => { expect((await compressResponse(req, res)).headers.get("content-encoding")).toBeNull(); };
		await same(new Response(big, { headers: { "Content-Type": "text/event-stream" } }));
		await same(new Response(big, { headers: { "Content-Type": "image/png" } }));
		await same(new Response(big, { status: 206, headers: { "Content-Type": "application/json" } }));
		const small = await compressResponse(req, Response.json({ ok: true }));
		expect(small.headers.get("content-encoding")).toBeNull();
		expect(await small.json()).toEqual({ ok: true });
		const json = await compressResponse(req, Response.json({ items: Array.from({ length: 200 }, (_, i) => ({ i, text: "row" })) }));
		expect(json.headers.get("content-encoding")).toBe("gzip");
		expect(JSON.parse(gunzipSync(new Uint8Array(await json.arrayBuffer())).toString("utf8")).items).toHaveLength(200);
	});

	test("the 모니터링 screen is in the shell, its module and styles are served, and the notification bell is gone", async () => {
		const html = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");
		expect(html).toContain('id="v-monitoring"');
		expect(html).not.toContain('id="bell"');
		const js = await (await appAsset(new Request("http://x/app.js"), "/app.js"))?.text();
		expect(js).toContain("function renderMonitoring");
		expect(js).not.toContain("function openNotices");
		expect(await (await appAsset(new Request("http://x/app.css"), "/app.css"))?.text()).toContain(".mon-list");
	});
});

describe("service worker shell", () => {
	const swSource = readFileSync(join(import.meta.dir, "..", "web", "sw.js"), "utf8");
	const boot = (caches: ReturnType<typeof fakeCaches>, fetchImpl: (u: string) => Promise<Response>, clients: unknown = {}) => {
		const handlers: Record<string, (ev: any) => void> = {};
		const location = { origin: "https://dotz.test" };
		new Function("self", "caches", "location", "fetch", "Response", "URL", swSource)({ clients, addEventListener: (t: string, h: (ev: any) => void) => { handlers[t] = h; } }, caches, location, (u: string | Request) => fetchImpl(typeof u === "string" ? u : u.url), Response, URL);
		return handlers;
	};

	test("a navigation answers from the cache without waiting for the network, then refreshes the shell in the background", async () => {
		const caches = fakeCaches();
		const c = await caches.open("dotz-shell-v11");
		await c.put("/", new Response("old page"));
		const calls: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>(r => { release = r; });
		const h = boot(caches, async u => { calls.push(new URL(u, "https://dotz.test").pathname); await gate; return new Response(`new ${u}`); });
		let answer!: Promise<Response>, pending!: Promise<unknown>;
		h.fetch!({ request: { method: "GET", url: "https://dotz.test/", mode: "navigate" }, respondWith: (p: Promise<Response>) => { answer = p; }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
		expect(await (await answer).text()).toBe("old page");
		release();
		await pending;
		expect(calls.sort()).toEqual(["/", "/app.css", "/app.js", "/custom.js", "/icons/apple-touch-icon.png", "/icons/badge-96.png", "/icons/icon-192.png", "/icons/icon-512.png"]);
		expect(await (await caches.open("dotz-shell-v11")).match("/").then(r => r!.text())).toBe("new /");
		expect(await (await caches.open("dotz-shell-v11")).match("/app.js").then(r => r!.text())).toBe("new /app.js");
	});

	test("the shell is replaced only when every file of the new version arrived", async () => {
		const caches = fakeCaches();
		const c = await caches.open("dotz-shell-v11");
		for (const p of ["/", "/app.js", "/app.css"]) await c.put(p, new Response(`old ${p}`));
		const h = boot(caches, async u => (u === "/app.js" ? new Response("boom", { status: 502 }) : new Response(`new ${u}`)));
		let pending!: Promise<unknown>;
		h.fetch!({ request: { method: "GET", url: "https://dotz.test/", mode: "navigate" }, respondWith: () => {}, waitUntil: (p: Promise<unknown>) => { pending = p; } });
		await pending;
		for (const p of ["/", "/app.js", "/app.css"]) expect(await c.match(p).then(r => r!.text())).toBe(`old ${p}`);
	});

	test("a tapped notification focuses an open window and hands it the target instead of opening a new one", async () => {
		const events: string[] = [];
		const win = { url: "https://dotz.test/#chat/main", focus: async () => { events.push("focus"); }, postMessage: (m: { open: string }) => { events.push(`msg ${m.open}`); } };
		const h = boot(fakeCaches(), async () => new Response(""), { matchAll: async () => [win], openWindow: async () => { events.push("open"); } });
		let done!: Promise<unknown>;
		h.notificationclick!({ notification: { close: () => {}, data: { url: "/#chat/lane:a" } }, waitUntil: (p: Promise<unknown>) => { done = p; } });
		await done;
		expect(events).toEqual(["focus", "msg https://dotz.test/#chat/lane:a"]);
	});
});

// Owner 2026-10-29: the project's name is not shown to the owner; the page's title, home-screen name and header are the assistant's name.
test("the page carries the assistant's name, escaped, and no 'dotz' where the owner sees it", () => {
	const html = named(readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8"), "땃쥐<b>");
	expect(html).toContain("<title>땃쥐&lt;b&gt;</title>");
	expect(html).toContain('content="땃쥐&lt;b&gt;"');
	expect(html).not.toMatch(/>dotz<|content="dotz"/);
});
