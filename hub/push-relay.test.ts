// One app for every computer: a peer's notice reaches this computer's app subscription (labeled with the computer, the tap switches to it),
// this computer's browser subscriptions stay quiet once a peer's app took the notice, and only a discovered peer may relay.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { notify, pushRoute, relayedMessage, setRelayPeers } from "./push.ts";
import { b64u } from "./webpush.ts";

const SELF = { name: "맥북", url: "https://mac.ts.net:8443", self: true };
const MINI = { name: "맥미니", url: "https://mini.ts.net:8445", self: false };

// the user agent's half of RFC 8291 (as hub/webpush.test.ts), to read what a subscription was sent
function decrypt(msg: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Record<string, unknown> {
	const salt = msg.subarray(0, 16), idlen = msg[20]!, asPublic = msg.subarray(21, 21 + idlen), ct = msg.subarray(21 + idlen);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(uaPrivate);
	const h = (k: Uint8Array, d: Uint8Array) => createHmac("sha256", k).update(d).digest();
	const ikm = h(h(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
	const prk = h(salt, ikm);
	const d = createDecipheriv("aes-128-gcm", h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
	d.setAuthTag(ct.subarray(-16));
	const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
	return JSON.parse(pt.subarray(0, -1).toString());
}

let n = 0;
const made: string[] = [];
async function subscribe(host: string, app: boolean) {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const auth = Buffer.alloc(16, ++n);
	const endpoint = `https://${host}/${n}`;
	const url = new URL("http://x/api/push/subscribe");
	await pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } }, ...(app ? { app: true } : {}) }) }), url);
	made.push(endpoint);
	return { endpoint, read: (body: Uint8Array) => decrypt(Buffer.from(body), ua.getPrivateKey(), ua.getPublicKey(), auth) };
}
const relay = (body: unknown) => {
	const url = new URL("http://x/api/push/relay");
	return pushRoute(new Request(url, { method: "POST", body: JSON.stringify(body) }), url)!;
};

type Call = { url: string; body?: Uint8Array | string };
let calls: Call[];
let relayAnswer: Response | Error;
const real = globalThis.fetch;
beforeEach(() => {
	calls = [];
	relayAnswer = Response.json({ ok: true, accepted: true });
	setRelayPeers(async () => [SELF, MINI]);
	globalThis.fetch = (async (input: unknown, init?: { body?: Uint8Array | string }) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push({ url, body: init?.body });
		if (url.endsWith("/api/push/relay")) {
			if (relayAnswer instanceof Error) throw relayAnswer;
			return relayAnswer.clone();
		}
		return new Response(null, { status: 201 });
	}) as unknown as typeof fetch;
});
afterEach(async () => {
	globalThis.fetch = real;
	const url = new URL("http://x/api/push/unsubscribe");
	for (const endpoint of made.splice(0)) await pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ endpoint }) }), url);
	setRelayPeers(async () => []);
});
const pushedTo = (endpoint: string) => calls.filter(c => c.url === endpoint);

const lanePush = (body: string) => ({ kind: "lane" as const, title: "custom-ui · 완료", body, url: "/#chat/lane:custom-ui", tag: "lane:custom-ui", ts: "2026-10-22T01:02:03.004Z" });

test("a peer's notice reaches the app subscription only, named with the computer, and the tap target is that computer", async () => {
	const app = await subscribe("app.push.example", true);
	const browser = await subscribe("browser.push.example", false);
	const r = await relay({ from: MINI.url, ...lanePush("relay-1") });
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ ok: true, accepted: true });
	expect(pushedTo(browser.endpoint)).toHaveLength(0);
	expect(pushedTo(app.endpoint)).toHaveLength(1);
});

test("the relayed message names the computer, tags per computer, opens the app with ?pc= and the item, and has no option buttons", () => {
	const m = relayedMessage(MINI, { ...lanePush("b"), id: "n-7", actions: [{ action: "opt:1", title: "1) x" }] })!;
	expect(m).toMatchObject({ kind: "lane", title: "맥미니 · custom-ui · 완료", body: "b", pc: MINI.url, id: "n-7", tag: "mini.ts.net:8445:lane:custom-ui" });
	expect(m.url).toBe("/?pc=https%3A%2F%2Fmini.ts.net%3A8445&n=n-7#chat/lane:custom-ui");
	expect(m.actions).toBeUndefined();
	const msg = relayedMessage(MINI, lanePush("b"))!;
	expect(msg.url).toBe("/?pc=https%3A%2F%2Fmini.ts.net%3A8445&m=2026-10-22T01%3A02%3A03.004Z#chat/lane:custom-ui");
	// the sender cannot steer the tap elsewhere: only its hash is taken from url, and a bad one is dropped
	expect(relayedMessage(MINI, { ...lanePush("b"), url: "https://evil.example/x#chat/main" })!.url).toStartWith("/?pc=");
	expect(relayedMessage(MINI, { ...lanePush("b"), url: "/#<script>" })!.url).not.toContain("<");
});

test("what the app subscription receives is that payload", async () => {
	const app = await subscribe("app2.push.example", true);
	await relay({ from: MINI.url, ...lanePush("relay-payload") });
	const sent = pushedTo(app.endpoint)[0]!;
	expect(sent).toBeDefined();
	expect(app.read(sent.body as Uint8Array)).toMatchObject({ title: "맥미니 · custom-ui · 완료", body: "relay-payload", pc: MINI.url, url: expect.stringContaining("pc=https%3A%2F%2Fmini.ts.net%3A8445") });
});

test("only a discovered peer may relay: an unknown computer, this computer itself and a body without a sender get 403 and send nothing", async () => {
	const app = await subscribe("app3.push.example", true);
	for (const from of ["https://evil.ts.net:8445", SELF.url, "", undefined]) {
		const r = await relay({ from, ...lanePush("relay-deny") });
		expect(r.status).toBe(403);
	}
	expect(pushedTo(app.endpoint)).toHaveLength(0);
});

test("a relay without kind, title or body is refused", async () => {
	expect((await relay({ from: MINI.url, kind: "nope", title: "t", body: "b" })).status).toBe(400);
	expect((await relay({ from: MINI.url, kind: "lane", body: "b" })).status).toBe(400);
});

test("a relay is not accepted when no app subscription wants that kind", async () => {
	const app = await subscribe("app4.push.example", true);
	const url = new URL("http://x/api/push/prefs");
	await pushRoute(new Request(url, { method: "PUT", body: JSON.stringify({ endpoint: app.endpoint, prefs: { lane: false } }) }), url);
	const r = await relay({ from: MINI.url, ...lanePush("relay-off") });
	expect(await r.json()).toEqual({ ok: true, accepted: false });
	expect(pushedTo(app.endpoint)).toHaveLength(0);
	await pushRoute(new Request(url, { method: "PUT", body: JSON.stringify({ endpoint: app.endpoint, prefs: { lane: true } }) }), url);
});

test("a local notice is relayed to the discovered peers from this computer's own url, and the browser subscription stays quiet when a peer's app took it", async () => {
	const app = await subscribe("app5.push.example", true);
	const browser = await subscribe("browser5.push.example", false);
	await notify({ kind: "lane", title: "x · 완료", body: "dedupe-yes", url: "/#chat/lane:x", tag: "lane:x" });
	const rel = calls.filter(c => c.url.endsWith("/api/push/relay"));
	expect(rel.map(c => c.url)).toEqual([`${MINI.url}/api/push/relay`]);   // never to itself or to an address that is not a discovered peer
	expect(JSON.parse(rel[0]!.body as string)).toMatchObject({ from: SELF.url, kind: "lane", title: "x · 완료", body: "dedupe-yes", url: "/#chat/lane:x" });
	expect(pushedTo(app.endpoint)).toHaveLength(1);   // this computer's own app still gets it at once
	expect(pushedTo(browser.endpoint)).toHaveLength(0);
});

test("the browser subscription fires as before when the peer cannot take the notice (down, older, no app, kind off)", async () => {
	for (const [i, answer] of [new Error("down"), new Response("nope", { status: 404 }), Response.json({ ok: true, accepted: false })].entries()) {
		relayAnswer = answer;
		const browser = await subscribe(`browser6-${i}.push.example`, false);
		await notify({ kind: "lane", title: "x · 완료", body: `dedupe-no-${i}`, url: "/#chat/lane:x", tag: "lane:x" });
		expect(pushedTo(browser.endpoint)).toHaveLength(1);
	}
});

test("a notice relayed in is delivered here only: it is never relayed on, and no peer is called", async () => {
	await subscribe("app7.push.example", true);
	await relay({ from: MINI.url, ...lanePush("no-loop") });
	expect(calls.filter(c => c.url.endsWith("/api/push/relay"))).toHaveLength(0);
});

test("a test notification and a lone computer keep the old behavior", async () => {
	const browser = await subscribe("browser8.push.example", false);
	setRelayPeers(async () => [SELF]);
	await notify({ kind: "lane", title: "x", body: "alone", url: "/", tag: "alone" });
	expect(pushedTo(browser.endpoint)).toHaveLength(1);
	setRelayPeers(async () => [SELF, MINI]);
	await notify({ kind: "test", title: "t", body: "test-kind", url: "/", tag: "test" });
	expect(pushedTo(browser.endpoint)).toHaveLength(2);
	expect(calls.filter(c => c.url.endsWith("/api/push/relay"))).toHaveLength(0);
});
