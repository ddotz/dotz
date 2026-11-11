// A queue of lanes that take turns: shift() gives each lane one item per round, in the order the lanes first had something waiting, so a lane with a
// long backlog never keeps another lane's single item behind it. push, shift and first(n) cost O(1) per item (O(n) for first), whatever the size.
type Lane<T> = { items: T[]; head: number };

const COMPACT_AT = 1024;
// Drops the consumed front of an array-backed queue once it is both long and mostly dead, so shifting stays O(1) without leaking.
const compacted = <T>(items: T[], head: number): [T[], number] => (head >= COMPACT_AT && head * 2 >= items.length ? [items.slice(head), 0] : [items, head]);

export class FairQueue<T extends object> {
	private lanes = new Map<string, Lane<T>>();
	private ring: string[] = [];
	private ringHead = 0;
	size = 0;

	push(lane: string, item: T): void {
		let l = this.lanes.get(lane);
		if (!l) {
			l = { items: [], head: 0 };
			this.lanes.set(lane, l);
			this.ring.push(lane);
		}
		l.items.push(item);
		this.size++;
	}

	shift(): T | undefined {
		if (this.ringHead >= this.ring.length) return undefined;
		const name = this.ring[this.ringHead++]!;
		const lane = this.lanes.get(name)!;
		const item = lane.items[lane.head++]!;
		this.size--;
		if (lane.head < lane.items.length) {
			this.ring.push(name);
			[lane.items, lane.head] = compacted(lane.items, lane.head);
		} else this.lanes.delete(name);
		[this.ring, this.ringHead] = compacted(this.ring, this.ringHead);
		return item;
	}

	/** The next `n` items in the order shift() would give them, left in the queue. */
	first(n: number): T[] {
		const out: T[] = [];
		for (let depth = 0; out.length < n && depth < n; depth++) {
			for (let i = this.ringHead; i < this.ring.length && out.length < n; i++) {
				const lane = this.lanes.get(this.ring[i]!)!;
				const item = lane.items[lane.head + depth];
				if (item !== undefined) out.push(item);
			}
		}
		return out;
	}
}
