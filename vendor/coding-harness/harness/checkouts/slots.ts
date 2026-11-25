import { basename } from "node:path";

/** What a slot is doing: held by a session or a launch claim, holding work nobody holds, or safe to recreate. */
export type SlotState = "live" | "parked" | "free";

/** The part of an ovnfs listing row that decides slot ownership: the checkout's name and the folder it was made from. */
export interface SlotRow {
	readonly name: string;
	readonly source: string;
}

/** The inputs both pickers share: the folder's slug and real path, every listing row, and the state of each of this folder's slots by name. A slot of this folder without a state is never picked. */
export interface SlotView {
	readonly slug: string;
	readonly folder: string;
	readonly rows: readonly SlotRow[];
	readonly states: ReadonlyMap<string, SlotState>;
}

const SLUG_MAX = 48;

/** The name part of a slot for `folder`: its basename lowercased, every run of characters outside a-z0-9 turned into one `-`, the ends trimmed, cut to 48 characters (ovnfs refuses names over 64), `folder` when nothing is left. */
export function slugOf(folder: string): string {
	const slug = basename(folder)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/, "");
	return slug === "" ? "folder" : slug;
}

/** The checkout name of slot number `n` (1 or more) of the folder with `slug`. */
export function slotName(slug: string, n: number): string {
	return `main-${slug}-${n}`;
}

/** The slot number in `name` when it is exactly `slotName(slug, n)` for a positive integer written without leading zeros, else undefined. */
export function parseSlotName(name: string, slug: string): number | undefined {
	const prefix = `main-${slug}-`;
	if (!name.startsWith(prefix)) return undefined;
	const digits = name.slice(prefix.length);
	if (!/^[1-9][0-9]*$/.test(digits)) return undefined;
	const n = Number(digits);
	return Number.isSafeInteger(n) ? n : undefined;
}

/** `live` when anything holds the slot, else `parked` when removing it would lose work, else `free`. A live slot with work is live: the holder is working in it. */
export function classify(holders: readonly unknown[], work: { readonly work: boolean }): SlotState {
	if (holders.length > 0) return "live";
	return work.work ? "parked" : "free";
}

function ownSlots(view: SlotView): Map<number, SlotRow> {
	const own = new Map<number, SlotRow>();
	for (const row of view.rows) {
		const n = parseSlotName(row.name, view.slug);
		if (n !== undefined && row.source === view.folder) own.set(n, row);
	}
	return own;
}

/**
 * The slot a plain launch takes: the lowest number whose checkout is absent (`recreate` false) or free (`recreate` true).
 * A number that is live or parked, has no known state, or whose checkout has another folder as its `source` is skipped.
 */
export function pickNew(view: SlotView): { readonly n: number; readonly recreate: boolean } {
	const own = ownSlots(view);
	const taken = new Set(view.rows.map(row => row.name));
	for (let n = 1; ; n++) {
		const row = own.get(n);
		if (row === undefined) {
			if (!taken.has(slotName(view.slug, n))) return { n, recreate: false };
			continue;
		}
		if (view.states.get(row.name) === "free") return { n, recreate: true };
	}
}

/** The name of the folder's slot that `omp -c` continues: among its slots that are not live and have a session file, the one whose session bucket holds the newest file (`sessions` maps a slot name to that mtime); the lower number wins a tie. */
export function pickContinue(view: SlotView, sessions: ReadonlyMap<string, number>): string | undefined {
	let best: { readonly name: string; readonly n: number; readonly mtime: number } | undefined;
	for (const [n, row] of ownSlots(view)) {
		const state = view.states.get(row.name);
		const mtime = sessions.get(row.name);
		if (state === undefined || state === "live" || mtime === undefined) continue;
		if (best === undefined || mtime > best.mtime || (mtime === best.mtime && n < best.n)) best = { name: row.name, n, mtime };
	}
	return best?.name;
}
