// hub/tailnet-fetch.ts: a tailnet name the system DNS cannot resolve (a VPN took the DNS over) is reached through its tailnet address.
import { afterAll, afterEach, expect, test } from "bun:test";
import { peerFetch } from "./tailnet-fetch.ts";

let seenHost = "";
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => ((seenHost = req.headers.get("host") ?? ""), Response.json({ gateway: "dotz" })) });
afterAll(() => server.stop(true));

test("a *.ts.net name that does not resolve is retried at the address Tailscale gives, with its own Host header", async () => {
	const url = `http://no-such-node-dz.tail1234.ts.net:${server.port}/manifest.webmanifest`;
	const asked: string[] = [];
	const r = await peerFetch(url, {}, async host => (asked.push(host), "127.0.0.1"));
	expect(await r.json()).toEqual({ gateway: "dotz" });
	expect(asked).toEqual(["no-such-node-dz.tail1234.ts.net"]);
	expect(seenHost).toBe(`no-such-node-dz.tail1234.ts.net:${server.port}`);
});

test("any other failure, or a name outside the tailnet, is not retried", async () => {
	const asked: string[] = [];
	const resolve = async (host: string) => (asked.push(host), "127.0.0.1");
	await expect(peerFetch("http://no-such-host-dz.invalid:1/x", {}, resolve)).rejects.toThrow();
	expect(asked).toEqual([]);
});

// The global fetch is replaced by one that records the signal it was given and never answers until that signal aborts.
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
function hang(seen: AbortSignal[], failFirst = false): void {
	let calls = 0;
	globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
		const signal = init!.signal!;
		seen.push(signal);
		if (failFirst && calls++ === 0) return Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
		return new Promise<Response>((_ok, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true }));
	}) as unknown as typeof fetch;
}

test("a call with no signal of its own is aborted at the limit", async () => {
	const seen: AbortSignal[] = [];
	hang(seen);
	await expect(peerFetch("http://peer.invalid:1/x", {}, undefined, 20)).rejects.toMatchObject({ name: "TimeoutError" });
	expect(seen).toHaveLength(1);
});

test("the caller's own signal is kept as it is, so a stream the caller keeps open is not cut", async () => {
	const seen: AbortSignal[] = [];
	hang(seen);
	const own = new AbortController();
	const call = peerFetch("http://peer.invalid:1/x", { signal: own.signal }, undefined, 1);
	own.abort(new Error("caller done"));
	await expect(call).rejects.toThrow("caller done");
	expect(seen[0]).toBe(own.signal);
});

test("the tailnet-address retry runs under the same limit", async () => {
	const seen: AbortSignal[] = [];
	hang(seen, true);
	await expect(peerFetch("http://node.tail1.ts.net:1/x", {}, async () => "127.0.0.1", 20)).rejects.toMatchObject({ name: "TimeoutError" });
	expect(seen).toHaveLength(2);
	expect(seen[1]).toBe(seen[0]);
});
