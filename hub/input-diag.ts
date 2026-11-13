// The phone's input diagnostic reports (web/js/34-input-diag.js): a text field that lost focus by itself. One JSON line each in DATA_DIR/input-diag.jsonl, the
// newest INPUT_DIAG_CAP kept. Only the fields the page writes are kept, each cut to a length; a typed value has no field here, so none is stored.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export const INPUT_DIAG_CAP = 200;
export const INPUT_DIAG_BATCH = 200;
export const inputDiagFile = (): string => join(DATA_DIR, "input-diag.jsonl");

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const bool = (v: unknown): boolean => v === true;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** One entry of the page's shape reduced to known fields with length caps; null when it has no field to speak of. */
export function cleanInputDiagEntry(raw: unknown): Record<string, unknown> | null {
	const e = obj(raw), f = obj(e.field);
	if (!str(f.tag, 16)) return null;
	const data: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj(f.data)).slice(0, 8)) data[k.slice(0, 40)] = str(v, 40);
	const after = obj(e.after), vh = obj(e.vh);
	return {
		n: num(e.n), at: str(e.at, 32), kind: str(e.kind, 16), app: str(e.app, 40), vis: str(e.vis, 16), hasFocus: bool(e.hasFocus), active: str(e.active, 200),
		field: { sel: str(f.sel, 200), tag: str(f.tag, 16), type: str(f.type, 16), id: str(f.id, 40), name: str(f.name, 40), data, ce: bool(f.ce) },
		recent: list(e.recent, 12).map(r => ({ type: str(obj(r).type, 24), on: str(obj(r).on, 200) })),
		stack: list(e.stack, 8).map(l => str(l, 120)),
		connected: bool(e.connected), to: str(e.to, 200),
		after: { active: str(after.active, 200), activeIsField: bool(after.activeIsField), connected: bool(after.connected), replaced: bool(after.replaced), sameNodeFocused: bool(after.sameNodeFocused) },
		vh: { before: num(vh.before), after: num(vh.after) },
	};
}

/** Appends the clean entries of body.entries to the file and drops the oldest past the cap. Returns how many were kept from this request. */
export function addInputDiag(b: Record<string, unknown>, file = inputDiagFile()): number {
	const app = str(b.app, 40);
	const fresh = list(b.entries, INPUT_DIAG_BATCH).flatMap(r => {
		const c = cleanInputDiagEntry(r);
		return c ? [JSON.stringify({ ...c, app: c.app || app, got: new Date().toISOString() })] : [];
	});
	if (!fresh.length) return 0;
	const old = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
	if (old.length + fresh.length <= INPUT_DIAG_CAP) {
		appendFileSync(file, `${fresh.join("\n")}\n`);
		return fresh.length;
	}
	const kept = [...old, ...fresh].slice(-INPUT_DIAG_CAP);
	writeFileSync(`${file}.tmp`, `${kept.join("\n")}\n`);
	renameSync(`${file}.tmp`, file);
	return fresh.length;
}
