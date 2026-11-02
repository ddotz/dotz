import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareGate, createDevices, derToRaw } from "./devices.ts";
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
		expect(Object.keys(list[0]!).sort()).toEqual(["created", "id", "last_used", "name"]);
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
		for (const [method, path] of [["GET", "/api/state"], ["POST", "/api/devices"], ["POST", "/api/pair/other"], ["GET", "/api/pair/code"]] as const) {
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
