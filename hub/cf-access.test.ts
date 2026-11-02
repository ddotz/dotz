import { beforeAll, describe, expect, test } from "bun:test";
import { createCfAccess } from "./cf-access.ts";
import { clock } from "./runtime/test-clock.ts";

const TEAM = "acme";
const AUD = "aud-123";
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const OWNER = "owner@example.com";
const enc = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

type Pair = { kid: string; priv: CryptoKey; jwk: JsonWebKey };
const makePair = async (kid: string): Promise<Pair> => {
	const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	return { kid, priv: kp.privateKey, jwk: { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid } };
};
const sign = async (pair: Pair, claims: Record<string, unknown>, head: Record<string, unknown> = {}): Promise<string> => {
	const input = `${enc({ alg: "RS256", kid: pair.kid, ...head })}.${enc(claims)}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.priv, new TextEncoder().encode(input));
	return `${input}.${Buffer.from(sig).toString("base64url")}`;
};
const claims = (over: Record<string, unknown> = {}) => ({ iss: ISS, aud: [AUD], email: OWNER, exp: clock.now / 1000 + 600, nbf: clock.now / 1000 - 10, ...over });

let a: Pair;
let b: Pair;
beforeAll(async () => {
	[a, b] = await Promise.all([makePair("kid-a"), makePair("kid-b")]);
});

// A certs endpoint whose key set the test swaps; counts every request.
const certs = (initial: Pair[]) => {
	const state = { keys: initial, calls: 0, urls: [] as string[], fail: false };
	const fetch = async (url: string) => {
		state.calls++;
		state.urls.push(url);
		if (state.fail) return new Response("no", { status: 500 });
		return Response.json({ keys: state.keys.map(k => k.jwk) });
	};
	return { state, fetch };
};
const make = (c: ReturnType<typeof certs>, allow = [OWNER]) => createCfAccess({ team: TEAM, aud: AUD, allow, fetch: c.fetch });

describe("cf-access", () => {
	test("a valid token gives the lower-cased e-mail and the keys come from the team's certs endpoint", async () => {
		const c = certs([a]);
		const cf = make(c);
		expect(await cf.verify(await sign(a, claims({ email: "Owner@Example.com" })))).toBe(OWNER);
		expect(c.state.urls).toEqual([`${ISS}/cdn-cgi/access/certs`]);
	});
	test("aud may be a plain string", async () => {
		expect(await make(certs([a])).verify(await sign(a, claims({ aud: AUD })))).toBe(OWNER);
	});
	test("rejects a wrong aud, an expired token, a wrong issuer, an unknown e-mail, a token not yet valid and a missing e-mail", async () => {
		const cf = make(certs([a]));
		expect(await cf.verify(await sign(a, claims({ aud: ["other"] })))).toBeUndefined();
		expect(await cf.verify(await sign(a, claims({ exp: clock.now / 1000 - 1 })))).toBeUndefined();
		expect(await cf.verify(await sign(a, claims({ iss: "https://evil.cloudflareaccess.com" })))).toBeUndefined();
		expect(await cf.verify(await sign(a, claims({ email: "stranger@example.com" })))).toBeUndefined();
		expect(await cf.verify(await sign(a, claims({ nbf: clock.now / 1000 + 3600 })))).toBeUndefined();
		const { email: _drop, ...noEmail } = claims();
		expect(await cf.verify(await sign(a, noEmail))).toBeUndefined();
	});
	test("rejects a bad signature, a signature by another key under a known kid, alg none and garbage", async () => {
		const cf = make(certs([a]));
		const good = await sign(a, claims());
		const [h, p, s] = good.split(".");
		expect(await cf.verify(`${h}.${enc(claims({ email: "x@example.com" }))}.${s}`)).toBeUndefined();
		expect(await cf.verify(await sign(b, claims(), { kid: "kid-a" }))).toBeUndefined();
		expect(await cf.verify(`${enc({ alg: "none", kid: "kid-a" })}.${p}.`)).toBeUndefined();
		expect(await cf.verify(`${enc({ alg: "HS256", kid: "kid-a" })}.${p}.${s}`)).toBeUndefined();
		expect(await cf.verify("not-a-jwt")).toBeUndefined();
		expect(await cf.verify("a.b.c")).toBeUndefined();
	});
	test("the e-mail header alone is never trusted", async () => {
		const c = certs([a]);
		const cf = make(c);
		const req = new Request("http://127.0.0.1/", { headers: { "cf-access-authenticated-user-email": OWNER } });
		expect(await cf.verifyRequest(req)).toBe(false);
		expect(c.state.calls).toBe(0);
		const withJwt = new Request("http://127.0.0.1/", { headers: { "cf-access-jwt-assertion": await sign(a, claims()), "cf-access-authenticated-user-email": "stranger@example.com" } });
		expect(await cf.verifyRequest(withJwt)).toBe(true);
	});
	test("an unknown kid refetches once, and not again within a minute", async () => {
		const c = certs([a]);
		const cf = make(c);
		expect(await cf.verify(await sign(a, claims()))).toBe(OWNER);
		expect(c.state.calls).toBe(1);
		c.state.keys = [b];
		expect(await cf.verify(await sign(b, claims()))).toBeUndefined();
		expect(c.state.calls).toBe(1);
		clock.now += 61_000;
		expect(await cf.verify(await sign(b, claims({ exp: clock.now / 1000 + 600 })))).toBe(OWNER);
		expect(c.state.calls).toBe(2);
	});
	test("a cached key set and a verified token need no further requests; keys are reloaded after an hour", async () => {
		const c = certs([a]);
		const cf = make(c);
		const t1 = await sign(a, claims());
		expect(await cf.verify(t1)).toBe(OWNER);
		expect(await cf.verify(t1)).toBe(OWNER);
		expect(await cf.verify(await sign(a, claims({ email: OWNER })))).toBe(OWNER);
		expect(c.state.calls).toBe(1);
		clock.now += 3_600_001;
		expect(await cf.verify(await sign(a, claims({ exp: clock.now / 1000 + 600 })))).toBe(OWNER);
		expect(c.state.calls).toBe(2);
	});
	test("a cached token stops working at its exp", async () => {
		const cf = make(certs([a]));
		const t = await sign(a, claims({ exp: clock.now / 1000 + 100 }));
		expect(await cf.verify(t)).toBe(OWNER);
		clock.now += 101_000;
		expect(await cf.verify(t)).toBeUndefined();
	});
	test("an unreachable certs endpoint denies instead of throwing", async () => {
		const c = certs([a]);
		c.state.fail = true;
		expect(await make(c).verify(await sign(a, claims()))).toBeUndefined();
	});
});
