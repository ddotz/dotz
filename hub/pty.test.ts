import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { PtyHost, ptyRoute } from "./pty.ts";

const SECRET = "hunter2-SECRET-마커-9f3a";
// A fake sudo: asks with echo off, then reports a checksum of what it was given (never the text itself).
const ASKER = `stty -echo; printf '[sudo] password for test: '; IFS= read -r pw; stty echo; printf '\\nSUM:%s\\n' "$(printf %s "$pw" | cksum | cut -d' ' -f1)"; sleep 5`;
// The same, but the terminal keeps echoing what is typed (a program that forgot to turn echo off).
const ECHOER = `printf 'Password: '; IFS= read -r pw; printf 'SUM:%s\\n' "$(printf %s "$pw" | cksum | cut -d' ' -f1)"; sleep 5`;
const cksum = (s: string) => new TextDecoder().decode(Bun.spawnSync(["sh", "-c", `printf %s "$1" | cksum | cut -d' ' -f1`, "sh", s]).stdout).trim();

const hosts: PtyHost[] = [];
const make = (script: string) => { const h = new PtyHost({ cmd: ["/bin/sh", "-c", script] }); hosts.push(h); return h; };
afterEach(() => { for (const h of hosts.splice(0)) h.kill(); });

// Resolves with all output seen so far once `done` accepts it.
function until(host: PtyHost, done: (all: string) => boolean, ms = 8000): Promise<string> {
	return new Promise((resolve, reject) => {
		let all = "";
		const timer = setTimeout(() => { sub.off(); reject(new Error(`timed out; saw ${JSON.stringify(all)}`)); }, ms);
		const sub = host.subscribe(e => {
			if (e.type !== "out") return;
			all += e.data;
			if (done(all)) { clearTimeout(timer); sub.off(); resolve(all); }
		});
		all = sub.backlog;
		if (done(all)) { clearTimeout(timer); sub.off(); resolve(all); }
	});
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? filesUnder(p) : [p]; });
}

describe("web terminal: input is never logged or kept", () => {
	test("a secret is delivered to the program, and appears in no console call, file, replay buffer or output", async () => {
		const calls: string[] = [];
		const keep = { log: console.log, info: console.info, warn: console.warn, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
		const grab = (...a: unknown[]) => { calls.push(a.map(String).join(" ")); };
		console.log = console.info = console.warn = console.error = grab;
		process.stdout.write = ((s: string | Uint8Array) => { calls.push(String(s)); return true; }) as typeof process.stdout.write;
		process.stderr.write = ((s: string | Uint8Array) => { calls.push(String(s)); return true; }) as typeof process.stderr.write;
		try {
			const host = make(ASKER);
			host.start();
			await until(host, a => a.includes("password for test:"));
			host.write(SECRET, true);
			const seen = await until(host, a => a.includes("SUM:"));
			expect(seen).toContain(`SUM:${cksum(SECRET)}`);
			expect(seen).not.toContain(SECRET);
			expect(host.subscribe(() => {}).backlog).not.toContain(SECRET);
		} finally {
			Object.assign(console, { log: keep.log, info: keep.info, warn: keep.warn, error: keep.error });
			process.stdout.write = keep.out as typeof process.stdout.write;
			process.stderr.write = keep.err as typeof process.stderr.write;
		}
		expect(calls.join("\n")).not.toContain(SECRET);
		for (const f of filesUnder(DATA_DIR)) expect(readFileSync(f).includes(SECRET)).toBe(false);
	});

	test("a secret the terminal echoes back is dropped from the stream and from the replay", async () => {
		const host = make(ECHOER);
		host.start();
		await until(host, a => a.includes("Password:"));
		host.write(SECRET, true);
		const seen = await until(host, a => a.includes("SUM:"));
		expect(seen).toContain(`SUM:${cksum(SECRET)}`);
		expect(seen).not.toContain(SECRET);
		expect(host.subscribe(() => {}).backlog).not.toContain(SECRET);
	});

	test("the module has no logger, console, or file writes at all", () => {
		const src = readFileSync(join(import.meta.dir, "pty.ts"), "utf8");
		expect(src).not.toMatch(/\blog\(|console\.|writeFile|appendFile|Bun\.write|createWriteStream|\.\/config\.ts/);
	});
});

describe("web terminal route", () => {
	const url = (p: string) => new URL(`http://hub.test${p}`);
	const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
		new Request(`http://hub.test${p}`, { method: "POST", headers: { "content-type": "application/json", host: "hub.test", ...headers }, body: JSON.stringify(body) });

	test("input reaches the shell; a page of another origin, a non-JSON body and a stopped shell are refused", async () => {
		const host = make("cat");
		host.start();
		expect((await ptyRoute(post("/api/pty/input", { data: "abc\r" }), url("/api/pty/input"), host))!.status).toBe(200);
		expect(await until(host, a => a.includes("abc"))).toContain("abc");
		const foreign = await ptyRoute(post("/api/pty/input", { data: "x" }, { origin: "https://evil.example" }), url("/api/pty/input"), host);
		expect(foreign!.status).toBe(403);
		const same = await ptyRoute(post("/api/pty/input", { data: "x" }, { origin: "http://hub.test" }), url("/api/pty/input"), host);
		expect(same!.status).toBe(200);
		const plain = new Request("http://hub.test/api/pty/input", { method: "POST", headers: { "content-type": "text/plain", host: "hub.test" }, body: "{}" });
		expect((await ptyRoute(plain, url("/api/pty/input"), host))!.status).toBe(415);
		host.kill();
		await Bun.sleep(0);
		const stopped = make("cat");
		expect((await ptyRoute(post("/api/pty/input", { data: "x" }), url("/api/pty/input"), stopped))!.status).toBe(409);
		expect(await ptyRoute(new Request("http://hub.test/api/state"), url("/api/state"), host)).toBeUndefined();
	});

	test("the stream starts with a reset frame carrying what the shell already printed, then live output", async () => {
		const host = make("printf 'first\\n'; cat");
		const res = (await ptyRoute(new Request("http://hub.test/api/pty/stream?cols=100&rows=30", { headers: { host: "hub.test" } }), url("/api/pty/stream?cols=100&rows=30"), host))!;
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let text = "";
		while (!text.includes("event: out")) {
			const { value, done } = await reader.read();
			if (done) break;
			text += typeof value === "string" ? value : dec.decode(value);
		}
		expect(text.startsWith("event: reset")).toBe(true);
		expect(text).toContain("first");
		await reader.cancel();
	});
});
