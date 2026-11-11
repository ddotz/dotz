// Web Push encryption against the RFC 8291 Appendix A vector, plus a VAPID JWT that verifies with its public key.
import { expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { b64u, encryptPayload, generateVapidKeys, sendPush, unb64u, vapidAuth } from "./webpush.ts";

const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	result:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("aes128gcm matches the RFC 8291 example byte for byte", () => {
	const out = encryptPayload(Buffer.from(RFC.plaintext), RFC.uaPublic, RFC.auth, { asPrivate: unb64u(RFC.asPrivate), salt: unb64u(RFC.salt) });
	expect(b64u(out)).toBe(RFC.result);
	expect(out.length).toBe(86 + RFC.plaintext.length + 1 + 16); // header + plaintext + delimiter + tag (the RFC's Content-Length: 145 is one too many)
});

// A receiver-side decrypt (the user agent's half of RFC 8291 3.4) round-trips a random-key, random-salt message.
function decrypt(msg: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
	const salt = msg.subarray(0, 16);
	const idlen = msg[20]!;
	const asPublic = msg.subarray(21, 21 + idlen);
	const ct = msg.subarray(21 + idlen);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(uaPrivate);
	const h = (k: Uint8Array, d: Uint8Array) => createHmac("sha256", k).update(d).digest();
	const ikm = h(h(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
	const prk = h(salt, ikm);
	const d = createDecipheriv("aes-128-gcm", h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
	d.setAuthTag(ct.subarray(-16));
	const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
	expect(pt.at(-1)).toBe(2);
	return pt.subarray(0, -1).toString();
}

test("a random-key message decrypts on the receiver side", () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const auth = Buffer.alloc(16, 7);
	const msg = encryptPayload(Buffer.from('{"title":"dotz"}'), b64u(ua.getPublicKey()), b64u(auth));
	expect(decrypt(msg, ua.getPrivateKey(), ua.getPublicKey(), auth)).toBe('{"title":"dotz"}');
});

test("bad subscription keys are rejected", () => {
	expect(() => encryptPayload(Buffer.from("x"), b64u(Buffer.alloc(65, 4)), RFC.auth)).toThrow();
	expect(() => encryptPayload(Buffer.from("x"), RFC.uaPublic, b64u(Buffer.alloc(8)))).toThrow();
});

test("VAPID header carries an ES256 JWT for the endpoint origin that verifies with k", () => {
	const keys = generateVapidKeys();
	const h = vapidAuth("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:dotz@localhost", 1_000_000);
	const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
	expect(m[4]).toBe(keys.publicKey);
	const claims = JSON.parse(unb64u(m[2]!).toString());
	expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_000_000 + 12 * 3600, sub: "mailto:dotz@localhost" });
	const pub = unb64u(keys.publicKey);
	const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
	expect(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, unb64u(m[3]!))).toBe(true);
});

test("sendPush posts an aes128gcm body with the push headers and returns the status", async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	let seen: { url: string; init: RequestInit } | undefined;
	const status = await sendPush({ endpoint: "https://push.example.net/p/1", keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 1)) } }, { title: "t" }, generateVapidKeys(), "mailto:a@b", {
		fetchFn: (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response(null, { status: 410 }))) as unknown as typeof fetch,
	});
	expect(status).toBe(410);
	const headers = seen!.init.headers as Record<string, string>;
	expect(headers["Content-Encoding"]).toBe("aes128gcm");
	expect(headers.Authorization).toStartWith("vapid t=");
	expect(headers.TTL).toBe("3600");
});
