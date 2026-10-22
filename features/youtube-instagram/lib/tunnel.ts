// Serves one local file on 127.0.0.1 under a random path token and exposes it through a `cloudflared tunnel --url` quick
// tunnel for the length of one Instagram upload (Reels need a public video URL). The spawner is injectable so tests use a
// fake cloudflared; the server and the process are always closed afterwards.
export type Proc = { lines: AsyncIterable<string>; kill: () => void };
export type Spawner = (argv: string[]) => Proc;

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const URL_TIMEOUT_MS = 30_000;
const SETTLE_MS = 3_000;

async function* mergedLines(streams: ReadableStream<Uint8Array>[]): AsyncGenerator<string> {
	const queue: string[] = [];
	let wake: (() => void) | undefined;
	let open = streams.length;
	for (const s of streams) {
		void (async () => {
			let buf = "";
			const dec = new TextDecoder();
			for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) {
				buf += dec.decode(chunk, { stream: true });
				const parts = buf.split("\n");
				buf = parts.pop() ?? "";
				queue.push(...parts);
				wake?.();
			}
			if (buf) queue.push(buf);
			open--;
			wake?.();
		})();
	}
	while (open > 0 || queue.length > 0) {
		if (queue.length === 0) await new Promise<void>(r => (wake = r));
		while (queue.length > 0) yield queue.shift() as string;
	}
}

export const realSpawner: Spawner = argv => {
	const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	return { lines: mergedLines([p.stdout, p.stderr]), kill: () => p.kill() };
};

async function publicUrl(proc: Proc, timeoutMs: number): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, rej) => {
		timer = setTimeout(() => rej(new Error("cloudflared did not report a tunnel URL in time")), timeoutMs);
	});
	const find = (async () => {
		for await (const line of proc.lines) {
			const m = URL_RE.exec(line);
			if (m) return m[0];
		}
		throw new Error("cloudflared exited without a tunnel URL");
	})();
	try {
		return await Promise.race([find, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export type TunnelOpts = { spawn?: Spawner; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };

// `fn` receives the public https URL of the file and the local one (for checks).
export async function withTunnel<T>(file: string, fn: (url: string, localUrl: string) => Promise<T>, opts: TunnelOpts = {}): Promise<T> {
	const token = crypto.randomUUID().replaceAll("-", "");
	const path = `/${token}.mp4`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: req => {
			if (new URL(req.url).pathname !== path || (req.method !== "GET" && req.method !== "HEAD")) return new Response("not found", { status: 404 });
			return new Response(req.method === "HEAD" ? null : Bun.file(file), { headers: { "Content-Type": "video/mp4", "Content-Length": String(Bun.file(file).size) } });
		},
	});
	const localUrl = `http://127.0.0.1:${server.port}${path}`;
	const proc = (opts.spawn ?? realSpawner)(["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${server.port}`]);
	try {
		const base = await publicUrl(proc, opts.timeoutMs ?? URL_TIMEOUT_MS);
		await (opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms))))(SETTLE_MS);
		return await fn(`${base}${path}`, localUrl);
	} finally {
		proc.kill();
		await server.stop(true);
	}
}
