import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { listLines, PRIVACY_ALLOW } from "./public-scrub.ts";
import {
	boundaryEdges, ceilingsRaised, cycles, deadExports, deadWebGlobals, duplicateGlobals, freezeReport, helperCopies, hubWebImports, importGraph, isTest, loadTree, longFunctions, metrics,
	nonAtomicWrites, oversizeFiles, pastedBlocks, prodOf, swallowedErrors, testTiming, unboundedCalls, unmappedModules, webJs, webStaticImports, type Src,
} from "./engineering-rules.ts";

// Repo-wide code health, measured on the real tree. Every ceiling below is what the detectors in engineering-rules.ts measured when the rule landed, so
// only new violations fail. A fix lowers the number (or removes the entry); never raise one to get a change past this test. A count that has dropped
// below its ceiling is logged by ratchet() so the ceiling can follow it down.
type Counts = Record<string, number>;
// The ceilings live in hub/engineering-ceilings.json so .githooks/pre-push can read the same file at another commit and refuse a push that raises one. Their
// per-entry reasons stay as comments here by name where they matter: createPrompts 725 (a woken run's restated worker result stays with the conversation that got
// the first answer, resultTo); extension->hub 13 (the post-compaction recall renders state.json with the first message's renderState in hub/recall-parts.ts, not a copy).
const CEILINGS: Record<string, Counts> = JSON.parse(readFileSync(join(import.meta.dir, "engineering-ceilings.json"), "utf8"));
// The tree and its import graph are read once; rule 15 reuses both.
const TREE = loadTree(join(import.meta.dir, ".."));
const GRAPH = importGraph(prodOf(TREE));
const M = metrics(TREE, GRAPH);

// Files over 800 lines are one reviewer's working memory too many; each is capped at its size rounded up to the next 25, room for a fix, not a feature.
const FILE_LINE_LIMIT = 800;
const FILE_LINE_CEILINGS: Counts = CEILINGS.fileLines;
// A top-level function past 300 lines hides its own seams; same cap rule (next 25 up), key is `file name`.
const FN_LINE_LIMIT = 300;
const FN_LINE_CEILINGS: Counts = CEILINGS.functionLines;
// Modules that import each other cannot be loaded, tested or replaced one by one; these are the cycles that exist today (members, sorted).
const IMPORT_CYCLES = [
	"features/youtube-instagram/lib/quota.ts features/youtube-instagram/lib/watchkit.ts",
	"hub/account-rules.ts hub/account-sticky.ts",
	"hub/api-budget.ts hub/fallback.ts hub/providers.ts",
	"hub/app-features.ts hub/monitors.ts hub/watch-scope.ts",
	"hub/laneevents.ts hub/lanefailover.ts hub/laneprompt.ts hub/lanereport.ts hub/lanerun.ts",
];
// Import edges (file to file) that cross a layer: the hub is the core, so a new edge into it from outside, or out of it into a feature, is a new coupling.
const BOUNDARY_CEILINGS: Counts = CEILINGS.boundaries;
// A swallowed error is a bug nobody sees. Per top dir: an empty catch or .catch(() => null) with no comment saying why the swallow is fine.
const SWALLOW_CEILINGS: Counts = CEILINGS.swallowedErrors;
// State a process can read back mid-write (a crash leaves half a file) must use writeAtomic from hub/config.ts; these are the plain writes left.
const NON_ATOMIC_WRITE_CEILINGS: Counts = CEILINGS.nonAtomicWrites;
// A fetch or process call with no timeout or abort can hang its caller for good; the web page is excluded because the browser owns that.
const UNBOUNDED_CALL_CEILINGS: Counts = CEILINGS.unboundedCalls;
// Timing assertions flake under load (the machine load average reaches 50 here) and fixed sleeps are luck, so tests wait on events instead.
const TEST_TIMING_CEILINGS: Counts = CEILINGS.testTiming;
// Exports nothing refers to, not even their own file or a test; remove the export or the code (the entry is `file name`).
const DEAD_EXPORTS: string[] = [];
// Page globals named once in the page, its markup, the hub tests and the site.
const DEAD_WEB_GLOBALS: string[] = [];
// docs/ARCHITECTURE.md is how one finds an existing feature before writing a second one; hub/*.ts files it does not name today, by count.
const UNMAPPED_MODULES = CEILINGS.moduleMap.hub ?? 0;
// A second private copy of a helper is how two paths drift; files defining each top-level helper today.
const HELPER_COPY_CEILINGS: Counts = CEILINGS.helperCopies;
// A 12-line block pasted into two files gets fixed in one of them; blocks that exist today.
const PASTED_BLOCKS = CEILINGS.pastedBlocks.blocks ?? 0;

// hub/config.ts throws when it is imported under NODE_ENV=test with a real data dir (hub/live-guard.ts testDataRefusal). The suite's bunfig preload sets a temp
// DOTZ_DIR in process.env, but a child a test starts without an env option gets the environment bun started with: NODE_ENV=test from bun test, no temp data dir.
// So a module a test file starts that way (by path, or imported by a "-e" script) must not reach hub/config.ts. A spawn with an env option is the test's own choice
// of environment (process.env carries the temp dir) and is not counted. Entries are found in the test files' spawn calls, not listed by hand.
const CONFIG_MODULE = "hub/config.ts";
const SPAWN_CALL = /\b(?:Bun\.)?(?:spawnSync|spawn|execFileSync|execFile|execSync)\(/g;
const isTestSide = (p: string) => isTest(p) || /\.fixtures?\.ts$/.test(p) || /(?:^|\/)(?:test|fixtures)\//.test(p);
// End of the bracketed group opening at "from", or of the statement starting there (";" or a line end outside any bracket); quoted text is skipped.
const endOf = (text: string, from: number, group: boolean): number => {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const c = text[i] ?? "";
		if (c === '"' || c === "'" || c === "`") { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++; continue; }
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) { depth--; if (group && depth === 0) return i + 1; }
		else if (!group && (c === ";" || c === "\n") && depth <= 0) return i;
	}
	return text.length;
};
const entryModules = (files: readonly Src[]): string[] => {
	const prod = new Set(prodOf(files).filter(f => f.path.endsWith(".ts")).map(f => f.path));
	const found = new Set<string>();
	for (const f of files) {
		if (!isTestSide(f.path) || !f.path.endsWith(".ts")) continue;
		const dir = posix.dirname(f.path);
		// First "const|let id =" of the file per id, indexed once per file instead of one RegExp per identifier per spawn.
		let defs: Map<string, number> | undefined;
		const defEnd = (id: string): number | undefined => {
			if (!defs) {
				defs = new Map();
				for (const d of f.text.matchAll(/(?:const|let)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=/g)) if (!defs.has(d[1] ?? "")) defs.set(d[1] ?? "", d.index + d[0].length);
			}
			return defs.get(id);
		};
		for (const m of f.text.matchAll(SPAWN_CALL)) {
			const call = f.text.slice(m.index, endOf(f.text, m.index + m[0].length - 1, true));
			if (/\benv\b/.test(call)) continue;
			// A path or a "-e" script held in a variable counts through the variable's own assignment.
			let text = call;
			for (const id of new Set(call.match(/\b[A-Za-z_]\w*\b/g))) {
				const at = defEnd(id);
				if (at !== undefined) text += "\n" + f.text.slice(at, endOf(f.text, at, false));
			}
			for (const j of text.matchAll(/join\(\s*([\w.]+)\s*((?:,\s*"[^"]*")+)\s*\)/g)) {
				found.add(posix.join(j[1] === "import.meta.dir" ? dir : "", ...[...(j[2] ?? "").matchAll(/"([^"]*)"/g)].map(s => s[1] ?? "")));
			}
			for (const s of text.matchAll(/["'`]((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.ts)["'`]/g)) { found.add(posix.normalize(s[1] ?? "")); found.add(posix.join(dir, s[1] ?? "")); }
		}
	}
	return [...found].filter(p => prod.has(p) && p !== CONFIG_MODULE).sort();
};
const reaches = (graph: Map<string, string[]>, from: string, to: string): boolean => {
	const seen = new Set([from]), queue = [from];
	for (let v = queue.shift(); v !== undefined; v = queue.shift()) {
		if (v === to) return true;
		for (const w of graph.get(v) ?? []) if (!seen.has(w)) { seen.add(w); queue.push(w); }
	}
	return false;
};
const configImporters = (files: readonly Src[], graph = importGraph(prodOf(files))): string[] =>
	entryModules(files).filter(e => reaches(graph, e, CONFIG_MODULE));
// Child entries that reach hub/config.ts today; fix one by giving the child an env (or dropping the import), then remove it. Never add one to get a change past this test.
const CONFIG_IMPORTERS: string[] = [];

const ratchet = (what: string, measured: Counts, ceilings: Counts) => {
	for (const [k, ceil] of Object.entries(ceilings)) if ((measured[k] ?? 0) < ceil) console.info(`ratchet: ${what} ${k} is ${measured[k] ?? 0}, ceiling ${ceil}`);
};
const over = (what: string, measured: Counts, ceilings: Counts) =>
	Object.entries(measured).filter(([k, n]) => n > (ceilings[k] ?? 0)).map(([k, n]) => `${what} ${k} is ${n}, ceiling ${ceilings[k] ?? 0}`);
const overCeilings = (what: string, measured: Counts, ceilings: Counts): string[] => {
	ratchet(what, measured, ceilings);
	return over(what, measured, ceilings);
};
// Size rules list only what is over the limit: a listed entry that is no longer over must go. Their ceilings are rounded up, so no ratchet note.
const sizeErrors = (what: string, measured: Counts, ceilings: Counts, limit: number): string[] => [
	...over(what, measured, ceilings),
	...Object.keys(ceilings).filter(k => !(k in measured)).map(k => `${what} ${k} is at or under ${limit} now: remove it from the list`),
];
const listErrors = (what: string, measured: string[], frozen: string[]): string[] => [
	...measured.filter(x => !frozen.includes(x)).map(x => `new ${what}: ${x}`),
	...frozen.filter(x => !measured.includes(x)).map(x => `${what} is gone, remove it from the list: ${x}`),
];

describe("engineering rules on the real tree", () => {
	test("1 file size", () => expect(sizeErrors("file", M.fileLines, FILE_LINE_CEILINGS, FILE_LINE_LIMIT)).toEqual([]));
	test("2 top-level function size", () => expect(sizeErrors("function", M.longFunctions, FN_LINE_CEILINGS, FN_LINE_LIMIT)).toEqual([]));
	test("3 import cycles", () => expect(listErrors("cycle", M.importCycles, IMPORT_CYCLES)).toEqual([]));
	test("4 boundaries", () => {
		expect(overCeilings("edges", M.boundaries, BOUNDARY_CEILINGS)).toEqual([]);
		expect(M.webStaticImports).toEqual([]);
		expect(M.hubWebImports).toEqual([]);
	});
	test("5 web/js globals are unique", () => expect(M.webGlobalDuplicates).toEqual([]));
	test("6 swallowed errors", () => expect(overCeilings("swallowed", M.swallowedErrors, SWALLOW_CEILINGS)).toEqual([]));
	test("7 non-atomic writes", () => expect(overCeilings("writes", M.nonAtomicWrites, NON_ATOMIC_WRITE_CEILINGS)).toEqual([]));
	test("8 unbounded external calls", () => expect(overCeilings("calls", M.unboundedCalls, UNBOUNDED_CALL_CEILINGS)).toEqual([]));
	test("9 test timing", () => expect(overCeilings("tests", M.testTiming, TEST_TIMING_CEILINGS)).toEqual([]));
	test("10 dead exports", () => expect(listErrors("dead export", M.deadExports, DEAD_EXPORTS)).toEqual([]));
	test("11 dead web globals", () => expect(listErrors("dead web global", M.deadWebGlobals, DEAD_WEB_GLOBALS)).toEqual([]));
	test("12 module map", () => expect(overCeilings("unmapped", { hub: M.unmappedModules.length }, { hub: UNMAPPED_MODULES })).toEqual([]));
	test("13 same-name helpers", () => expect(overCeilings("copies", M.helperCopies, HELPER_COPY_CEILINGS)).toEqual([]));
	test("14 pasted blocks", () => expect(overCeilings("blocks", { blocks: M.pastedBlocks.length }, { blocks: PASTED_BLOCKS })).toEqual([]));
	test("15 a module a test starts as a child without an env does not reach hub/config.ts", () => {
		expect(listErrors("child entry importing hub/config.ts", configImporters(TREE, GRAPH), CONFIG_IMPORTERS)).toEqual([]);
	});
});

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

// The repo is public. The owner's personal terms live one per line in an untracked file, so this list stays private; without the file (CI) nothing is checked.
// A failure names the file and the term's line number, never the term.
// The markdown files of the tree: the tracked ones in a checkout, every one in an export with no git (the pre-push hook's `git archive` tree).
function treeDocs(root: string): Src[] {
	const paths = existsSync(join(root, ".git"))
		? execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8", timeout: 10_000 }).split("\n").filter(Boolean)
		: readdirSync(root, { recursive: true, encoding: "utf8" }).filter(p => p.endsWith(".md") && !p.split("/").includes("node_modules"));
	return paths.map(path => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

test("no term from the owner's local privacy list is in the tree", () => {
	const list = process.env.PRIVACY_TERMS_FILE ?? join(homedir(), ".dotz", "secrets", "privacy-terms.txt");
	if (!existsSync(list)) return;
	const terms = readFileSync(list, "utf8").toLowerCase().split("\n").map((t, i) => ({ line: i + 1, term: t.trim() })).filter(t => t.term);
	const allow = listLines(join(dirname(list), PRIVACY_ALLOW)).map(w => w.toLowerCase());
	const root = join(import.meta.dir, "..");
	const found = [...loadTree(root), ...treeDocs(root)].flatMap(src => {
		const text = allow.reduce((t, word) => t.replaceAll(word, " "), src.text.toLowerCase());
		return terms.filter(t => text.includes(t.term)).map(t => `${src.path}: term ${t.line}`);
	});
	expect(found).toEqual([]);
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
	test("an unreadable baseline passes with one warning line", () => {
		for (const unreadable of [undefined, "", "not json", "[1]"]) {
			const r = freezeReport(unreadable, file({ fileLines: { "hub/a.ts": 925 } }));
			expect(r.ok).toBe(true);
			expect(r.lines).toHaveLength(1);
			expect(r.lines[0]).toMatch(/^pre-push: ceiling freeze skipped/);
		}
	});
});
