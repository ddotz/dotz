// Cloudflare Access login for the web app (web.access = "cloudflare"). Access puts a signed JWT in the Cf-Access-Jwt-Assertion header of every request it
// lets through; it is accepted only when its RS256 signature verifies against the team's published keys and its claims match this install's
// config. The Cf-Access-Authenticated-User-Email header is never read: anyone who can reach the loopback port could write it.

const CERTS_TTL_MS = 3_600_000; // keys are kept this long
const REFETCH_MIN_MS = 60_000; // an unknown kid triggers at most one fetch per this interval
const NBF_SKEW_S = 30;
const MAX_TOKEN = 8192;
const MAX_CACHED = 64;

export type CfAccessOpts = {
	/** Zero Trust team name: the <team> of <team>.cloudflareaccess.com. */
	team: string;
	/** Application Audience (AUD) tag of the Access application. */
	aud: string;
	/** Lower-cased e-mail addresses that may log in (web.allow_logins). */
	allow: Iterable<string>;
	/** Injectable for tests; defaults to the global fetch. */
	fetch?: (url: string) => Promise<Response>;
};
export type CfAccess = {
	/** The lower-cased e-mail of a valid token, else undefined. Never throws. */
	verify(jwt: string): Promise<string | undefined>;
	/** True when the request carries a valid Access token of an allowed e-mail. */
	verifyRequest(req: Request): Promise<boolean>;
};

const b64u = (s: string): Uint8Array<ArrayBuffer> => {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
};
const parseJson = (s: string): Record<string, unknown> | undefined => {
	try {
		const v = JSON.parse(new TextDecoder().decode(b64u(s)));
		return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
	} catch {
		return undefined;
	}
};

export function createCfAccess(opts: CfAccessOpts): CfAccess {
	const issuer = `https://${opts.team}.cloudflareaccess.com`;
	const allow = new Set([...opts.allow].map(s => s.toLowerCase()));
	const doFetch = opts.fetch ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(5000) }));
	let keys = new Map<string, CryptoKey>();
	let loadedAt = 0; // last successful load
	let triedAt = 0; // last attempt, successful or not
	let inflight: Promise<void> | undefined;
	const verified = new Map<string, { email: string; exp: number }>(); // token -> result, until the token's own exp

	async function load(): Promise<void> {
		triedAt = Date.now();
		const res = await doFetch(`${issuer}/cdn-cgi/access/certs`);
		if (!res.ok) throw new Error(`certs ${res.status}`);
		const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
		const next = new Map<string, CryptoKey>();
		for (const jwk of body.keys ?? []) {
			if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
			try {
				next.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
			} catch {
				// a key this runtime cannot import is skipped
			}
		}
		keys = next;
		loadedAt = Date.now();
	}
	const refresh = (): Promise<void> => (inflight ??= load().finally(() => void (inflight = undefined)));

	async function keyFor(kid: string): Promise<CryptoKey | undefined> {
		const now = Date.now();
		const stale = now - loadedAt >= CERTS_TTL_MS;
		const unknown = !keys.has(kid);
		if ((stale || unknown) && now - triedAt >= REFETCH_MIN_MS) await refresh().catch(() => void 0);
		return keys.get(kid);
	}

	async function verify(jwt: string): Promise<string | undefined> {
		try {
			const now = Date.now();
			const hit = verified.get(jwt);
			if (hit) {
				if (hit.exp * 1000 > now) return hit.email;
				verified.delete(jwt);
			}
			if (jwt.length > MAX_TOKEN) return undefined;
			const parts = jwt.split(".");
			if (parts.length !== 3) return undefined;
			const head = parseJson(parts[0]!);
			if (!head || head.alg !== "RS256" || typeof head.kid !== "string") return undefined;
			const key = await keyFor(head.kid);
			if (!key) return undefined;
			const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
			if (!ok) return undefined;
			const c = parseJson(parts[1]!);
			if (!c || c.iss !== issuer) return undefined;
			const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
			if (!aud.includes(opts.aud)) return undefined;
			const t = Date.now() / 1000;
			if (typeof c.exp !== "number" || c.exp <= t) return undefined;
			if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf > t + NBF_SKEW_S)) return undefined;
			const email = typeof c.email === "string" ? c.email.toLowerCase() : "";
			if (!email || !allow.has(email)) return undefined;
			if (verified.size >= MAX_CACHED) {
				for (const [k, v] of verified) if (v.exp * 1000 <= now) verified.delete(k);
				if (verified.size >= MAX_CACHED) verified.delete(verified.keys().next().value!);
			}
			verified.set(jwt, { email, exp: c.exp });
			return email;
		} catch {
			return undefined;
		}
	}

	return {
		verify,
		verifyRequest: async req => {
			const jwt = req.headers.get("cf-access-jwt-assertion");
			return !!jwt && !!(await verify(jwt));
		},
	};
}
