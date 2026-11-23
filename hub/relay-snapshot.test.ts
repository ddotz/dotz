import { expect, test } from "bun:test";
import fc from "fast-check";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeSnapshot, encodeSnapshot, MAX_SNAPSHOT_CHARS, normalizeSnapshot, type Snapshot } from "./relay-snapshot.ts";

const ugly = fc.constantFrom("", "배포 점검", "build failed on main", 'a "quoted" line\nwith a break', join(homedir(), "notes.txt"), "someone@example.com");
const shortText = fc.oneof(fc.string({ unit: "grapheme", maxLength: 30 }), fc.string({ maxLength: 30 }), ugly);
const longText = fc.oneof(fc.string({ unit: "grapheme", minLength: 40, maxLength: 160, size: "max" }), ugly);
const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
const snapshotOf = (text: fc.Arbitrary<string>, rows: { minLength?: number; maxLength: number; size?: "max" }) =>
	fc.record({
		v: fc.constant(1),
		at: fc.integer({ min: 0, max: 4_102_444_800_000 }),
		projects: fc.array(fc.record({ key: text, name: text, note: maybe(text), live: maybe(fc.integer({ min: -2, max: 9 })) }), rows),
		sessions: fc.array(fc.record({ name: text, title: maybe(text), status: text, live: fc.boolean(), waiting: maybe(fc.boolean()), at: maybe(text) }), rows),
		monitors: fc.array(
			fc.record({
				name: text,
				kind: fc.constantFrom("watch", "schedule", "other"),
				result: maybe(fc.constantFrom("ok", "changed", "fail", "odd")),
				paused: maybe(fc.boolean()),
				conn: maybe(fc.constantFrom("connected", "disconnected")),
				last: maybe(text),
				next: maybe(text),
				summary: maybe(text),
			}),
			rows,
		),
		todos: fc.record({ open: fc.integer({ min: -1, max: 50 }), items: fc.array(text, { maxLength: 8 }) }),
		notices: fc.array(fc.record({ at: text, tone: text, title: text }), { maxLength: 8 }),
	});
const small = snapshotOf(shortText, { maxLength: 4 });
const large = snapshotOf(longText, { minLength: 8, maxLength: 30, size: "max" });
const prefix = fc.constantFrom("", "[b]", "[맥미니]");

const sent = (p: string, raw: unknown) => {
	const out = encodeSnapshot(p, raw);
	if (out === undefined) throw new Error("no message for a snapshot");
	const back = decodeSnapshot(p ? out.slice(p.length + 1) : out);
	if (!back) throw new Error("the message does not read back");
	return { out, back };
};
const bare = <T extends { note?: string; summary?: string }>({ note: _note, summary: _summary, ...rest }: T) => rest;
const cleaned = (raw: unknown): Snapshot => {
	const s = normalizeSnapshot(raw);
	if (!s) throw new Error("not a snapshot");
	return s;
};

test("a snapshot that fits reads back as the cleaned snapshot, with any reply prefix", () => {
	fc.assert(
		fc.property(prefix, small, (p, raw) => {
			const { out, back } = sent(p, raw);
			expect(out.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS);
			expect(back).toEqual(cleaned(raw));
		}),
		{ numRuns: 300 },
	);
});

test("a snapshot too long to fit is cut under the limit: the first rows of every list stay as they were, and a row is lost only after every line under a name is gone", () => {
	fc.assert(
		fc.property(prefix, large, (p, raw) => {
			const { out, back } = sent(p, raw);
			const want = cleaned(raw);
			expect(out.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS);
			expect(back.cut).toBe(true);
			expect(back.at).toBe(want.at);
			expect(back.todos.open).toBe(want.todos.open);
			expect(back.projects.map(bare)).toEqual(want.projects.slice(0, back.projects.length).map(bare));
			expect(back.monitors.map(bare)).toEqual(want.monitors.slice(0, back.monitors.length).map(bare));
			expect(back.sessions).toEqual(want.sessions.slice(0, back.sessions.length));
			expect(back.notices).toEqual(want.notices.slice(0, back.notices.length));
			expect(back.todos.items).toEqual(want.todos.items.slice(0, back.todos.items.length));
			expect(back.projects.map((x, i) => x.note ?? want.projects[i]?.note)).toEqual(want.projects.slice(0, back.projects.length).map(x => x.note));
			expect(back.monitors.map((x, i) => x.summary ?? want.monitors[i]?.summary)).toEqual(want.monitors.slice(0, back.monitors.length).map(x => x.summary));
			const lostRow = back.projects.length < want.projects.length || back.monitors.length < want.monitors.length || back.sessions.length < want.sessions.length || back.notices.length < want.notices.length || back.todos.items.length < want.todos.items.length;
			if (lostRow) expect([...back.projects.map(x => x.note), ...back.monitors.map(x => x.summary)].filter(x => x !== undefined)).toEqual([]);
		}),
		{ numRuns: 300 },
	);
});
