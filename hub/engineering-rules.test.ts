import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	boundaryEdges, ceilingsRaised, configImporters, cycles, deadExports, deadWebGlobals, duplicateGlobals, entryModules, freezeReport, helperCopies, hubWebImports, importGraph, longFunctions,
	nonAtomicWrites, oversizeFiles, pastedBlocks, prodOf, swallowedErrors, testTiming, treeDocs, unboundedCalls, unmappedModules, webJs, webStaticImports, type Src,
} from "./engineering-rules.ts";

// The detectors of hub/engineering-rules.ts proven on seeded violations. The same detectors measure the real tree in `bun hub/check.ts` (ceilings, lists, docs/engineering-standards.md).
type Counts = Record<string, number>;

// Seeded violations: each detector must flag the violation and leave its neighbour alone.
const src = (text: string, path = "hub/x.ts"): Src[] => [{ path, text }];
const twelve = Array.from({ length: 12 }, (_, i) => `const line${i} = ${i};`);
const graphOf = (files: Src[]) => importGraph(files);
const body = (n: number) => `function big() {\n${"\tx();\n".repeat(n)}}\n`;

describe("detectors can fail", () => {
	test("1 file size counts lines over the limit", () => {
		expect(oversizeFiles(src("a\n".repeat(801)), 800)).toEqual({ "hub/x.ts": 801 });
		expect(oversizeFiles(src("a\n".repeat(800)), 800)).toEqual({});
	});
	test("2 function size ends at the column-0 closer", () => {
		expect(longFunctions(src(body(300)), 300)).toEqual({ "hub/x.ts big": 302 });
		expect(longFunctions(src(body(10)), 300)).toEqual({});
		expect(longFunctions(src(`const f = () => 1;\nconst g = 2;\n${"x();\n".repeat(400)}}\n`), 300)).toEqual({});
	});
	test("3 cycles are components of two or more", () => {
		expect(cycles(new Map([["a", ["b"]], ["b", ["a"]], ["c", ["a"]]]))).toEqual(["a b"]);
		expect(cycles(new Map([["a", ["b"]], ["b", []]]))).toEqual([]);
	});
	test("3 type-only and dynamic imports are not edges", () => {
		const b = { path: "hub/b.ts", text: "export const b = 1;" };
		const edges = (text: string) => graphOf([{ path: "hub/a.ts", text }, b]).get("hub/a.ts");
		expect(edges(`import { b } from "./b.ts";`)).toEqual(["hub/b.ts"]);
		expect(edges(`import type { b } from "./b.ts";`)).toEqual([]);
		expect(edges(`import { type b } from "./b.ts";`)).toEqual([]);
		expect(edges(`const m = await import("./b.ts");`)).toEqual([]);
	});
	test("4 boundary edges are counted by top dir and by feature", () => {
		const g = new Map([["hub/a.ts", ["features/x/a.ts"]], ["features/x/a.ts", ["features/x/b.ts", "features/y/a.ts"]]]);
		expect(boundaryEdges(g)).toMatchObject({ "hub->features": 1, "feature->feature": 1, "extension->hub": 0 });
	});
	test("4 web code with a static import or a hub import of web/ is flagged", () => {
		expect(webStaticImports(src(`import { a } from "./b.js";`, "web/custom.js"))).toEqual(["web/custom.js"]);
		expect(webStaticImports(src(`const s = "import x from 'y'"; import("./b.js");`, "web/custom.js"))).toEqual([]);
		expect(hubWebImports(src(`import { a } from "../web/js/a.js";`))).toEqual(["hub/x.ts ../web/js/a.js"]);
		expect(hubWebImports(src(`import { a } from "./web-a.ts";`))).toEqual([]);
	});
	test("5 a column-0 name in two web/js files is flagged", () => {
		const two = [{ path: "web/js/a.js", text: "function f() {}\nconst g = 1;" }, { path: "web/js/b.js", text: "async function f() {}\n\tconst g = 2;" }];
		expect(duplicateGlobals(webJs(two))).toEqual(["f web/js/a.js web/js/b.js"]);
	});
	test("6 swallows count, explained ones do not", () => {
		const bad = "try { a(); } catch {}\ntry { a(); } catch (e) {\n\n}\nx.catch(() => {});\nx.catch(() => null);";
		expect(swallowedErrors(src(bad))).toEqual({ hub: 4 });
		const ok = "try { a(); } catch { /* gone */ }\ntry { a(); } catch (e) { log(e); }\nx.catch(e => log(e));\n// catch {}";
		expect(swallowedErrors(src(ok))).toEqual({});
	});
	test("7 plain writes count, tmp and rename and writeAtomic do not", () => {
		expect(nonAtomicWrites(src("writeFileSync(f, x);\nBun.write(f, x);\nawait writeFile(f, x);\nrenameSync(a, b);".replace("renameSync(a, b);", "\n\n\n\nrenameSync(a, b);")))).toEqual({ hub: 3 });
		expect(nonAtomicWrites(src("writeFileSync(tmp, x);"))).toEqual({});
		expect(nonAtomicWrites(src("writeFileSync(`${f}.tmp`, x);"))).toEqual({});
		expect(nonAtomicWrites(src("writeFileSync(f, x);\nrenameSync(a, b);"))).toEqual({});
		expect(nonAtomicWrites(src("appendFileSync(f, x);"))).toEqual({});
		expect(nonAtomicWrites(src("export function writeAtomic() {}\nwriteFileSync(f, x);"))).toEqual({});
	});
	test("8 unbounded calls count, bounded ones and web do not", () => {
		const bad = [`fetch(u);`, `fetch(u, { headers: "signal" });`, `Bun.spawn(["a"]);`, `execSync("x", { cwd });`];
		for (const call of bad) expect(unboundedCalls(src(call))).toEqual({ hub: 1 });
		const ok = [`fetch(u, { signal });`, "fetch(`${a}`, { signal: s });", `Bun.spawn(["a"], { timeout: 1 });`, `execFileSync("x", [], { killSignal: 9 });`, `spawn(lane, true);`, `fetch(req) {}`];
		for (const call of ok) expect(unboundedCalls(src(call))).toEqual({});
		expect(unboundedCalls(src(`fetch(u);`, "web/js/a.js"))).toEqual({});
	});
	test("9 fixed sleeps and wall-clock budgets count in tests", () => {
		const t = (text: string) => testTiming(src(text, "hub/a.test.ts"));
		expect(t("await Bun.sleep(50);\nawait sleep(10);\nawait new Promise(r => setTimeout(r, 20));").fixedSleeps).toBe(3);
		expect(t("await Bun.sleep(0);\nawait Bun.sleep(ms);").fixedSleeps).toBe(0);
		expect(t("const t = performance.now();\nexpect(t).toBeLessThan(5);").budgetFiles).toBe(1);
		expect(t("const t = performance.now();").budgetFiles).toBe(0);
	});
	test("10 an export named once is dead, a used one is not", () => {
		const lib = { path: "hub/lib.ts", text: "export const used = 1;\nexport function lone() {}\nexport type Shape = 1;" };
		const user = { path: "hub/user.ts", text: 'import { used, type Shape } from "./lib.ts";' };
		expect(deadExports(prodOf([lib, user]), [lib, user])).toEqual(["hub/lib.ts lone"]);
	});
	test("11 a web global named once is dead, one used in the markup is not", () => {
		const js = { path: "web/js/a.js", text: "function lone() {}\nfunction shown() {}" };
		const html = { path: "web/index.html", text: '<b onclick="shown()">' };
		expect(deadWebGlobals([js, html])).toEqual(["lone"]);
	});
	test("12 a hub module the map does not name is listed", () => {
		const prod = prodOf([{ path: "hub/a.ts", text: "" }, { path: "hub/b.ts", text: "" }, { path: "hub/c.ts", text: "" }]);
		expect(unmappedModules(prod, "- hub/b.ts is the b. Also sub-c.ts.")).toEqual(["a.ts", "c.ts"]);
	});
	test("13 a top-level helper copy counts, a nested one does not", () => {
		expect(helperCopies(src("const readJson = () => 1;\nexport async function sleep() {}")).readJson).toBe(1);
		expect(helperCopies(src("function f() {\n\tconst readJson = 1;\n}"))).toMatchObject({ readJson: 0, sleep: 0 });
	});
	test("15 a child started without an env that reaches hub/config.ts is flagged, also through another module; a child with an env, a clean child and a non-test spawner are not", () => {
		const tree: Src[] = [
			{ path: "hub/config.ts", text: "export const DATA_DIR = 1;" },
			{ path: "hub/mid.ts", text: 'import { DATA_DIR } from "./config.ts";' },
			{ path: "hub/by-path.ts", text: 'import "./mid.ts";' },
			{ path: "hub/by-script.ts", text: 'import "./mid.ts";' },
			{ path: "hub/with-env.ts", text: 'import "./mid.ts";' },
			{ path: "hub/clean.ts", text: "export const x = 1;" },
			{ path: "hub/prod-spawner.ts", text: 'Bun.spawn([process.execPath, join(import.meta.dir, "other.ts")]);' },
			{ path: "hub/other.ts", text: 'import "./mid.ts";' },
			{
				path: "hub/child.test.ts",
				text: [
					'const a = Bun.spawn([process.execPath, join(import.meta.dir, "by-path.ts")], { stdout: "pipe" });',
					"const script = `import { x } from ${JSON.stringify(join(import.meta.dir, 'by-script.ts'))};`;",
					'const b = Bun.spawnSync([process.execPath, "-e", script]);',
					'const c = Bun.spawn([process.execPath, join(import.meta.dir, "with-env.ts")], { env: { ...process.env, DOTZ_DIR: dir } });',
					'const d = Bun.spawn([process.execPath, join(import.meta.dir, "clean.ts")]);',
				].join("\n"),
			},
		];
		expect(entryModules(tree)).toEqual(["hub/by-path.ts", "hub/by-script.ts", "hub/clean.ts"]);
		expect(configImporters(tree)).toEqual(["hub/by-path.ts", "hub/by-script.ts"]);
	});
	test("14 a 12-line block in two files is one block, 11 lines or one file is none", () => {
		const two = (a: string[], b: string[]) => pastedBlocks([{ path: "hub/a.ts", text: a.join("\n") }, { path: "hub/b.ts", text: b.join("\n") }]);
		expect(two(twelve, ["const other = 1;", ...twelve])).toHaveLength(1);
		expect(two(twelve.slice(1), ["const other = 1;", ...twelve.slice(1)])).toEqual([]);
		expect(pastedBlocks(src([...twelve, ...twelve.map(l => `${l} // again`)].join("\n")))).toEqual([]);
	});
});

test("the doc listing works in a tree without git, like the pre-push hook's archive", () => {
	const root = mkdtempSync(join(tmpdir(), "tree-docs-"));
	try {
		mkdirSync(join(root, "sub"));
		mkdirSync(join(root, "node_modules/x"), { recursive: true });
		for (const f of ["a.md", "sub/b.md", "sub/c.txt", "node_modules/x/d.md"]) writeFileSync(join(root, f), f);
		expect(treeDocs(root).map(d => d.path).sort()).toEqual(["a.md", "sub/b.md"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


// The ceilings only go down: a commit that raises one, or adds a key the baseline has no ceiling for, is refused by .githooks/pre-push.
describe("ceiling freeze", () => {
	const base = { "hub/routes.ts": 1025, "hub/bgwork.ts": 400 };
	test("a raised ceiling is returned", () => {
		expect(ceilingsRaised(base, { ...base, "hub/routes.ts": 1050 })).toEqual([{ key: "hub/routes.ts", from: 1025, to: 1050 }]);
	});
	test("a key the baseline does not have is returned", () => {
		expect(ceilingsRaised(base, { ...base, "hub/new.ts": 810 })).toEqual([{ key: "hub/new.ts", from: undefined, to: 810 }]);
	});
	test("a lowered, equal or removed ceiling is allowed", () => {
		expect(ceilingsRaised(base, { "hub/routes.ts": 1000 })).toEqual([]);
		expect(ceilingsRaised(base, base)).toEqual([]);
		expect(ceilingsRaised(base, {})).toEqual([]);
	});
	const file = (groups: Record<string, Counts>) => JSON.stringify(groups);
	test("the report names each raised key as group key: a -> b and refuses", () => {
		const r = freezeReport(file({ fileLines: { "hub/a.ts": 900 } }), file({ fileLines: { "hub/a.ts": 925, "hub/b.ts": 850 } }));
		expect(r.ok).toBe(false);
		expect(r.lines).toEqual(["ceiling raised fileLines hub/a.ts: 900 -> 925", "ceiling raised fileLines hub/b.ts: none -> 850"]);
	});
	test("an allowlist's counts freeze the same way: a number, a map entry or a list entry; reasons and _rule are ignored", () => {
		const allow = (counts: object, reasons = {}) => JSON.stringify({ _rule: "r", counts, reasons });
		const base = allow({ goBranches: 48, rawNet: { "a.js": 2 }, overlaySites: ["overlay:x"] });
		expect(freezeReport(base, allow({ goBranches: 47, rawNet: { "a.js": 2 }, overlaySites: [] }, { "rawNet a.js": "why", "rawNet b.js": "new" })).ok).toBe(true);
		const r = freezeReport(base, allow({ goBranches: 49, rawNet: { "a.js": 3 }, overlaySites: ["overlay:x", "overlay:y"] }));
		expect(r.ok).toBe(false);
		expect(r.lines).toEqual(["ceiling raised goBranches: 48 -> 49", "ceiling raised rawNet a.js: 2 -> 3", "ceiling raised overlaySites overlay:y: none -> 1"]);
	});
	test("a new ownerWrites key passes only for an object the baseline owners file does not register", () => {
		const allow = (ownerWrites: Counts) => JSON.stringify({ _rule: "r", counts: { ownerWrites }, reasons: {} });
		const owners = JSON.stringify({ objects: { MON: ["30-monitoring.js"] }, lets: { target: ["04-state.js"] } });
		const base = allow({ "MON|a.js": 2 });
		expect(freezeReport(base, allow({ "MON|a.js": 2, "NT|b.js": 3 }), "allow", owners)).toEqual({ ok: true, lines: [] });
		expect(freezeReport(base, allow({ "MON|a.js": 2, "MON|b.js": 1, "target|b.js": 1 }), "allow", owners).lines).toEqual(["ceiling raised ownerWrites MON|b.js: none -> 1", "ceiling raised ownerWrites target|b.js: none -> 1"]);
		expect(freezeReport(base, allow({ "MON|a.js": 3 }), "allow", owners).lines).toEqual(["ceiling raised ownerWrites MON|a.js: 2 -> 3"]);
		expect(freezeReport(base, allow({ "MON|a.js": 2, "NT|b.js": 3 }), "allow").lines).toEqual(["ceiling raised ownerWrites NT|b.js: none -> 3"]);
	});
	test("an ownerWrites number may rise up to the baseline code recounted by the pushed rule, and no further", () => {
		const allow = (counts: object) => JSON.stringify({ _rule: "r", counts, reasons: {} });
		const owners = JSON.stringify({ objects: { MON: ["m.js"] }, lets: { CS: ["c.js"] } });
		const base = allow({ goBranches: 3, ownerWrites: { "CS|t.js": 1, "MON|a.js": 2 } });
		const recount = JSON.stringify({ "CS|t.js": 14, "CS|d.js": 4, "MON|a.js": 2 });
		expect(freezeReport(base, allow({ goBranches: 3, ownerWrites: { "CS|t.js": 14, "CS|d.js": 4, "MON|a.js": 2 } }), "allow", owners, recount))
			.toEqual({ ok: true, lines: ["recount allowed ownerWrites CS|t.js: 1 -> 14 (recount 14)", "recount allowed ownerWrites CS|d.js: none -> 4 (recount 4)"] });
		expect(freezeReport(base, allow({ goBranches: 3, ownerWrites: { "CS|t.js": 15, "CS|d.js": 4, "MON|a.js": 3 } }), "allow", owners, recount).lines)
			.toEqual(["ceiling raised ownerWrites CS|t.js: 1 -> 15", "ceiling raised ownerWrites MON|a.js: 2 -> 3", "recount allowed ownerWrites CS|d.js: none -> 4 (recount 4)"]);
		expect(freezeReport(base, allow({ goBranches: 3, ownerWrites: { "CS|t.js": 14 } }), "allow", owners).lines).toEqual(["ceiling raised ownerWrites CS|t.js: 1 -> 14"]);
		expect(freezeReport(base, allow({ goBranches: 4, ownerWrites: { "CS|t.js": 1 } }), "allow", owners, JSON.stringify({ goBranches: 9 })).lines).toEqual(["ceiling raised goBranches: 3 -> 4"]);
	});
	test("an unreadable baseline passes with one warning line", () => {
		for (const unreadable of [undefined, "", "not json", "[1]"]) {
			const r = freezeReport(unreadable, file({ fileLines: { "hub/a.ts": 925 } }));
			expect(r.ok).toBe(true);
			expect(r.lines).toHaveLength(1);
			expect(r.lines[0]).toMatch(/^pre-push: ceiling freeze skipped/);
		}
	});
});
