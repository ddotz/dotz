// Per-cell values of one voice, computed from the stored per-document measurements (the texts are never read again). A cell is `ok` with enough
// text to trust the values, `direction` with values to read as a direction only, and `empty` with no values at all: another length's numbers are never lent.
import { type CellId, type Length, type Purpose, ALL_CELLS, lengthOf, parseCell, purposeOf } from "./cells.ts";
import { type Features, type Flat, flat, isDocumentKey, measure, percentile } from "./measure.ts";
import { chunkText, nonSpaceLength } from "./text.ts";

export type Kind = "self" | "other";
export type Source = "folder" | "file" | "url" | "blog" | "mail" | "messages" | "learn";
export type CellStatus = "ok" | "direction" | "empty";
export type DocRec = {
	id: string;
	origin: "scope" | "learn";
	target?: string;
	source: Source;
	chars: number;
	hangul: number;
	cell: CellId;
	features: Features;
	units: Flat[];
};
export type CellProfile = {
	id: CellId;
	status: CellStatus;
	docs: number;
	hangul: number;
	units: number;
	values?: Flat;
	ranges?: { s_mean: [number, number] };
	endingTop?: [string, number][];
	connectives?: [string, number][];
};
export type Profile = {
	voice: string;
	kind: Kind;
	builtAt: string;
	docs: number;
	counts: Partial<Record<CellId, number>>;
	cells: CellProfile[];
};

const FIELDS = Object.keys(flat(measure("")));
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Mail and messages only ever fill the short cells, whatever their length.
export function makeDoc(input: { id: string; origin: DocRec["origin"]; source: Source; text: string; hint?: string }): DocRec {
	const { text, source } = input;
	const chars = nonSpaceLength(text);
	const features = measure(text);
	const chunks = chunkText(text);
	const length: Length = source === "mail" || source === "messages" ? "short" : lengthOf(chars);
	const purpose: Purpose = purposeOf(text, input.hint);
	return {
		id: input.id,
		origin: input.origin,
		source,
		chars,
		hangul: features.hangul,
		cell: `${length}-${purpose}`,
		features,
		units: chunks.length > 1 ? chunks.map(c => flat(measure(c))) : [],
	};
}

export const unitsOf = (d: DocRec): Flat[] => (d.units.length ? d.units : [flat(d.features)]);

function statusOf(length: Length, docs: number, hangul: number, units: number): CellStatus {
	const enough = docs >= (length === "short" ? 30 : 3) || (length === "long" && hangul >= 50_000);
	if (enough && hangul >= 5000 && units >= 10) return "ok";
	return docs >= 3 ? "direction" : "empty";
}

function mergeTop(lists: readonly [string, number][][], n: number): [string, number][] {
	const sum = new Map<string, number>();
	for (const list of lists) for (const [k, c] of list) sum.set(k, (sum.get(k) ?? 0) + c);
	return [...sum].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
}

export function computeCell(docs: readonly DocRec[], id: CellId): CellProfile {
	const inCell = docs.filter(d => d.cell === id);
	const hangul = inCell.reduce((a, d) => a + d.hangul, 0);
	const unitFlats = inCell.flatMap(unitsOf);
	const length = parseCell(id)?.length ?? "short";
	const status = statusOf(length, inCell.length, hangul, unitFlats.length);
	const base = { id, status, docs: inCell.length, hangul, units: unitFlats.length };
	if (status === "empty") return base;
	const docFlats = inCell.map(d => flat(d.features));
	const values: Flat = {};
	for (const key of FIELDS) values[key] = r4(mean((isDocumentKey(key) ? docFlats : unitFlats).map(f => f[key] ?? 0)));
	const lengths = unitFlats.map(f => f.s_mean ?? 0).sort((a, b) => a - b);
	return {
		...base,
		values,
		ranges: { s_mean: [r4(percentile(lengths, 0.1)), r4(percentile(lengths, 0.9))] },
		endingTop: mergeTop(inCell.map(d => d.features.endingTop), 10),
		connectives: mergeTop(inCell.map(d => d.features.connectives), 10),
	};
}

export function cellCounts(docs: readonly DocRec[]): Partial<Record<CellId, number>> {
	const counts: Partial<Record<CellId, number>> = {};
	for (const d of docs) counts[d.cell] = (counts[d.cell] ?? 0) + 1;
	return counts;
}

export function buildProfile(input: { voice: string; kind: Kind; docs: readonly DocRec[]; cells: readonly CellId[]; now: Date }): Profile {
	return {
		voice: input.voice,
		kind: input.kind,
		builtAt: input.now.toISOString(),
		docs: input.docs.length,
		counts: cellCounts(input.docs),
		cells: ALL_CELLS.filter(id => input.cells.includes(id)).map(id => computeCell(input.docs, id)),
	};
}
