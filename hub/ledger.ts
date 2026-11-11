// The owner's work ledger: what he must handle, kept in one file (<data>/ledger.json, mode 600). No model call here; the day-before and morning
// notices that read it are hub/ledger-tick.ts, the tool and routes that fill it come from the agent (extension dotz_ledger, /api/ledger).
// The store is a factory over { file, now } so a test brings its own file and clock; every call reads the file and writes it back whole (a few
// dozen items at most), so a second process or a hand edit is never overwritten from a stale copy.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, readJsonOrQuarantine, writeAtomic } from "./config.ts";

export type LedgerSource = { kind: "conversation" | "mail"; /** The conversation target or the mail id. */ ref?: string; /** The project (ch:/th: target) the item belongs to. */ project?: string };
export type LedgerItem = {
	id: string;
	what: string;
	source: LedgerSource;
	/** Local date, YYYY-MM-DD. */
	due?: string;
	/** What to do next. */
	next?: string;
	state: "open" | "done" | "cancelled";
	created: string;
	closed?: string;
	told?: { before?: string; morning?: string };
};
export type LedgerInput = { what: string; source: LedgerSource; due?: string; next?: string };
export type LedgerEdit = { what?: string; source?: LedgerSource; due?: string | null; next?: string | null };
export type Ledger = {
	add(input: LedgerInput): LedgerItem;
	/** Open items first, by due date (none last), then by creation; closed items after them, newest closed first. */
	list(): LedgerItem[];
	done(id: string): LedgerItem;
	cancel(id: string): LedgerItem;
	/** `due` / `next` null clears the field; a changed due date clears the told marks. */
	edit(id: string, patch: LedgerEdit): LedgerItem;
	/** Records now as the time the items were told before / in the morning. */
	mark(ids: string[], kinds: ("before" | "morning")[]): void;
};

export function createLedger(deps: { file: string; now: () => number }): Ledger {
	const read = (): LedgerItem[] => readJsonOrQuarantine<LedgerItem[]>(deps.file, () => [], { keepGood: false });
	const write = (items: LedgerItem[]): void => writeAtomic(deps.file, `${JSON.stringify(items, null, 2)}\n`, 0o600);
	const stamp = (): string => new Date(deps.now()).toISOString();
	const change = (id: string, apply: (item: LedgerItem) => void): LedgerItem => {
		const items = read(), item = items.find(x => x.id === id);
		if (!item) throw new Error(`no ledger item ${id}`);
		apply(item);
		write(items);
		return item;
	};
	const close = (id: string, state: "done" | "cancelled"): LedgerItem => change(id, item => Object.assign(item, { state, closed: stamp() }));
	return {
		add(input) {
			const items = read();
			let id = randomBytes(3).toString("hex");
			while (items.some(x => x.id === id)) id = randomBytes(3).toString("hex");
			const item: LedgerItem = { id, what: input.what, source: input.source, ...(input.due ? { due: input.due } : {}), ...(input.next ? { next: input.next } : {}), state: "open", created: stamp() };
			write([...items, item]);
			return item;
		},
		list() {
			const open = read().filter(x => x.state === "open").sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.created.localeCompare(b.created));
			const closed = read().filter(x => x.state !== "open").sort((a, b) => (b.closed ?? "").localeCompare(a.closed ?? ""));
			return [...open, ...closed];
		},
		mark(ids, kinds) {
			const items = read(), at = stamp();
			for (const item of items) if (ids.includes(item.id)) item.told = { ...item.told, ...Object.fromEntries(kinds.map(k => [k, at])) };
			write(items);
		},
		done: id => close(id, "done"),
		cancel: id => close(id, "cancelled"),
		edit: (id, patch) =>
			change(id, item => {
				if (patch.what !== undefined) item.what = patch.what;
				if (patch.source !== undefined) item.source = patch.source;
				// A new due date is told again: the marks were for the old one.
				if (patch.due !== undefined && patch.due !== item.due) delete item.told;
				for (const key of ["due", "next"] as const) {
					if (patch[key] === null) delete item[key];
					else if (patch[key] !== undefined) item[key] = patch[key];
				}
			}),
	};
}

/** The gateway's ledger. */
export const ledger: Ledger = createLedger({ file: join(DATA_DIR, "ledger.json"), now: Date.now });

const pad = (n: number): string => String(n).padStart(2, "0");
/** The local date of `ms` (plus `plusDays`) as YYYY-MM-DD, the form a due date is kept in. */
export function localDate(ms: number, plusDays = 0): string {
	const d = new Date(ms);
	d.setDate(d.getDate() + plusDays);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
