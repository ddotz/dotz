// The web terminal's shell: one login shell on a PTY (Bun.spawn terminal), shared by every page of this computer.
// Output goes to the page over SSE (/api/pty/stream); input comes back by POST (/api/pty/input). The route sits behind the
// same identity check as every /api route (hub/routes.ts authorized()).
//
// Input is never recorded: this module has no logger, writes no file, and keeps only the shell's own output in a small
// in-memory ring (the replay for a page that reconnects). A password sent as a secret is held in one local string for a
// few seconds, only to drop it from the output if the terminal echoes it, and is then cleared.
import { homedir } from "node:os";
import { json } from "./routes-util.ts";

const RING_CHARS = 64_000;
const INPUT_MAX = 64_000;
const SECRET_MS = 3_000;
const PING_MS = 15_000;

export type PtyEvent = { type: "out"; data: string } | { type: "exit"; code: number | null };

export type PtyOptions = { cmd?: string[]; cwd?: string; env?: Record<string, string> };

// The environment a shell gets: the hub's own, minus the gateway's markers and tokens.
const shellEnv = (extra: Record<string, string> = {}): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("DOTZ_") && !/TOKEN|SECRET|API_KEY/i.test(k)) env[k] = v;
	return { ...env, TERM: "xterm-256color", ...extra };
};

export class PtyHost {
	private proc: ReturnType<typeof Bun.spawn> | undefined;
	private ring = "";
	private subs = new Set<(e: PtyEvent) => void>();
	private secret = "";
	private secretTimer: ReturnType<typeof setTimeout> | undefined;
	constructor(private opts: PtyOptions = {}) {}

	get alive(): boolean {
		return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
	}

	start(cols = 80, rows = 24): void {
		if (this.alive) return;
		this.ring = "";
		const decoder = new TextDecoder();
		const cmd = this.opts.cmd ?? [process.env.SHELL || "/bin/zsh", "-l", "-i"];
		const proc = Bun.spawn(cmd, {
			cwd: this.opts.cwd ?? homedir(),
			env: shellEnv(this.opts.env),
			terminal: {
				cols,
				rows,
				data: (_term, bytes) => {
					let text = decoder.decode(bytes, { stream: true });
					if (this.secret) text = text.replaceAll(this.secret, "");
					if (text) this.emit({ type: "out", data: text });
				},
			},
		});
		this.proc = proc;
		void proc.exited.then(code => {
			if (this.proc !== proc) return;
			this.emit({ type: "exit", code });
		});
	}

	private emit(e: PtyEvent): void {
		if (e.type === "out") this.ring = (this.ring + e.data).slice(-RING_CHARS);
		for (const fn of this.subs) fn(e);
	}

	// Replay of what the shell printed so far, then live events until the returned function is called.
	subscribe(fn: (e: PtyEvent) => void): { backlog: string; off: () => void } {
		this.subs.add(fn);
		return { backlog: this.ring, off: () => void this.subs.delete(fn) };
	}

	write(data: string, secret = false): void {
		if (!this.alive) throw new Error("terminal is not running");
		if (data.length > INPUT_MAX) throw new Error("input too long");
		if (secret) {
			const text = data.replace(/[\r\n]/g, "");
			this.secret = text;
			clearTimeout(this.secretTimer);
			this.secretTimer = setTimeout(() => { this.secret = ""; }, SECRET_MS);
			this.proc!.terminal!.write(`${text}\r`);
			return;
		}
		this.proc!.terminal!.write(data);
	}

	resize(cols: number, rows: number): void {
		if (this.alive) this.proc!.terminal!.resize(cols, rows);
	}

	kill(): void {
		if (this.alive) this.proc!.kill();
	}

	async restart(): Promise<void> {
		const proc = this.proc;
		if (proc && this.alive) {
			proc.kill();
			await Promise.race([proc.exited, Bun.sleep(2000)]);
		}
		this.start();
	}
}

let shared: PtyHost | undefined;
const sharedHost = (): PtyHost => (shared ??= new PtyHost());

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
	const n = Math.round(Number(v));
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// A page of another origin (the browser sends Origin on every POST) must not drive the shell with the owner's identity.
const sameOrigin = (req: Request): boolean => {
	const origin = req.headers.get("origin");
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.get("host");
	} catch {
		return false;
	}
};

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function ptyRoute(req: Request, url: URL, host: PtyHost = sharedHost()): Promise<Response | undefined> {
	if (!url.pathname.startsWith("/api/pty/")) return undefined;
	if (!sameOrigin(req)) return json({ error: "cross-origin request" }, 403);
	const action = url.pathname.slice("/api/pty/".length);
	if (req.method === "GET" && action === "stream") {
		host.start(clamp(url.searchParams.get("cols"), 20, 300, 80), clamp(url.searchParams.get("rows"), 5, 120, 24));
		let off = () => {};
		let ping: ReturnType<typeof setInterval> | undefined;
		const stream = new ReadableStream<string>({
			start(c) {
				const sub = host.subscribe(e => {
					try {
						c.enqueue(e.type === "out" ? frame("out", { data: e.data }) : frame("exit", { code: e.code }));
					} catch {}
				});
				off = sub.off;
				c.enqueue(frame("reset", { data: sub.backlog, alive: host.alive }));
				ping = setInterval(() => { try { c.enqueue(": ping\n\n"); } catch {} }, PING_MS);
			},
			cancel() {
				off();
				clearInterval(ping);
			},
		});
		return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
	}
	if (req.method !== "POST") return json({ error: "not found" }, 404);
	if (!(req.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "content-type must be application/json" }, 415);
	let b: Record<string, unknown>;
	try {
		b = (await req.json()) as Record<string, unknown>;
	} catch {
		return json({ error: "invalid JSON" }, 400);
	}
	if (action === "input") {
		if (typeof b.data !== "string") return json({ error: "data must be a string" }, 400);
		try {
			host.write(b.data, b.secret === true);
		} catch (e) {
			return json({ error: (e as Error).message }, 409);
		}
		return json({ ok: true });
	}
	if (action === "resize") {
		host.resize(clamp(b.cols, 20, 300, 80), clamp(b.rows, 5, 120, 24));
		return json({ ok: true });
	}
	if (action === "restart") {
		await host.restart();
		return json({ ok: true });
	}
	return json({ error: "not found" }, 404);
}
