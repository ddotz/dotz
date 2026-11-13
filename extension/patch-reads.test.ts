import { describe, expect, test } from "bun:test";
import { expandCellVars, readPaths } from "./patch-reads.ts";

const ISO = "/iso";
const patchesIn = (code: string, known: Map<string, string>) => [...expandCellVars(code, known).matchAll(/(\/\S+?\.patch)\b/g)].map(m => m[1]);

describe("patch reads through joined names", () => {
	test.each([
		["Python join", "print(open(W + '/st_x/root.patch').read())"],
		["JS join", "const t = await Bun.file(W + \"/st_x/root.patch\").text();"],
		["join assigned first", "P = W + '/st_x/root.patch'\nprint(open(P).read())"],
	])("%s with a known W reads that patch", (_: string, code: string) => {
		const known = new Map([["W", ISO]]);
		expect(readPaths(expandCellVars(code, known), known)).toEqual([`${ISO}/st_x/root.patch`]);
	});

	test("an unknown variable still yields no path", () => {
		const known = new Map<string, string>();
		expect(readPaths(expandCellVars("print(open(W + '/st_x/root.patch').read())", known), known)).toEqual([]);
	});

	test("a Python join in the apply line names the real patch", () => {
		const known = new Map([["ISO", ISO]]);
		expect(patchesIn("print(sh('cd ' + WT + ' && git apply --3way ' + ISO + '/st_x/root.patch 2>&1'))", known)).toEqual([`${ISO}/st_x/root.patch`]);
	});

	test("globalThis.P = '...' is kept for a later cell", () => {
		const known = new Map<string, string>();
		expandCellVars(`globalThis.P1 = '${ISO}/st_x';`, known);
		expect(patchesIn("await sh(`git apply ${P1}/root.patch`)", known)).toEqual([`${ISO}/st_x/root.patch`]);
	});

	test("globalThis.P = P keeps the known path of P", () => {
		const known = new Map<string, string>();
		expandCellVars(`const iso = '${ISO}/st_x'; globalThis.iso = iso;`, known);
		expect(patchesIn("await sh(`git apply ${iso}/root.patch`)", known)).toEqual([`${ISO}/st_x/root.patch`]);
	});

	test.each([
		["JS for-of", 'for (const n of ["a", "b"]) await sh(`git apply ${PD}${n}.patch`);'],
		["Python for-in", "for n in ['a', 'b']:\n    sh('git apply ' + PD + n + '.patch')"],
		["shell for-in", "for n in a b; do git apply $PD$n.patch; done"],
	])("a %s loop variable names each listed patch", (_: string, code: string) => {
		expect(patchesIn(code, new Map([["PD", "/pd/"]]))).toEqual(expect.arrayContaining(["/pd/a.patch", "/pd/b.patch"]));
	});

	test("a loop line still names the patch as written, so a read and an apply through the same unresolved name match", () => {
		const read = patchesIn("for (const id of ['st_1']) print(await sh(`head ${ISO}/${id}/root.patch`));", new Map([["ISO", ISO]]));
		const applied = patchesIn("for (const [id] of Object.entries(m)) await sh(`git apply ${ISO}/${id}/root.patch`);", new Map([["ISO", ISO]]));
		expect(read).toEqual(expect.arrayContaining(applied));
	});
});
