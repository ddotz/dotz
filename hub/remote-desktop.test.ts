import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnboard, type Io } from "../features/remote-desktop/bin/onboard.ts";
import { loadFeatureDirs } from "./featuredirs.ts";
import { checkPeer, PEER_POST } from "./peer-auth.ts";
import { binOf, createDesk, defaultDeps, JXA, viewerOf, type DeskDeps, type Settings } from "./remote-desktop.ts";
import { Bridge, HOLD } from "./remote-desktop-ws.ts";

// A stand-in for voxl: a Bun server speaking the parts the gateway uses. It reports what happens to the test over a TCP side channel
// ("<pid> <event>" lines), so a test waits for an event instead of a sleep.
const FAKE = `
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
const port = Number(args.find(a => a.startsWith("--port="))?.split("=")[1]);
const pw = process.env.VOXL_PASSWORD ?? "";
const mode = process.env.FAKE_MODE ?? "";
const sock = await Bun.connect({ hostname: "127.0.0.1", port: Number(process.env.FAKE_NOTIFY), socket: { data() {} } });
const note = (m) => { sock.write(process.pid + " " + m + "\\n"); sock.flush(); };
if (mode === "dyld-always" || (mode === "dyld-once" && !existsSync(process.env.FAKE_FLAG))) {
	console.error("dyld[1]: Library not loaded: /opt/homebrew/opt/x264/lib/libx264.165.dylib");
	process.exit(1);
}
process.on("SIGTERM", async () => {
	note("TERM");
	if (mode === "ignore-term") return;
	await Bun.sleep(20);
	process.exit(0);
});
const CHUNK = new Uint8Array(65536);
let sent = 0, total = 0, fin = false;
function pump(ws) {
	while (sent < total) {
		const r = ws.send(CHUNK);
		sent += CHUNK.length;
		if (r === -1) return note("blocked " + sent);
	}
	if (total && !fin) { fin = true; note("done " + sent); }
}
Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch(req, srv) {
		const u = new URL(req.url);
		if (u.pathname === "/healthz") return new Response("ok");
		if (req.headers.get("authorization") !== "Bearer " + pw) return new Response("no", { status: 401, headers: { "www-authenticate": "Bearer" } });
		if (u.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
		if (u.pathname === "/" || u.pathname === "/index.html") return Response.json({ headers: Object.fromEntries(req.headers) });
		if (u.pathname === "/client.js") return new Response("console.log('voxl')", { headers: { "content-type": "text/javascript", "set-cookie": "sid=1", "www-authenticate": "Bearer" } });
		if (u.pathname === "/screenshot") return new Response(new Uint8Array(3000).fill(0).map((_, i) => [0x89, 0x50, 0x4e, 0x47][i] ?? 0), { headers: { "content-type": "image/png" } });
		return new Response("nf", { status: 404 });
	},
	websocket: {
		open() { note("wsopen"); },
		message(ws, m) {
			if (typeof m === "string" && m.startsWith("flood:")) { total = Number(m.slice(6)); sent = 0; fin = false; pump(ws); }
			else if (m === "probe") note("probe " + sent);
			else ws.send(m);
		},
		drain(ws) { pump(ws); },
		close() { note("wsclosed"); },
	},
});
note("ready");
`;

let scratch: string;
let fakePath: string;
let inbox: string[] = [];
let waiters: { re: RegExp; ok: (l: string) => void }[] = [];
let listener: ReturnType<typeof Bun.listen>;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "desk-test-"));
	fakePath = join(scratch, "fake-voxl.ts");
	writeFileSync(fakePath, FAKE);
	listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(_s, d) {
				for (const line of new TextDecoder().decode(d).split("\n").filter(Boolean)) {
					const w = waiters.findIndex(x => x.re.test(line));
					if (w >= 0) waiters.splice(w, 1)[0]!.ok(line);
					else inbox.push(line);
				}
			},
		},
	});
});
beforeEach(() => {
	inbox = [];
});
afterAll(() => {
	listener.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

// A state change that has no event to subscribe to (the gateway's pause), awaited with a deadline instead of a fixed sleep.
async function until(cond: () => boolean, ms = 20_000): Promise<void> {
	const end = performance.now() + ms;
	while (!cond()) {
		if (performance.now() > end) throw new Error("timed out waiting for a state change");
		await Bun.sleep(1);
	}
}

// The next fake-voxl event matching `re`, with a bounded wait.
function next(re: RegExp, ms = 10_000): Promise<string> {
	const at = inbox.findIndex(l => re.test(l));
	if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0]!);
	return Promise.race([
		new Promise<string>(ok => waiters.push({ re, ok })),
		Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out waiting for ${re}; inbox ${JSON.stringify(inbox)}`))),
	]);
}

const fakeClock = () => {
	let t = 1_000_000;
	let id = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => t,
		after: (ms: number, fn: () => void) => {
			const k = ++id;
			timers.set(k, { at: t + ms, fn });
			return () => void timers.delete(k);
		},
		advance: (ms: number) => {
			t += ms;
			for (const [k, v] of [...timers]) if (v.at <= t) (timers.delete(k), v.fn());
		},
		pending: () => timers.size,
		everArmed: () => id,
	};
};

const SELF_IP = "100.64.0.1";
const PEER_IP = "100.64.0.2";
const TS = { Self: { TailscaleIPs: [SELF_IP] }, Peer: { a: { TailscaleIPs: [PEER_IP], DNSName: "mac-mini.tail1.ts.net." } } };
const COMPUTERS = [
	{ name: "MacBook", host: "macbook.tail1.ts.net", url: "https://macbook.tail1.ts.net:8443", self: true },
	{ name: "Mac mini", host: "mac-mini.tail1.ts.net", url: "https://mac-mini.tail1.ts.net:8443", self: false },
];
const HOST = "macbook.tail1.ts.net";

type Spawned = { argv: string[]; env: Record<string, string>; child: ReturnType<typeof Bun.spawn> };
type Opts = { env?: Record<string, string>; platform?: NodeJS.Platform; featureOn?: boolean; installBinary?: boolean } & Partial<DeskDeps>;
const made: { d: ReturnType<typeof createDesk>; dir: string; spawned: Spawned[] }[] = [];

function make(o: Opts = {}) {
	const { env = {}, platform = "darwin", featureOn = true, installBinary = true, ...rest } = o;
	const dir = mkdtempSync(join(scratch, "data-"));
	if (installBinary) {
		mkdirSync(join(dir, "remote-desktop", "bin"), { recursive: true });
		writeFileSync(binOf(dir), "");
	}
	const clock = fakeClock();
	const spawned: Spawned[] = [];
	const deps: DeskDeps = {
		...defaultDeps(),
		dataDir: dir,
		platform,
		featureOn: () => featureOn,
		clock,
		spawn: (argv, e) => {
			const child = Bun.spawn([process.execPath, fakePath, ...argv.slice(1)], { env: { ...e, FAKE_NOTIFY: String(listener.port), ...env }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
			spawned.push({ argv, env: e, child });
			return child;
		},
		tailscale: async () => TS,
		computers: async () => COMPUTERS,
		peerOpen: async () => false,
		run: async () => 0,
		rebuild: async () => false,
		host: { exec: async () => ({ code: 0, stdout: "true", stderr: "" }), sleep: async () => {} },
		...rest,
	};
	const d = createDesk(deps);
	made.push({ d, dir, spawned });
	return { d, dir, clock, spawned };
}
afterEach(async () => {
	for (const m of made.splice(0)) {
		for (const s of m.spawned) s.child.kill("SIGKILL");
		await m.d.stop();
	}
});

const setCfg = (dir: string, s: Partial<Settings>) => {
	mkdirSync(join(dir, "remote-desktop"), { recursive: true });
	writeFileSync(join(dir, "remote-desktop", "settings.json"), JSON.stringify(s));
};
type Made = ReturnType<typeof make>;
const call = async (m: Made, path: string, init: RequestInit & { mode?: string } = {}): Promise<Response> => {
	const { mode = "tailscale", ...rest } = init;
	const url = `https://${HOST}${path}`;
	const r = await m.d.route(new Request(url, { ...rest, headers: { host: HOST, ...(rest.headers as Record<string, string>) } }), new URL(url), undefined, mode);
	if (!r) throw new Error(`no response for ${path}`);
	return r;
};
const JSON_HEADERS = { "content-type": "application/json", origin: `https://${HOST}` };
const post = (m: Made, path: string, body: unknown, headers: Record<string, string> = {}, mode?: string) =>
	call(m, path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body), ...(mode ? { mode } : {}) });
const seenAs = (ip: string) => ({ "tailscale-user-login": "owner@example.com", "x-forwarded-for": ip });

describe("voxl spawn", () => {
	test("view-only args, a random password only in the env, no resize or mic", async () => {
		const m = make();
		expect(await m.d.host.ensure()).toBe("ok");
		const first = m.spawned[0]!;
		expect(first.argv).toContain("--addr=127.0.0.1");
		expect(first.argv).toContain("--file-transfers=none");
		expect(first.argv).toContain("--read-only");
		expect(first.argv.join(" ")).not.toMatch(/enable-resize|microphone/);
		const pw = first.env.VOXL_PASSWORD!;
		expect(pw).toMatch(/^[0-9a-f]{64}$/);
		expect(first.argv.join(" ")).not.toContain(pw);
		await m.d.stop();
		await m.d.host.ensure();
		expect(m.spawned[1]!.env.VOXL_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
		expect(m.spawned[1]!.env.VOXL_PASSWORD).not.toBe(pw);
	});

	test("control on drops --read-only", async () => {
		const m = make();
		setCfg(m.dir, { control: true });
		await m.d.host.ensure();
		expect(m.spawned[0]!.argv).not.toContain("--read-only");
	});

	test("the password is in no answer the browser can see", async () => {
		const m = make();
		const shown = [await call(m, "/desk/client.js"), await call(m, "/api/desk/status"), await call(m, "/desk/screenshot")];
		const pw = m.spawned[0]!.env.VOXL_PASSWORD!;
		for (const r of shown) {
			expect(await r.text()).not.toContain(pw);
			expect([...r.headers].join("\n")).not.toContain(pw);
		}
	});

	test("a dyld failure rebuilds once, then starts", async () => {
		const flag = join(scratch, "dyld-flag");
		rmSync(flag, { force: true });
		let rebuilds = 0;
		const m = make({ env: { FAKE_MODE: "dyld-once", FAKE_FLAG: flag }, rebuild: async () => (rebuilds++, writeFileSync(flag, "1"), true) });
		expect(await m.d.host.ensure()).toBe("rebuilding");
		await m.d.host.settled();
		expect(rebuilds).toBe(1);
		expect(m.d.host.ready).toBe(true);
	});

	test("a binary that still fails after the rebuild is not rebuilt again", async () => {
		let rebuilds = 0;
		const m = make({ env: { FAKE_MODE: "dyld-always" }, rebuild: async () => (rebuilds++, true) });
		expect(await m.d.host.ensure()).toBe("rebuilding");
		await m.d.host.settled();
		expect(m.d.host.ready).toBe(false);
		expect(await m.d.host.ensure()).toBe("failed");
		expect(rebuilds).toBe(1);
	});

	test("while it rebuilds, /desk/ is a self-refreshing page and no second rebuild starts", async () => {
		let release!: (ok: boolean) => void;
		let rebuilds = 0;
		const m = make({ env: { FAKE_MODE: "dyld-always" }, rebuild: () => (rebuilds++, new Promise<boolean>(r => (release = r))) });
		const first = await call(m, "/desk/");
		expect(first.status).toBe(503);
		expect(await first.text()).toContain('http-equiv="refresh"');
		expect((await call(m, "/desk/")).status).toBe(503);
		expect(rebuilds).toBe(1);
		expect(((await (await call(m, "/api/desk/status")).json()) as { rebuilding: boolean }).rebuilding).toBe(true);
		release(false);
		await m.d.host.settled();
	});
});

describe("lifecycle", () => {
	test("viewers are counted and the grace stop runs on the injected clock", async () => {
		const m = make();
		const host = m.d.host;
		await host.ensure();
		const pid = m.spawned[0]!.child.pid;
		expect(m.clock.pending()).toBe(1); // armed at start: a page that never connects still ends
		const a = { close() {} };
		const b = { close() {} };
		host.addViewer(a, { who: "me" });
		host.addViewer(b, { who: "me" });
		expect(m.clock.pending()).toBe(0);
		host.dropViewer(a);
		expect(m.clock.pending()).toBe(0);
		host.dropViewer(b);
		expect(m.clock.pending()).toBe(1);
		m.clock.advance(59_999);
		expect(host.ready).toBe(true);
		host.addViewer(a, { who: "me" }); // back within the grace: the stop is cancelled
		expect(m.clock.pending()).toBe(0);
		host.dropViewer(a);
		m.clock.advance(60_000);
		await next(new RegExp(`^${pid} TERM$`));
		expect(host.ready).toBe(false);
	});

	test("a start nobody connects to ends after the grace", async () => {
		const m = make();
		await m.d.host.ensure();
		const pid = m.spawned[0]!.child.pid;
		m.clock.advance(60_000);
		await next(new RegExp(`^${pid} TERM$`));
		expect(await m.spawned[0]!.child.exited).toBe(0);
	});

	test("SIGTERM first, SIGKILL after 3 s to one that ignores it", async () => {
		const m = make({ env: { FAKE_MODE: "ignore-term" } });
		await m.d.host.ensure();
		const { child } = m.spawned[0]!;
		const stopped = m.d.stop();
		await next(new RegExp(`^${child.pid} TERM$`));
		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		m.clock.advance(3_000);
		await stopped;
		expect(child.signalCode).toBe("SIGKILL");
	});

	test("one that exits on SIGTERM is never killed", async () => {
		const m = make();
		await m.d.host.ensure();
		const { child } = m.spawned[0]!;
		await m.d.stop();
		expect(child.signalCode).toBeNull();
		expect(child.exitCode).toBe(0);
	});

	test("turning control on or off stops it at once, and the next start uses the new mode", async () => {
		const m = make();
		await m.d.host.ensure();
		const first = m.spawned[0]!.child;
		const put = (b: object) => call(m, "/api/desk/settings", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(b) });
		const res = await put({ control: true });
		expect(first.exitCode).not.toBeNull(); // gone before the answer
		expect(((await res.json()) as { control: boolean; running: boolean }).running).toBe(false);
		await m.d.host.ensure();
		expect(m.spawned[1]!.argv).not.toContain("--read-only");
		await put({ control: false });
		expect(m.spawned[1]!.child.exitCode).not.toBeNull();
		await m.d.host.ensure();
		await put({ on: false });
		expect(m.spawned[2]!.child.exitCode).not.toBeNull();
		expect((await call(m, "/desk/")).status).toBe(403);
	});

	test("settings take booleans only, from the same origin", async () => {
		const m = make();
		const put = (body: unknown, headers = JSON_HEADERS) => call(m, "/api/desk/settings", { method: "PUT", headers, body: JSON.stringify(body) });
		expect((await put({ control: "yes" })).status).toBe(400);
		expect((await put({ control: true }, { ...JSON_HEADERS, origin: "https://evil.example" })).status).toBe(403);
		expect((await put({ control: true }, { origin: JSON_HEADERS.origin } as typeof JSON_HEADERS)).status).toBe(400);
		expect(existsSync(join(m.dir, "remote-desktop", "settings.json"))).toBe(false);
	});

	test("a gateway killed without a shutdown takes voxl down with it (the watchdog pipe)", async () => {
		const dir = mkdtempSync(join(scratch, "data-"));
		mkdirSync(join(dir, "remote-desktop", "bin"), { recursive: true });
		writeFileSync(binOf(dir), "");
		const script = join(scratch, "child-gateway.ts");
		writeFileSync(
			script,
			`import { createDesk, defaultDeps } from ${JSON.stringify(join(import.meta.dir, "remote-desktop.ts"))};
const [dir, notify] = process.argv.slice(2);
let voxl = 0;
const desk = createDesk({ ...defaultDeps(), dataDir: dir, platform: "darwin", featureOn: () => true,
	spawn: (argv, env) => { const c = Bun.spawn([process.execPath, ${JSON.stringify(fakePath)}, ...argv.slice(1)], { env: { ...env, FAKE_NOTIFY: notify }, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); voxl = c.pid; return c; } });
console.log((await desk.host.ensure()) === "ok" ? "READY " + voxl : "FAILED");
setInterval(() => {}, 1 << 30);
`,
		);
		const gateway = Bun.spawn([process.execPath, script, dir, String(listener.port)], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
		try {
			const ready = (async () => {
				for await (const c of gateway.stdout) {
					const m = /READY (\d+)/.exec(new TextDecoder().decode(c));
					if (m) return m[1]!;
				}
				throw new Error("child gateway ended before READY");
			})();
			const voxl = await Promise.race([ready, Bun.sleep(20_000).then(() => Promise.reject(new Error("child gateway never got ready")))]);
			await next(new RegExp(`^${voxl} ready$`));
			gateway.kill("SIGKILL");
			await next(new RegExp(`^${voxl} TERM$`));
		} finally {
			gateway.kill("SIGKILL");
		}
	});
});

describe("proxy", () => {
	test("Bearer added here, Host rewritten, Origin, Cookie and identity headers stripped", async () => {
		const m = make();
		const res = await call(m, "/desk/", {
			headers: {
				cookie: "dotz_session=secret",
				origin: `https://${HOST}`,
				"tailscale-user-login": "owner@example.com",
				"x-dotz-token": "hub-token",
				"x-dotz-peer": "peer-token",
				"x-forwarded-for": "203.0.113.9",
				authorization: "Bearer browser-supplied",
				accept: "text/html",
			},
		});
		const seen = ((await res.json()) as { headers: Record<string, string> }).headers;
		const spawn = m.spawned[0]!;
		expect(seen.authorization).toBe(`Bearer ${spawn.env.VOXL_PASSWORD}`);
		expect(seen.host).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(seen.host).toBe(`127.0.0.1:${spawn.argv.find(a => a.startsWith("--port="))!.slice(7)}`);
		for (const h of ["origin", "cookie", "tailscale-user-login", "x-dotz-token", "x-dotz-peer", "x-forwarded-for"]) expect(seen[h]).toBeUndefined();
		expect(seen.accept).toBe("text/html");
	});

	test("answers lose Set-Cookie and WWW-Authenticate and gain the frame, cache and referrer headers", async () => {
		const m = make();
		const res = await call(m, "/desk/client.js");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("console.log('voxl')");
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(res.headers.get("www-authenticate")).toBeNull();
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
	});

	test("only the allow-list reaches voxl; screenshot, files, record, wait and stats do not, and nothing is even started for them", async () => {
		const m = make();
		for (const p of ["screenshot", "files", "record", "wait", "stats", "files/x", "/ws", "healthz", "index.html/x"]) {
			const r = await call(m, `/desk/${p}`);
			expect([404, 403]).toContain(r.status);
		}
		expect(m.spawned.length).toBe(0);
		const root = await call(m, "/desk");
		expect(root.status).toBe(301);
		expect(root.headers.get("location")).toBe("/desk/");
		for (const p of ["", "index.html", "client.js"]) expect((await call(m, `/desk/${p}`)).status).toBe(200);
		expect((await call(m, "/desk/client.js", { method: "POST", headers: JSON_HEADERS, body: "{}" })).status).toBe(405);
	});

	test("Cloudflare mode and cf-* headers are refused unless allow_public", async () => {
		const m = make();
		expect((await call(m, "/desk/", { mode: "cloudflare" })).status).toBe(403);
		for (const h of ["cf-ray", "cf-connecting-ip", "cf-access-jwt-assertion"]) expect((await call(m, "/desk/", { headers: { [h]: "x" } })).status).toBe(403);
		expect(m.spawned.length).toBe(0);
		const status = (await (await call(m, "/api/desk/status", { mode: "cloudflare" })).json()) as { public_blocked: boolean };
		expect(status.public_blocked).toBe(true);
		setCfg(m.dir, { allow_public: true });
		expect((await call(m, "/desk/", { mode: "cloudflare" })).status).toBe(200);
		expect((await call(m, "/desk/", { headers: { "cf-ray": "x" } })).status).toBe(200);
	});

	test("a cross-origin websocket, a cross-site fetch and a cross-origin POST are refused", async () => {
		const m = make();
		const ws = { upgrade: "websocket", connection: "Upgrade" };
		expect((await call(m, "/desk/ws", { headers: { ...ws, origin: "https://evil.example" } })).status).toBe(403);
		for (const site of ["cross-site", "same-site"]) expect((await call(m, "/desk/", { headers: { "sec-fetch-site": site } })).status).toBe(403);
		expect((await call(m, "/desk/client.js", { method: "POST", headers: { ...JSON_HEADERS, origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
		expect(m.spawned.length).toBe(0);
		for (const site of ["same-origin", "none"]) expect((await call(m, "/desk/", { headers: { "sec-fetch-site": site } })).status).toBe(200);
	});

	test("viewing this computer's screen from itself is a 409 page and starts nothing", async () => {
		const m = make();
		const res = await call(m, "/desk/", { headers: seenAs(SELF_IP) });
		expect(res.status).toBe(409);
		expect(m.spawned.length).toBe(0);
		expect((await call(m, "/desk/", { headers: seenAs(PEER_IP) })).status).toBe(200);
	});
});

describe("viewerOf", () => {
	const deps = { tailscale: async () => TS, computers: async () => COMPUTERS };
	test("a forged X-Forwarded-For without Tailscale-User-Login is ignored", async () => {
		expect(await viewerOf(new Request("https://x/", { headers: { "x-forwarded-for": SELF_IP } }), deps)).toEqual({ unknown: true });
		expect(await viewerOf(new Request("https://x/", { headers: { "x-forwarded-for": PEER_IP } }), deps)).toEqual({ unknown: true });
	});
	test("with the login header the tailnet address names this computer or a peer", async () => {
		expect(await viewerOf(new Request("https://x/", { headers: seenAs(SELF_IP) }), deps)).toEqual({ self: true });
		expect(await viewerOf(new Request("https://x/", { headers: seenAs(PEER_IP) }), deps)).toEqual({ dns: "mac-mini.tail1.ts.net", name: "Mac mini", url: "https://mac-mini.tail1.ts.net:8443" });
		expect(await viewerOf(new Request("https://x/", { headers: seenAs("198.51.100.7") }), deps)).toEqual({ unknown: true });
	});
});

describe("POST /api/desk/open", () => {
	const open = (m: Made, body: unknown, headers: Record<string, string> = {}, mode?: string) => post(m, "/api/desk/open", body, headers, mode).then(r => r.json() as Promise<{ action: string; reason?: string; note?: string; name?: string }>);
	const NOTE = "단축키(Cmd+W 같은)는 이 컴퓨터로 가요";

	test("blocked: not available, off, public access not allowed, viewer is this computer", async () => {
		expect((await open(make({ featureOn: false }), { chrome: true })).action).toBe("blocked");
		expect((await open(make({ platform: "linux" }), { chrome: true })).action).toBe("blocked");
		expect((await open(make({ installBinary: false }), { chrome: true })).action).toBe("blocked");
		const off = make();
		setCfg(off.dir, { on: false });
		expect((await open(off, { chrome: true })).action).toBe("blocked");
		const pub = make();
		const blocked = await open(pub, { chrome: true }, {}, "cloudflare");
		expect(blocked.action).toBe("blocked");
		expect(blocked.reason).toBeTruthy();
		expect((await open(pub, { chrome: true }, { "cf-ray": "x" })).action).toBe("blocked");
		const self = make();
		expect((await open(self, { chrome: true }, seenAs(SELF_IP))).action).toBe("blocked");
	});

	test("chrome: open here; phone: open here with the note", async () => {
		const m = make();
		expect(await open(m, { chrome: true }, seenAs(PEER_IP))).toEqual({ action: "here" });
		expect(await open(m, { chrome: false, phone: true }, seenAs(PEER_IP))).toEqual({ action: "here", note: NOTE });
	});

	test("the viewer's gateway opens Chrome: the answer names the computer", async () => {
		const calls: string[][] = [];
		const m = make({ peerOpen: async (g, u) => (calls.push([g, u]), true) });
		expect(await open(m, { chrome: false, phone: false }, seenAs(PEER_IP))).toEqual({ action: "opened", name: "Mac mini" });
		expect(calls).toEqual([["https://mac-mini.tail1.ts.net:8443", "https://macbook.tail1.ts.net:8443/desk/"]]);
	});

	test("no gateway, an old gateway or a failed peer call: open here with the note", async () => {
		let asked = 0;
		const unknown = make({ peerOpen: async () => (asked++, true) });
		expect(await open(unknown, { chrome: false })).toEqual({ action: "here", note: NOTE });
		expect(asked).toBe(0);
		const old = make({ peerOpen: async () => false });
		expect(await open(old, { chrome: false }, seenAs(PEER_IP))).toEqual({ action: "here", note: NOTE });
		const down = make({ peerOpen: async () => Promise.reject(new Error("unreachable")) });
		expect(await open(down, { chrome: false }, seenAs(PEER_IP))).toEqual({ action: "here", note: NOTE });
	});

	test("a cross-origin page cannot ask", async () => {
		expect((await post(make(), "/api/desk/open", { chrome: true }, { origin: "https://evil.example" })).status).toBe(403);
	});
});

describe("POST /api/peer/desk-open (the viewer's gateway)", () => {
	const PEER = { "x-dotz-peer": "token" };
	const mini = "https://mac-mini.tail1.ts.net:8443";
	const send = (m: Made, url: unknown, headers: Record<string, string> = PEER) => post(m, "/api/peer/desk-open", { url }, headers);
	const reason = async (r: Response) => ((await r.json()) as { reason?: string }).reason;

	test("only https, the exact /desk/ path, no query, and another known computer's origin", async () => {
		const ran: string[][] = [];
		const m = make({ run: async a => (ran.push(a), 0) });
		const bad = [
			"https://evil.example/desk/",
			"https://macbook.tail1.ts.net:8443/desk/",
			`${mini}/other`,
			`${mini}/desk`,
			`${mini}/desk/x`,
			`${mini}/desk/?x=1`,
			`${mini}/desk/#frag`,
			"http://mac-mini.tail1.ts.net:8443/desk/",
			"https://user:pw@mac-mini.tail1.ts.net:8443/desk/",
			"https://mac-mini.tail1.ts.net/desk/",
			"not a url",
			42,
		];
		for (const url of bad) {
			const r = await send(m, url);
			expect({ url, status: r.status, reason: await reason(r) }).toEqual({ url, status: 400, reason: "bad-url" });
		}
		expect(ran).toEqual([]);
		const ok = await send(m, `${mini}/desk/`);
		expect(await ok.json()).toEqual({ ok: true });
		expect(ran).toEqual([["open", "-Ra", "Google Chrome"], ["open", "-a", "Google Chrome", `${mini}/desk/`]]);
	});

	test("without the peer header it is refused", async () => {
		expect((await send(make(), `${mini}/desk/`, {})).status).toBe(403);
	});

	test("one open per 5 s on the injected clock; refused ones do not use it up", async () => {
		const m = make();
		expect((await send(m, `${mini}/desk/`)).status).toBe(200);
		expect((await send(m, `${mini}/desk/`)).status).toBe(429);
		m.clock.advance(4_999);
		expect((await send(m, `${mini}/desk/`)).status).toBe(429);
		m.clock.advance(1);
		expect((await send(m, `${mini}/desk/`)).status).toBe(200);
		const fresh = make();
		expect((await send(fresh, "https://evil.example/desk/")).status).toBe(400);
		expect((await send(fresh, `${mini}/desk/`)).status).toBe(200);
	});

	test("no Chrome and a non-macOS computer say so, and never launch anything", async () => {
		const ran: string[][] = [];
		const noChrome = make({ run: async a => (ran.push(a), 1) });
		expect(await (await send(noChrome, `${mini}/desk/`)).json()).toEqual({ ok: false, reason: "no-chrome" });
		expect(ran).toEqual([["open", "-Ra", "Google Chrome"]]);
		const linux = make({ platform: "linux", run: async a => (ran.push(a), 0) });
		expect(await (await send(linux, `${mini}/desk/`)).json()).toEqual({ ok: false, reason: "unsupported" });
		expect(ran.length).toBe(1);
	});

	test("PEER_POST admits the path while checkPeer still denies /desk", () => {
		expect(PEER_POST.some(r => r.test("/api/peer/desk-open"))).toBe(true);
		const tokens = ["peer-token-0123456789"];
		const peer = (path: string, method: string) => checkPeer(new Request(`https://x${path}`, { method, headers: { "x-dotz-peer": tokens[0]!, "tailscale-user-login": "a@b.c" } }), tokens);
		expect(peer("/api/peer/desk-open", "POST")).toBe("ok");
		for (const [path, method] of [["/desk/", "GET"], ["/desk/ws", "GET"], ["/api/desk/status", "GET"], ["/api/desk/open", "POST"], ["/api/desk/settings", "PUT"], ["/api/desk/probe", "POST"]] as const) expect(peer(path, method)).toBe("denied");
	});
});

describe("websocket bridge", () => {
	function serve(m: Made) {
		return Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			websocket: m.d.socket as never,
			async fetch(req, srv) {
				const r = await m.d.route(req, new URL(req.url), srv, "tailscale");
				return r === null ? undefined : r;
			},
		});
	}

	test("text and binary go both ways; a viewer is counted while connected and the grace stop is armed after", async () => {
		const m = make();
		const srv = serve(m);
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/desk/ws`);
			ws.binaryType = "arraybuffer";
			const got: unknown[] = [];
			ws.onmessage = e => got.push(e.data);
			await new Promise<void>((ok, bad) => ((ws.onopen = () => ok()), (ws.onerror = () => bad(new Error("ws error")))));
			await next(/wsopen/);
			expect(m.d.host.viewers.size).toBe(1);
			expect(m.clock.pending()).toBe(0);
			expect(m.d.summary()?.viewers[0]?.who).toBe("기기");
			ws.send("hello");
			ws.send(new Uint8Array([1, 2, 3]));
			await Promise.race([new Promise<void>(ok => (ws.onmessage = e => (got.push(e.data), got.length === 2 && ok()))), Bun.sleep(10_000).then(() => Promise.reject(new Error("no echo")))]);
			expect(got[0]).toBe("hello");
			expect([...new Uint8Array(got[1] as ArrayBuffer)]).toEqual([1, 2, 3]);
			ws.close();
			await next(/wsclosed/);
			expect(m.d.host.viewers.size).toBe(0);
			expect(m.clock.pending()).toBe(1);
		} finally {
			srv.stop(true);
		}
	});

	// A viewer that stops reading: voxl floods, and the flood must stall at voxl, not pile up in the gateway.
	test("a client that stops reading stalls the upstream; gateway memory stays bounded and nothing is lost", async () => {
		const m = make();
		const srv = serve(m);
		const TOTAL = 128 << 20;
		let received = 0;
		const allIn = Promise.withResolvers<void>();
		let handshaken = false;
		let head = "";
		let sock!: Awaited<ReturnType<typeof Bun.connect>>;
		const text = (s: string) => {
			const body = new TextEncoder().encode(s);
			const mask = [1, 2, 3, 4];
			return Uint8Array.from([0x81, 0x80 | body.length, ...mask, ...body.map((b, i) => b ^ mask[i & 3]!)]);
		};
		try {
			const ready = Promise.withResolvers<void>();
			sock = await Bun.connect({
				hostname: "127.0.0.1",
				port: srv.port,
				socket: {
					open(s) {
						s.write(`GET /desk/ws HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
					},
					data(s, d) {
						if (!handshaken) {
							head += new TextDecoder().decode(d);
							if (!head.includes("\r\n\r\n")) return;
							handshaken = true;
							expect(head).toMatch(/^HTTP\/1\.1 101/);
							s.pause(); // stop reading: from here nothing is consumed until resume()
							ready.resolve();
							return;
						}
						received += d.length;
						if (received >= TOTAL) allIn.resolve();
					},
				},
			});
			await ready.promise;
			await next(/wsopen/);
			const upstream = m.spawned[0]!.child.pid;
			sock.write(text(`flood:${TOTAL}`));
			const relay = m.d.host.relay;
			await until(() => relay.pauses > 0);
			await next(new RegExp(`^${upstream} blocked \\d+$`)); // voxl's own writes met a full pipe
			expect(relay.max_buffered).toBeLessThanOrEqual((1 << 20) + (256 << 10));
			expect(received).toBeLessThan(1 << 20); // the paused client read (almost) nothing
			expect(inbox.some(l => l.includes(" done "))).toBe(false); // the flood is held back at voxl, not parked in the gateway
			sock.resume();
			await next(new RegExp(`^${upstream} done ${TOTAL}$`), 60_000);
			await allIn.promise;
			expect(relay.max_buffered).toBeLessThanOrEqual((1 << 20) + (256 << 10));
		} finally {
			sock?.terminate();
			srv.stop(true);
		}
	}, 90_000);
});

describe("frame parsing", () => {
	// A Bridge whose upstream answers the handshake; bytes are then handed straight to the parser, one read at a time.
	async function bridge() {
		const got: (string | Uint8Array)[] = [];
		const upstream: Uint8Array[] = [];
		const closed: number[] = [];
		const srv = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(s, d) {
					const t = new TextDecoder().decode(d);
					if (!t.startsWith("GET ")) return void upstream.push(new Uint8Array(d));
					const key = /Sec-WebSocket-Key: (\S+)/.exec(t)![1]!;
					const accept = new Bun.CryptoHasher("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
					s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
				},
			},
		});
		const ws = { send: (m: string | Uint8Array) => (got.push(m), 1), getBufferedAmount: () => 0, close: (c: number) => void closed.push(c) };
		const host = { port: srv.port, password: "pw", relay: { bytes: 0, paused_ms: 0, pauses: 0, max_buffered: 0 } };
		const b = new Bridge(ws as never, host as never, fakeClock(), "");
		await until(() => (b as unknown as { shaken: boolean }).shaken);
		return { b, got, upstream, closed, read: (...bytes: number[]) => (b as unknown as { onData(c: Uint8Array): void }).onData(new Uint8Array(bytes)), stop: () => (b.close(), srv.stop(true)) };
	}

	test("a frame header split over three reads keeps every byte", async () => {
		const x = await bridge();
		const body = new Uint8Array(300).fill(7);
		x.read(0x82);
		x.read(126);
		x.read(1);
		x.read(44, ...body);
		expect(x.closed).toEqual([]);
		expect(x.got).toEqual([body]);
		x.stop();
	});

	test("one message bigger than the hold passes while nothing waits ahead of it", async () => {
		const x = await bridge();
		x.b.send(new Uint8Array(HOLD + 1024));
		expect(x.closed).toEqual([]);
		await until(() => x.upstream.reduce((n, c) => n + c.length, 0) >= HOLD);
		x.stop();
	});
});

describe("permission scripts", () => {
	test.if(process.platform === "darwin").each(Object.entries(JXA))("%s runs under osascript and answers a boolean", async (_k, script) => {
		const p = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script], { stdout: "pipe", stderr: "pipe" });
		expect((await new Response(p.stdout).text()).trim()).toMatch(/^(true|false)$/);
	});
});

describe("not available", () => {
	test.each([
		["linux", { platform: "linux" as const }],
		["windows", { platform: "win32" as const }],
		["feature off", { featureOn: false }],
		["no binary", { installBinary: false }],
	])("%s: no desk key, /desk/ is 404, nothing spawned, no timers", async (_name, o) => {
		const m = make(o);
		expect(m.d.summary()).toBeUndefined();
		expect(m.d.available()).toBe(false);
		expect((await call(m, "/desk/")).status).toBe(404);
		expect((await call(m, "/desk/ws", { headers: { upgrade: "websocket" } })).status).toBe(404);
		expect(await (await call(m, "/api/desk/status")).json()).toEqual({ available: false });
		expect(await (await call(m, "/api/desk/settings", { method: "PUT", headers: JSON_HEADERS, body: "{}" })).json()).toEqual({ available: false });
		await m.d.stop();
		expect(m.spawned.length).toBe(0);
		expect(m.clock.everArmed()).toBe(0);
	});

	test("available: the /api/state summary and the status carry the same facts", async () => {
		const m = make();
		expect(m.d.summary()).toEqual({ on: true, control: false, running: false, viewers: [] });
		const s = (await (await call(m, "/api/desk/status")).json()) as Record<string, unknown>;
		expect(Object.keys(s).sort()).toEqual(["allow_public", "available", "control", "on", "public_blocked", "relay", "rebuilding", "running", "viewers"].sort());
	});
});

describe("permission probe", () => {
	test("reports both permissions from the gateway's own process, and the trial reads a PNG read-only then stops", async () => {
		const asked: string[][] = [];
		const m = make({ host: { exec: async argv => (asked.push(argv), { code: 0, stdout: argv.join(" ").includes("CGPreflight") ? "true\n" : "false\n", stderr: "" }), sleep: async () => {} } });
		expect(await (await post(m, "/api/desk/probe", {})).json()).toEqual({ screen: true, accessibility: false });
		expect(asked.every(a => a[0] === "osascript")).toBe(true);
		const trial = (await (await post(m, "/api/desk/probe", { trial: true })).json()) as { ok: boolean; bytes: number };
		expect(trial.ok).toBe(true);
		expect(m.spawned[0]!.argv).toContain("--read-only");
		expect(m.d.host.ready).toBe(false);
	});

	test("a trial is read-only even when control is on", async () => {
		const m = make();
		setCfg(m.dir, { control: true });
		await post(m, "/api/desk/probe", { trial: true });
		expect(m.spawned[0]!.argv).toContain("--read-only");
	});
});

describe("onboard steps", () => {
	const REPO = join(import.meta.dir, "..");
	type Gw = (method: string, path: string, body?: unknown) => unknown;
	function io(o: { platform?: NodeJS.Platform; files?: Record<string, string>; exec?: (argv: string[]) => { code: number; stdout?: string; stderr?: string }; gateway?: Gw; which?: string[] } = {}) {
		const files = new Map(Object.entries(o.files ?? {}));
		const execs: string[][] = [];
		const gw: [string, string, unknown][] = [];
		const said: string[] = [];
		const dataDir = join(scratch, "onboard-data");
		const real: Io = {
			platform: o.platform ?? "darwin",
			dataDir,
			repo: REPO,
			exec: async argv => ({ stdout: "", stderr: "", ...(execs.push(argv), o.exec?.(argv) ?? { code: 0 }) }),
			which: bin => (o.which ?? ["brew", "cargo", "esbuild"]).includes(bin),
			read: f => files.get(f) ?? (f.startsWith(REPO) && existsSync(f) ? readFileSync(f, "utf8") : undefined),
			write: (f, t) => void files.set(f, t),
			gateway: async (method, path, body) => {
				gw.push([method, path, body]);
				return (o.gateway ?? (() => ({})))(method, path, body);
			},
			say: l => void said.push(l),
		};
		return { io: real, files, execs, gw, said, dataDir };
	}
	const okGateway: Gw = (method, path, body) => {
		if (path === "/api/desk/status") return { available: true };
		if ((body as { trial?: boolean }).trial) return { ok: true, bytes: 5000 };
		return { screen: true, accessibility: false };
	};
	const state = (t: ReturnType<typeof io>) => JSON.parse(t.files.get(join(t.dataDir, "remote-desktop", "onboard.json")) ?? "{}");

	test.each(["linux", "win32"] as const)("%s stops with the reason before touching anything", async platform => {
		const t = io({ platform });
		const r = await runOnboard(t.io, {});
		expect(r).toMatchObject({ code: 1, status: "failed", step: "preflight" });
		expect(t.said.join("\n")).toContain(platform);
		expect(t.execs).toEqual([]);
		expect(t.gw).toEqual([]);
		expect(t.files.size).toBe(0);
	});

	test("no Homebrew stops with the reason", async () => {
		const t = io({ which: [] });
		expect((await runOnboard(t.io, {})).code).toBe(1);
		expect(t.execs).toEqual([]);
	});

	test("a full run builds, enables the shipped feature, asks the gateway and succeeds", async () => {
		const t = io({ gateway: okGateway });
		const r = await runOnboard(t.io, {});
		expect(r).toEqual({ code: 0, status: "done" });
		expect(t.execs.filter(a => a[0] === "cargo").length).toBe(1);
		expect(t.execs.find(a => a[0] === "cargo")).toContain("--locked");
		expect(state(t).done).toEqual(["deps", "build", "link", "enable", "trial"]);
		expect(JSON.parse(t.files.get(join(t.dataDir, "remote-desktop", "settings.json"))!)).toEqual({ on: true, control: false, allow_public: false });
		const copy = join(t.dataDir, "features", "remote-desktop", "feature.md");
		mkdirSync(join(scratch, "onboard-data", "features", "remote-desktop"), { recursive: true });
		writeFileSync(copy, t.files.get(copy)!);
		const shipped = loadFeatureDirs(join(scratch, "no-personal-copy")).features.find(f => f.id === "remote-desktop");
		expect(shipped).toMatchObject({ enabled: false, trigger: "항상(프롬프트)", appliesTo: "orchestrator" });
		expect(loadFeatureDirs(join(scratch, "onboard-data")).features.find(f => f.id === "remote-desktop")).toMatchObject({ enabled: true, origin: "personal", name: shipped!.name });
	});

	test("--control writes control and needs the accessibility permission too", async () => {
		const t = io({ gateway: okGateway });
		const r = await runOnboard(t.io, { control: true });
		expect(r).toMatchObject({ code: 3, status: "waiting", step: "permissions" });
		expect(JSON.parse(t.files.get(join(t.dataDir, "remote-desktop", "settings.json"))!).control).toBe(true);
		expect(t.said.join("\n")).toContain("손쉬운 사용");
	});

	test("a missing permission is one printed step (exit 3), and a rerun resumes without redoing the build", async () => {
		let granted = false;
		const t = io({ gateway: (m, p, b) => (granted ? okGateway(m, p, b) : p === "/api/desk/status" ? { available: true } : { screen: false, accessibility: false, step: "화면 기록에서 bun을 켜 주세요" }) });
		const first = await runOnboard(t.io, {});
		expect(first).toMatchObject({ code: 3, status: "waiting", step: "permissions" });
		expect(t.said).toContain("화면 기록에서 bun을 켜 주세요");
		expect(state(t).done).toEqual(["deps", "build", "link", "enable"]);
		const before = t.execs.length;
		granted = true;
		expect(await runOnboard(t.io, {})).toEqual({ code: 0, status: "done" });
		expect(t.execs.length).toBe(before + 0);
		expect(t.execs.filter(a => a[0] === "cargo" || a[0] === "brew").length).toBe(t.execs.slice(0, before).filter(a => a[0] === "cargo" || a[0] === "brew").length);
	});

	test("it resumes from the saved steps", async () => {
		const file = join(scratch, "onboard-data", "remote-desktop", "onboard.json");
		const t = io({ gateway: okGateway, files: { [file]: JSON.stringify({ done: ["deps", "build", "link"] }) } });
		expect((await runOnboard(t.io, {})).code).toBe(0);
		expect(t.execs).toEqual([]);
	});

	test("a gateway that is off, or older than this feature, stops with what to do", async () => {
		const down = io({ gateway: () => { throw new Error("게이트웨이에 연결하지 못했어요"); } });
		expect(await runOnboard(down.io, {})).toMatchObject({ code: 1, step: "gateway" });
		const old = io({ gateway: () => ({ available: false }) });
		expect(await runOnboard(old.io, {})).toMatchObject({ code: 1, step: "gateway" });
		expect(old.said.join("\n")).toContain("다시 시작");
		expect(state(old).done).toContain("enable");
	});

	test("a binary that fails to link is rebuilt once; if it still fails the run stops", async () => {
		const file = join(scratch, "onboard-data", "remote-desktop", "onboard.json");
		let rebuilt = false;
		const t = io({
			gateway: okGateway,
			files: { [file]: JSON.stringify({ done: ["deps", "build"] }) },
			exec: argv => (argv[0] === "cargo" ? ((rebuilt = true), { code: 0 }) : argv[1] === "--help" && !rebuilt ? { code: 1, stderr: "dyld: Library not loaded: libx264" } : { code: 0 }),
		});
		expect((await runOnboard(t.io, {})).code).toBe(0);
		expect(t.execs.filter(a => a[0] === "cargo").length).toBe(1);
		const broken = io({ gateway: okGateway, files: { [file]: JSON.stringify({ done: ["deps", "build"] }) }, exec: argv => (argv[1] === "--help" ? { code: 1, stderr: "dyld: Library not loaded" } : { code: 0 }) });
		expect(await runOnboard(broken.io, {})).toMatchObject({ code: 1, step: "link" });
		expect(broken.execs.filter(a => a[0] === "cargo").length).toBe(1);
	});

	test("an install whose build is already the pinned one and runs is not rebuilt", async () => {
		const crates = join(scratch, "onboard-data", "remote-desktop", ".crates.toml");
		const t = io({ gateway: okGateway, files: { [crates]: "[v1]\n\"voxl 0.3.2 (git+https://github.com/tembo/voxl?rev=eba3b7ced9f60e885bb7b3a96a12e3ccb347fdcd#eba3b7c)\" = [\"voxl\"]" } });
		expect((await runOnboard(t.io, {})).code).toBe(0);
		expect(t.execs.filter(a => a[0] === "cargo")).toEqual([]);
	});

	test("--rebuild rebuilds and links only, never asking the gateway", async () => {
		const file = join(scratch, "onboard-data", "remote-desktop", "onboard.json");
		const t = io({ files: { [file]: JSON.stringify({ done: ["deps", "build", "link", "enable", "trial"] }) } });
		expect(await runOnboard(t.io, { rebuild: true })).toEqual({ code: 0, status: "done" });
		expect(t.execs.filter(a => a[0] === "cargo").length).toBe(1);
		expect(t.gw).toEqual([]);
		expect(t.execs.some(a => a[0] === "brew" && a[1] === "install")).toBe(false);
	});
});
