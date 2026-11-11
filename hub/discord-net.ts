// What keeps the Discord connection from waiting for good: a time limit on every REST call, and a reconnect delay that grows while Discord
// stays unreachable. hub/discord.ts calls both; the timers and the random source are injectable so a test needs no real waiting.

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
// Unref'd: a pending reconnect or limit never holds the process open at shutdown.
const realTimers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms).unref(),
	clear: t => clearTimeout(t as Timer),
};

// A REST limit runs on the engine's own timer (AbortSignal.timeout, one-shot and unref'd), so the test clock that replaces setTimeout cannot fire it
// while a real answer is still on its way. Clearing it drops the listener.
const restTimers: Timers = {
	set: (fn, ms) => {
		const signal = AbortSignal.timeout(ms);
		signal.addEventListener("abort", fn, { once: true });
		return { signal, fn };
	},
	clear: t => (t as { signal: AbortSignal; fn: () => void }).signal.removeEventListener("abort", (t as { fn: () => void }).fn),
};

export const REST_MS = 15_000;
const UPLOAD_BASE_MS = 30_000;
const UPLOAD_PER_MB_MS = 10_000;
const UPLOAD_MAX_MS = 300_000;

// A plain JSON call is short; a call with files gets 30 s plus 10 s per started megabyte (at most 5 min). DOTZ_DISCORD_REST_MS replaces it (a test).
export function restLimitMs(sizes?: readonly number[]): number {
	const forced = Number(process.env.DOTZ_DISCORD_REST_MS);
	if (forced > 0) return forced;
	if (!sizes?.length) return REST_MS;
	return Math.min(UPLOAD_MAX_MS, UPLOAD_BASE_MS + UPLOAD_PER_MB_MS * Math.ceil(sizes.reduce((a, b) => a + b, 0) / 1_048_576));
}

// The body of a REST call: JSON, or multipart (payload_json + files[i]) when files go along, the way Discord takes message attachments.
export function restPayload(body: unknown, files?: readonly { name: string; path: string }[]): string | FormData | undefined {
	if (!files?.length) return body === undefined ? undefined : JSON.stringify(body);
	const form = new FormData();
	form.append("payload_json", JSON.stringify({ ...(body as object), attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
	files.forEach((f, i) => form.append(`files[${i}]`, Bun.file(f.path), f.name));
	return form;
}

// Runs `run` with a signal that aborts after `ms`, body reading included. The timer is cleared on every path. An abort throws one error naming
// the call (`what` is the route: no token, no message text) and logs it once.
export async function limited<T>(o: { what: string; ms: number; log: (line: string) => void; timers?: Timers }, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const timers = o.timers ?? restTimers;
	const ctl = new AbortController();
	const timer = timers.set(() => ctl.abort(), o.ms);
	try {
		return await run(ctl.signal);
	} catch (error) {
		if (!ctl.signal.aborted) throw error;
		o.log(`${o.what}: no answer in ${o.ms} ms, given up`);
		throw new Error(`${o.what}: no answer in ${o.ms} ms`);
	} finally {
		timers.clear(timer);
	}
}

// Close codes after which Discord will not accept the same login again: reconnecting would only repeat the refusal.
export const FATAL_CLOSE = [4004, 4010, 4011, 4012, 4013, 4014];
export const RECONNECT_BASE_MS = 5000;
export const RECONNECT_CAP_MS = 300_000;

// 5 s, 10 s, 20 s ... up to 5 min, each cut by up to a quarter at random so several gateways do not knock together.
export const reconnectDelay = (tries: number, rand: () => number = Math.random): number =>
	Math.round(Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(tries, 16)) * (0.75 + 0.25 * rand()));

// The reconnect loop of the gateway socket. `schedule(code)` after a close arms one timer for `open` and returns true, or returns false for a fatal
// code (nothing armed). `reset()` goes back to the first delay once a session is really ready or resumed.
export function reconnector(open: () => void, o: { timers?: Timers; rand?: () => number } = {}) {
	const timers = o.timers ?? realTimers;
	let tries = 0;
	let timer: unknown;
	return {
		schedule(code: number): boolean {
			if (FATAL_CLOSE.includes(code)) return false;
			timers.clear(timer);
			timer = timers.set(open, reconnectDelay(tries++, o.rand));
			return true;
		},
		reset(): void {
			tries = 0;
		},
	};
}
