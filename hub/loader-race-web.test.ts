import { afterAll, expect, test } from "bun:test";
import { advanceSettled, fakeHub, on } from "./test-web.ts";

// A read asked for while an older read of the same path is out (sent before what changed) gets a read that starts after it, never that older answer
// (web/js/02-basic-markdown.js latest, under api()). The page's own fetch holds each /api/queue answer until the test releases it.
// The page keeps its own sub-second timers (and their reads) running during a test, so a test counts only the requests of the path it is about,
// and puts back what it swapped (fetch, relayOn) and releases what it held in a finally, so a failed test cannot leave a held read for the next.
const hub = fakeHub({ stream: "fake", slowTimers: true });
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(view);
const opened = hub.nextStream();
await view.navigate(`${hub.origin}/`);
await opened;
await waitFor(`typeof loadQueue === "function" && S && !latestOut("/api/queue")`);

test("a reload asked for during an older read waits for a read sent after it, and the older answer never wins", async () => {
	await view.evaluate(`(window.__fetch = fetch, window.__held = [], fetch = (p, o) => (String(p) === "/api/queue" ? new Promise(r => __held.push(r)) : __fetch(p, o)), 0)`);
	const answer = (id: string) => `new Response(JSON.stringify({ items: [{ id: "${id}", text: "${id}", target: "main" }] }))`;
	try {
		await view.evaluate(`(window.__first = loadQueue(), 0)`);
		await waitFor(`__held.length === 1`);
		// The queue changes on the hub; the reload asked for now must not be handed the answer of the read already out.
		await view.evaluate(`(window.__second = loadQueue(), 0)`);
		expect(await view.evaluate(`__held.length`)).toBe(1);
		await view.evaluate(`(__held[0](${answer("old")}), 0)`);
		await waitFor(`__held.length === 2`);
		await view.evaluate(`(__held[1](${answer("new")}), 0)`);
		expect(await view.evaluate(`Promise.all([__first, __second]).then(() => QUEUE.map(i => i.id).join(","))`)).toBe("new");
	} finally {
		await view.evaluate(`(fetch = __fetch, __held.forEach(r => r(new Response(JSON.stringify({ items: [] })))), 0)`);
	}
});

// The page's 15 s polls share one state read, and that read brings the one context read with it (99-boot.js, 17-state-refresh.js refreshState).
test("one 15 s tick on the chat sends one /api/state and one /api/context read", async () => {
	await view.evaluate(`(go("chat"), 0)`);
	await advanceSettled(view, 0);
	await view.evaluate(`(window.__fetch = fetch, window.__n = {}, fetch = (p, o) => { const k = String(p).split("?")[0]; __n[k] = (__n[k] || 0) + 1; return __fetch(p, o); }, 0)`);
	try {
		await advanceSettled(view, 15000);
		expect(await view.evaluate(`JSON.stringify([__n["/api/state"], __n["/api/context"]])`)).toBe("[1,1]");
	} finally {
		await view.evaluate(`(fetch = __fetch, 0)`);
	}
});

// A poll needs no read that starts after it: a tick while the last read is still out leaves it alone instead of queueing another (42-relay-chat.js relayTick).
test("a relay poll tick while the room's read is out sends nothing and queues nothing", async () => {
	// __sent counts only reads of the room's messages (the path relayLoad fetches), not the page's other requests.
	await view.evaluate(`(window.__ro = relayOn, relayOn = () => true, window.__rel = null, window.__out = latest(targetKey(target), () => new Promise(r => { window.__rel = r; })), window.__room = relayApi(target) + "/messages", window.__fetch = fetch, window.__sent = 0, fetch = (p, o) => (String(p).split("?")[0] === __room && __sent++, __fetch(p, o)), 0)`);
	try {
		await view.evaluate(`(relayTick(), 0)`);
		expect(await view.evaluate(`JSON.stringify([__sent, !!FLIGHTS.get(targetKey(target)).next])`)).toBe("[0,false]");
	} finally {
		await view.evaluate(`(relayOn = __ro, fetch = __fetch, __rel && __rel(), __out.then(() => 0))`);
	}
});

test("with a call during every read, each caller is still answered by the first read sent after its call", async () => {
	await view.evaluate(`(window.__fetch = fetch, window.__held = [], window.__got = {}, fetch = (p, o) => (String(p) === "/api/queue" ? new Promise(r => __held.push(r)) : __fetch(p, o)), 0)`);
	const ask = (k: number) => view.evaluate(`(api("/api/queue").then(r => { __got[${k}] = r.items[0].id; }), 0)`);
	const answer = (k: number) => view.evaluate(`(__held[${k - 1}](new Response(JSON.stringify({ items: [{ id: "read${k}" }] }))), 0)`);
	try {
		await ask(1);
		for (let k = 1; k <= 4; k++) {
			await waitFor(`__held.length === ${k}`);
			await ask(k + 1);
			await answer(k);
			await waitFor(`__got[${k}] === "read${k}"`);
		}
		await waitFor(`__held.length === 5`);
		await answer(5);
		await waitFor(`__got[5] === "read5" && !latestOut("/api/queue")`);
		expect(await view.evaluate(`JSON.stringify(__got)`)).toBe(JSON.stringify({ 1: "read1", 2: "read2", 3: "read3", 4: "read4", 5: "read5" }));
		expect(await view.evaluate(`__held.length`)).toBe(5);
	} finally {
		await view.evaluate(`(fetch = __fetch, __held.forEach(r => r(new Response(JSON.stringify({ items: [{ id: "none" }] })))), 0)`);
	}
});
