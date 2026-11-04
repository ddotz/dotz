import { afterAll, describe, expect, test } from "bun:test";
import { qrPath } from "./qr.ts";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareGate, createDevices, derToRaw, safeNext } from "./devices.ts";
import { HOP_HTML, HOP_JS, PAIR_HTML, SAFE_NEXT_SRC } from "./pair-page.ts";
import { clock } from "./runtime/test-clock.ts";
import { ev, fakeHub, waitFor } from "./test-web.ts";

const HOST = "dotz.example.com";
const ORIGIN = `https://${HOST}`;
const MIN = 60_000;
const DAY = 86_400_000;

const enc = new TextEncoder();
const b64u = (b: Uint8Array | ArrayBuffer): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const sha = async (d: Uint8Array | string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : (d as Uint8Array<ArrayBuffer>)));
const cat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) (out.set(p, at), (at += p.length));
	return out;
};
const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// DER for the raw r||s that WebCrypto signs; authenticators send DER.
function rawToDer(raw: Uint8Array): Uint8Array {
	const int = (v: Uint8Array): Uint8Array => {
		let i = 0;
		while (i < v.length - 1 && v[i] === 0) i++;
		let x = v.slice(i);
		if (x[0]! & 0x80) x = cat(new Uint8Array([0]), x);
		return cat(new Uint8Array([0x02, x.length]), x);
	};
	const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
	return cat(new Uint8Array([0x30, body.length]), body);
}

type Tweak = { origin?: string; rpId?: string; uv?: boolean; up?: boolean; type?: string; challenge?: string };

// A software authenticator: a key pair, a credential id and a signature counter.
class Authenticator {
	counter = 0;
	constructor(
		readonly alg: -7 | -257,
		readonly priv: CryptoKey,
		readonly spki: Uint8Array,
		readonly credId: Uint8Array,
	) {}
	static async make(alg: -7 | -257): Promise<Authenticator> {
		const pair =
			alg === -7
				? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
				: await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
		const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
		return new Authenticator(alg, pair.privateKey, spki, crypto.getRandomValues(new Uint8Array(32)));
	}
	private clientData(challenge: string, type: string, origin: string): Uint8Array {
		return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	}
	private async authData(t: Tweak, withKey: boolean, counter: number): Promise<Uint8Array> {
		const flags = (t.up === false ? 0 : 1) | (t.uv === false ? 0 : 4) | (withKey ? 0x40 : 0);
		const head = cat(await sha(t.rpId ?? HOST), new Uint8Array([flags]), u32(counter));
		return withKey ? cat(head, new Uint8Array(16), new Uint8Array([this.credId.length >> 8, this.credId.length & 255]), this.credId, new Uint8Array([0xa0])) : head;
	}
	async create(challenge: string, t: Tweak = {}): Promise<Record<string, unknown>> {
		return {
			id: b64u(this.credId),
			clientDataJSON: b64u(this.clientData(t.challenge ?? challenge, t.type ?? "webauthn.create", t.origin ?? ORIGIN)),
			authenticatorData: b64u(await this.authData(t, true, this.counter)),
			publicKey: b64u(this.spki),
			publicKeyAlgorithm: this.alg,
			name: "Test phone",
		};
	}
	async get(challenge: string, t: Tweak & { counter?: number; badSignature?: boolean } = {}): Promise<Record<string, unknown>> {
		this.counter = t.counter ?? this.counter + 1;
		const cd = this.clientData(t.challenge ?? challenge, t.type ?? "webauthn.get", t.origin ?? ORIGIN);
		const ad = await this.authData(t, false, this.counter);
		const data = cat(ad, await sha(cd));
		const sig = this.alg === -7 ? rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, data as Uint8Array<ArrayBuffer>))) : new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", this.priv, data as Uint8Array<ArrayBuffer>));
		if (t.badSignature) sig[sig.length - 1]! ^= 1;
		return { id: b64u(this.credId), clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig) };
	}
}

function fresh() {
	const dir = mkdtempSync(join(tmpdir(), "dotz-devices-"));
	const sent: string[] = [];
	const make = () => createDevices({ dir, hostname: HOST, notify: t => void sent.push(t) });
	const d = make();
	const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Response> => {
		const url = new URL(`${ORIGIN}${path}`);
		return (await d.pairRoute(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) }), url))!;
	};
	const code = () => /\d{6}/.exec(sent.at(-1)!)![0];
	const begin = async (): Promise<string> => {
		expect((await post("/api/pair/code")).status).toBe(200);
		const res = await post("/api/pair/begin", { code: code() });
		expect(res.status).toBe(200);
		return ((await res.json()) as { challenge: string }).challenge;
	};
	const loginBegin = async (): Promise<string> => ((await (await post("/api/pair/login-begin")).json()) as { challenge: string }).challenge;
	const tokenOf = (res: Response): string => /dotz_dev=([A-Za-z0-9_-]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
	const withCookie = (token: string): Request => new Request(`${ORIGIN}/`, { headers: { cookie: `dotz_dev=${token}` } });
	const pair = async (a: Authenticator): Promise<string> => {
		const res = await post("/api/pair/register", await a.create(await begin()));
		expect(res.status).toBe(200);
		return tokenOf(res);
	};
	const file = join(dir, "web-devices.json");
	return { dir, file, sent, make, d, post, code, begin, loginBegin, tokenOf, withCookie, pair };
}

describe("pairing", () => {
	test("a code from the messengers lets an ES256 or RS256 passkey register and signs the browser in", async () => {
		for (const alg of [-7, -257] as const) {
			const t = fresh();
			const a = await Authenticator.make(alg);
			const res = await t.post("/api/pair/register", await a.create(await t.begin()));
			expect(res.status).toBe(200);
			const cookie = res.headers.get("set-cookie")!;
			expect(cookie).toMatch(/^dotz_dev=[A-Za-z0-9_-]{43};/);
			for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(cookie).toContain(part);
			expect(await t.d.verifySession(t.withCookie(t.tokenOf(res)))).toBe(true);
			expect(t.d.list()).toMatchObject([{ id: b64u(a.credId), name: "Test phone" }]);
			expect(t.sent).toHaveLength(1);
		}
	});

	test("a registration with the wrong origin, rpId, type, no user verification or no presence is refused", async () => {
		const bad: Tweak[] = [{ origin: "https://evil.example.com" }, { rpId: "evil.example.com" }, { uv: false }, { up: false }, { type: "webauthn.get" }, { challenge: "AAAA" }];
		for (const tweak of bad) {
			const t = fresh();
			const a = await Authenticator.make(-7);
			const res = await t.post("/api/pair/register", await a.create(await t.begin(), tweak));
			expect([JSON.stringify(tweak), res.status]).toEqual([JSON.stringify(tweak), 403]);
			expect(t.d.list()).toEqual([]);
		}
	});

	test("a challenge works once", async () => {
		const t = fresh();
		const a = await Authenticator.make(-7);
		const body = await a.create(await t.begin());
		expect((await t.post("/api/pair/register", body)).status).toBe(200);
		t.d.revoke(b64u(a.credId));
		expect((await t.post("/api/pair/register", body)).status).toBe(403);
		expect(t.d.list()).toEqual([]);
	});

	test("a challenge expires after five minutes", async () => {
		const t = fresh();
		const a = await Authenticator.make(-7);
		const body = await a.create(await t.begin());
		clock.now += 5 * MIN + 1;
		expect((await t.post("/api/pair/register", body)).status).toBe(403);
	});

	test("a wrong code is refused, a code works once and expires after ten minutes", async () => {
		const t = fresh();
		await t.post("/api/pair/code");
		const good = t.code();
		const wrong = good === "000000" ? "000001" : "000000";
		expect((await t.post("/api/pair/begin", { code: wrong })).status).toBe(403);
		expect((await t.post("/api/pair/begin", { code: good })).status).toBe(200);
		expect((await t.post("/api/pair/begin", { code: good })).status).toBe(403);
		await t.post("/api/pair/code");
		clock.now += 10 * MIN + 1;
		expect((await t.post("/api/pair/begin", { code: t.code() })).status).toBe(403);
	});

	test("five wrong tries kill the code, even for the right one afterwards; four do not", async () => {
		const t = fresh();
		await t.post("/api/pair/code");
		const good = t.code();
		const wrong = good === "000000" ? "000001" : "000000";
		for (let i = 0; i < 5; i++) expect((await t.post("/api/pair/begin", { code: wrong })).status).toBe(403);
		expect((await t.post("/api/pair/begin", { code: good })).status).toBe(403);
		await t.post("/api/pair/code");
		const next = t.code();
		for (let i = 0; i < 4; i++) await t.post("/api/pair/begin", { code: next === "000000" ? "000001" : "000000" });
		expect((await t.post("/api/pair/begin", { code: next })).status).toBe(200);
	});

	test("three codes an hour, then 429 until the hour is over", async () => {
		const t = fresh();
		for (let i = 0; i < 3; i++) expect((await t.post("/api/pair/code")).status).toBe(200);
		expect((await t.post("/api/pair/code")).status).toBe(429);
		expect(t.sent).toHaveLength(3);
		clock.now += 60 * MIN + 1;
		expect((await t.post("/api/pair/code")).status).toBe(200);
	});

	test("a request from another origin is refused before anything happens", async () => {
		const t = fresh();
		expect((await t.post("/api/pair/code", {}, { Origin: "https://evil.example.com" })).status).toBe(403);
		expect(t.sent).toEqual([]);
	});
});

describe("login", () => {
	test("a paired ES256 or RS256 passkey signs in and gets a new session cookie", async () => {
		for (const alg of [-7, -257] as const) {
			const t = fresh();
			const a = await Authenticator.make(alg);
			await t.pair(a);
			const res = await t.post("/api/pair/login", await a.get(await t.loginBegin()));
			expect(res.status).toBe(200);
			const token = t.tokenOf(res);
			expect(await t.d.verifySession(t.withCookie(token))).toBe(true);
			expect(t.d.list()[0]!.last_used).not.toBeNull();
		}
	});

	test("a bad signature, a wrong origin, no user verification and a reused challenge are refused", async () => {
		const t = fresh();
		const a = await Authenticator.make(-7);
		await t.pair(a);
		for (const tweak of [{ badSignature: true }, { origin: "https://evil.example.com" }, { uv: false }, { rpId: "evil.example.com" }]) {
			expect([JSON.stringify(tweak), (await t.post("/api/pair/login", await a.get(await t.loginBegin(), tweak))).status]).toEqual([JSON.stringify(tweak), 403]);
		}
		const challenge = await t.loginBegin();
		const body = await a.get(challenge);
		expect((await t.post("/api/pair/login", body)).status).toBe(200);
		expect((await t.post("/api/pair/login", body)).status).toBe(403);
	});

	test("a signature made by another key is refused", async () => {
		const t = fresh();
		const a = await Authenticator.make(-7);
		await t.pair(a);
		const impostor = new Authenticator(-7, (await Authenticator.make(-7)).priv, a.spki, a.credId);
		expect((await t.post("/api/pair/login", await impostor.get(await t.loginBegin()))).status).toBe(403);
	});

	test("a signature counter that does not go up is refused, two zeros are fine", async () => {
		const t = fresh();
		const a = await Authenticator.make(-7);
		await t.pair(a);
		expect((await t.post("/api/pair/login", await a.get(await t.loginBegin(), { counter: 5 }))).status).toBe(200);
		expect((await t.post("/api/pair/login", await a.get(await t.loginBegin(), { counter: 5 }))).status).toBe(403);
		expect((await t.post("/api/pair/login", await a.get(await t.loginBegin(), { counter: 4 }))).status).toBe(403);
		expect((await t.post("/api/pair/login", await a.get(await t.loginBegin(), { counter: 6 }))).status).toBe(200);

		const z = fresh();
		const b = await Authenticator.make(-257);
		await z.pair(b);
		expect((await z.post("/api/pair/login", await b.get(await z.loginBegin(), { counter: 0 }))).status).toBe(200);
		expect((await z.post("/api/pair/login", await b.get(await z.loginBegin(), { counter: 0 }))).status).toBe(200);
	});

	test("a revoked device loses its sessions at once and cannot sign in again", async () => {
		const t = fresh();
		const a = await Authenticator.make(-7);
		const other = await Authenticator.make(-7);
		const token = await t.pair(a);
		const otherToken = await t.pair(other);
		const id = encodeURIComponent(b64u(a.credId));
		const url = new URL(`${ORIGIN}/api/devices/${id}`);
		expect((await t.d.apiRoute(new Request(url, { method: "DELETE" }), url))!.status).toBe(200);
		expect(await t.d.verifySession(t.withCookie(token))).toBe(false);
		expect(await t.d.verifySession(t.withCookie(otherToken))).toBe(true);
		expect((await t.post("/api/pair/login", await a.get(await t.loginBegin()))).status).toBe(403);
		expect((await t.d.apiRoute(new Request(url, { method: "DELETE" }), url))!.status).toBe(404);
	});
});

describe("sessions and storage", () => {
	test("the file is 0600 and holds the sha256 of the cookie, never the cookie", async () => {
		const t = fresh();
		const token = await t.pair(await Authenticator.make(-7));
		expect(statSync(t.file).mode & 0o777).toBe(0o600);
		const text = readFileSync(t.file, "utf8");
		expect(text).not.toContain(token);
		expect(Object.keys(JSON.parse(text).sessions)).toEqual([createHash("sha256").update(token).digest("hex")]);
	});

	test("the sessions and devices survive a restart; a session slides for 30 days and then ends", async () => {
		const t = fresh();
		const token = await t.pair(await Authenticator.make(-7));
		const again = t.make();
		expect(again.list()).toHaveLength(1);
		expect(await again.verifySession(t.withCookie(token))).toBe(true);
		clock.now += 20 * DAY;
		expect(await again.verifySession(t.withCookie(token))).toBe(true);
		clock.now += 20 * DAY;
		expect(await again.verifySession(t.withCookie(token))).toBe(true);
		clock.now += 31 * DAY;
		expect(await again.verifySession(t.withCookie(token))).toBe(false);
	});

	test("a made-up or malformed cookie is no session", async () => {
		const t = fresh();
		await t.pair(await Authenticator.make(-7));
		for (const c of ["dotz_dev=" + "A".repeat(43), "dotz_dev=short", "other=1"]) expect(await t.d.verifySession(new Request(`${ORIGIN}/`, { headers: { cookie: c } }))).toBe(false);
		expect(await t.d.verifySession(new Request(`${ORIGIN}/`))).toBe(false);
	});

	test("the device list shows no keys", async () => {
		const t = fresh();
		await t.pair(await Authenticator.make(-7));
		const url = new URL(`${ORIGIN}/api/devices`);
		const list = (await (await t.d.apiRoute(new Request(url), url))!.json()) as Record<string, unknown>[];
		expect(list).toHaveLength(1);
		expect(Object.keys(list[0]!).sort()).toEqual(["created", "current", "id", "last_used", "name"]);
	});
});

describe("the settings screen's calls", () => {
	const call = async (t: ReturnType<typeof fresh>, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> => {
		const url = new URL(`${ORIGIN}${path}`);
		const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.token ? { cookie: `dotz_dev=${opts.token}` } : {}) };
		const req = new Request(url, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
		// The routes.ts order: pairing paths first, then the gate (a device session in cloudflare mode), then these calls.
		const open = await t.d.pairRoute(req.clone(), url);
		if (open) return open;
		if (!cloudflareGate({ device: await t.d.verifySession(req), accessConfigured: false, access: false })) return t.d.denied(req, url);
		return (await t.d.apiRoute(req, url)) ?? new Response("not found", { status: 404 });
	};

	test("the list marks the caller's own device", async () => {
		const t = fresh();
		const a = await Authenticator.make(-7), b = await Authenticator.make(-7);
		const ta = await t.pair(a);
		await t.pair(b);
		const list = (await (await call(t, "GET", "/api/devices", { token: ta })).json()) as { id: string; current: boolean }[];
		expect(list.map(d => [d.id, d.current])).toEqual([[b64u(a.credId), true], [b64u(b.credId), false]]);
	});

	test("rename and unpair work for a paired device and are refused to an unpaired request", async () => {
		const t = fresh();
		const a = await Authenticator.make(-7), b = await Authenticator.make(-7);
		const ta = await t.pair(a);
		const tb = await t.pair(b);
		const bid = encodeURIComponent(b64u(b.credId));
		for (const [method, path, body] of [["PATCH", `/api/devices/${bid}`, { name: "훔친 이름" }], ["DELETE", `/api/devices/${bid}`, undefined], ["POST", "/api/devices/code", {}], ["GET", "/api/devices", undefined]] as const) {
			const r = await call(t, method, path, { body, token: "A".repeat(43) });
			expect([method, r.status, r.headers.get("x-dotz-pair")]).toEqual([method, 403, "1"]);
		}
		expect(t.d.list().map(d => d.name)).toEqual(["Test phone", "Test phone"]);
		const renamed = await call(t, "PATCH", `/api/devices/${bid}`, { token: ta, body: { name: "  회사 노트북\n" } });
		expect(((await renamed.json()) as { name: string }).name).toBe("회사 노트북");
		expect(t.make().list().find(d => d.id === b64u(b.credId))!.name).toBe("회사 노트북");
		expect((await call(t, "PATCH", `/api/devices/${bid}`, { token: ta, body: { name: " " } })).status).toBe(400);
		expect((await call(t, "DELETE", `/api/devices/${bid}`, { token: ta })).status).toBe(200);
		expect((await call(t, "GET", "/api/devices", { token: tb })).status).toBe(403);
	});

	test("a code issued on screen pairs a new device once and shares the hourly limit with /pair", async () => {
		const t = fresh();
		const ta = await t.pair(await Authenticator.make(-7));
		const sentBefore = t.sent.length;
		const r = await call(t, "POST", "/api/devices/code", { token: ta });
		const o = (await r.json()) as { code: string; minutes: number; url: string; qr: unknown };
		expect([r.status, o.minutes, o.url, /^\d{6}$/.test(o.code)]).toEqual([200, 10, `${ORIGIN}/pair`, true]);
		expect(o.qr).toEqual(qrPath(`${ORIGIN}/pair#code=${o.code}`));
		expect(t.sent.length).toBe(sentBefore);
		expect((await t.post("/api/pair/begin", { code: o.code })).status).toBe(200);
		expect((await t.post("/api/pair/begin", { code: o.code })).status).toBe(403);
		// pair() used one code; this is the third this hour
		expect((await call(t, "POST", "/api/devices/code", { token: ta })).status).toBe(200);
		expect((await call(t, "POST", "/api/devices/code", { token: ta })).status).toBe(429);
		expect((await t.post("/api/pair/code")).status).toBe(429);
	});
});

describe("the gate", () => {
	test("in cloudflare mode a device session is required, and Access too when it is set up", () => {
		expect(cloudflareGate({ device: false, accessConfigured: false, access: false })).toBe(false);
		expect(cloudflareGate({ device: false, accessConfigured: true, access: true })).toBe(false);
		expect(cloudflareGate({ device: true, accessConfigured: false, access: false })).toBe(true);
		expect(cloudflareGate({ device: true, accessConfigured: true, access: false })).toBe(false);
		expect(cloudflareGate({ device: true, accessConfigured: true, access: true })).toBe(true);
	});

	test("an unpaired page load goes to /pair, an unpaired call gets the 403 the web app reacts to", () => {
		const t = fresh();
		const page = new URL(`${ORIGIN}/`);
		const r = t.d.denied(new Request(page, { headers: { accept: "text/html" } }), page);
		expect([r.status, r.headers.get("location")]).toEqual([302, "/pair"]);
		const api = new URL(`${ORIGIN}/api/state`);
		const f = t.d.denied(new Request(api, { headers: { accept: "*/*" } }), api);
		expect([f.status, f.headers.get("x-dotz-pair")]).toEqual([403, "1"]);
	});

	test("on a workers.dev host the gate is the same: a passkey for that host pairs, one for another host does not, unpaired is sent to /pair", async () => {
		const host = "dotz.owner.workers.dev";
		const origin = `https://${host}`;
		const sent: string[] = [];
		const d = createDevices({ dir: mkdtempSync(join(tmpdir(), "dotz-devices-")), hostname: host, notify: t => void sent.push(t) });
		const post = async (path: string, body: unknown = {}): Promise<Response> => {
			const url = new URL(`${origin}${path}`);
			return (await d.pairRoute(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }), url))!;
		};
		const begin = async (): Promise<string> => {
			expect((await post("/api/pair/code")).status).toBe(200);
			return ((await (await post("/api/pair/begin", { code: /\d{6}/.exec(sent.at(-1)!)![0] })).json()) as { challenge: string }).challenge;
		};
		const page = new URL(`${origin}/`);
		expect(d.denied(new Request(page, { headers: { accept: "text/html" } }), page).headers.get("location")).toBe("/pair");
		const a = await Authenticator.make(-7);
		expect((await post("/api/pair/register", await a.create(await begin()))).status).toBe(403);
		const res = await post("/api/pair/register", await a.create(await begin(), { origin, rpId: host }));
		expect(res.status).toBe(200);
		const token = /dotz_dev=([A-Za-z0-9_-]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
		expect(await d.verifySession(new Request(page, { headers: { cookie: `dotz_dev=${token}` } }))).toBe(true);
	});

	test("only the pairing paths are public", async () => {
		const t = fresh();
		for (const [method, path] of [["GET", "/api/state"], ["POST", "/api/devices"], ["POST", "/api/pair/other"], ["GET", "/api/pair/code"], ["GET", "/api/devices"], ["POST", "/api/devices/code"], ["PATCH", "/api/devices/x"], ["DELETE", "/api/devices/x"]] as const) {
			const url = new URL(`${ORIGIN}${path}`);
			expect(await t.d.pairRoute(new Request(url, { method }), url)).toBeUndefined();
		}
	});

	test("a tampered DER signature is not accepted as raw", () => {
		expect(derToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toBeUndefined();
		expect(derToRaw(new Uint8Array(0))).toBeUndefined();
	});
});

describe("the /pair page in a headless WebView", () => {
	const t = fresh();
	const hub = fakeHub({ api: (req, url) => t.d.pairRoute(req, url) });
	afterAll(() => hub.stop());

	test("renders with its script running under the page's content-security policy", async () => {
		const view = await hub.view({}, "/pair");
		await waitFor(view, `document.getElementById("lead").textContent.length > 0`);
		expect(await ev(view, `document.querySelector("h1").textContent`)).toBe("기기 연결");
		expect(await ev(view, `document.getElementById("get").textContent`)).toBe("코드 받기");
		expect(await ev(view, `document.getElementById("login").hidden`)).toBe(true);
	});

	test("with a paired device it offers the passkey login", async () => {
		await t.pair(await Authenticator.make(-7));
		const view = await hub.view({}, "/pair");
		await waitFor(view, `document.getElementById("lead").textContent.length > 0`);
		expect(await ev(view, `document.getElementById("login").hidden`)).toBe(false);
		expect(await ev(view, `document.getElementById("go").textContent`)).toBe("패스키로 들어가기");
	});
});

// What a link into the app does for a browser that is not paired, and what the paired one is sent on to.
const NEXT_TABLE: [string | null | undefined, string][] = [
	["/", "/"],
	["/api/file?path=%2Ftmp%2Fa.txt", "/api/file?path=%2Ftmp%2Fa.txt"],
	["/#chat/main", "/#chat/main"],
	["/한글 경로?q=값", "/한글 경로?q=값"],
	["/pairing", "/pairing"],
	["/pair.js", "/pair.js"],
	["/" + "a".repeat(1999), "/" + "a".repeat(1999)],
	["//evil.com", "/"],
	["//evil.com/x", "/"],
	["/\\evil.com", "/"],
	["\\evil.com", "/"],
	["https://evil.com", "/"],
	["http://evil.com/x", "/"],
	["javascript:alert(1)", "/"],
	["evil.com", "/"],
	["", "/"],
	[null, "/"],
	[undefined, "/"],
	["/pair", "/"],
	["/pair?next=/x", "/"],
	["/pair/x", "/"],
	["/pair#a", "/"],
	["/a\nb", "/"],
	["/a\rb", "/"],
	["/a\tb", "/"],
	["/a\u0000b", "/"],
	["/a\u007fb", "/"],
	["/a\u0085b", "/"],
	["/" + "a".repeat(2000), "/"],
];
const HOSTILE = ["//evil.com", "/\\evil.com", "https://evil.com", "/pair", "/a\nb", "/" + "a".repeat(5000), "/.//evil.com", "/%2F%2Fevil.com", "///evil.com", "/\t/evil.com"];

describe("next: where a link goes after the door", () => {
	test("safeNext takes a same-origin path only, and the browser's copy answers the same table", () => {
		const twin = new Function(SAFE_NEXT_SRC + "\nreturn safeNext;")() as (raw: unknown) => string;
		for (const [raw, want] of NEXT_TABLE) expect([raw?.slice(0, 40), safeNext(raw), twin(raw)]).toEqual([raw?.slice(0, 40), want, want]);
	});

	const nav = (path: string, headers: Record<string, string> = {}) => {
		const url = new URL(ORIGIN + path);
		return { url, req: new Request(url, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "none", ...headers } }) };
	};

	test("an unpaired page load, an /api link too, goes to /pair with its own address and receives nothing", async () => {
		const t = fresh();
		await t.pair(await Authenticator.make(-7));
		for (const [path, to] of [["/api/file?path=/etc/hosts&x=%ED%95%9C", "/pair?next=" + encodeURIComponent("/api/file?path=/etc/hosts&x=%ED%95%9C")], ["/#chat/main", "/pair"], ["/", "/pair"], ["/some/page?q=1", "/pair?next=%2Fsome%2Fpage%3Fq%3D1"]] as const) {
			const { url, req } = nav(path);
			const r = t.d.denied(req, url);
			expect([path, r.status, r.headers.get("location")]).toEqual([path, 302, to]);
			expect(await r.text()).toBe("");
		}
		const html = nav("/api/state", { "sec-fetch-mode": "", accept: "text/html,application/xhtml+xml" });
		html.req.headers.delete("sec-fetch-mode");
		expect(t.d.denied(html.req, html.url).headers.get("location")).toBe("/pair?next=%2Fapi%2Fstate");
	});

	test("a fetch, or anything that is not a GET, stays the 403 the app reacts to", async () => {
		const t = fresh();
		for (const [method, headers] of [["GET", { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", accept: "*/*" }], ["GET", { "sec-fetch-mode": "cors", accept: "text/html" }], ["POST", { "sec-fetch-mode": "navigate" }], ["GET", { accept: "application/json" }]] as const) {
			const url = new URL(ORIGIN + "/api/file?path=/etc/hosts");
			const r = t.d.denied(new Request(url, { method, headers, ...(method === "POST" ? { body: "x" } : {}) }), url);
			expect([method, r.status, r.headers.get("x-dotz-pair"), await r.text()]).toEqual([method, 403, "1", "forbidden"]);
		}
	});

	test("a cross-site first navigation, which carries no cookie, gets the fixed page with no data; its script is public", async () => {
		const t = fresh();
		for (const path of ["/", "/api/file?path=/etc/hosts", "/#chat/main"]) {
			const { url, req } = nav(path, { "sec-fetch-site": "cross-site" });
			const r = t.d.denied(req, url);
			const body = await r.text();
			expect([path, r.status, r.headers.get("content-type"), r.headers.get("location")]).toEqual([path, 200, "text/html; charset=utf-8", null]);
			expect(body).toBe(HOP_HTML);
			expect(body).not.toContain("etc");
			expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
			expect(r.headers.get("cache-control")).toBe("no-store");
		}
		const cors = new URL(ORIGIN + "/api/state");
		expect(t.d.denied(new Request(cors, { headers: { "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" } }), cors).status).toBe(403);
		const js = new URL(ORIGIN + "/pair-hop.js");
		const r = (await t.d.pairRoute(new Request(js), js))!;
		expect([r.status, r.headers.get("content-security-policy")?.includes("script-src 'self'"), await r.text()]).toEqual([200, true, HOP_JS]);
	});

	test("a cross-site first navigation anywhere but / and /api/file gets the plain redirect: no hop page, so no cookie travels and nothing runs signed in", async () => {
		const t = fresh();
		for (const path of ["/api/state", "/apps/x/y", "/desk/", "/api/file/../state"]) {
			const { url, req } = nav(path, { "sec-fetch-site": "cross-site" });
			const r = t.d.denied(req, url);
			expect([path, r.status, r.headers.get("location")]).toEqual([path, 302, "/pair?next=" + encodeURIComponent(safeNext(url.pathname + url.search))]);
			expect(await r.text()).not.toContain(HOP_HTML);
		}
	});

	const pairGet = async (t: ReturnType<typeof fresh>, next: string | undefined, token?: string, access?: (req: Request) => Promise<boolean>): Promise<Response> => {
		const url = new URL(ORIGIN + "/pair" + (next === undefined ? "" : "?next=" + encodeURIComponent(next)));
		return (await t.d.pairRoute(new Request(url, { headers: token ? { cookie: "dotz_dev=" + token } : {} }), url, access))!;
	};

	test("with Cloudflare Access set up, /pair?next sends a paired browser on only when the Access check passes; otherwise it is the page", async () => {
		const t = fresh();
		const token = await t.pair(await Authenticator.make(-7));
		const pass = await pairGet(t, "/x", token, async () => true);
		expect([pass.status, pass.headers.get("location")]).toEqual([302, "/x"]);
		const fail = await pairGet(t, "/x", token, async () => false);
		expect([fail.status, fail.headers.get("location"), (await fail.text()).includes("data-devices")]).toEqual([200, null, true]);
		let asked = 0;
		const plain = await pairGet(t, undefined, token, async () => { asked++; return true; });
		const unpaired = await pairGet(t, "/x", undefined, async () => { asked++; return true; });
		expect([plain.status, unpaired.status, asked]).toEqual([200, 200, 0]);
	});

	test("/pair?next with a live device session goes on to next; without one, or with no next, it is the page", async () => {
		const t = fresh();
		const token = await t.pair(await Authenticator.make(-7));
		const ok = await pairGet(t, "/api/file?path=%2Ftmp%2Fa.txt", token);
		expect([ok.status, ok.headers.get("location")]).toEqual([302, "/api/file?path=%2Ftmp%2Fa.txt"]);
		const korean = await pairGet(t, "/한글 경로?q=값", token);
		expect(korean.headers.get("location")).toBe("/%ED%95%9C%EA%B8%80%20%EA%B2%BD%EB%A1%9C?q=%EA%B0%92");
		for (const [next, tok] of [["/x", "A".repeat(43)], ["/x", undefined], [undefined, token]] as const) {
			const r = await pairGet(t, next, tok);
			expect([r.status, r.headers.get("location"), (await r.text()).includes("data-devices")]).toEqual([200, null, true]);
		}
	});

	test("no next can make an open redirect: a hostile one lands on / and every Location stays on this origin", async () => {
		const t = fresh();
		const token = await t.pair(await Authenticator.make(-7));
		for (const next of HOSTILE) {
			const r = await pairGet(t, next, token);
			const loc = r.headers.get("location")!;
			expect([next.slice(0, 20), r.status, new URL(loc, ORIGIN).origin]).toEqual([next.slice(0, 20), 302, ORIGIN]);
			expect(loc).toMatch(/^\/[^/\\]*|^\/\.\/\/|^\/%2F/);
			expect(loc.startsWith("//")).toBe(false);
			if (safeNext(next) === "/") expect(loc).toBe("/");
		}
		for (const next of HOSTILE) {
			const { url, req } = nav("/" + next.replace(/^\/+/, ""));
			const loc = t.d.denied(req, url).headers.get("location")!;
			expect(new URL(loc, ORIGIN).origin).toBe(ORIGIN);
		}
	});
});

describe("the /pair page carries the app's tokens", () => {
	const tokens = readFileSync(join(import.meta.dir, "..", "web", "css", "01-tokens.css"), "utf8");
	const vars = (block: string): Map<string, string> => new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.replace(/\s+/g, " ").trim()] as const));
	const darkAt = tokens.indexOf(':root[data-theme="dark"] {');
	const appLight = vars(tokens.slice(tokens.indexOf(":root {"), darkAt));
	const appDark = vars(tokens.slice(darkAt, tokens.indexOf("\n}", darkAt)));
	const css = PAIR_HTML.slice(PAIR_HTML.indexOf("<style>"), PAIR_HTML.indexOf("</style>"));
	const mediaAt = css.indexOf("@media (prefers-color-scheme: dark){:root{");
	const pageLight = vars(css.slice(css.indexOf(":root{"), css.indexOf("}")));
	const pageDark = vars(css.slice(mediaAt, css.indexOf("}", mediaAt)));

	test("every colour, size, space, radius, height, motion and font value equals web/css/01-tokens.css, light and dark", () => {
		expect(pageLight.size).toBeGreaterThan(25);
		expect(pageDark.size).toBeGreaterThan(8);
		for (const [name, value] of pageLight) expect([name, value]).toEqual([name, appLight.get(name)]);
		for (const [name, value] of pageDark) expect([name, value]).toEqual([name, appDark.get(name)]);
	});

	test("every colour the page changes in dark is one the app changes in dark, and every token it uses is defined", () => {
		for (const name of pageDark.keys()) expect([name, appDark.has(name)]).toEqual([name, true]);
		for (const m of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect([m[1], pageLight.has(m[1]!)]).toEqual([m[1], true]);
	});
});

describe("the /pair page, drawn", () => {
	const SHOTS = process.env.PAIR_SHOTS ?? "/tmp/cf-webapp/shots";
	mkdirSync(SHOTS, { recursive: true });
	const t = fresh();
	// WebView cannot switch prefers-color-scheme, so the page is served with its dark media query forced on (or off): the same rules, deterministic.
	const hub = fakeHub({
		api: async (req, url) => {
			const real = await t.d.pairRoute(req, url);
			const theme = url.searchParams.get("theme");
			if (!real || url.pathname !== "/pair" || !theme) return real;
			return new Response((await real.text()).replace("@media (prefers-color-scheme: dark)", theme === "dark" ? "@media all" : "@media not all"), { headers: real.headers });
		},
	});
	afterAll(() => hub.stop());

	test("light and dark, desktop and phone: the app's canvas, card, type size and one 220ms arrive; screenshots saved", async () => {
		await t.pair(await Authenticator.make(-7));
		const want = { light: ["rgb(242, 244, 246)", "rgb(255, 255, 255)"], dark: ["rgb(18, 18, 20)", "rgb(29, 29, 33)"] } as const;
		for (const [width, height] of [[1280, 800], [390, 844]] as const) {
			for (const theme of ["light", "dark"] as const) {
				const v = await hub.view({ width, height }, "/pair?theme=" + theme);
				await waitFor(v, 'document.getElementById("lead").textContent.length > 0');
				await waitFor(v, 'document.getAnimations().every(a => a.playState !== "running")');
				const got = await ev<string[]>(v, '(() => { const c = e => getComputedStyle(document.querySelector(e)); return [c("body").backgroundColor, c("main").backgroundColor, c("main").animationName, c("main").animationDuration, c("h1").fontSize, c("#go").height, c("#go").backgroundColor]; })()');
				expect(got.slice(0, 2)).toEqual([...want[theme]]);
				expect(got.slice(2, 4)).toEqual(["arrive", "0.22s"]);
				expect(got[4]).toBe(width > 639 ? "22px" : "20px");
				expect(got[5]).toBe("36px");
				expect(got[6]).toBe(theme === "light" ? "rgb(49, 130, 246)" : "rgb(76, 148, 255)");
				await Bun.write(SHOTS + "/pair-" + width + "-" + theme + ".png", await v.screenshot());
			}
		}
	}, 60_000);
});
