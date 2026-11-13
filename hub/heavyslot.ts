// Machine-wide slot for heavy verification commands (tests, builds): sessions on one machine take turns instead of
// fighting for CPU and memory. A slot is a file linked into place atomically with its holder's pid, so it is never seen
// half-written. A slot whose holder died (or that outlived any run) is reclaimed. Waiting wakes on the directory's change
// events (a release in this process wakes its waiters directly: the OS watch can start too late to see it); a slow
// recheck only covers holders that die without releasing and a watch that missed a release. Only node builtins: hub/receipts.ts imports it.
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

const RECHECK_MS = 2000;
const localWaiters = new Set<() => void>();
const WAIT_MS = 20 * 60_000;
// Longer than the 15 min run limit in hub/receipts.ts: a slot this old belongs to no live run, even if its pid was reused.
export const MAX_HOLD_MS = 20 * 60_000;

// aborted: the signal ended the wait (the owner's stop); no slot is held and the caller does not run.
export type HeavySlot = { release: () => void; waitedMs: number; note?: string; aborted?: boolean };
type SlotOptions = { dir: string; label: string; slots?: number; timeoutMs?: number; maxHoldMs?: number; onWait?: (heldBy: string) => void; pid?: number; family?: number[]; signal?: AbortSignal };

export const heavySlots = (): number => Math.max(1, Math.floor(Number(process.env.DOTZ_HEAVY_SLOTS) || cpus().length / 4));

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

const read = (file: string): string | undefined => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
};

// Who holds the first slot, when it took it and what it runs, for the progress line of a waiter (and for a gate that counts its limit from the hold).
export const holderInfo = (dir: string): { pid: number; at: number; label: string } | undefined => {
	const [pid, at, , ...label] = (read(join(dir, "slot.1")) ?? "").split(" ");
	return at ? { pid: Number(pid), at: Number(at), label: label.join(" ") } : undefined;
};

// Holder line: "<pid> <takenAt ms> <uuid> <label>".
const stale = (holder: string, maxHoldMs: number): boolean => {
	const [pid, at] = holder.split(" ").map(Number);
	return !pidAlive(pid!) || !(Date.now() - at! < maxHoldMs);
};

const link = (from: string, to: string): boolean => {
	try {
		linkSync(from, to);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
};

// Two waiters may judge the same slot stale; the reap lock makes the second re-read it, so it never removes a slot a
// third process took in between.
function reap(dir: string, slot: string, holder: string, me: string): void {
	const lock = join(dir, "reap.lock");
	if (!link(me, lock)) {
		const other = read(lock);
		if (other === undefined || pidAlive(Number(other.split(" ")[0]))) return;
		try {
			unlinkSync(lock);
		} catch {}
		if (!link(me, lock)) return;
	}
	try {
		if (read(slot) === holder) unlinkSync(slot);
	} finally {
		unlinkSync(lock);
	}
}

export async function acquireHeavySlot(o: SlotOptions): Promise<HeavySlot> {
	const slots = o.slots ?? heavySlots();
	const maxHoldMs = o.maxHoldMs ?? MAX_HOLD_MS;
	mkdirSync(o.dir, { recursive: true });
	const owner = `${o.pid ?? process.pid} ${Date.now()} ${randomUUID()} ${o.label.replace(/\s+/g, " ").slice(0, 120)}`;
	const me = join(o.dir, `.${randomUUID()}.tmp`);
	writeFileSync(me, owner);
	let heldBy = "";
	const attempt = (): string | undefined => {
		for (let n = 1; n <= slots; n++) {
			const slot = join(o.dir, `slot.${n}`);
			if (link(me, slot)) return slot;
			const holder = read(slot);
			if (o.family?.some(pid => holder?.startsWith(`${pid} `))) return slot; // held by this run or by what started it: waiting would wait for itself
			if (holder !== undefined && stale(holder, maxHoldMs)) reap(o.dir, slot, holder, me);
			else if (holder) heldBy ||= holder.split(" ").slice(3).join(" ");
			if (link(me, slot)) return slot;
		}
		return undefined;
	};
	const started = Date.now();
	let slot: string | undefined;
	let aborted = false;
	try {
		slot = attempt();
		if (!slot && o.signal?.aborted) aborted = true;
		else if (!slot) {
			o.onWait?.(heldBy);
			const { promise, resolve } = Promise.withResolvers<string | undefined>();
			let done = false;
			const finish = (s: string | undefined) => {
				if (done) return;
				done = true;
				resolve(s);
			};
			const check = () => {
				if (done) return;
				const s = attempt();
				if (s) finish(s);
			};
			const watcher = watch(o.dir, check);
			localWaiters.add(check);
			const tick = setInterval(check, RECHECK_MS);
			const limit = setTimeout(() => finish(undefined), o.timeoutMs ?? WAIT_MS);
			const onAbort = () => {
				aborted = true;
				finish(undefined);
			};
			o.signal?.addEventListener("abort", onAbort, { once: true });
			check(); // a release between the first attempt and the watch registration fires no event
			slot = await promise;
			o.signal?.removeEventListener("abort", onAbort);
			watcher.close();
			localWaiters.delete(check);
			clearInterval(tick);
			clearTimeout(limit);
		}
	} finally {
		unlinkSync(me);
	}
	const waitedMs = Date.now() - started;
	const who = heldBy ? ` (held by ${heldBy.slice(0, 80)})` : "";
	const note = aborted ? undefined : !heldBy && slot ? undefined : slot ? `waited ${(waitedMs / 1000).toFixed(1)}s for heavy slot${who}` : `heavy slot wait timed out after ${Math.round(waitedMs / 1000)}s${who}; ran anyway`;
	const held = slot;
	return {
		waitedMs,
		note,
		...(aborted ? { aborted } : {}),
		release: () => {
			if (!held || read(held) !== owner) return;
			unlinkSync(held);
			for (const wake of [...localWaiters]) wake();
		},
	};
}
