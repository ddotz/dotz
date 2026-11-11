// hub/discord-net.ts: a Discord REST call that never answers is aborted at its limit, and the gateway socket reconnects after a growing delay
// that starts again from the first one once a session is ready. The unit tests inject their own timers, the gateway test reads its reconnect
// timers off the preload's manual clock (advance()), and the REST path runs against a fake Discord server (DOTZ_DISCORD_API), never the real one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as discord from "./discord.ts";
import { advance } from "./runtime/test-clock.ts";
import { FATAL_CLOSE, limited, reconnectDelay, reconnector, restLimitMs } from "./discord-net.ts";

type Job = { fn: () => void; ms: number; live: boolean };
function fakeTimers() {
	const jobs: Job[] = [];
	return {
		jobs,
		timers: {
			set: (fn: () => void, ms: number) => {
				const job = { fn, ms, live: true };
				jobs.push(job);
				return job;
			},
			clear: (t: unknown) => {
				if (t) (t as Job).live = false;
			},
		},
		fire: (job: Job) => {
			if (job.live) {
				job.live = false;
				job.fn();
			}
		},
	};
}

const never = (signal: AbortSignal) => new Promise<never>((_ok, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true }));

test("a call that never answers is aborted at its limit, logged once with the route, and its timer is cleared", async () => {
	const clock = fakeTimers();
	const lines: string[] = [];
	const call = limited({ what: "discord POST /channels/1/messages", ms: 15_000, log: l => lines.push(l), timers: clock.timers }, never);
	expect(clock.jobs.map(j => j.ms)).toEqual([15_000]);
	clock.fire(clock.jobs[0]!);
	await expect(call).rejects.toThrow("discord POST /channels/1/messages: no answer in 15000 ms");
	expect(lines).toHaveLength(1);
	expect(clock.jobs.every(j => !j.live)).toBe(true);
});

test("an answer or an ordinary failure clears the timer too, and a failure that is not a timeout is not logged as one", async () => {
	const clock = fakeTimers();
	const lines: string[] = [];
	const o = { what: "discord GET /x", ms: 1000, log: (l: string) => lines.push(l), timers: clock.timers };
	expect(await limited(o, async () => 7)).toBe(7);
	await expect(limited(o, async () => Promise.reject(new Error("discord GET /x: 500")))).rejects.toThrow("500");
	expect(clock.jobs.every(j => !j.live)).toBe(true);
	expect(lines).toEqual([]);
});

test("a plain call is short, a call with files is longer by size and has a top", () => {
	expect(restLimitMs()).toBe(15_000);
	expect(restLimitMs([])).toBe(15_000);
	expect(restLimitMs([1])).toBe(40_000);
	expect(restLimitMs([3 * 1_048_576])).toBe(60_000);
	expect(restLimitMs([500 * 1_048_576])).toBe(300_000);
});

test("the reconnect delay grows from 5 s to the 5 min cap, with jitter that only shortens it", () => {
	const top = Array.from({ length: 9 }, (_, n) => reconnectDelay(n, () => 1));
	expect(top).toEqual([5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
	expect(reconnectDelay(0, () => 0)).toBe(3750);
	expect(reconnectDelay(40, () => 0)).toBe(225_000);
});

test("the reconnector backs off per close, starts again after ready, and a fatal code arms nothing", () => {
	const clock = fakeTimers();
	let opened = 0;
	const retry = reconnector(() => opened++, { timers: clock.timers, rand: () => 1 });
	for (let i = 0; i < 3; i++) {
		expect(retry.schedule(1006)).toBe(true);
		clock.fire(clock.jobs.at(-1)!);
	}
	expect(clock.jobs.map(j => j.ms)).toEqual([5000, 10_000, 20_000]);
	expect(opened).toBe(3);
	retry.reset();
	retry.schedule(1006);
	expect(clock.jobs.at(-1)!.ms).toBe(5000);
	const armed = clock.jobs.length;
	for (const code of FATAL_CLOSE) expect(retry.schedule(code)).toBe(false);
	expect(clock.jobs).toHaveLength(armed);
});

test("an 8 hour outage costs about a hundred attempts, not the 5760 of a fixed 5 s", () => {
	let waited = 0;
	let attempts = 0;
	while (waited < 8 * 3600_000) waited += reconnectDelay(attempts++, () => 0.5);
	expect(attempts).toBeWithin(90, 130);
});

let server: ReturnType<typeof Bun.serve>;
let mode: "hang" | "limit-once" | "ok" = "ok";
let seen = 0;
let onHit: () => void = () => {};
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch() {
			seen++;
			onHit();
			if (mode === "hang") return new Promise<Response>(() => {});
			if (mode === "limit-once" && seen === 1) return Response.json({ retry_after: 0 }, { status: 429 });
			return Response.json({ id: "m1" });
		},
	});
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
	discord.status.enabled = true;
	discord.channels.work["222"] = "files";
});
afterAll(() => {
	server.stop(true);
	delete process.env.DOTZ_DISCORD_API;
});

test("send to a Discord that never answers gives the normal failure at the limit instead of waiting for good", async () => {
	mode = "hang";
	seen = 0;
	process.env.DOTZ_DISCORD_REST_MS = "50";
	try {
		const failed = await discord.send("ch:222", "hej").then(() => "delivered", e => String(e));
		expect(seen).toBe(1);
		expect(failed).toMatch(/discord POST \/channels\/222\/messages: no answer in 50 ms/);
	} finally {
		delete process.env.DOTZ_DISCORD_REST_MS;
	}
});

test("a rate-limited call waits and tries again, as before", async () => {
	mode = "limit-once";
	seen = 0;
	expect((await discord.send("ch:222", "hej")).delivered).toBe(true);
	expect(seen).toBe(2);
});

// The gateway socket against a fake gateway (DOTZ_DISCORD_GATEWAY). Every reconnect timer is read off the manual clock as it is armed.
let gw: ReturnType<typeof Bun.serve>;
let conns = 0;
let behavior: "close" | "fatal" | "ready" = "close";
const delays: number[] = [];
const timeout = globalThis.setTimeout;
async function until(cond: () => boolean): Promise<void> {
	const end = performance.now() + 5000;
	while (!cond()) {
		if (performance.now() > end) throw new Error("timed out waiting for the gateway test");
		await new Promise<void>(r => setImmediate(r));
	}
}
beforeAll(() => {
	gw = Bun.serve({
		port: 0,
		fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
		websocket: {
			open(ws) {
				conns++;
				if (behavior === "fatal") ws.close(4004, "bad token");
				else if (behavior === "close") ws.close(4000, "again");
				else ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1e9 } }));
			},
			message(ws, raw) {
				if (JSON.parse(String(raw)).op === 2) {
					ws.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "s", resume_gateway_url: `ws://127.0.0.1:${gw.port}`, user: { username: "bot" } } }));
					ws.close(4000, "again");
				}
			},
		},
	});
	process.env.DOTZ_DISCORD_GATEWAY = `ws://127.0.0.1:${gw.port}/gateway`;
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		if ((ms ?? 0) >= 3750) delays.push(ms!);
		return (timeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
	}) as unknown as typeof setTimeout;
});
afterAll(() => {
	globalThis.setTimeout = timeout;
	delete process.env.DOTZ_DISCORD_GATEWAY;
	gw.stop(true);
});

test("a fatal close code still stops the reconnecting", async () => {
	behavior = "fatal";
	delays.length = 0;
	discord.connect(() => {});
	await until(() => conns === 1 && discord.status.error === "closed 4004");
	await advance(3_600_000);
	expect(conns).toBe(1);
	expect(delays).toEqual([]);
});

test("the delay between reconnects grows to the cap, and starts again from 5 s after a session is ready", async () => {
	behavior = "close";
	conns = 0;
	delays.length = 0;
	discord.connect(() => {});
	const wait: number[] = [];
	for (let n = 0; n < 6; n++) {
		await until(() => delays.length === n + 1);
		wait.push(delays[n]!);
		if (n === 5) behavior = "ready";
		await advance(delays[n]!);
		await until(() => conns === n + 2);
	}
	await until(() => delays.length === 7);
	expect(wait.map((d, n) => d >= 0.75 * Math.min(300_000, 5000 * 2 ** n) && d <= Math.min(300_000, 5000 * 2 ** n))).toEqual([true, true, true, true, true, true]);
	expect(wait[5]!).toBeGreaterThan(wait[0]! * 8);
	expect(delays[6]!).toBeWithin(3750, 5001);
	const done = discord.disconnect();
	await advance(3000);
	await done;
});
