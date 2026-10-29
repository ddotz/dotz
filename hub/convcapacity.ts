// How many conversation sessions (hub/convsessions.ts) may run at once on this computer, from what it has free right now instead of a
// fixed number (owner 2026-10-28: "동시 세션은 컴퓨터 리소스에 따라서 동적으로 조절해"). A sampler reads available memory, the load and
// the memory the live sessions really use every 30 s; the registry asks `max()` each time a session is about to start. The pure part
// (capacityFrom) is what the tests pin. `conversations.max_live` in config still fixes the number when the owner sets it.
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import { reserveGb } from "./limits.ts";

export type Sample = { availBytes: number; totalBytes: number; cpus: number; load1: number; live: number; perSessionBytes: number };
export type Capacity = { max: number; reason: string };

const GIB = 1024 ** 3;
// One OmO session on the Mac mini measured 2026-10-28: the senpi process 250-400 MB plus its model child 260-290 MB.
export const DEFAULT_SESSION_BYTES = 650 * 1024 ** 2;
const MIN_SESSION_BYTES = 300 * 1024 ** 2;
export const MAX_LIVE_CEILING = 12;

const mb = (b: number) => `${Math.round(b / 1024 ** 2)}MB`;

/** The live-session cap for one sample: what fits in available memory above a reserve, bounded by the CPUs and the current load. Never below 1. */
export function capacityFrom(s: Sample): Capacity {
	const per = Math.max(MIN_SESSION_BYTES, s.perSessionBytes || DEFAULT_SESSION_BYTES);
	// The rest of the computer (the owner's apps, main, lanes, workers) keeps the one reserve lanes keep too (hub/limits.ts reserveGb).
	const reserve = reserveGb(s.totalBytes / GIB) * GIB;
	const extra = Math.floor(Math.max(0, s.availBytes - reserve) / per);
	const byMem = s.live + extra;
	const cores = Math.max(1, s.cpus);
	// A busy computer starts no more than it already runs: a load above the core count means every core is taken.
	const byCpu = s.load1 > cores ? Math.max(1, s.live) : Math.max(1, Math.floor(cores * 0.75));
	const max = Math.min(MAX_LIVE_CEILING, Math.max(1, Math.min(byMem, byCpu)));
	const reason = `메모리 여유 ${mb(s.availBytes)} (예비 ${mb(reserve)}, 세션당 ${mb(per)}) → ${byMem}개, CPU ${cores}코어 · 부하 ${s.load1.toFixed(1)} → ${byCpu}개`;
	return { max, reason };
}

/** Memory the system can hand out now: free plus reclaimable pages (macOS vm_stat, Linux MemAvailable); os.freemem() elsewhere. */
export function availableBytes(vmStat?: string, meminfo?: string): number {
	if (vmStat !== undefined) {
		const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 4096);
		const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0);
		return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page;
	}
	if (meminfo !== undefined) {
		const kb = Number(/MemAvailable:\s+(\d+) kB/.exec(meminfo)?.[1] ?? NaN);
		if (Number.isFinite(kb)) return kb * 1024;
	}
	return freemem();
}

/** RSS (bytes) of each pid together with its whole process tree, from one `ps -axo pid=,ppid=,rss=` listing. */
export function treeRss(ps: string, roots: readonly number[]): number[] {
	const kids = new Map<number, number[]>();
	const rss = new Map<number, number>();
	for (const line of ps.split("\n")) {
		const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
		if (!pid || !Number.isFinite(kb)) continue;
		rss.set(pid, kb! * 1024);
		kids.set(ppid!, [...(kids.get(ppid!) ?? []), pid]);
	}
	return roots.map(root => {
		let sum = 0;
		const todo = [root];
		const seen = new Set<number>();
		while (todo.length) {
			const p = todo.pop()!;
			if (seen.has(p)) continue;
			seen.add(p);
			sum += rss.get(p) ?? 0;
			todo.push(...(kids.get(p) ?? []));
		}
		return sum;
	});
}

const run = async (cmd: string[]): Promise<string> => {
	try {
		const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(p.stdout).text();
		await p.exited;
		return out;
	} catch {
		return "";
	}
};

/**
 * The cap moves only when two samples in a row point the same way, and then by the smaller of the two steps, so a one-off reading (a
 * session still ramping up, a passing load spike) does not flip it: the Mac mini logged a new cap every 30 s between 2 and 7 (2026-10-29).
 */
export function settleMax(current: number | undefined, pending: number | undefined, next: number): { max: number; pending?: number } {
	if (current === undefined || next === current) return { max: next };
	if (pending !== undefined && Math.sign(pending - current) === Math.sign(next - current))
		return { max: Math.abs(pending - current) < Math.abs(next - current) ? pending : next };
	return { max: current, pending: next };
}

/** Keeps the latest sample; `livePids` are the conversation sessions running now. */
export function createCapacity(livePids: () => number[], log: (line: string) => void) {
	let last: Capacity | undefined;
	let lastMax = 0;
	let pending: number | undefined;
	async function sample(): Promise<Capacity> {
		const os = platform();
		const vm = os === "darwin" ? await run(["vm_stat"]) : undefined;
		let meminfo: string | undefined;
		if (os === "linux") {
			try {
				meminfo = readFileSync("/proc/meminfo", "utf8");
			} catch {}
		}
		const pids = livePids();
		const sizes = pids.length ? treeRss(await run(["ps", "-axo", "pid=,ppid=,rss="]), pids).filter(n => n > 0) : [];
		const per = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : DEFAULT_SESSION_BYTES;
		const raw = capacityFrom({ availBytes: availableBytes(vm || undefined, meminfo), totalBytes: totalmem(), cpus: cpus().length, load1: loadavg()[0] ?? 0, live: pids.length, perSessionBytes: per });
		const s = settleMax(last?.max, pending, raw.max);
		pending = s.pending;
		last = { max: s.max, reason: raw.reason };
		if (last.max !== lastMax) log(`conversation sessions: up to ${last.max} at once now (${last.reason})`);
		lastMax = last.max;
		return last;
	}
	return {
		sample,
		/** The cap from the latest sample; before the first one, a cautious 2. */
		max: (): number => last?.max ?? 2,
		view: (): Capacity => last ?? { max: 2, reason: "아직 측정 전" },
	};
}
