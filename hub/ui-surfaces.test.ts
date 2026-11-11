// The list of screens and in-app surfaces (hub/ui-surfaces.json) must name every opener site the extractor finds in web/, and nothing else.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { extractOpenSites } from "./ui-surfaces";

type Entry = { id: string; kind: string; sites: string[]; reach: string; why?: string };
const root = join(import.meta.dir, "..");
const list: Entry[] = await Bun.file(join(import.meta.dir, "ui-surfaces.json")).json();
const found = new Set(extractOpenSites(join(root, "web")).map(s => s.key));
const listed = new Map<string, string>();
for (const e of list) for (const k of e.sites) listed.set(k, e.id);

test("every opener site in web/ belongs to a list entry", () => {
	expect([...found].filter(k => !listed.has(k))).toEqual([]);
});

test("every list site key is still in web/", () => {
	expect([...listed.keys()].filter(k => !found.has(k))).toEqual([]);
});

test("a site key belongs to one entry only", () => {
	const seen = new Map<string, string>(), twice: string[] = [];
	for (const e of list) for (const k of e.sites) { if (seen.has(k)) twice.push(`${k} (${seen.get(k)}, ${e.id})`); else seen.set(k, e.id); }
	expect(twice).toEqual([]);
});

test("an entry that cannot be reached says why", () => {
	expect(list.filter(e => e.reach === "none" && !e.why).map(e => e.id)).toEqual([]);
});

test("entry ids are unique", () => {
	const ids = list.map(e => e.id);
	expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
});
