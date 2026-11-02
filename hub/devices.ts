// Paired devices for web.access = "cloudflare": only a browser that was paired once with a passkey (WebAuthn) may use the web app.
// Pairing: a 6-digit code is sent to the owner through the messengers; with it a browser registers a passkey, and a later visit signs in with that
// passkey and gets the `dotz_dev` session cookie. The gateway keeps the public keys and the sha256 of each session cookie in DATA_DIR/web-devices.json
// (0600); the pages are hub/pair-page.ts. Everything uses crypto.subtle; an unpaired visitor reaches only /pair, /pair.js and /api/pair/*.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./config.ts";
import { PAIR_HTML, PAIR_JS } from "./pair-page.ts";
import { cfBase } from "./weblink.ts";

export const DEVICE_COOKIE = "dotz_dev";
const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5; // wrong guesses a code survives
const CODES_PER_HOUR = 3;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 200;
const SESSION_MS = 30 * 86_400_000;
const SLIDE_MIN_MS = 86_400_000; // a session's stored expiry moves forward at most once a day (one disk write)
const MAX_SESSIONS = 200;
const MAX_DEVICES = 20;
const BODY_MAX = 16_384;
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

export type Device = { id: string; spki: string; alg: -7 | -257; signCount: number; name: string; created: string; last_used: string | null };
type Stored = { devices: Device[]; sessions: Record<string, { device: string; exp: number }> };
export type DevicesOpts = {
	dir: string;
	/** web.cloudflare.hostname; without a valid host name every pairing request is refused. */
	hostname: string | undefined;
	/** Delivers text to the owner (hub/outbound.ts out("alert", ...), which reaches every messenger). */
	notify: (text: string) => unknown;
};
export type Devices = ReturnType<typeof createDevices>;

/** The cloudflare-mode rule behind routes.ts authorized(): a paired device's session, and the Cloudflare Access token too when Access is set up. */
export const cloudflareGate = (o: { device: boolean; accessConfigured: boolean; access: boolean }): boolean => o.device && (!o.accessConfigured || o.access);

const enc = new TextEncoder();
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64u = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "base64url"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const sha256 = async (d: Uint8Array | string): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : d));
const randomBytes = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n));
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const sameText = (a: string, b: string): boolean => {
	let d = a.length ^ b.length;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
	return d === 0;
};
const B64U = /^[A-Za-z0-9_-]+$/;
const field = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max && B64U.test(v) ? v : undefined);

// A 6-digit code without modulo bias.
function newCode(): string {
	const limit = 4_294_000_000; // largest multiple of 1e6 that fits in 32 bits
	for (;;) {
		const n = new DataView(randomBytes(4).buffer).getUint32(0);
		if (n < limit) return String(n % 1_000_000).padStart(6, "0");
	}
}

/** An ECDSA signature in DER (what authenticators send) as the raw r||s that crypto.subtle verifies. */
export function derToRaw(der: Uint8Array): Uint8Array | undefined {
	let i = 0;
	if (der[i++] !== 0x30) return undefined;
	let len = der[i++]!;
	if (len & 0x80) {
		const n = len & 0x7f;
		if (n < 1 || n > 2) return undefined;
		len = 0;
		for (let k = 0; k < n; k++) len = (len << 8) | (der[i++] ?? 0);
	}
	if (i + len !== der.length) return undefined;
	const parts: Uint8Array[] = [];
	for (let p = 0; p < 2; p++) {
		if (der[i++] !== 0x02) return undefined;
		const l = der[i++] ?? 0;
		if (l === 0 || i + l > der.length) return undefined;
		let v = der.slice(i, i + l);
		i += l;
		while (v.length > 1 && v[0] === 0) v = v.slice(1);
		if (v.length > 32) return undefined;
		parts.push(v);
	}
	if (i !== der.length) return undefined;
	const raw = new Uint8Array(64);
	raw.set(parts[0]!, 32 - parts[0]!.length);
	raw.set(parts[1]!, 64 - parts[1]!.length);
	return raw;
}

const importKey = (spki: Uint8Array<ArrayBuffer>, alg: number): Promise<CryptoKey> =>
	alg === -7
		? crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
		: crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);

export function createDevices(opts: DevicesOpts) {
	const base = cfBase(opts.hostname?.toLowerCase());
	const rpId = base?.slice("https://".length);
	const file = join(opts.dir, "web-devices.json");

	let data: Stored = { devices: [], sessions: {} };
	try {
		if (existsSync(file)) {
			const v = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
			data = { devices: Array.isArray(v.devices) ? v.devices : [], sessions: v.sessions && typeof v.sessions === "object" ? v.sessions : {} };
		}
	} catch (e) {
		log(`web-devices.json unreadable, starting with no paired devices: ${e}`);
	}
	function save(): void {
		mkdirSync(opts.dir, { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	}

	let code: { value: string; exp: number; wrong: number } | undefined;
	const codeAt: number[] = [];
	const challenges = new Map<string, { kind: "create" | "get"; exp: number }>();

	const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
	const fail = (status: number, error: string): Response => json({ error }, status);
	const iso = (): string => new Date(Date.now()).toISOString();

	function issueChallenge(kind: "create" | "get"): string | undefined {
		const now = Date.now();
		for (const [k, v] of challenges) if (v.exp <= now) challenges.delete(k);
		if (challenges.size >= MAX_CHALLENGES) return undefined;
		const c = b64u(randomBytes(32));
		challenges.set(c, { kind, exp: now + CHALLENGE_TTL_MS });
		return c;
	}
	// A challenge works once: looking it up removes it, whatever the rest of the request turns out to be.
	function takeChallenge(c: string, kind: "create" | "get"): boolean {
		const v = challenges.get(c);
		challenges.delete(c);
		return !!v && v.kind === kind && v.exp > Date.now();
	}

	async function session(deviceId: string): Promise<string> {
		const now = Date.now();
		for (const [h, s] of Object.entries(data.sessions)) if (s.exp <= now) delete data.sessions[h];
		const all = Object.entries(data.sessions);
		if (all.length >= MAX_SESSIONS) for (const [h] of all.sort((a, b) => a[1].exp - b[1].exp).slice(0, all.length - MAX_SESSIONS + 1)) delete data.sessions[h];
		const token = b64u(randomBytes(32));
		data.sessions[hex(await sha256(token))] = { device: deviceId, exp: now + SESSION_MS };
		save();
		return token;
	}
	const cookie = (token: string): string => `${DEVICE_COOKIE}=${token}; Max-Age=34560000; Path=/; HttpOnly; Secure; SameSite=Strict`;

	/** True when the request carries the session cookie of a paired device; the session slides 30 days from each use. */
	async function verifySession(req: Request): Promise<boolean> {
		const m = /(?:^|;\s*)dotz_dev=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.get("cookie") ?? "");
		if (!m) return false;
		const h = hex(await sha256(m[1]!));
		const s = data.sessions[h];
		if (!s) return false;
		const now = Date.now();
		if (s.exp <= now || !data.devices.some(d => d.id === s.device)) {
			delete data.sessions[h];
			return false;
		}
		if (now + SESSION_MS - s.exp >= SLIDE_MIN_MS) {
			s.exp = now + SESSION_MS;
			save();
		}
		return true;
	}

	async function readBody(req: Request): Promise<Record<string, unknown> | undefined> {
		if (Number(req.headers.get("content-length") ?? 0) > BODY_MAX) return undefined;
		try {
			const text = await req.text();
			if (text.length > BODY_MAX) return undefined;
			const v = JSON.parse(text || "{}");
			return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}

	// clientDataJSON checked against what this ceremony expects; the challenge is used up here.
	function clientData(raw: string | undefined, type: "webauthn.create" | "webauthn.get", kind: "create" | "get"): boolean {
		if (!raw || !base) return false;
		let cd: Record<string, unknown>;
		try {
			cd = JSON.parse(new TextDecoder().decode(unb64u(raw)));
		} catch {
			return false;
		}
		if (!cd || typeof cd.challenge !== "string") return false;
		const fresh = takeChallenge(cd.challenge, kind);
		return fresh && cd.type === type && cd.origin === base && cd.crossOrigin !== true;
	}
	// authenticatorData: rpIdHash, flags (user present AND verified) and the signature counter.
	async function authData(raw: string | undefined): Promise<{ bytes: Uint8Array; flags: number; signCount: number } | undefined> {
		if (!raw || !rpId) return undefined;
		const bytes = unb64u(raw);
		if (bytes.length < 37 || !equal(bytes.slice(0, 32), await sha256(rpId))) return undefined;
		const flags = bytes[32]!;
		if (!(flags & FLAG_UP) || !(flags & FLAG_UV)) return undefined;
		return { bytes, flags, signCount: new DataView(bytes.buffer, bytes.byteOffset).getUint32(33) };
	}

	async function requestCode(): Promise<Response> {
		const now = Date.now();
		while (codeAt.length && now - codeAt[0]! >= 3_600_000) codeAt.shift();
		if (codeAt.length >= CODES_PER_HOUR) return fail(429, "코드를 너무 자주 요청했습니다. 한 시간 뒤에 다시 시도해 주세요");
		codeAt.push(now);
		code = { value: newCode(), exp: now + CODE_TTL_MS, wrong: 0 };
		try {
			await opts.notify(`기기 연결 코드: ${code.value} (10분간 유효). 본인이 요청한 것이 아니면 무시하세요.`);
		} catch (e) {
			log(`device pairing code could not be sent: ${e}`);
			code = undefined;
			return fail(502, "코드를 보내지 못했습니다");
		}
		return json({ ok: true, minutes: 10 });
	}

	async function begin(req: Request): Promise<Response> {
		const b = await readBody(req);
		if (!b) return fail(400, "요청이 올바르지 않습니다");
		if (data.devices.length >= MAX_DEVICES) return fail(409, "연결할 수 있는 기기 수를 넘었습니다. 설정에서 쓰지 않는 기기를 해제해 주세요");
		const c = code;
		if (!c || c.exp <= Date.now()) {
			code = undefined;
			return fail(403, "코드가 없거나 만료되었습니다. 새 코드를 받아 주세요");
		}
		if (typeof b.code !== "string" || !sameText(c.value, b.code.trim())) {
			if (++c.wrong >= CODE_TRIES) code = undefined;
			return fail(403, "코드가 맞지 않습니다");
		}
		code = undefined; // single use
		const challenge = issueChallenge("create");
		if (!challenge) return fail(429, "잠시 후 다시 시도해 주세요");
		return json({
			challenge,
			rp: { id: rpId, name: "dotz" },
			user: { id: b64u(randomBytes(16)), name: "owner", displayName: "owner" },
			pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
			authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
			attestation: "none",
			timeout: CHALLENGE_TTL_MS,
		});
	}

	async function register(req: Request): Promise<Response> {
		const b = await readBody(req);
		const id = field(b?.id, 1400), spki = field(b?.publicKey, 2000), alg = b?.publicKeyAlgorithm;
		if (!b || !id || !spki || (alg !== -7 && alg !== -257)) return fail(400, "요청이 올바르지 않습니다");
		if (!clientData(field(b.clientDataJSON, 4000), "webauthn.create", "create")) return fail(403, "기기 확인에 실패했습니다");
		const ad = await authData(field(b.authenticatorData, 4000));
		if (!ad || !(ad.flags & FLAG_AT) || ad.bytes.length < 55) return fail(403, "기기 확인에 실패했습니다");
		const credLen = (ad.bytes[53]! << 8) | ad.bytes[54]!;
		if (!equal(ad.bytes.slice(55, 55 + credLen), unb64u(id))) return fail(403, "기기 확인에 실패했습니다");
		try {
			await importKey(unb64u(spki), alg);
		} catch {
			return fail(400, "공개키를 읽지 못했습니다");
		}
		if (data.devices.length >= MAX_DEVICES) return fail(409, "연결할 수 있는 기기 수를 넘었습니다");
		if (data.devices.some(d => d.id === id)) return fail(409, "이미 연결된 기기입니다");
		const name = (typeof b.name === "string" ? b.name : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) || "기기";
		data.devices.push({ id, spki, alg, signCount: ad.signCount, name, created: iso(), last_used: iso() });
		const token = await session(id);
		log(`web: device paired: ${name}`);
		return json({ ok: true }, 200, { "Set-Cookie": cookie(token) });
	}

	function loginBegin(): Response {
		if (!data.devices.length) return fail(404, "연결된 기기가 없습니다");
		const challenge = issueChallenge("get");
		if (!challenge) return fail(429, "잠시 후 다시 시도해 주세요");
		return json({ challenge, rpId, userVerification: "required", allowCredentials: data.devices.map(d => ({ type: "public-key", id: d.id })), timeout: CHALLENGE_TTL_MS });
	}

	async function login(req: Request): Promise<Response> {
		const b = await readBody(req);
		const id = field(b?.id, 1400), sig = field(b?.signature, 2000), cdRaw = field(b?.clientDataJSON, 4000);
		if (!b || !id || !sig || !cdRaw) return fail(400, "요청이 올바르지 않습니다");
		const denied = fail(403, "기기 확인에 실패했습니다");
		if (!clientData(cdRaw, "webauthn.get", "get")) return denied;
		const dev = data.devices.find(d => d.id === id);
		const ad = await authData(field(b.authenticatorData, 4000));
		if (!dev || !ad) return denied;
		const signed = new Uint8Array(ad.bytes.length + 32);
		signed.set(ad.bytes);
		signed.set(await sha256(unb64u(cdRaw)), ad.bytes.length);
		let ok = false;
		try {
			const key = await importKey(unb64u(dev.spki), dev.alg);
			const s = unb64u(sig);
			if (dev.alg === -7) {
				const raw = derToRaw(s);
				ok = !!raw && (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signed));
			} else ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, s, signed);
		} catch {
			ok = false;
		}
		if (!ok) return denied;
		// The counter must go up; authenticators that keep none send 0 every time.
		if (!(ad.signCount > dev.signCount || (ad.signCount === 0 && dev.signCount === 0))) {
			log(`web: device ${dev.name} sent a repeated signature counter; refused`);
			return denied;
		}
		dev.signCount = ad.signCount;
		dev.last_used = iso();
		const token = await session(dev.id);
		return json({ ok: true }, 200, { "Set-Cookie": cookie(token) });
	}

	/** The pages and calls an unpaired browser may use: GET /pair, GET /pair.js and POST /api/pair/*. Undefined for any other request. */
	async function pairRoute(req: Request, url: URL): Promise<Response | undefined> {
		const p = url.pathname;
		const read = req.method === "GET" || req.method === "HEAD";
		if (read && (p === "/pair" || p === "/pair.js")) {
			const csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
			const page = p === "/pair";
			const body = req.method === "HEAD" ? null : page ? PAIR_HTML.replace("__DEVICES__", String(data.devices.length)) : PAIR_JS;
			return new Response(body, { headers: { "Content-Type": page ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff" } });
		}
		if (req.method !== "POST" || !p.startsWith("/api/pair/")) return undefined;
		const step = p.slice("/api/pair/".length);
		if (!["code", "begin", "register", "login-begin", "login"].includes(step)) return undefined;
		if (!base) return fail(503, "web.cloudflare.hostname 설정이 필요합니다");
		const origin = req.headers.get("origin");
		if (origin && origin !== base) return fail(403, "허용되지 않은 출처입니다");
		if (step === "code") return requestCode();
		if (step === "begin") return begin(req);
		if (step === "register") return register(req);
		if (step === "login-begin") return loginBegin();
		return login(req);
	}

	/** GET /api/devices and DELETE /api/devices/<id> (the caller has already checked authorized()). */
	function apiRoute(req: Request, url: URL): Response | undefined {
		if (url.pathname === "/api/devices" && req.method === "GET") return json(data.devices.map(d => ({ id: d.id, name: d.name, created: d.created, last_used: d.last_used })));
		const m = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
		if (!m || req.method !== "DELETE") return undefined;
		let id: string;
		try {
			id = decodeURIComponent(m[1]!);
		} catch {
			return fail(400, "id가 올바르지 않습니다");
		}
		if (!revoke(id)) return fail(404, "그런 기기가 없습니다");
		return json({ ok: true });
	}
	/** Removes a device and every session it holds, at once. */
	function revoke(id: string): boolean {
		const n = data.devices.length;
		data.devices = data.devices.filter(d => d.id !== id);
		if (data.devices.length === n) return false;
		for (const [h, s] of Object.entries(data.sessions)) if (s.device === id) delete data.sessions[h];
		save();
		log(`web: device ${id.slice(0, 8)} revoked`);
		return true;
	}

	/** What a request that failed the gate gets: a page load goes to /pair, anything else a 403 the web app turns into that redirect. */
	function denied(req: Request, url: URL): Response {
		if ((req.method === "GET" || req.method === "HEAD") && (req.headers.get("accept") ?? "").includes("text/html") && !url.pathname.startsWith("/api/")) return new Response(null, { status: 302, headers: { Location: "/pair", "Cache-Control": "no-store" } });
		return new Response("forbidden", { status: 403, headers: { "X-Dotz-Pair": "1" } });
	}

	return { pairRoute, apiRoute, verifySession, denied, revoke, list: () => data.devices.map(d => ({ id: d.id, name: d.name, created: d.created, last_used: d.last_used })) };
}
