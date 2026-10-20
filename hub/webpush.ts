// Web Push without dependencies: VAPID (RFC 8292) ES256 JWT and aes128gcm payload encryption (RFC 8291 / RFC 8188).
// Pure functions over node:crypto; hub/push.ts owns keys, subscriptions and sending.
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";

export const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
export const unb64u = (s: string) => Buffer.from(s, "base64url");

export type VapidKeys = { publicKey: string; privateKey: string }; // base64url: 65-byte uncompressed point, 32-byte scalar

export function generateVapidKeys(): VapidKeys {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject(keys: VapidKeys) {
	const pub = unb64u(keys.publicKey);
	return createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey }, format: "jwk" });
}

// The Authorization header value for one push service origin (aud), valid for `ttlSec` (max 24h per RFC 8292).
export function vapidAuth(endpoint: string, keys: VapidKeys, subject: string, nowSec = Math.floor(Date.now() / 1000), ttlSec = 12 * 3600): string {
	const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const body = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + ttlSec, sub: subject })));
	const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKeyObject(keys), dsaEncoding: "ieee-p1363" });
	return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

// One aes128gcm record (RFC 8291 section 4). `asPrivate` and `salt` are injectable for the RFC test vector only.
export function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, opts: { asPrivate?: Buffer; salt?: Buffer } = {}): Buffer {
	const uaPublic = unb64u(p256dh);
	const authSecret = unb64u(auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh must be a 65-byte uncompressed P-256 point");
	if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");
	const ecdh = createECDH("prime256v1");
	if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const ecdhSecret = ecdh.computeSecret(uaPublic); // throws on a point not on the curve
	const salt = opts.salt ?? randomBytes(16);
	const prkKey = hmac(authSecret, ecdhSecret);
	const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const rs = Buffer.alloc(4);
	rs.writeUInt32BE(4096);
	return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

// POSTs one message. Returns the push service status: 201 sent, 404/410 the subscription is gone.
export async function sendPush(sub: Subscription, payload: unknown, keys: VapidKeys, subject: string, opts: { ttl?: number; urgency?: "normal" | "high"; fetchFn?: typeof fetch } = {}): Promise<number> {
	const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
	const res = await (opts.fetchFn ?? fetch)(sub.endpoint, {
		method: "POST",
		headers: { Authorization: vapidAuth(sub.endpoint, keys, subject), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(opts.ttl ?? 3600), Urgency: opts.urgency ?? "high" },
		body,
	});
	await res.arrayBuffer().catch(() => {});
	return res.status;
}
