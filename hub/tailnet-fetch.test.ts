// hub/tailnet-fetch.ts: a tailnet name the system DNS cannot resolve (a VPN took the DNS over) is reached through its tailnet address.
import { afterAll, expect, test } from "bun:test";
import { peerFetch } from "./tailnet-fetch.ts";

let seenHost = "";
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => ((seenHost = req.headers.get("host") ?? ""), Response.json({ gateway: "dotz" })) });
afterAll(() => server.stop(true));

test("a *.ts.net name that does not resolve is retried at the address Tailscale gives, with its own Host header", async () => {
	const url = `http://no-such-node-dz.tailbcf3ef.ts.net:${server.port}/manifest.webmanifest`;
	const asked: string[] = [];
	const r = await peerFetch(url, {}, async host => (asked.push(host), "127.0.0.1"));
	expect(await r.json()).toEqual({ gateway: "dotz" });
	expect(asked).toEqual(["no-such-node-dz.tailbcf3ef.ts.net"]);
	expect(seenHost).toBe(`no-such-node-dz.tailbcf3ef.ts.net:${server.port}`);
});

test("any other failure, or a name outside the tailnet, is not retried", async () => {
	const asked: string[] = [];
	const resolve = async (host: string) => (asked.push(host), "127.0.0.1");
	await expect(peerFetch("http://no-such-host-dz.invalid:1/x", {}, resolve)).rejects.toThrow();
	expect(asked).toEqual([]);
});
