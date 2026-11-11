import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { broadcast, sseResponse, subscriberCount } from "./events.ts";
import { PtyHost, ptyRoute } from "./pty.ts";
import { onHangUp } from "./routes-util.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

const nextOrNone = (r: ReadableStreamDefaultReader<string>) => Promise.race([r.read().then(x => x.value), new Promise<string>(res => setImmediate(() => res("none")))]);

test("a stream that is opened and never read is dropped once its backlog passes the bound, and later events are not queued for it", async () => {
	const ac = new AbortController();
	let hung = 0;
	onHangUp(ac.signal, () => hung++);
	const reader = sseResponse(null, ac.signal).body!.getReader();
	let sent = 0;
	while (subscriberCount() > 0 && sent < 1500) { broadcast({ kind: "out", n: sent }); sent++; }
	expect(subscriberCount()).toBe(0);
	expect(sent).toBeGreaterThan(100);
	expect(hung).toBe(1);
	for (let i = 0; i <= sent; i++) expect(await nextOrNone(reader)).not.toBe("none");
	broadcast({ kind: "out", n: "after" });
	expect(await nextOrNone(reader)).toBe("none");
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
	const reader = sseResponse().body!.getReader();
	expect(String((await reader.read()).value)).toContain("event: reset");
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
	const id = /^id: (.+)$/m.exec(String((await first.read()).value))![1];
	await first.cancel();
	for (let i = 0; i < 1200; i++) broadcast({ kind: "out", n: i });
	const reader = sseResponse(id).body!.getReader();
	cleanups.push(() => void reader.cancel());
	broadcast({ kind: "out", n: "live" });
	expect(subscriberCount()).toBe(1);
	expect(String((await reader.read()).value).match(/^id: /gm)!.length).toBeGreaterThanOrEqual(1200);
});

test("over a real socket the gateway closes the connection of a client that stopped reading", async () => {
	let aborted!: Promise<void>;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		fetch(req, srv) {
			aborted = new Promise(r => req.signal.addEventListener("abort", () => r(), { once: true }));
			onHangUp(req.signal, () => srv.timeout(req, 1));
			return sseResponse(null, req.signal);
		},
	});
	const sock = net.connect(server.port, "127.0.0.1");
	cleanups.push(() => { sock.destroy(); void server.stop(true); });
	await new Promise<void>(r => sock.once("connect", () => r()));
	sock.pause();
	sock.write("GET /api/events HTTP/1.1\r\nHost: x\r\n\r\n");
	while (subscriberCount() === 0) await new Promise(r => setImmediate(r));
	const big = "x".repeat(16_000);
	for (let i = 0; i < 1500 && subscriberCount() > 0; i++) {
		broadcast({ kind: "out", big });
		await new Promise(r => setImmediate(r));
	}
	expect(subscriberCount()).toBe(0);
	await aborted;
}, 20_000);

function trackPingTimers() {
	const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
	const live = new Set<unknown>();
	globalThis.setInterval = ((fn: () => void, ms?: number, ...a: unknown[]) => {
		const id = realSet(fn, ms, ...a);
		if (ms === 15_000) live.add(id);
		return id;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { live.delete(id); realClear(id); }) as typeof clearInterval;
	cleanups.push(() => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; for (const id of live) realClear(id as never); });
	return live;
}

async function openTerminal(signal: AbortSignal) {
	const live = trackPingTimers();
	const host = new PtyHost({ cmd: ["/bin/sh", "-c", "sleep 30"] });
	cleanups.push(() => host.kill());
	const res = await ptyRoute(new Request("http://localhost/api/pty/stream", { signal }), new URL("http://localhost/api/pty/stream"), host);
	expect(res?.status).toBe(200);
	expect(live.size).toBe(1);
	return { host: host as unknown as { subs: Set<unknown>; emit(e: { type: "out"; data: string }): void }, live };
}

test("the terminal stream stops its timer and its subscription when the client goes away", async () => {
	const ac = new AbortController();
	const { host, live } = await openTerminal(ac.signal);
	expect(host.subs.size).toBe(1);
	ac.abort();
	expect(live.size).toBe(0);
	expect(host.subs.size).toBe(0);
});

test("the terminal stream of a client that never reads is dropped, its timer stopped and its connection closed", async () => {
	const ac = new AbortController();
	let hung = 0;
	onHangUp(ac.signal, () => hung++);
	const { host, live } = await openTerminal(ac.signal);
	for (let i = 0; i < 3000 && host.subs.size > 0; i++) host.emit({ type: "out", data: "x" });
	expect(host.subs.size).toBe(0);
	expect(live.size).toBe(0);
	expect(hung).toBe(1);
});
