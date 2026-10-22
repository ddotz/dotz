// One phone endpoint held by two gateways: the origin gateway has it as the installed app's subscription (with a device id), the other holds the same
// endpoint from before device ids existed (no id, no app flag). Whichever gateway makes the notice, the phone hears it once.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { b64u } from "./webpush.ts";

type Push = typeof import("./push.ts");
const GW = {
	alpha: { name: "알파", url: "https://alpha.ts.net:8443" },
	beta: { name: "베타", url: "https://beta.ts.net:8445" },
} as const;
type Id = keyof typeof GW;
const ids = Object.keys(GW) as Id[];
const inst = {} as Record<Id, Push>;
for (const id of ids) inst[id] = (await import(`./push.ts?dedupe=${id}`)) as Push;

const PHONE = "phone-device-0001";
const ENDPOINT = "https://push.example/phone-endpoint";
let pushes: string[];
const real = globalThis.fetch;
const idOfHost = (host: string) => ids.find(i => new URL(GW[i].url).host === host)!;
beforeEach(() => {
	pushes = [];
	for (const id of ids) inst[id].setRelayPeers(async () => ids.map(i => ({ ...GW[i], self: i === id })));
	globalThis.fetch = (async (input: unknown, init?: { body?: string; method?: string }) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.pathname.startsWith("/api/push/") && ids.some(i => new URL(GW[i].url).host === url.host)) {
			return (await inst[idOfHost(url.host)].pushRoute(new Request(url, { method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) }), url))!;
		}
		pushes.push(String(input));
		return new Response(null, { status: 201 });
	}) as unknown as typeof fetch;
});

const ua = createECDH("prime256v1");
ua.generateKeys();
const subscription = { endpoint: ENDPOINT, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 7)) } };
const ENDPOINT2 = "https://push.example/phone-endpoint-rotated";
async function subscribe(gw: Id, extra: object, endpoint = ENDPOINT) {
	const url = new URL("http://x/api/push/subscribe");
	await inst[gw].pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ subscription: { ...subscription, endpoint }, ...extra }) }), url);
}
afterEach(async () => {
	const url = new URL("http://x/api/push/unsubscribe");
	for (const id of ids) for (const endpoint of [ENDPOINT, ENDPOINT2]) await inst[id].pushRoute(new Request(url, { method: "POST", body: JSON.stringify({ endpoint }) }), url);
	globalThis.fetch = real;
});

let seq = 0;
const notice = () => ({ kind: "lane" as const, title: "dotz · 완료", body: `notice-${++seq}`, url: "/#chat/main", tag: `lane:dotz-${seq}` });
const phone = () => pushes.filter(p => p === ENDPOINT).length;

test("a notice made by the app's gateway reaches the phone once, though another gateway holds the same endpoint without a device id", async () => {
	await subscribe("beta", {});
	await subscribe("alpha", { did: PHONE, app: true });
	await inst.alpha.notify(notice());
	expect(phone()).toBe(1);
});

test("a notice made by the gateway with the id-less copy reaches the phone once too", async () => {
	await subscribe("beta", {});
	await subscribe("alpha", { did: PHONE, app: true });
	await inst.beta.notify(notice());
	expect(phone()).toBe(1);
});

test("an id-less copy that appears after the app's gateway told its peers (nothing adopts it) is still skipped for the app gateway's notice, and the other way round", async () => {
	await subscribe("alpha", { did: PHONE, app: true });
	await subscribe("beta", {});
	await inst.alpha.notify(notice());
	expect(phone()).toBe(1);
	pushes.length = 0;
	await inst.beta.notify(notice());
	expect(phone()).toBe(1);
});

test("when the app subscribes, a gateway holding the same endpoint without an id adopts it as the app's", async () => {
	await subscribe("beta", {});
	await subscribe("alpha", { did: PHONE, app: true });
	const url = new URL("http://x/api/push/gateways?did=" + PHONE);
	expect(await (await inst.beta.pushRoute(new Request(url), url))!.json()).toMatchObject({ app: true });
	const get = new URL(`http://x/api/push?endpoint=${encodeURIComponent(ENDPOINT)}`);
	expect(await (await inst.beta.pushRoute(new Request(get), get))!.json()).toMatchObject({ app: true, did: PHONE });
});

test("one gateway holding two subscriptions of one device (the endpoint rotated, the old one not yet reported gone) sends once", async () => {
	await subscribe("alpha", { did: PHONE, app: true }, ENDPOINT);
	await subscribe("alpha", { did: PHONE, app: true }, ENDPOINT2);
	await inst.alpha.notify(notice());
	expect(pushes.filter(p => p === ENDPOINT || p === ENDPOINT2)).toHaveLength(1);
});

test("the same notice emitted twice by the hub (same tag and body) reaches the phone once, from either gateway", async () => {
	await subscribe("beta", {});
	await subscribe("alpha", { did: PHONE, app: true });
	const n = notice();
	await inst.alpha.notify(n);
	await inst.alpha.notify({ ...n });
	expect(phone()).toBe(1);
	const m = notice();
	await inst.beta.notify(m);
	await inst.beta.notify({ ...m });
	expect(phone()).toBe(2);
});
