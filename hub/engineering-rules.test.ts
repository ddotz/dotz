import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	boundaryEdges, cycles, deadExports, deadWebGlobals, duplicateGlobals, helperCopies, hubWebImports, importGraph, loadTree, longFunctions, metrics,
	nonAtomicWrites, oversizeFiles, pastedBlocks, prodOf, swallowedErrors, testTiming, unboundedCalls, unmappedModules, webJs, webStaticImports, type Src,
} from "./engineering-rules.ts";

// Repo-wide code health, measured on the real tree. Every ceiling below is what the detectors in engineering-rules.ts measured when the rule landed, so
// only new violations fail. A fix lowers the number (or removes the entry); never raise one to get a change past this test. A count that has dropped
// below its ceiling is logged by ratchet() so the ceiling can follow it down.
type Counts = Record<string, number>;
const M = metrics(loadTree(join(import.meta.dir, "..")));

// Files over 800 lines are one reviewer's working memory too many; each is capped at its size rounded up to the next 25, room for a fix, not a feature.
const FILE_LINE_LIMIT = 800;
const FILE_LINE_CEILINGS: Counts = {
	"extension/guard.ts": 1275, "hub/custom.ts": 925, "hub/discord.ts": 950, "hub/kakao/web.ts": 850, "hub/messenger-agent.ts": 875,
	"hub/orchestrator.ts": 1125, "hub/prompts.ts": 825, "hub/providers.ts": 825, "hub/routes.ts": 1150, "hub/selfupdate.ts": 1100, "web/js/30-kakao.js": 1200, "web/js/30-monitoring.js": 1200,
};
// A top-level function past 300 lines hides its own seams; same cap rule (next 25 up), key is `file name`.
const FN_LINE_LIMIT = 300;
const FN_LINE_CEILINGS: Counts = {
	"extension/guard.ts installGuard": 375, "hub/bgwork.ts createBgWork": 375, "hub/comments/engine.ts createEngine": 675, "hub/devices.ts createDevices": 325,
	"hub/kakao/web.ts createKakaoWeb": 700, "hub/messenger-agent.ts createAgentAdapter": 475, "hub/messenger-jandi.ts createJandiAdapter": 325,
	"hub/orchestrator.ts createOrchestrator": 1025, "hub/peer-monitor.ts createPeerMonitor": 400, "hub/prompts.ts createPrompts": 700, "hub/routes.ts makeRoute": 750,
	"web/js/07-board.js makeBoard": 375,
};
// Modules that import each other cannot be loaded, tested or replaced one by one; these are the cycles that exist today (members, sorted).
const IMPORT_CYCLES = [
	"features/youtube-instagram/lib/quota.ts features/youtube-instagram/lib/watchkit.ts",
	"hub/account-rules.ts hub/account-sticky.ts",
	"hub/api-budget.ts hub/fallback.ts hub/providers.ts",
	"hub/app-features.ts hub/monitors.ts hub/watch-scope.ts",
	"hub/laneevents.ts hub/lanefailover.ts hub/laneprompt.ts hub/lanereport.ts hub/lanerun.ts",
];
// Import edges (file to file) that cross a layer: the hub is the core, so a new edge into it from outside, or out of it into a feature, is a new coupling.
const BOUNDARY_CEILINGS: Counts = {
	"hub->features": 50, // the hub mounts feature routes and tools
	"hub->onboard": 7, // setup flows the hub triggers
	"hub->extension": 2, // shared guard code
	"extension->hub": 12, // the extension reuses hub helpers it cannot duplicate
	"onboard->hub": 1, // onboarding reads hub config
	"features->onboard": 2, // features reuse onboarding prompts
	"feature->feature": 18, // a feature importing another feature couples two things meant to be removable alone
};
// A swallowed error is a bug nobody sees. Per top dir: an empty catch or .catch(() => null) with no comment saying why the swallow is fine.
const SWALLOW_CEILINGS: Counts = { extension: 11, features: 28, hub: 194, onboard: 4, "setup.ts": 1, web: 78 };
// State a process can read back mid-write (a crash leaves half a file) must use writeAtomic from hub/config.ts; these are the plain writes left.
const NON_ATOMIC_WRITE_CEILINGS: Counts = { extension: 3, features: 8, hub: 43, onboard: 1, "setup.ts": 8 };
// A fetch or process call with no timeout or abort can hang its caller for good; the web page is excluded because the browser owns that.
const UNBOUNDED_CALL_CEILINGS: Counts = { extension: 2, features: 13, hub: 72, onboard: 7, "setup.ts": 5 };
// Timing assertions flake under load (the machine load average reaches 50 here) and fixed sleeps are luck, so tests wait on events instead.
const TEST_TIMING_CEILINGS: Counts = { fixedSleeps: 12, budgetFiles: 5 };
// Exports nothing refers to, not even their own file or a test; remove the export or the code (the entry is `file name`).
// stopAll stays until someone decides whether shutdown should call it (the messengers are never stopped today).
const DEAD_EXPORTS = ["hub/messenger.ts stopAll"];
// Page globals named once in the page, its markup, the hub tests and the site.
// The names left sit in files other work is changing right now; armExitGuard's comment says boot calls it, so that one may be a lost call, not dead code.
const DEAD_WEB_GLOBALS = ["NT_RESULT", "armExitGuard", "fillResult", "ntUnreadIn", "ntWait", "toolBox", "unrepNo"];
// docs/ARCHITECTURE.md is how one finds an existing feature before writing a second one; hub/*.ts files it does not name today, by count.
const UNMAPPED_MODULES = 151;
// A second private copy of a helper is how two paths drift; files defining each top-level helper today.
const HELPER_COPY_CEILINGS: Counts = { readJson: 13, json: 17, sameOrigin: 4, git: 7, shq: 5, sleep: 4 };
// A 12-line block pasted into two files gets fixed in one of them; blocks that exist today.
const PASTED_BLOCKS = 4;

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
	test("14 a 12-line block in two files is one block, 11 lines or one file is none", () => {
		const two = (a: string[], b: string[]) => pastedBlocks([{ path: "hub/a.ts", text: a.join("\n") }, { path: "hub/b.ts", text: b.join("\n") }]);
		expect(two(twelve, ["const other = 1;", ...twelve])).toHaveLength(1);
		expect(two(twelve.slice(1), ["const other = 1;", ...twelve.slice(1)])).toEqual([]);
		expect(pastedBlocks(src([...twelve, ...twelve.map(l => `${l} // again`)].join("\n")))).toEqual([]);
	});
});
