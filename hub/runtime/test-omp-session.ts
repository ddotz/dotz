import { cpSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures", "omp-sessions");
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

const filesOf = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? filesOf(join(dir, e.name)) : e.name.endsWith(".jsonl") ? [join(dir, e.name)] : []));
const lastStamp = (text: string): number => Math.max(0, ...(text.match(ISO) ?? []).map(s => Date.parse(s)));

export type OmpTree = { file: string; dir: string; transcript: (worker: string) => string };

/** The fixture `name` under `into`; its parent file's last row is `ageMs` old now. */
export function ompTree(name: string, into: string, ageMs = 10 * 60_000): OmpTree {
	const dir = join(into, name);
	mkdirSync(dirname(dir), { recursive: true });
	cpSync(join(FIXTURES, name), dir, { recursive: true });
	const file = filesOf(dir).find(f => dirname(f) === dir)!;
	const shift = Date.now() - ageMs - lastStamp(readFileSync(file, "utf8"));
	const anchor = (Date.now() - ageMs) / 1000;
	for (const f of filesOf(dir)) {
		const text = readFileSync(f, "utf8");
		writeFileSync(f, text.replace(ISO, s => new Date(Date.parse(s) + shift).toISOString()));
		const last = lastStamp(text);
		const at = last ? (last + shift) / 1000 : anchor;
		utimesSync(f, at, at);
	}
	return { file, dir, transcript: worker => join(file.slice(0, -".jsonl".length), `${worker}.jsonl`) };
}
