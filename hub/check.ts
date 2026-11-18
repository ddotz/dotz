import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { designRuleFindings, dialogListFindings, iconFindings, transitionFindings } from "./design-rules.ts";
import { configImporters, importGraph, loadTree, metrics, privacyFindings, prodOf } from "./engineering-rules.ts";
import { hoverFindings } from "./hover-touch-css.ts";
import { areasFindings, completenessFindings, ownersFindings, ratchetFindings, recountWrites, screenFindings } from "./web-structure.ts";

// The repo and CSS lints that used to run as tests: they go red on code growth, not on a behavior regression, and every `bun test` re-scanned the tree.
//   bun hub/check.ts                       every check; exit 1 and one block per failed check, exit 0 when clean
//   bun hub/check.ts --rules               the repo-wide limits (rules 1-15, the privacy list, the gateway start path); the pre-push hook runs this
//   bun hub/check.ts --completeness        every top-level web/js name another file writes is owned or exempt (the pre-push hook)
//   bun hub/check.ts --recount <file>      writes the web files' ownerWrites counts to <file>, no check (the pre-push hook's baseline recount)
// Needs no node_modules and no browser. The detectors are hub/engineering-rules.ts, hub/design-rules.ts, hub/hover-touch-css.ts and hub/web-structure.ts; their
// own tests (seeded or planted violations) prove each can fail. The release gate (hub/release-gate.ts) runs this before the suite.
//
// Every ceiling below is what the detectors measured when the rule landed, so only new violations fail. A fix lowers the number (or removes the entry); never
// raise one to get a change past this check. A count that has dropped below its ceiling is printed as a ratchet note so the ceiling can follow it down.
type Counts = Record<string, number>;
// The ceilings live in hub/engineering-ceilings.json so .githooks/pre-push can read the same file at another commit and refuse a push that raises one. Their
// per-entry reasons stay as comments here by name where they matter: createPrompts 725 (a woken run's restated worker result stays with the conversation that got
// the first answer, resultTo); extension->hub 13 (the post-compaction recall renders state.json with the first message's renderState in hub/recall-parts.ts, not a copy).
const ROOT = join(import.meta.dir, "..");
const CEILINGS: Record<string, Counts> = JSON.parse(readFileSync(join(import.meta.dir, "engineering-ceilings.json"), "utf8"));

// Files over 800 lines are one reviewer's working memory too many; each is capped at its size rounded up to the next 25, room for a fix, not a feature.
const FILE_LINE_LIMIT = 800;
// A top-level function past 300 lines hides its own seams; same cap rule (next 25 up), key is `file name`.
const FN_LINE_LIMIT = 300;
// Modules that import each other cannot be loaded, tested or replaced one by one; these are the cycles that exist today (members, sorted).
const IMPORT_CYCLES = [
	"features/youtube-instagram/lib/quota.ts features/youtube-instagram/lib/watchkit.ts",
	"hub/account-rules.ts hub/account-sticky.ts",
	"hub/api-budget.ts hub/fallback.ts hub/providers.ts",
	"hub/app-features.ts hub/monitors.ts hub/watch-scope.ts",
	"hub/laneevents.ts hub/lanefailover.ts hub/laneprompt.ts hub/lanereport.ts hub/lanerun.ts",
];
// Import edges (file to file) that cross a layer: the hub is the core, so a new edge into it from outside, or out of it into a feature, is a new coupling.
// A swallowed error is a bug nobody sees. Per top dir: an empty catch or .catch(() => null) with no comment saying why the swallow is fine.
// State a process can read back mid-write (a crash leaves half a file) must use writeAtomic from hub/config.ts; these are the plain writes left.
// A fetch or process call with no timeout or abort can hang its caller for good; the web page is excluded because the browser owns that.
// Timing assertions flake under load (the machine load average reaches 50 here) and fixed sleeps are luck, so tests wait on events instead.
// Exports nothing refers to, not even their own file or a test; remove the export or the code (the entry is `file name`).
const DEAD_EXPORTS: string[] = [];
// Page globals named once in the page, its markup, the hub tests and the site.
const DEAD_WEB_GLOBALS: string[] = [];
// docs/ARCHITECTURE.md is how one finds an existing feature before writing a second one; hub/*.ts files it does not name today, by count.
const UNMAPPED_MODULES = CEILINGS.moduleMap?.hub ?? 0;
// A 12-line block pasted into two files gets fixed in one of them; blocks that exist today.
const PASTED_BLOCKS = CEILINGS.pastedBlocks?.blocks ?? 0;
// Child entries that reach hub/config.ts today; fix one by giving the child an env (or dropping the import), then remove it. Never add one to get a change past this check.
const CONFIG_IMPORTERS: string[] = [];

const notes: string[] = [];
const over = (what: string, measured: Counts, ceilings: Counts) =>
	Object.entries(measured).filter(([k, n]) => n > (ceilings[k] ?? 0)).map(([k, n]) => `${what} ${k} is ${n}, ceiling ${ceilings[k] ?? 0}`);
const overCeilings = (what: string, measured: Counts, ceilings: Counts): string[] => {
	for (const [k, ceil] of Object.entries(ceilings)) if ((measured[k] ?? 0) < ceil) notes.push(`ratchet: ${what} ${k} is ${measured[k] ?? 0}, ceiling ${ceil}`);
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

// Static imports only: what the gateway loads when it starts. hub/chart.ts must be reachable and load ztd-charts and resvg by dynamic import alone.
function gatewayStartImports(): string[] {
	const seen = new Set<string>(), found: string[] = [];
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm)) {
			const spec = (m[1] ?? m[2])!;
			if (/^(ztd-charts|@resvg\/|react)/.test(spec)) found.push(`the gateway start path imports ${spec} statically: ${file}`);
			if (spec.startsWith(".") && /\.ts$/.test(spec)) walk(resolve(dirname(file), spec));
		}
	};
	walk(join(import.meta.dir, "main.ts"));
	if (!seen.has(join(import.meta.dir, "chart.ts"))) found.push("hub/chart.ts is not reached from hub/main.ts");
	return found;
}

type Check = { name: string; run: () => string[] | Promise<string[]> };
// The tree and its import graph are read once; rule 15 reuses both.
function ruleChecks(): Check[] {
	const tree = loadTree(ROOT), graph = importGraph(prodOf(tree)), M = metrics(tree, graph);
	return [
		{ name: "1 file size", run: () => sizeErrors("file", M.fileLines, CEILINGS.fileLines ?? {}, FILE_LINE_LIMIT) },
		{ name: "2 top-level function size", run: () => sizeErrors("function", M.longFunctions, CEILINGS.functionLines ?? {}, FN_LINE_LIMIT) },
		{ name: "3 import cycles", run: () => listErrors("cycle", M.importCycles, IMPORT_CYCLES) },
		{
			name: "4 boundaries",
			run: () => [
				...overCeilings("edges", M.boundaries, CEILINGS.boundaries ?? {}),
				...M.webStaticImports.map(f => `web code with a static import: ${f}`),
				...M.hubWebImports.map(f => `hub imports web/: ${f}`),
				...gatewayStartImports(),
			],
		},
		{ name: "5 web/js globals are unique", run: () => M.webGlobalDuplicates },
		{ name: "6 swallowed errors", run: () => overCeilings("swallowed", M.swallowedErrors, CEILINGS.swallowedErrors ?? {}) },
		{ name: "7 non-atomic writes", run: () => overCeilings("writes", M.nonAtomicWrites, CEILINGS.nonAtomicWrites ?? {}) },
		{ name: "8 unbounded external calls", run: () => overCeilings("calls", M.unboundedCalls, CEILINGS.unboundedCalls ?? {}) },
		{ name: "9 test timing", run: () => overCeilings("tests", M.testTiming, CEILINGS.testTiming ?? {}) },
		{ name: "10 dead exports", run: () => listErrors("dead export", M.deadExports, DEAD_EXPORTS) },
		{ name: "11 dead web globals", run: () => listErrors("dead web global", M.deadWebGlobals, DEAD_WEB_GLOBALS) },
		{ name: "12 module map", run: () => overCeilings("unmapped", { hub: M.unmappedModules.length }, { hub: UNMAPPED_MODULES }) },
		{ name: "13 same-name helpers", run: () => overCeilings("copies", M.helperCopies, CEILINGS.helperCopies ?? {}) },
		{ name: "14 pasted blocks", run: () => overCeilings("blocks", { blocks: M.pastedBlocks.length }, { blocks: PASTED_BLOCKS }) },
		{ name: "15 a module a test starts as a child without an env does not reach hub/config.ts", run: () => listErrors("child entry importing hub/config.ts", configImporters(tree, graph), CONFIG_IMPORTERS) },
		// The repo is public; the owner's private term list is read from an untracked file and a failure names the file and the term's line number, never the term.
		{ name: "no term from the owner's local privacy list is in the tree", run: () => privacyFindings(tree, ROOT) },
	];
}

const CHECKS: Record<"rules" | "css" | "web" | "completeness", () => Check[]> = {
	rules: ruleChecks,
	css: () => [
		{ name: "web/DESIGN.md: the real CSS and scripts have no new violation", run: designRuleFindings },
		{ name: "web/DESIGN.md: only transform and opacity move in a transition", run: transitionFindings },
		{ name: "web/DESIGN.md: a list inside a dialog sets no height cap of its own", run: dialogListFindings },
		{ name: "web/DESIGN.md: icons are drawn at 14, 16 or 20px with a 1.75 or 2 stroke", run: iconFindings },
		{ name: "every :hover look rule is inside @media (hover: hover), so a tap leaves no hover behind", run: hoverFindings },
	],
	web: () => [
		{ name: "hub/web-areas.json names every web/js file once and registers the pending ones", run: areasFindings },
		{ name: "web/js and web/custom.js add no foreign state write, go() branch, raw overlay, raw request, current assignment or empty-state bypass", run: ratchetFindings },
		{ name: "hub/web-structure-owners.json names files that exist or are pending", run: ownersFindings },
		{ name: "rule A: only 03-screens.js declares or changes the screen lists, and its html rows match web/index.html", run: screenFindings },
	],
	completeness: () => [{ name: "completeness: every top-level name another file writes is owned or exempt in hub/web-structure-owners.json", run: completenessFindings }],
};

async function main(args: string[]): Promise<number> {
	const recount = args.indexOf("--recount");
	if (recount >= 0) {
		const file = args[recount + 1];
		if (!file) { console.error("check: --recount needs a file"); return 2; }
		recountWrites(file);
		return 0;
	}
	const only = (["rules", "completeness"] as const).filter(g => args.includes(`--${g}`));
	const unknown = args.filter(a => !["--rules", "--completeness"].includes(a));
	if (unknown.length) { console.error(`check: unknown argument ${unknown.join(" ")}`); return 2; }
	const groups = only.length ? only : (["rules", "css", "web", "completeness"] as const);
	let ran = 0, failed = 0;
	for (const group of groups) for (const check of CHECKS[group]()) {
		ran++;
		const found = await check.run();
		if (!found.length) continue;
		failed++;
		console.log(`FAIL ${check.name}`);
		for (const line of found) console.log(`  ${line}`);
	}
	for (const note of notes) console.log(note);
	console.log(failed ? `check: ${failed} of ${ran} checks failed` : `check: ${ran} checks passed`);
	return failed ? 1 : 0;
}

process.exit(await main(process.argv.slice(2)));
