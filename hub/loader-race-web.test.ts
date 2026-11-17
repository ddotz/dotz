import { afterAll, expect, test } from "bun:test";
import { fakeHub, on } from "./test-web.ts";

// A read asked for while an older read of the same path is out (sent before what changed) gets a read that starts after it, never that older answer
// (web/js/02-basic-markdown.js latest, under api()). The page's own fetch holds each /api/queue answer until the test releases it.
const hub = fakeHub({ stream: "fake" });
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
	await view.evaluate(`(window.__first = loadQueue(), 0)`);
	await waitFor(`__held.length === 1`);
	// The queue changes on the hub; the reload asked for now must not be handed the answer of the read already out.
	await view.evaluate(`(window.__second = loadQueue(), 0)`);
	expect(await view.evaluate(`__held.length`)).toBe(1);
	await view.evaluate(`(__held[0](${answer("old")}), 0)`);
	await waitFor(`__held.length === 2`);
	await view.evaluate(`(__held[1](${answer("new")}), 0)`);
	expect(await view.evaluate(`Promise.all([__first, __second]).then(() => QUEUE.map(i => i.id).join(","))`)).toBe("new");
	await view.evaluate(`(fetch = __fetch, 0)`);
});

test("with a call during every read, each caller is still answered by the first read sent after its call", async () => {
	await view.evaluate(`(window.__fetch = fetch, window.__held = [], window.__got = {}, fetch = (p, o) => (String(p) === "/api/queue" ? new Promise(r => __held.push(r)) : __fetch(p, o)), 0)`);
	const ask = (k: number) => view.evaluate(`(api("/api/queue").then(r => { __got[${k}] = r.items[0].id; }), 0)`);
	const answer = (k: number) => view.evaluate(`(__held[${k - 1}](new Response(JSON.stringify({ items: [{ id: "read${k}" }] }))), 0)`);
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
	await view.evaluate(`(fetch = __fetch, 0)`);
});
