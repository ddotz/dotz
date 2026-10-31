// One notice, each device once: three gateways (alpha, beta, gamma; each its own push.ts instance with its own subscriptions) and two devices.
// The phone has the installed app on one gateway (and, before the app existed, a browser subscription on another: the app removes it); the laptop has a browser only.
// A device's per-gateway switch (PUT /api/push/gateways) lives on the sending gateway and decides whether that gateway's notices reach the device.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
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
// The instances read the shared data dir when they load: subscriptions another test file left there would be pushed to as well.
for (const f of ["push.json", "push-devices.json"]) rmSync(join(process.env.DOTZ_DIR!, f), { force: true });
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
// A presence POST is forwarded to the other gateways in the background; a test awaits the n forwards it expects instead of sleeping.
let presenceLeft = 0;
let presenceDone: () => void = () => {};
const forwards = (n: number) => new Promise<void>(resolve => {
	presenceLeft = n;
	presenceDone = resolve;
});
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
		if (url.pathname.startsWith("/api/push/") && url.pathname !== "/api/push/presence" && ids.some(i => new URL(GW[i].url).host === url.host)) {
			const to = idOfHost(url.host);
			if (down.has(to)) throw new Error("unreachable");
			return (await inst[to].pushRoute(new Request(url, { method: init?.method ?? "GET", ...(init?.body ? { body: init.body as string } : {}) }), url))!;
		}
		if (url.pathname === "/api/push/presence") {
			const res = (await inst[idOfHost(url.host)].pushRoute(new Request(url, { method: "POST", body: init!.body as string }), url))!;
			if (--presenceLeft === 0) presenceDone();
			return res;
		}
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
	const res = (await inst[gw].pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } }, ...(did ? { did } : {}), ...(app ? { app: true } : {}), ...(prefs ? { prefs } : {}) }) }), url))!;
	made.push([gw, endpoint]);
	return { endpoint, status: res.status, got: () => pushes.filter(p => p.endpoint === endpoint).map(p => decrypt(Buffer.from(p.body), ua.getPrivateKey(), ua.getPublicKey(), auth)) };
}
afterEach(async () => {
	down.clear();
	const url = new URL("http://x/api/push/unsubscribe");
	for (const [gw, endpoint] of made.splice(0)) await inst[gw].pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ endpoint }) }), url);
	for (const id of ids) {
		const dev = new URL("http://x/api/push/device");
		const from = GW[id === "alpha" ? "beta" : "alpha"].url;
		for (const did of [PHONE, LAPTOP]) await inst[id].pushRoute(new Request(dev, { method: "POST", body: JSON.stringify({ from, did, on: true, app: false }) }), dev);
	}
	globalThis.fetch = real;
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

test("the app's gateway being unreachable: the phone stays quiet (its browser is no second channel), the laptop is unaffected", async () => {
	const d = await devices();
	expect(d.phoneBrowser.status).toBe(409);   // refused: the phone has the app
	down.add("alpha");
	await send("gamma");
	expect(d.phoneApp.got()).toHaveLength(0);
	expect(d.phoneBrowser.got()).toHaveLength(0);
	expect(d.laptop.got()).toHaveLength(1);
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

test("a device that switched the kind off in its app is not woken by a browser either", async () => {
	const app = await sub("alpha", PHONE, true, { lane: false }), browser = await sub("beta", PHONE, false);
	expect(browser.status).toBe(409);
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
	// the device id plus the endpoint key (what lets a gateway holding the same endpoint without an id stay quiet)
	const served = ((await ok.json()) as { served: string[] }).served;
	expect(served).toHaveLength(2);
	expect(served).toContain(PHONE);
	expect(served.filter(k => /^ep:[0-9a-f]{24}$/.test(k))).toHaveLength(1);
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
	const app = await sub("alpha", PHONE, true), browser = await sub("gamma", LAPTOP, false), laptop = await sub("beta", LAPTOP, false);
	const url = new URL("http://x/api/push/presence");
	const page = (active: boolean) => inst.gamma.pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ did: PHONE, active }) }), url);
	let landed = forwards(2);
	await page(true);
	await landed;
	await send("beta");
	expect([app.got().length, laptop.got().length]).toEqual([0, 1]);
	landed = forwards(2);
	await page(false);
	await landed;
	await send("beta");
	expect(app.got().length).toBe(1);
	expect(browser.got().length).toBe(0);   // the laptop's gamma browser: the laptop's other subscription (beta) took it
	expect(relays.length).toBeGreaterThan(0);
});

// ---- per-gateway switches: one device (the phone, app on alpha), the notices of beta switched off and on ----
const gwCall = (at: Id, method: "GET" | "PUT", body?: object) => {
	const url = new URL(`http://x/api/push/gateways${method === "GET" ? `?did=${PHONE}` : ""}`);
	return inst[at].pushRoute(new Request(url, { method, ...(body ? { body: JSON.stringify({ did: PHONE, ...body }) } : {}) }), url)!;
};
const view = async (at: Id) => (await (await gwCall(at, "GET")).json()) as { app: boolean; gateways: Array<{ name: string; url: string; self: boolean; on: boolean; online: boolean }> };

test("the app's tells every gateway: a browser subscription the phone left on beta is removed, a new one is refused, and beta's notices reach the phone once, through the app", async () => {
	const early = await sub("beta", PHONE, false);   // made before the app existed
	expect(early.status).toBe(200);
	const app = await sub("alpha", PHONE, true);
	const late = await sub("beta", PHONE, false);
	expect(late.status).toBe(409);
	await send("beta");
	expect([app.got().length, early.got().length, late.got().length]).toEqual([1, 0, 0]);
	expect((await view("beta")).app).toBe(true);   // beta learned it from the claim
	// the app ends: beta no longer treats the phone as an app device
	const url = new URL("http://x/api/push/unsubscribe");
	await inst.alpha.pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ endpoint: app.endpoint }) }), url);
	expect((await view("beta")).app).toBe(false);
});

test("beta off stops beta's notices on the phone (and no browser fires), beta on delivers exactly once through the app; the other gateways are untouched", async () => {
	const app = await sub("alpha", PHONE, true), laptop = await sub("beta", LAPTOP, false);
	await send("beta");
	expect(app.got()).toHaveLength(1);
	pushes.length = 0;
	// from the app's own gateway (the page on alpha)
	expect((await gwCall("alpha", "PUT", { url: GW.beta.url, on: false })).status).toBe(200);
	expect((await view("alpha")).gateways.map(g => [g.name, g.on])).toEqual([["알파", true], ["베타", false], ["감마", true]]);
	await send("beta");
	expect(app.got()).toHaveLength(0);
	expect(laptop.got()).toHaveLength(1);   // another device is not affected
	await send("gamma");
	expect(app.got()).toHaveLength(1);       // gamma's notices still arrive
	pushes.length = 0;
	expect((await gwCall("alpha", "PUT", { url: GW.beta.url, on: true })).status).toBe(200);
	await send("beta");
	expect(app.got()).toHaveLength(1);
	expect(pushes.filter(p => p.endpoint === app.endpoint)).toHaveLength(1);
});

test("the page on a peer origin (beta, inside the same device id) shows and edits the same list: alpha off from beta stops alpha's notices", async () => {
	const app = await sub("alpha", PHONE, true);
	const onBeta = await view("beta");
	expect(onBeta.app).toBe(true);
	expect(onBeta.gateways.map(g => [g.name, g.self, g.on])).toEqual([["알파", false, true], ["베타", true, true], ["감마", false, true]]);
	expect((await gwCall("beta", "PUT", { url: GW.alpha.url, on: false })).status).toBe(200);
	expect((await view("alpha")).gateways.find(g => g.self)!.on).toBe(false);   // the same record, read where it is kept
	await send("alpha");
	expect(app.got()).toHaveLength(0);
	await send("beta");
	expect(app.got()).toHaveLength(1);
	await gwCall("gamma", "PUT", { url: GW.alpha.url, on: true });
	await send("alpha");
	expect(app.got()).toHaveLength(2);
});

test("a gateway that does not answer shows as offline and cannot be switched; an unknown address is refused", async () => {
	await sub("alpha", PHONE, true);
	down.add("beta");
	expect((await view("alpha")).gateways.find(g => g.url === GW.beta.url)).toMatchObject({ online: false });
	expect((await gwCall("alpha", "PUT", { url: GW.beta.url, on: false })).status).toBe(502);
	down.clear();
	expect((await gwCall("alpha", "PUT", { url: "https://evil.ts.net:8445", on: false })).status).toBe(404);
	expect((await gwCall("alpha", "PUT", { url: GW.beta.url })).status).toBe(400);
});

test("only a discovered peer may read or set a device's record on a gateway", async () => {
	const dev = (method: string, qs: string, body?: object) => {
		const url = new URL(`http://x/api/push/device${qs}`);
		return inst.alpha.pushRoute(new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), url)!;
	};
	expect((await dev("GET", `?did=${PHONE}&from=https://evil.ts.net:8445`)).status).toBe(403);
	expect((await dev("POST", "", { from: GW.alpha.url, did: PHONE, on: false })).status).toBe(403);
	expect((await dev("POST", "", { did: PHONE, on: false })).status).toBe(403);
	expect((await view("alpha")).gateways.find(g => g.self)!.on).toBe(true);
	expect(await (await dev("GET", `?did=${PHONE}&from=${GW.beta.url}`)).json()).toEqual({ on: true, app: false });
});

// Owner 2026-10-28: a notification about something already handled ("확인이 필요" for a finished item) must go away on every device.
test("a handled notice is taken back on every device it reached: now on a regular endpoint, relayed copies on the other computer too", async () => {
	const { phoneApp, laptop } = await devices();
	const m = notice("ask");
	await send("alpha", m);
	expect(phoneApp.got().map(x => x.tag)).toEqual([m.tag]);
	expect(laptop.got().map(x => x.tag)).toEqual([`alpha.ts.net:8443:${m.tag}`]);
	await inst.alpha.withdraw([m.tag]);
	expect(phoneApp.got().at(-1)).toMatchObject({ kind: "withdraw", withdraw: [m.tag] });
	expect(laptop.got().at(-1)).toMatchObject({ kind: "withdraw", withdraw: [`alpha.ts.net:8443:${m.tag}`] });
	// a tag no device was shown is a no-op
	const before = pushes.length;
	await inst.alpha.withdraw(["decision:never-shown"]);
	expect(pushes.length).toBe(before);
});

test("an Apple endpoint is never sent a bare withdraw (Safari revokes silent pushes): the tag rides on its next notification", async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const auth = Buffer.alloc(16, ++n);
	const endpoint = `https://web.push.apple.com/apple-${n}`;
	const url = new URL("http://x/api/push/subscribe");
	await inst.alpha.pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } }, did: "iphone-device-01", app: true }) }), url);
	made.push(["alpha", endpoint]);
	const got = () => pushes.filter(p => p.endpoint === endpoint).map(p => decrypt(Buffer.from(p.body), ua.getPrivateKey(), ua.getPublicKey(), auth));
	expect(inst.alpha.isAppleEndpoint(endpoint)).toBe(true);
	const first = notice("ask");
	await send("alpha", first);
	await inst.alpha.withdraw([first.tag]);
	expect(got().map(x => x.kind)).toEqual(["ask"]);
	const next = notice("ask");
	await send("alpha", next);
	expect(got().at(-1)).toMatchObject({ tag: next.tag, withdraw: [first.tag] });
});

test("what makes a notification stale: a decision answered or dismissed, a conversation read", () => {
	const { staleTags } = inst.alpha;
	expect(staleTags({ kind: "notice_dismiss", id: 7 })).toEqual(["decision:7"]);
	expect(staleTags({ kind: "read", target: "main" })).toEqual(["answer", "ask:main"]);
	expect(staleTags({ kind: "read", target: "lane:x" })).toEqual(["ask:x", "lane:x", "start:x"]);
	expect(staleTags({ kind: "read", target: "ch:5" })).toEqual(["answer:ch:5", "ask:ch:5"]);
	expect(staleTags({ kind: "notice", item: { id: 3, decision: { state: "open", options: [], to: "web" } } })).toEqual([]);
	expect(staleTags({ kind: "notice", item: { id: 3, decision: { state: "answered", options: [], to: "web" } } })).toEqual(["decision:3"]);
});
