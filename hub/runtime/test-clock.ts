// Deterministic timers for the state-machine tests: setTimeout/setInterval/Date.now are replaced by a manual scheduler,
// so a scenario can move minutes forward instantly. Installed once by the test preload (test-setup.ts) before any hub
// module loads, because orchestrator.ts and lanes.ts register their intervals at import.
type Task = { id: number; at: number; fn: () => void; every?: number };

const tasks = new Map<number, Task>();
let seq = 0;
export const clock = { now: 1_800_000_000_000 };
const realSetImmediate = setImmediate;
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
		if (next.every) next.at += next.every;
		else tasks.delete(next.id);
		next.fn();
		await flush(3);
	}
	clock.now = target;
	await flush();
}
