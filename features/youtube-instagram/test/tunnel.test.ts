// tunnel lib: one file served on 127.0.0.1 under a random token, the public URL read from a fake cloudflared, both closed after.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Spawner, withTunnel } from "../lib/tunnel.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let file: string;
let killed: number;
let argv: string[];
beforeEach(() => {
	env = setupEnv();
	file = join(env.dir, "v.mp4");
	writeFileSync(file, "BYTES");
	killed = 0;
	argv = [];
});
afterEach(() => env.cleanup());

const spawner =
	(lines: string[]): Spawner =>
	a => {
		argv = a;
		return {
			lines: (async function* () {
				for (const l of lines) yield l;
			})(),
			kill: () => {
				killed++;
			},
		};
	};
const noSleep = async () => {};

test("serves the file at the token path only and hands fn the public URL", async () => {
	const local = await withTunnel(
		file,
		async (url, localUrl) => {
			expect(url).toMatch(/^https:\/\/my-test\.trycloudflare\.com\/[0-9a-f]{32}\.mp4$/);
			expect(url.split("/").at(-1)).toBe(localUrl.split("/").at(-1));
			const ok = await fetch(localUrl);
			expect(await ok.text()).toBe("BYTES");
			expect(ok.headers.get("content-type")).toBe("video/mp4");
			expect((await fetch(localUrl.replace(/[0-9a-f]{32}/, "nope"))).status).toBe(404);
			expect(killed).toBe(0);
			return localUrl;
		},
		{ spawn: spawner(["INF Requesting new quick Tunnel", "INF |  https://my-test.trycloudflare.com  |"]), sleep: noSleep },
	);
	expect(killed).toBe(1);
	expect(argv.slice(0, 2)).toEqual(["cloudflared", "tunnel"]);
	expect(argv.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	await expect(fetch(local)).rejects.toBeDefined();
});

test("closes the tunnel and the server when fn throws", async () => {
	let local = "";
	await expect(
		withTunnel(
			file,
			async (_url, localUrl) => {
				local = localUrl;
				throw new Error("upload failed");
			},
			{ spawn: spawner(["https://my-test.trycloudflare.com"]), sleep: noSleep },
		),
	).rejects.toThrow("upload failed");
	expect(killed).toBe(1);
	await expect(fetch(local)).rejects.toBeDefined();
});

test("a cloudflared that exits without a URL is an error and is cleaned up", async () => {
	await expect(withTunnel(file, async () => "never", { spawn: spawner(["ERR something broke"]), sleep: noSleep })).rejects.toThrow(/without a tunnel URL/);
	expect(killed).toBe(1);
});
