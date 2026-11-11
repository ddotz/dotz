import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { broadcast, sseResponse, subscriberCount } from "./events.ts";
import { PtyHost, ptyRoute } from "./pty.ts";

const open: { stop(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.stop(); });

// Enough small frames to pass any backlog bound a stream may use, without reading.
function floodUntilDropped(max: number, frame: () => object): number {
	let n = 0;
	while (subscriberCount() > 0 && n < max) { broadcast(frame()); n++; }
	return n;
}

test("a stream that is opened and never read is dropped once its backlog passes the bound, and later events are not queued for it", async () => {
	const res = sseResponse();
	expect(subscriberCount()).toBe(1);
	const sent = floodUntilDropped(1500, () => ({ kind: "out", n: 1 }));
	expect(subscriberCount()).toBe(0);
	expect(sent).toBeGreaterThan(100);
	// The stream is errored, so the client sees the end instead of an endless wait.
	await expect(res.body!.getReader().read()).rejects.toThrow();
	const before = sent;
	broadcast({ kind: "out", n: 2 });
	expect(subscriberCount()).toBe(0);
	expect(before).toBe(sent);
});

test("an aborted request is removed at once", () => {
	const ac = new AbortController();
	sseResponse(null, ac.signal);
	expect(subscriberCount()).toBe(1);
	ac.abort();
	expect(subscriberCount()).toBe(0);
});

test("a request that is already aborted is never added", () => {
	const ac = new AbortController();
	ac.abort();
	sseResponse(null, ac.signal);
	expect(subscriberCount()).toBe(0);
});

test("a client that reads normally keeps every event in order, however many", async () => {
	const res = sseResponse();
	const reader = res.body!.getReader();
	const first = await reader.read();
	expect(String(first.value)).toContain("event: reset");
	for (let i = 0; i < 1500; i++) {
		broadcast({ kind: "out", seqtest: i });
		const { value } = await reader.read();
		expect(JSON.parse(String(value).split("data: ")[1]).seqtest).toBe(i);
	}
	expect(subscriberCount()).toBe(1);
	await reader.cancel();
	expect(subscriberCount()).toBe(0);
});

test("a long replay for a reconnecting client is not counted as an unread backlog", async () => {
	const first = sseResponse().body!.getReader();
	const seen = (await first.read()).value as string;
	await first.cancel();
	const id = /^id: (.+)$/m.exec(seen)![1];
	for (let i = 0; i < 1200; i++) broadcast({ kind: "out", n: i });
	const reader = sseResponse(id).body!.getReader();
	open.push({ stop: () => void reader.cancel() });
	expect(subscriberCount()).toBeGreaterThan(0);
	broadcast({ kind: "out", n: "live" });
	expect(subscriberCount()).toBeGreaterThan(0);
	const text = String((await reader.read()).value);
	expect(text.match(/^id: /gm)!.length).toBeGreaterThanOrEqual(1200);
});

test("over a real socket a client that stops reading is dropped and its socket is closed by the gateway", async () => {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: req => sseResponse(req.headers.get("last-event-id"), req.signal) });
	const sock = net.connect(server.port, "127.0.0.1");
	open.push({ stop: () => { sock.destroy(); void server.stop(true); } });
	await new Promise<void>(r => sock.once("connect", () => r()));
	sock.pause();
	sock.write("GET /api/events HTTP/1.1\r\nHost: x\r\n\r\n");
	for (let i = 0; i < 400 && subscriberCount() === 0; i++) await new Promise(r => setImmediate(r));
	expect(subscriberCount()).toBe(1);
	const big = "x".repeat(16_000);
	for (let i = 0; i < 1500 && subscriberCount() > 0; i++) {
		broadcast({ kind: "out", big });
		await new Promise(r => setImmediate(r));
	}
	expect(subscriberCount()).toBe(0);
	// Reading again shows the gateway ended the connection (the old behaviour left it open forever).
	const closed = new Promise<void>(r => sock.once("close", () => r()));
	sock.on("data", () => {});
	sock.resume();
	await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("socket was not closed by the gateway")), 8000))]);
});

test("the terminal stream stops its timer and its subscription when the client goes away", async () => {
	const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
	const live = new Set<unknown>();
	globalThis.setInterval = ((fn: () => void, ms?: number, ...a: unknown[]) => {
		const id = realSet(fn, ms, ...a);
		if (ms === 15_000) live.add(id);
		return id;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { live.delete(id); realClear(id); }) as typeof clearInterval;
	const host = new PtyHost({ cmd: ["/bin/sh", "-c", "sleep 30"] });
	open.push({ stop: () => { host.kill(); globalThis.setInterval = realSet; globalThis.clearInterval = realClear; for (const id of live) realClear(id as never); } });
	const ac = new AbortController();
	const res = await ptyRoute(new Request("http://localhost/api/pty/stream", { signal: ac.signal }), new URL("http://localhost/api/pty/stream"), host);
	expect(res?.status).toBe(200);
	expect(live.size).toBe(1);
	expect((host as any).subs.size).toBe(1);
	ac.abort();
	expect(live.size).toBe(0);
	expect((host as any).subs.size).toBe(0);
});
