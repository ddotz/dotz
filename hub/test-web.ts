// Shared fixtures for the headless Bun.WebView tests: a fake hub (the real page assets and event stream, a per-file API handler), an
// SSE push that a test can wait on, and page-side helpers. Waits here are events or page conditions, never sleeps. The test preload
// replaces setTimeout in this process (runtime/test-clock.ts), so node-side timeouts use AbortSignal.timeout, which is a real timer.
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

export type View = InstanceType<typeof Bun.WebView>;
export type ViewOptions = { width?: number; height?: number; console?: (type: string, ...args: unknown[]) => void };
// A route for the fake hub: return a Response to answer, or undefined to fall through to the defaults.
export type Api = (req: Request, url: URL) => Response | Promise<Response | undefined> | undefined;

export const json = (v: unknown, status = 200): Response => Response.json(v, { status });
export const idleState = (extra: object = {}) => ({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, ...extra });

export type HubOptions = {
	// Answers before the defaults, so a file can override /api/state or add its own routes.
	api?: Api;
	// The /api/state body; a function is called on every request.
	state?: object | (() => object);
	// "real" (default) serves events.ts's sseResponse; "fake" serves a private stream that only hub.push writes to.
	stream?: "real" | "fake";
	// Answer to unknown /api/* paths (the page tolerates an empty object).
	fallback?: unknown;
	// Page timers of 1 s or more (the page's 2 s / 4 s / 15 s / 60 s polls) become virtual: they only run when a test calls advanceTimers(view, ms).
	slowTimers?: boolean;
	// A script that runs before the page's own, after the slow timers; needs slowTimers.
	headScript?: string;
};

const enc = new TextEncoder();

// Injected first into the page: setTimeout / setInterval of >= 1000 ms go to a virtual queue that __advance(ms) runs in time order.
const SLOW_TIMERS = `(() => { const q = []; let now = 0, seq = 1e9; const rs = setTimeout, ri = setInterval, rc = clearTimeout, rci = clearInterval;
	setTimeout = (f, ms = 0, ...a) => { if (ms < 1000) return rs(f, ms, ...a); q.push({ id: ++seq, at: now + ms, f: () => f(...a) }); return seq; };
	setInterval = (f, ms = 0, ...a) => { if (ms < 1000) return ri(f, ms, ...a); q.push({ id: ++seq, at: now + ms, every: ms, f: () => f(...a) }); return seq; };
	const clear = real => id => { const i = q.findIndex(t => t.id === id); if (i >= 0) q.splice(i, 1); else real(id); };
	clearTimeout = clear(rc); clearInterval = clear(rci);
	// Real requests the page has open (fetch, until the body is read): virtual time must not pass them, or a 2 s page wait (setConn after a state read, the STATE_WAIT_MS guard) fires
	// while the answer is milliseconds away, and a test that ran fast on an idle machine fails on a busy one.
	let open = 0, idleWaiters = [];
	const done = () => { if (--open === 0) for (const w of idleWaiters.splice(0)) w(); };
	const rf = fetch;
	fetch = (...a) => { open++; let p; try { p = rf(...a); } catch (e) { done(); throw e; } p.then(r => { r.clone().arrayBuffer().then(done, done); }, done); return p; };
	const idle = () => open === 0 ? Promise.resolve() : new Promise((res, rej) => { const t = rs(() => rej(new Error("page still has " + open + " request(s) open after 5 s")), 5000); idleWaiters.push(() => { rc(t); res(); }); });
	const hop = () => new Promise(r => rs(r, 0));
	const settle = async () => { do { await idle(); await hop(); } while (open > 0); };
	window.__rt = rs;
	window.__advance = async (ms, quiet) => { const end = now + ms; if (quiet) await settle(); for (;;) { const due = q.filter(t => t.at <= end).sort((x, y) => x.at - y.at)[0]; if (!due) break; now = due.at; if (due.every) due.at += due.every; else q.splice(q.indexOf(due), 1); due.f(); } if (quiet) await settle(); now = end; };
})();`;
async function slowIndex(req: Request, head = ""): Promise<Response> {
	const plain = await indexPage(new Request(req.url));
	const html = (await plain.text()).replace(/<head[^>]*>/i, m => `${m}<script>${SLOW_TIMERS}${head}</script>`);
	return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// A WebView costs ~120 ms to start, a navigation ~20 ms: finished views go back to a process-wide pool (bun runs every test file in one process)
// and the next hub reuses one. A view with a console handler is bound to its first test and is closed instead.
const idle: View[] = [];
const pooled = new WeakSet<View>();
const pending = new WeakMap<View, number>();   // evaluate() calls still running: a view with one is closed, never reused
async function acquire(o: ViewOptions): Promise<View> {
	const width = o.width ?? 390, height = o.height ?? 844;
	const v = o.console ? undefined : idle.pop();
	if (v) { await v.resize(width, height); return v; }
	const fresh = new Bun.WebView({ width, height, ...(o.console ? { console: o.console } : {}) } as ConstructorParameters<typeof Bun.WebView>[0]);
	if (!o.console) pooled.add(fresh);
	const evaluate = fresh.evaluate.bind(fresh);
	fresh.evaluate = ((...a: Parameters<View["evaluate"]>) => {
		pending.set(fresh, (pending.get(fresh) ?? 0) + 1);
		const p = evaluate(...a);
		const done = () => pending.set(fresh, (pending.get(fresh) ?? 1) - 1);
		p.then(done, done);
		return p;
	}) as View["evaluate"];
	return fresh;
}
// What a page keeps for its origin (localStorage, the snapshot in indexedDB, caches) outlives the navigation: the next test on this hub would start from it.
const FORGET = `(async () => { try { localStorage.clear(); sessionStorage.clear(); for (const d of await indexedDB.databases()) indexedDB.deleteDatabase(d.name!); for (const k of await caches.keys()) await caches.delete(k); } catch {} })().then(() => 0)`;
function release(v: View): void {
	if (!pooled.has(v) || pending.get(v)) { v.close(); return; }
	v.evaluate(FORGET).catch(() => undefined).then(() => v.navigate("about:blank")).then(() => { idle.push(v); }, () => { pooled.delete(v); v.close(); });
}

export function fakeHub(opts: HubOptions = {}) {
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const views: View[] = [];
	let connects = 0;
	let waiters: { n: number; resolve: () => void }[] = [];
	const connected = () => {
		connects++;
		for (const w of waiters.filter(x => connects >= x.n)) w.resolve();
		waiters = waiters.filter(x => connects < x.n);
	};
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url), p = url.pathname;
			if (p === "/") return opts.slowTimers ? slowIndex(req, opts.headScript) : indexPage(req);
			const asset = appAsset(req, p);
			if (asset) return asset;
			const own = await opts.api?.(req, url);
			if (own) return own;
			if (p === "/api/events") {
				connected();
				if (opts.stream !== "fake") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
				let ctl!: ReadableStreamDefaultController<Uint8Array>;
				const body = new ReadableStream<Uint8Array>({
					start(c) { ctl = c; streams.add(c); c.enqueue(enc.encode(": open\n\n")); },
					cancel() { streams.delete(ctl); },
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
			}
			if (p === "/api/state") return json(typeof opts.state === "function" ? opts.state() : (opts.state ?? idleState()));
			return p.startsWith("/api/") ? json(opts.fallback ?? {}) : new Response("not found", { status: 404 });
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const hub = {
		server,
		origin,
		port: server.port,
		streams,
		// Writes one SSE data frame to every open stream of a "fake" hub.
		push(event: object) {
			for (const c of streams) {
				try { c.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { streams.delete(c); }
			}
		},
		// Resolves once the page has opened /api/events `n` times in total (instead of polling the stream set).
		streamConnected(n = 1, ms = 10_000): Promise<void> {
			if (connects >= n) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				waiters.push({ n, resolve });
				AbortSignal.timeout(ms).addEventListener("abort", () => reject(new Error(`no /api/events connection #${n} within ${ms} ms`)));
			});
		},
		// Resolves on the next /api/events connection after this call (use before the navigation that opens it).
		nextStream(ms = 10_000): Promise<void> { return hub.streamConnected(connects + 1, ms); },
		// A tracked view, navigated to `path` on this hub when one is given; release() or stop() gives it back.
		async view(o: ViewOptions = {}, path?: string): Promise<View> {
			const v = await acquire(o);
			views.push(v);
			if (path !== undefined) await v.navigate(`${origin}${path}`);
			return v;
		},
		// Hands every view this hub gave out back to the pool (a view with an evaluate() still running is closed): a test file calls it after each test,
		// so a test owns its views and one left behind by a timed-out test never reaches the next one.
		release() {
			for (const v of views.splice(0)) release(v);
		},
		stop() {
			hub.release();
			for (const c of streams) { try { c.close(); } catch { /* already closed */ } }
			server.stop(true);
		},
	};
	return hub;
}

// Resolves when the page-side expression is truthy, re-checked every animation frame.
export const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = (window.__rt || setTimeout)(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
// Runs the page's virtual slow timers (fakeHub({ slowTimers: true })) that fall due within `ms`.
export const advanceTimers = (v: View, ms: number) => v.evaluate(`__advance(${ms}).then(() => 0)`);
// The same, but time starts only once the requests the page has open are answered, and the call returns once those its timers started are: a state read that is
// 30 ms away is not overtaken by a 2 s page wait, as it would not be in real time. Inside one call timers still run back to back, so keep the window short enough that a
// refresh and the wait it arms do not both fall in it. Rejects when a request stays open for 5 s.
export const advanceSettled = (v: View, ms: number) => v.evaluate(`__advance(${ms}, true).then(() => 0)`);
// Evaluates a page-side expression and returns it as JSON.
export const ev = async <T = unknown>(v: View, expr: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify(${expr})`)) as string) as T;
// Runs page-side statements and returns nothing.
export const run = (v: View, code: string): Promise<unknown> => v.evaluate(`(() => { ${code} })(), 0`);
// waitFor / ev / run bound to one view, for files that keep a single module-level view.
export const on = (v: View) => ({
	waitFor: (expr: string, ms?: number) => waitFor(v, expr, ms),
	ev: <T = unknown>(expr: string) => ev<T>(v, expr),
	run: (code: string) => run(v, code),
});

// Page-side fake time: Date.now() runs from `now` (and keeps ticking), so dated fixtures label the same way on every day.
export const fixPageNow = (v: View, now: number) => run(v, `const off = ${now} - Date.now(), real = Date.now.bind(Date); Date.now = () => real() + off`);

// Node-side values a test waits for (requests a fake hub received, messages posted): a plain array whose push() wakes until().
const inboxWaiters = new WeakMap<object, Set<() => void>>();
class Inbox<T> extends Array<T> {
	static get [Symbol.species]() { return Array; }
	push(...x: T[]): number {
		const n = super.push(...x);
		for (const w of [...(inboxWaiters.get(this) ?? [])]) w();
		return n;
	}
	// Resolves on the push that makes `ok` true; rejects after `ms` (a real timer: setTimeout is the test clock here).
	until(ok: (items: T[]) => boolean, ms = 10_000, what = "condition"): Promise<T[]> {
		if (ok(this)) return Promise.resolve(this);
		return new Promise<T[]>((resolve, reject) => {
			const waiters = inboxWaiters.get(this) ?? new Set<() => void>();
			inboxWaiters.set(this, waiters);
			const check = () => { if (ok(this)) { waiters.delete(check); resolve(this); } };
			waiters.add(check);
			AbortSignal.timeout(ms).addEventListener("abort", () => { waiters.delete(check); reject(new Error(`timeout: ${what}; got ${JSON.stringify(this)}`)); });
		});
	}
}
export const inbox = <T>(): Inbox<T> => new Inbox<T>();
