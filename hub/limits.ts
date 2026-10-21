// Dynamic limits (owner 2026-10-21: the number of sessions that may run at once follows the machine's resources). One agent
// (a lane, an orchestrator or a task worker) is a senpi process plus its claude child: ~1 GB, measured. The memory the owner's
// own apps and the OS need stays free: 25% of RAM or 8 GB, whichever is larger. What is left is `spare` (running agents are
// already out of `availableGb`; agents still starting are taken off as `ramping`); a lane takes one spare agent and, with its task workers, up to
// TYPICAL_WORKERS more. lanes.max_active and lanes.max_workers, when set in config.json, are hard caps on top of this, never
// fixed numbers. launch() and a lane's spawn call `limitsNow()` each time, so the answer follows the load of that moment.
import { readFileSync } from "node:fs";
import { availableParallelism, freemem, totalmem } from "node:os";

export const AGENT_GB = 1;
export const RESERVE_FRACTION = 0.25;
export const RESERVE_MIN_GB = 8;
// Workers one lane is planned for when lanes are counted (the former fixed default), and the ceilings with no config value.
export const TYPICAL_WORKERS = 2;
export const MAX_LANES = 16;
export const MAX_WORKERS = 8;
const GB = 2 ** 30;

export type Machine = { totalGb: number; availableGb: number; cpus: number };
export type Running = { lanes: number; workers: number; ramping?: number };
export type Caps = { lanes?: number; workers?: number };
export type WaitReason = "memory" | "cpu" | "cap";
export type Limits = {
	/** Most lanes that may run at once right now (the running ones included); a launch waits while running >= lanes. */
	lanes: number;
	/** Task workers one lane started now may run at once (OmO queues the rest). */
	workers: number;
	/** Agents that still fit in the budget. */
	spare: number;
	reserveGb: number;
	/** Why no further lane is allowed; unset while one more fits. */
	reason?: WaitReason;
};

export const reserveGb = (totalGb: number): number => Math.max(RESERVE_MIN_GB, totalGb * RESERVE_FRACTION);

const whole = (n: number | undefined): number | undefined => (typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined);

// Pure: the lanes and the per-lane workers this machine allows, given what already runs.
export function agentLimits(m: Machine, running: Running, caps: Caps = {}): Limits {
	const reserve = reserveGb(m.totalGb);
	const byMemory = Math.max(0, Math.floor((m.availableGb - (running.ramping ?? 0) * AGENT_GB - reserve) / AGENT_GB));
	const byCpu = Math.max(0, Math.floor(m.cpus) - running.lanes - running.workers);
	const spare = Math.min(byMemory, byCpu);
	const laneCap = Math.min(whole(caps.lanes) ?? MAX_LANES, MAX_LANES);
	const workerCap = Math.min(whole(caps.workers) ?? MAX_WORKERS, MAX_WORKERS);
	// A lane and its planned workers per spare agent group; one lane still starts when only its own agent fits.
	const fresh = spare >= 1 ? Math.max(1, Math.floor(spare / (1 + TYPICAL_WORKERS))) : 0;
	// With nothing running one lane is always allowed, so work cannot starve on a machine that is short of memory.
	const wanted = Math.max(running.lanes + fresh, running.lanes === 0 && running.workers === 0 ? 1 : 0);
	const lanes = Math.min(wanted, laneCap);
	const sharing = Math.max(1, running.lanes + Math.max(0, lanes - running.lanes));
	const workers = Math.max(1, Math.min(workerCap, Math.floor(Math.max(0, spare - Math.max(0, lanes - running.lanes)) / sharing)));
	const reason: WaitReason | undefined = running.lanes < lanes ? undefined : running.lanes >= laneCap ? "cap" : byMemory <= byCpu ? "memory" : "cpu";
	return { lanes, workers, spare, reserveGb: reserve, ...(reason ? { reason } : {}) };
}

// ---- reading the machine ---------------------------------------------------------------------------------------------

// macOS `vm_stat`: free + inactive + speculative pages are memory the system gives back on demand (os.freemem() counts only
// the free ones, 8.6 of 48 GB while 25 GB were reclaimable, measured 2026-10-21).
export function vmStatAvailableBytes(text: string): number | undefined {
	const page = /page size of (\d+) bytes/.exec(text)?.[1];
	const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(text)?.[1]);
	const free = pages("free");
	const inactive = pages("inactive");
	const speculative = pages("speculative");
	if (!page || [free, inactive, speculative].some(n => !Number.isFinite(n))) return undefined;
	return (free + inactive + speculative) * Number(page);
}

// macOS `memory_pressure`: "System-wide memory free percentage: 87%".
export function memoryPressureFreeFraction(text: string): number | undefined {
	const pct = /free percentage:\s*(\d+)%/.exec(text)?.[1];
	return pct === undefined ? undefined : Number(pct) / 100;
}

const run = (cmd: string[]): string => {
	try {
		const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 3000 });
		return r.exitCode === 0 ? r.stdout.toString() : "";
	} catch {
		return "";
	}
};

function availableBytes(total: number): number {
	if (process.platform === "darwin") {
		const reclaimable = vmStatAvailableBytes(run(["vm_stat"]));
		const fraction = memoryPressureFreeFraction(run(["memory_pressure"]));
		// The smaller of the two readings: a wrong high number would admit work the machine cannot hold.
		const readings = [reclaimable, fraction === undefined ? undefined : fraction * total].filter((n): n is number => n !== undefined);
		if (readings.length) return Math.min(...readings);
	} else if (process.platform === "linux") {
		try {
			const kb = Number(/MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]);
			if (Number.isFinite(kb)) return kb * 1024;
		} catch {}
	}
	return freemem();
}

export function readMachine(): Machine {
	const total = totalmem();
	return { totalGb: total / GB, availableGb: Math.min(total, availableBytes(total)) / GB, cpus: availableParallelism() };
}

// Tests pin the machine (test-setup.ts) so a lane launch never depends on the memory of the box running them.
let probe: (() => Machine) | undefined;
let sampled: { at: number; machine: Machine } | undefined;
export function setMachineProbe(fn: (() => Machine) | undefined): void {
	probe = fn;
	sampled = undefined;
}

/** `maxAgeMs` > 0 reuses a reading that young (the web page polls); a launch decision reads fresh. */
export function sampleMachine(maxAgeMs = 0): Machine {
	if (sampled && maxAgeMs > 0 && Date.now() - sampled.at < maxAgeMs) return sampled.machine;
	const machine = (probe ?? readMachine)();
	sampled = { at: Date.now(), machine };
	return machine;
}

/** The limits for this machine right now; `running` is what the gateway already runs. */
export const limitsNow = (running: Running, caps: Caps = {}, maxAgeMs = 0): Limits => agentLimits(sampleMachine(maxAgeMs), running, caps);

export function waitText(reason: WaitReason, caps: Caps = {}): string {
	if (reason === "memory") return "메모리 여유가 없어 대기 중";
	if (reason === "cpu") return "CPU 여유가 없어 대기 중";
	return `동시 세션 한도(${caps.lanes ?? MAX_LANES}개)에 도달해 대기 중`;
}
