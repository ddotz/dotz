// Measurement helpers of the load harness: latency percentiles, timed HTTP calls with payload size, process RSS, and a
// before/after snapshot of a data dir to see which files one operation rewrote.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Stat = { n: number; p50: number; p95: number; max: number; min: number };
export type Timed = { ms: number; status: number; bytes: number; gzipBytes?: number };

/** Nearest-rank percentile of a sorted list. */
const rank = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
export function stat(samples: number[]): Stat {
	const s = [...samples].sort((a, b) => a - b);
	const r = (x: number) => Math.round(x * 100) / 100;
	return { n: s.length, p50: r(rank(s, 50)), p95: r(rank(s, 95)), max: r(s.at(-1) ?? 0), min: r(s[0] ?? 0) };
}

export type Call = { method?: string; path: string; body?: unknown; headers?: Record<string, string> };

/** One timed request. `bytes` is the decoded body, `gzipBytes` the bytes on the wire when the server compressed it. */
export async function timed(base: string, c: Call, headers: Record<string, string> = {}): Promise<Timed> {
	const t0 = performance.now();
	const res = await fetch(base + c.path, {
		method: c.method ?? "GET",
		headers: { ...headers, ...c.headers, ...(c.body !== undefined ? { "content-type": "application/json" } : {}), "accept-encoding": "gzip" },
		...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
	});
	const buf = await res.arrayBuffer();
	const ms = performance.now() - t0;
	const wire = Number(res.headers.get("content-length") ?? 0) || undefined;
	return { ms, status: res.status, bytes: buf.byteLength, ...(wire && res.headers.get("content-encoding") ? { gzipBytes: wire } : {}) };
}

/** `samples` sequential calls (one warm-up call is dropped); build(i) makes the call so a POST can carry a fresh body. */
export async function sample(base: string, samples: number, build: (i: number) => Call, headers: Record<string, string> = {}) {
	await timed(base, build(-1), headers);
	const ms: number[] = [], bytes: number[] = [], statuses: Record<number, number> = {};
	let gzip = 0;
	for (let i = 0; i < samples; i++) {
		const t = await timed(base, build(i), headers);
		ms.push(t.ms);
		bytes.push(t.bytes);
		gzip = t.gzipBytes ?? gzip;
		statuses[t.status] = (statuses[t.status] ?? 0) + 1;
	}
	return { latency_ms: stat(ms), bytes: stat(bytes).p50, ...(gzip ? { gzip_bytes: gzip } : {}), statuses };
}

/** Resident set size of a process in MB (ps reports KB). */
export async function rssMb(pid: number): Promise<number> {
	const p = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe" });
	const kb = Number((await new Response(p.stdout).text()).trim());
	await p.exited;
	return Math.round((kb / 1024) * 10) / 10;
}

/** Peak RSS over a window, sampled every `everyMs` until stop() is called. */
export function watchRss(pid: number, everyMs = 250) {
	let peak = 0, stopped = false;
	const loop = (async () => {
		while (!stopped) {
			peak = Math.max(peak, await rssMb(pid).catch(() => 0));
			await Bun.sleep(everyMs);
		}
	})();
	return { async stop() { stopped = true; await loop; return peak; } };
}

export type FileStat = { size: number; mtimeMs: number };
export function snapshot(dir: string, depth = 2): Map<string, FileStat> {
	const out = new Map<string, FileStat>();
	const walk = (d: string, level: number) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) { if (level < depth) walk(p, level + 1); }
			else if (e.isFile()) { const s = statSync(p); out.set(p, { size: s.size, mtimeMs: s.mtimeMs }); }
		}
	};
	walk(dir, 0);
	return out;
}

/** Files that changed or appeared between two snapshots, with their size at the end. */
export function rewritten(before: Map<string, FileStat>, after: Map<string, FileStat>): Array<{ file: string; bytes: number }> {
	const out: Array<{ file: string; bytes: number }> = [];
	for (const [file, s] of after) {
		const b = before.get(file);
		if (!b || b.mtimeMs !== s.mtimeMs || b.size !== s.size) out.push({ file, bytes: s.size });
	}
	return out.sort((a, b) => b.bytes - a.bytes);
}
