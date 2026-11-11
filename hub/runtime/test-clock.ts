// Deterministic timers for the state-machine tests: setTimeout/setInterval/Date.now are replaced by a manual scheduler,
// so a scenario can move minutes forward instantly. Installed once by the test preload (test-setup.ts) before any hub
// module loads, because orchestrator.ts and lanes.ts register their intervals at import.
type Task = { id: number; at: number; fn: () => void; every?: number };

const tasks = new Map<number, Task>();
let seq = 0;
export const clock = { now: 1_800_000_000_000 };
const realSetImmediate = setImmediate;
// The real timers, for a deadline on a wait that the fake clock would never fire: a test's `setTimeout(() => reject(...), 5000)` hangs to
// the test timeout and names no step. Kept on globalThis so a preload run again in the same realm (--isolate) never captures the fakes.
const realTimers = ((globalThis as any)[Symbol.for("dotz.realTimers")] ??= { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }) as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
export const realSetTimeout: typeof setTimeout = realTimers.setTimeout;
export const realClearTimeout: typeof clearTimeout = realTimers.clearTimeout;
// Lets pending promise/stream continuations run (frames pushed into a fake stdout are read asynchronously).
export const flush = async (rounds = 6): Promise<void> => {
	for (let i = 0; i < rounds; i++) await new Promise<void>(r => realSetImmediate(r));
};

const handle = (id: number) => ({ id, unref() { return this; }, ref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]: () => id });
const add = (fn: () => void, ms: number, every?: number) => {
	const id = ++seq;
	tasks.set(id, { id, at: clock.now + Math.max(0, ms), fn, every });
	return handle(id);
};
const remove = (h: unknown) => {
	const id = typeof h === "object" && h ? (h as { id: number }).id : Number(h);
	tasks.delete(id);
};

export function installClock(): void {
	const g = globalThis as any;
	g.setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => add(() => fn(...args), ms);
	g.setInterval = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => add(() => fn(...args), ms, Math.max(1, ms));
	g.clearTimeout = g.clearInterval = remove;
	Date.now = () => clock.now;
}

// Runs every task due within `ms`, in time order, letting async continuations settle after each one.
export async function advance(ms: number): Promise<void> {
	const target = clock.now + ms;
	for (;;) {
		let next: Task | undefined;
		for (const t of tasks.values()) if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
		if (!next) break;
		clock.now = Math.max(clock.now, next.at);
		// A test that sets clock.now leaves an interval behind: like a real timer it fires once and goes on from now. Once per missed period
		// (20 days of a 1 s interval) ran past a later file's 5 s limit, in that file's first advance.
		if (next.every) next.at = clock.now + next.every;
		else tasks.delete(next.id);
		next.fn();
		await flush(3);
	}
	clock.now = target;
	await flush();
}
