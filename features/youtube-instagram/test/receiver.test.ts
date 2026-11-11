// lib/receiver.ts: the one-shot localhost receiver and the one-shot secret server, against real loopback sockets.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ReceiverError, serveOnce, startReceiver } from "../lib/receiver.ts";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dz-recv-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const post = (url: string, body: unknown) => fetch(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });

test("accepts one POST, writes only the wanted fields to a 0600 file and closes", async () => {
	const file = join(dir, "secrets", "client.json");
	const r = startReceiver({ file, fields: ["client_id", "client_secret"], sleep: () => new Promise(() => {}) });
	expect(new URL(r.url).hostname).toBe("127.0.0.1");

	const res = await post(r.url, { client_id: " cid ", client_secret: "CS-secret", extra: "dropped" });
	expect(res.status).toBe(200);
	expect(res.headers.get("access-control-allow-origin")).toBe("*");
	expect(await res.text()).toBe("ok");
	await r.done;

	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ client_id: "cid", client_secret: "CS-secret" });
	expect(statSync(file).mode & 0o777).toBe(0o600);
	await expect(post(r.url, { client_id: "x", client_secret: "y" })).rejects.toThrow();
});

test("answers the CORS preflight with the private-network header", async () => {
	const r = startReceiver({ file: join(dir, "a.json"), fields: ["token"], sleep: () => new Promise(() => {}) });
	const res = await fetch(r.url, { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "POST", "access-control-request-private-network": "true" } });
	expect(res.status).toBe(204);
	expect(res.headers.get("access-control-allow-private-network")).toBe("true");
	expect(res.headers.get("access-control-allow-methods")).toContain("POST");
	expect(res.headers.get("access-control-allow-origin")).toBe("*");
	r.stop();
});

test("rejects a wrong path, a GET, a bad body and a missing field without writing, then still accepts a good one", async () => {
	const file = join(dir, "a.json");
	const r = startReceiver({ file, fields: ["token"], sleep: () => new Promise(() => {}) });
	const origin = new URL(r.url).origin;
	expect((await post(`${origin}/not-the-token`, { token: "t" })).status).toBe(404);
	expect((await fetch(r.url)).status).toBe(405);
	expect((await post(r.url, "{not json")).status).toBe(400);
	expect((await post(r.url, { token: "" })).status).toBe(400);
	expect((await post(r.url, { token: "x".repeat(20_000) })).status).toBe(413);
	expect(existsSync(file)).toBe(false);

	expect((await post(r.url, { token: "ok-token" })).status).toBe(200);
	await r.done;
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: "ok-token" });
});

test("gives up with a ReceiverError after the bounded wait and writes nothing", async () => {
	const file = join(dir, "a.json");
	const waits: number[] = [];
	const r = startReceiver({ file, fields: ["token"], waitMs: 1234, sleep: async ms => void waits.push(ms) });
	await expect(r.done).rejects.toBeInstanceOf(ReceiverError);
	expect(waits).toEqual([1234]);
	expect(existsSync(file)).toBe(false);
	await expect(post(r.url, { token: "late" })).rejects.toThrow();
});

test("never echoes the body: the failure and success responses carry no part of it", async () => {
	const r = startReceiver({ file: join(dir, "a.json"), fields: ["token"], sleep: () => new Promise(() => {}) });
	const bad = await post(r.url, { token: "", note: "SECRET-VALUE" });
	expect(await bad.text()).not.toContain("SECRET-VALUE");
	const good = await post(r.url, { token: "SECRET-VALUE" });
	expect(await good.text()).not.toContain("SECRET-VALUE");
});

test("serveOnce hands the value out exactly once, only on its own path", async () => {
	const s = serveOnce("the-value");
	expect((await fetch(`${new URL(s.url).origin}/nope`)).status).toBe(404);
	expect(await (await fetch(s.url)).text()).toBe("the-value");
	expect((await fetch(s.url)).status).toBe(404);
	s.stop();
});
