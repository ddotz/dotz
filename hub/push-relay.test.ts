// One notice, each device once: three gateways (alpha, beta, gamma; each its own push.ts instance with its own subscriptions) and two devices.
// The phone has the installed app on one gateway and a browser subscription on another (same device id); the laptop has a browser only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { b64u } from "./webpush.ts";

type Push = typeof import("./push.ts");
const GW = {
	alpha: { name: "알파", url: "https://alpha.ts.net:8443" },
	beta: { name: "베타", url: "https://beta.ts.net:8445" },
	gamma: { name: "감마", url: "https://gamma.ts.net:8444" },
} as const;
type Id = keyof typeof GW;
const ids = Object.keys(GW) as Id[];
const inst = {} as Record<Id, Push>;
for (const id of ids) inst[id] = (await import(`./push.ts?gw=${id}`)) as Push;

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

// who may be reached, and what each gateway has been asked to relay
let down: Set<Id>;
let relays: Array<{ to: Id; from: string; via: string }>;
let pushes: Array<{ endpoint: string; body: Uint8Array }>;
const real = globalThis.fetch;
const idOfHost = (host: string) => ids.find(i => new URL(GW[i].url).host === host)!;
beforeEach(() => {
	down = new Set();
	relays = [];
	pushes = [];
	for (const id of ids) inst[id].setRelayPeers(async () => ids.map(i => ({ ...GW[i], self: i === id })));
	globalThis.fetch = (async (input: unknown, init?: { body?: Uint8Array | string; method?: string }) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.pathname === "/api/push/relay") {
			const to = idOfHost(url.host);
			if (down.has(to)) throw new Error("unreachable");
			const body = JSON.parse(init!.body as string);
			relays.push({ to, from: idOfHost(new URL(body.from).host), via: body.via });
			return (await inst[to].pushRoute(new Request(url, { method: "POST", body: init!.body as string }), url))!;
		}
		if (url.pathname === "/api/push/presence") return (await inst[idOfHost(url.host)].pushRoute(new Request(url, { method: "POST", body: init!.body as string }), url))!;
		pushes.push({ endpoint: String(input), body: init!.body as Uint8Array });
		return new Response(null, { status: 201 });
	}) as unknown as typeof fetch;
});

let n = 0;
const made: Array<[Id, string]> = [];
// one subscription of a device on a gateway; `read` opens what was pushed to it
async function sub(gw: Id, did: string | undefined, app: boolean, prefs?: Record<string, boolean>) {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const auth = Buffer.alloc(16, ++n);
	const endpoint = `https://push.example/${gw}/${n}`;
	const url = new URL("http://x/api/push/subscribe");
	await inst[gw].pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } }, ...(did ? { did } : {}), ...(app ? { app: true } : {}), ...(prefs ? { prefs } : {}) }) }), url);
	made.push([gw, endpoint]);
	return { endpoint, got: () => pushes.filter(p => p.endpoint === endpoint).map(p => decrypt(Buffer.from(p.body), ua.getPrivateKey(), ua.getPublicKey(), auth)) };
}
afterEach(async () => {
	globalThis.fetch = real;
	const url = new URL("http://x/api/push/unsubscribe");
	for (const [gw, endpoint] of made.splice(0)) await inst[gw].pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ endpoint }) }), url);
});

const PHONE = "phone-device-0001", LAPTOP = "laptop-device-0001";
let seq = 0;
const notice = (kind: "lane" | "ask" = "lane") => ({ kind, title: "custom-ui · 완료", body: `notice-${++seq}`, url: "/#chat/lane:custom-ui", tag: `lane:custom-ui-${seq}`, ts: "2026-10-22T01:02:03.004Z" });
const send = (gw: Id, m = notice()) => inst[gw].notify(m);
// phone: app on alpha, browser on beta; laptop: browser on gamma
async function devices() {
	return { phoneApp: await sub("alpha", PHONE, true), phoneBrowser: await sub("beta", PHONE, false), laptop: await sub("gamma", LAPTOP, false) };
}

test("a notice from any gateway reaches the phone once (through its app) and the laptop once (through its browser)", async () => {
	const d = await devices();
	for (const from of ids) {
		pushes.length = 0;
		await send(from);
		expect([from, d.phoneApp.got().length, d.phoneBrowser.got().length, d.laptop.got().length]).toEqual([from, 1, 0, 1]);
	}
});

test("a relayed notice is titled with the gateway it came from and a tap opens that gateway; a notice made where the subscription is stays plain", async () => {
	const d = await devices();
	await send("gamma");
	expect(d.phoneApp.got()[0]).toMatchObject({ title: "감마 · custom-ui · 완료", pc: GW.gamma.url, url: expect.stringContaining("pc=https%3A%2F%2Fgamma.ts.net%3A8444") });
	expect(d.laptop.got()[0]).toMatchObject({ title: "custom-ui · 완료", url: "/#chat/lane:custom-ui" });
	pushes.length = 0;
	await send("alpha");
	expect(d.phoneApp.got()[0]).toMatchObject({ title: "custom-ui · 완료" });
	expect(d.laptop.got()[0]).toMatchObject({ title: "알파 · custom-ui · 완료", pc: GW.alpha.url });
});

test("the app's gateway being unreachable: the phone's browser subscription takes the notice, once, and the laptop is unaffected", async () => {
	const d = await devices();
	down.add("alpha");
	await send("gamma");
	expect(d.phoneApp.got()).toHaveLength(0);
	expect(d.phoneBrowser.got()).toHaveLength(1);
	expect(d.phoneBrowser.got()[0]).toMatchObject({ title: "감마 · custom-ui · 완료" });
	expect(d.laptop.got()).toHaveLength(1);
	// the origin's own subscription of the phone is the fallback when the origin has one
	const own = await sub("gamma", PHONE, false);
	pushes.length = 0;
	await send("gamma");
	expect(own.got()).toHaveLength(1);
	expect(d.phoneBrowser.got()).toHaveLength(0);
});

test("an unreachable gateway is dropped from the rest of that notice, a reachable one is asked for apps first, then for everything", async () => {
	await devices();
	down.add("beta");
	await send("gamma");
	expect(relays.filter(r => r.to === "beta")).toHaveLength(0);   // a down gateway never gets as far as a recorded relay
	expect(relays.filter(r => r.to === "alpha").map(r => r.via)).toEqual(["app", "all"]);
});

test("the phone's app on two gateways is still one device: it hears each notice once, from the first gateway in a fixed order", async () => {
	const a1 = await sub("alpha", PHONE, true), a2 = await sub("beta", PHONE, true);
	await send("gamma");
	expect(a1.got()).toHaveLength(1);
	expect(a2.got()).toHaveLength(0);
	pushes.length = 0;
	down.add("alpha");
	await send("gamma");
	expect(a2.got()).toHaveLength(1);   // the first one down: the next one
});

test("two devices with the app on different gateways each get the notice once", async () => {
	const a = await sub("alpha", PHONE, true), b = await sub("beta", LAPTOP, true);
	await send("gamma");
	expect(a.got()).toHaveLength(1);
	expect(b.got()).toHaveLength(1);
});

test("a subscription without a device id is a device of its own and is never silenced by another's app", async () => {
	const app = await sub("alpha", PHONE, true), loose = await sub("beta", undefined, false);
	await send("gamma");
	expect(app.got()).toHaveLength(1);
	expect(loose.got()).toHaveLength(1);
});

test("a device that switched the kind off in its app is not woken by its browser either", async () => {
	const app = await sub("alpha", PHONE, true, { lane: false }), browser = await sub("beta", PHONE, false);
	await send("gamma");
	expect(app.got()).toHaveLength(0);
	expect(browser.got()).toHaveLength(0);
	await send("gamma", notice("ask"));
	expect(app.got()).toHaveLength(1);
});

test("no loop: only the gateway that made the notice relays, each peer at most twice, and a relay delivered by a peer is never sent on", async () => {
	await devices();
	await send("gamma");
	expect(relays.every(r => r.from === "gamma")).toBe(true);
	expect(relays.length).toBeLessThanOrEqual(4);
	expect(pushes.length).toBe(2);
});

test("only a discovered peer may relay: an unknown gateway, the gateway itself and a body without a sender get 403 and send nothing", async () => {
	const d = await devices();
	const post = (to: Id, from: unknown) => {
		const url = new URL("http://x/api/push/relay");
		return inst[to].pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ from, ...notice() }) }), url)!;
	};
	for (const from of ["https://evil.ts.net:8445", GW.alpha.url, "", undefined]) expect((await post("alpha", from)).status).toBe(403);
	expect(d.phoneApp.got()).toHaveLength(0);
	const ok = await post("alpha", GW.gamma.url);
	expect(ok.status).toBe(200);
	expect(((await ok.json()) as { served: string[] }).served).toEqual([PHONE]);
	setNoPeers();
	expect((await post("alpha", GW.gamma.url)).status).toBe(403);
});
function setNoPeers() {
	inst.alpha.setRelayPeers(async () => [{ ...GW.alpha, self: true }]);
}

test("a relay without kind, title or body is refused", async () => {
	const url = new URL("http://x/api/push/relay");
	const post = (b: object) => inst.alpha.pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ from: GW.gamma.url, ...b }) }), url)!;
	expect((await post({ kind: "nope", title: "t", body: "b" })).status).toBe(400);
	expect((await post({ kind: "lane", body: "b" })).status).toBe(400);
});

test("a lone gateway keeps the old behavior, and a test notification goes to every subscription", async () => {
	const a = await sub("alpha", PHONE, false);
	inst.alpha.setRelayPeers(async () => [{ ...GW.alpha, self: true }]);
	await send("alpha");
	expect(a.got()).toHaveLength(1);
	expect(relays).toHaveLength(0);
	const d = await devices();
	inst.alpha.setRelayPeers(async () => ids.map(i => ({ ...GW[i], self: i === "alpha" })));
	await inst.alpha.notify({ kind: "test", title: "t", body: "test-kind", url: "/", tag: "test" });
	expect(d.phoneApp.got()).toHaveLength(1);
	expect(relays).toHaveLength(0);
});

test("the relayed message names the gateway, tags per gateway, opens with ?pc= and the item, has no option buttons, and cannot be steered by the sender", () => {
	const m = inst.alpha.relayedMessage(GW.beta, { ...notice(), id: "n-7", actions: [{ action: "opt:1", title: "1) x" }] })!;
	expect(m).toMatchObject({ kind: "lane", title: "베타 · custom-ui · 완료", pc: GW.beta.url, id: "n-7" });
	expect(m.url).toBe("/?pc=https%3A%2F%2Fbeta.ts.net%3A8445&n=n-7#chat/lane:custom-ui");
	expect(m.actions).toBeUndefined();
	expect(inst.alpha.relayedMessage(GW.beta, notice())!.url).toStartWith("/?pc=https%3A%2F%2Fbeta.ts.net%3A8445&m=");
	expect(inst.alpha.relayedMessage(GW.beta, { ...notice(), url: "https://evil.example/x#chat/main" })!.url).toStartWith("/?pc=");
	expect(inst.alpha.relayedMessage(GW.beta, { ...notice(), url: "/#<script>" })!.url).not.toContain("<");
});

test("a page open on one gateway quiets its device's subscriptions on the others (it toasts their notices itself), and only that device", async () => {
	const app = await sub("alpha", PHONE, true), browser = await sub("gamma", PHONE, false), laptop = await sub("beta", LAPTOP, false);
	const url = new URL("http://x/api/push/presence");
	const page = (active: boolean) => inst.gamma.pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ endpoint: browser.endpoint, active }) }), url);
	await page(true);
	await Bun.sleep(10);
	await send("beta");
	expect([app.got().length, browser.got().length, laptop.got().length]).toEqual([0, 0, 1]);
	await page(false);
	await Bun.sleep(10);
	await send("beta");
	expect([app.got().length, browser.got().length]).toEqual([1, 0]);
	expect(relays.length).toBeGreaterThan(0);
});
