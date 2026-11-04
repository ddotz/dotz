import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

// Repo-wide code health detectors for hub/engineering-rules.test.ts. Pure text and regex scans (no TypeScript compiler); imports come from
// Bun.Transpiler.scanImports. `bun hub/engineering-rules.ts --json` prints every metric, without the flag a short table.
// Prod scope: hub, extension, features, onboard, setup.ts, web/js, minus tests, test helpers and the generated web/js/01-notice-ko.js.

export type Src = { readonly path: string; readonly text: string };
type Counts = Record<string, number>;

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor"]);
const TREE_DIRS = ["hub", "extension", "features", "onboard", "web", "site"];
const ARCH = "docs/ARCHITECTURE.md";
const GENERATED = "web/js/01-notice-ko.js";
const SELF_TEST = "hub/engineering-rules.test.ts";
const PROD_ROOT = /^(?:hub|extension|features|onboard|web\/js)\/|^setup\.ts$/;

// Walks the file system (no git, so a tarball install works) and reads every .ts/.js/.html under the scanned dirs, plus setup.ts and the module map.
export function loadTree(root: string): Src[] {
	const out: Src[] = [];
	const add = (path: string) => out.push({ path, text: readFileSync(join(root, path), "utf8") });
	const walk = (dir: string) => {
		for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
			const path = `${dir}/${e.name}`;
			if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path); }
			else if (/\.(?:ts|js|html)$/.test(e.name)) add(path);
		}
	};
	for (const d of TREE_DIRS) if (existsSync(join(root, d))) walk(d);
	for (const f of ["setup.ts", ARCH]) if (existsSync(join(root, f))) add(f);
	return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export const isTest = (p: string) => p.endsWith(".test.ts");
const isSupport = (p: string) => /(?:^|\/)(?:test|fixtures)\/|(?:^|\/)test-[^/]*$/.test(p);
export const prodOf = (files: readonly Src[]) =>
	files.filter(f => /\.(?:ts|js)$/.test(f.path) && PROD_ROOT.test(f.path) && !isTest(f.path) && !isSupport(f.path) && f.path !== GENERATED);
export const topDir = (p: string) => (p.startsWith("web/") ? "web" : p.split("/")[0]);
const bump = (c: Counts, k: string, n = 1) => { if (n) c[k] = (c[k] ?? 0) + n; };
const sorted = (c: Counts): Counts => Object.fromEntries(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : 1)));

// Matches that do not sit on a comment-only line.
function* hits(text: string, re: RegExp): Generator<RegExpMatchArray & { index: number }> {
	for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
		const before = text.slice(text.lastIndexOf("\n", m.index - 1) + 1, m.index);
		if (!/^\s*(?:\/\/|\/?\*)/.test(before)) yield m as RegExpMatchArray & { index: number };
	}
}

// Balanced-paren scanner. From just after an opening "(" (or "${") to its closer, it returns the end index and the text with string, template
// and comment bodies blanked, so a keyword inside a string is not mistaken for code. Template expressions are scanned as code.
function scan(t: string, from: number, close: string): { end: number; code: string } {
	let i = from, depth = 0, code = "";
	while (i < t.length) {
		const c = t[i] ?? "", two = t.slice(i, i + 2);
		if (c === '"' || c === "'") {
			for (i++; i < t.length && t[i] !== c && t[i] !== "\n"; i += t[i] === "\\" ? 2 : 1);
			i++; code += " ";
		} else if (c === "`") {
			for (i++; i < t.length && t[i] !== "`";) {
				if (t[i] === "\\") i += 2;
				else if (t.slice(i, i + 2) === "${") { const r = scan(t, i + 2, "}"); code += ` ${r.code} `; i = r.end + 1; }
				else i++;
			}
			i++; code += " ";
		} else if (two === "//") { while (i < t.length && t[i] !== "\n") i++; }
		else if (two === "/*") { const e = t.indexOf("*/", i + 2); i = e < 0 ? t.length : e + 2; }
		else if ("([{".includes(c)) { depth++; code += c; i++; }
		else if (")]}".includes(c)) {
			if (depth === 0 && c === close) return { end: i, code };
			depth--; code += c; i++;
		} else { code += c; i++; }
	}
	return { end: t.length, code };
}

// Rule 1 and 2: size.
export const lineCount = (t: string) => t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
export const oversizeFiles = (prod: readonly Src[], limit: number): Counts =>
	Object.fromEntries(prod.map(f => [f.path, lineCount(f.text)] as const).filter(([, n]) => n > limit));

const FN_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)|^(?:export\s+)?const\s+([\w$]+)\b[^=\n]*=\s*(?:async\s+)?(?:\(|function\b|[\w$]+\s*=>)/;
const CLOSER = /^(?:\}|\};|\}\);)$/;
// A function or const-arrow at column 0, up to the next column-0 closer. A column-0 line that is not a closer, comment or `)` ends a one-liner early.
export function longFunctions(prod: readonly Src[], limit: number): Counts {
	const out: Counts = {};
	for (const { path, text } of prod) {
		const ls = text.split("\n");
		ls.forEach((l, i) => {
			const m = FN_START.exec(l);
			if (!m) return;
			let j = i + 1;
			while (j < ls.length && !CLOSER.test(ls[j] ?? "") && /^(?:$|[\s)\]]|\/\/)/.test(ls[j] ?? "")) j++;
			const n = CLOSER.test(ls[j] ?? "") ? j - i + 1 : j - i;
			if (n > limit) out[`${path} ${m[1] ?? m[2]}`] = Math.max(n, out[`${path} ${m[1] ?? m[2]}`] ?? 0);
		});
	}
	return out;
}

// Rule 3 and 4: import graph. Static value imports only; `import type` is already dropped by scanImports, a statement of only `type` members is dropped here.
const transpiler = new Bun.Transpiler({ loader: "ts" });
const scanImports = (text: string) => transpiler.scanImports(text.replace(/^#!.*/, ""));
const ALL_TYPE = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
export function staticImports(f: Src): string[] {
	const valued = new Map<string, boolean>();
	for (const m of f.text.matchAll(ALL_TYPE)) valued.set(m[2] ?? "", (valued.get(m[2] ?? "") ?? false) || !(m[1] ?? "").split(",").every(s => /^\s*(?:type\s|$)/.test(s)));
	return scanImports(f.text).filter(i => i.kind === "import-statement" && (valued.get(i.path) ?? true)).map(i => i.path);
}
export function importGraph(prod: readonly Src[]): Map<string, string[]> {
	const ts = prod.filter(f => f.path.endsWith(".ts"));
	const known = new Set(ts.map(f => f.path));
	const graph = new Map<string, string[]>();
	for (const f of ts) {
		const to = new Set<string>();
		for (const spec of staticImports(f)) {
			if (!spec.startsWith(".")) continue;
			const base = posix.join(posix.dirname(f.path), spec);
			const hit = [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, ".ts")].find(c => known.has(c));
			if (hit && hit !== f.path) to.add(hit);
		}
		graph.set(f.path, [...to].sort());
	}
	return graph;
}
// Tarjan: strongly connected components with more than one node, as sorted member lists joined by a space.
export function cycles(graph: Map<string, string[]>): string[] {
	const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out: string[] = [];
	const visit = (v: string) => {
		index.set(v, index.size); low.set(v, index.get(v) ?? 0); stack.push(v); on.add(v);
		for (const w of graph.get(v) ?? []) {
			if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0)); }
			else if (on.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
		}
		if (low.get(v) !== index.get(v)) return;
		const comp: string[] = [];
		for (let w = stack.pop(); w !== undefined; w = stack.pop()) { on.delete(w); comp.push(w); if (w === v) break; }
		if (comp.length > 1) out.push(comp.sort().join(" "));
	};
	for (const v of [...graph.keys()].sort()) if (!index.has(v)) visit(v);
	return out.sort();
}

const BOUNDARY_PAIRS = ["hub->features", "hub->onboard", "hub->extension", "extension->hub", "onboard->hub", "features->onboard"];
// File-to-file import edges by top dir, plus feature -> another feature.
export function boundaryEdges(graph: Map<string, string[]>): Counts {
	const out: Counts = Object.fromEntries([...BOUNDARY_PAIRS, "feature->feature"].map(k => [k, 0]));
	for (const [from, tos] of graph) for (const to of tos) {
		const pair = `${topDir(from)}->${topDir(to)}`;
		if (BOUNDARY_PAIRS.includes(pair)) bump(out, pair);
		if (topDir(from) === "features" && topDir(to) === "features" && from.split("/")[1] !== to.split("/")[1]) bump(out, "feature->feature");
	}
	return out;
}
const WEB_IMPORT = /^[ \t]*(?:import|export)\s+(?:[\w*${},\s]+?\s+from\s+)?["']\.{0,2}\//m;
export const webStaticImports = (files: readonly Src[]) =>
	files.filter(f => /^web\/(?:js\/[^/]+\.js|custom\.js|sw\.js)$/.test(f.path) && WEB_IMPORT.test(f.text)).map(f => f.path);
export const hubWebImports = (prod: readonly Src[]) =>
	prod.filter(f => f.path.startsWith("hub/") && f.path.endsWith(".ts"))
		.flatMap(f => scanImports(f.text).filter(i => i.path.startsWith(".") && posix.join(posix.dirname(f.path), i.path).startsWith("web/")).map(i => `${f.path} ${i.path}`));

// Rule 5 and 11: top-level names of the concatenated web/js script.
const GLOBAL_DECL = /^(?:async\s+function\*?|function\*?|class|const|let|var)\s+([\w$]+)/gm;
export const webJs = (files: readonly Src[]) => files.filter(f => /^web\/js\/[^/]+\.js$/.test(f.path) && f.path !== GENERATED);
export function webGlobals(web: readonly Src[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const f of web) for (const m of f.text.matchAll(GLOBAL_DECL)) {
		const files = out.get(m[1] ?? "") ?? [];
		if (!files.includes(f.path)) out.set(m[1] ?? "", [...files, f.path]);
	}
	return out;
}
export const duplicateGlobals = (web: readonly Src[]) =>
	[...webGlobals(web)].filter(([, files]) => files.length > 1).map(([name, files]) => `${name} ${files.join(" ")}`).sort();

// Rule 6: swallowed errors, per top dir. A comment inside the catch body means the swallow is explained.
const SWALLOW = /\bcatch\s*(?:\(\s*[\w$]*\s*\))?\s*\{\s*\}|\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|null|undefined)\s*\)/;
export function swallowedErrors(prod: readonly Src[]): Counts {
	const out: Counts = {};
	for (const f of prod) bump(out, topDir(f.path), [...hits(f.text, SWALLOW)].length);
	return sorted(out);
}

// Rule 7: non-atomic writes. Exempt: tmp/temp in the call, a renameSync within 3 lines after it, or the file that defines writeAtomic.
const WRITE = /(?<![\w$])(?:writeFileSync|writeFile|Bun\.write)\(/;
export function nonAtomicWrites(prod: readonly Src[]): Counts {
	const out: Counts = {};
	for (const { path, text } of prod) {
		if (/\b(?:function|const)\s+writeAtomic\b/.test(text)) continue;
		for (const m of hits(text, WRITE)) {
			const open = m.index + m[0].length;
			const { end } = scan(text, open, ")");
			if (/tmp|temp/i.test(text.slice(open, end)) || /renameSync/.test(text.slice(end).split("\n", 4).join("\n"))) continue;
			bump(out, topDir(path));
		}
	}
	return sorted(out);
}

// Rule 8: external calls with no timeout or abort, per top dir except web. A bare spawn( counts only with process options (stdout, cwd, env ...), since
// several modules have their own spawn(lane) helper.
const FETCH = /(?<![\w$.])fetch\(/;
const PROCESS = /(?<![\w$])(?:Bun\.)?(?:spawn|spawnSync|execSync|execFileSync)\(/;
export function unboundedCalls(prod: readonly Src[]): Counts {
	const out: Counts = {};
	for (const { path, text } of prod) {
		if (topDir(path) === "web") continue;
		const check = (re: RegExp, bounded: RegExp) => {
			for (const m of hits(text, re)) {
				if (/\bfunction\s+$/.test(text.slice(0, m.index))) continue;
				const { end, code } = scan(text, m.index + m[0].length, ")");
				if (/^\s*\{/.test(text.slice(end + 1)) || bounded.test(code)) continue;
				if (m[0] === "spawn(" && !/\b(?:stdout|stdin|stdio|cwd|env)\b/.test(code)) continue;
				bump(out, topDir(path));
			}
		};
		check(FETCH, /\b(?:signal|timeout)\b/);
		check(PROCESS, /\b(?:timeout|signal|killSignal)\b/);
	}
	return sorted(out);
}

// Rule 9: fixed sleeps and wall-clock budget assertions in tests. This file's own test carries seeded violations as strings and is skipped.
const SLEEP = /\bBun\.sleep(?:Sync)?\(\s*(\d[\d_]*)|(?<![\w$.])sleep\(\s*(\d[\d_]*)|new Promise\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*setTimeout\(\s*\3\s*,\s*(\d[\d_]*)/;
export function testTiming(files: readonly Src[]): { fixedSleeps: number; budgetFiles: number } {
	let fixedSleeps = 0, budgetFiles = 0;
	for (const { path, text } of files) {
		if (!isTest(path) || !PROD_ROOT.test(path) || path === SELF_TEST) continue;
		for (const m of hits(text, SLEEP)) if (Number((m[1] ?? m[2] ?? m[4] ?? "0").replace(/_/g, "")) > 0) fixedSleeps++;
		if (/performance\.now\(|Bun\.nanoseconds\(/.test(text) && /toBeLessThan/.test(text)) budgetFiles++;
	}
	return { fixedSleeps, budgetFiles };
}

// Rule 10 and 11: names with a single word occurrence over the corpus. This file's test lists the frozen names, so it is not part of the corpus.
const WORD = /[A-Za-z_$][\w$]*/g;
const wordCounts = (files: readonly Src[]) => {
	const c = new Map<string, number>();
	for (const f of files) if (f.path !== SELF_TEST) for (const m of f.text.matchAll(WORD)) c.set(m[0], (c.get(m[0]) ?? 0) + 1);
	return c;
};
const EXPORT_DECL = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|abstract\s+class|type|interface|enum)\s+([\w$]+)/gm;
export function deadExports(prod: readonly Src[], corpus: readonly Src[]): string[] {
	const words = wordCounts(corpus.filter(f => /\.(?:ts|js|html)$/.test(f.path)));
	return prod.flatMap(f => [...f.text.matchAll(EXPORT_DECL)].filter(m => words.get(m[1] ?? "") === 1).map(m => `${f.path} ${m[1]}`)).sort();
}
// site/demo is a built copy of the bundle, where every page name shows up a second time.
export function deadWebGlobals(files: readonly Src[]): string[] {
	const used = files.filter(f => /^(?:web\/js\/[^/]+\.js|web\/index\.html|web\/custom\.js|hub\/[^/]+\.test\.ts|site\/(?!demo\/).+\.(?:ts|js|html))$/.test(f.path));
	const words = wordCounts(used);
	return [...webGlobals(webJs(files)).keys()].filter(n => words.get(n) === 1).sort();
}

// Rule 12: hub/*.ts prod files whose file name the module map does not mention.
export function unmappedModules(prod: readonly Src[], arch: string): string[] {
	return prod.filter(f => /^hub\/[^/]+\.ts$/.test(f.path)).map(f => f.path.slice(4))
		.filter(n => !new RegExp(`(?<![\\w-])${n.replace(/\./g, "\\.")}(?![\\w-])`).test(arch)).sort();
}

// Rule 13: files defining a top-level helper of the given name.
export const HELPERS = ["readJson", "json", "sameOrigin", "git", "shq", "sleep"];
export function helperCopies(prod: readonly Src[]): Counts {
	const out: Counts = Object.fromEntries(HELPERS.map(n => [n, 0]));
	for (const f of prod) for (const n of HELPERS)
		if (new RegExp(`^(?:export\\s+)?(?:(?:async\\s+)?function\\*?\\s+${n}\\b|(?:const|let)\\s+${n}\\b)`, "m").test(f.text)) bump(out, n);
	return out;
}

// Rule 14: pasted blocks. A window is 12 consecutive normalised lines; windows seen in 2+ files are merged into runs, and a run is named by its first window.
const WINDOW = 12;
export function pastedBlocks(prod: readonly Src[]): string[] {
	const ids = new Map<string, number>();
	const seen = new Map<string, Set<string>>();
	const perFile = prod.map(f => {
		const ls = f.text.split("\n").map(l => l.trim().replace(/\s+/g, " ")).filter(l => l.length >= 4 && !/^import\b/.test(l));
		const keys: string[] = [];
		for (let i = 0; i + WINDOW <= ls.length; i++) {
			const key = ls.slice(i, i + WINDOW).map(l => ids.get(l) ?? ids.set(l, ids.size).get(l)).join(",");
			keys.push(key);
			(seen.get(key) ?? seen.set(key, new Set()).get(key))?.add(f.path);
		}
		return { path: f.path, keys, lines: ls };
	});
	const blocks = new Set<string>();
	for (const { path, keys, lines } of perFile)
		keys.forEach((k, i) => {
			if ((seen.get(k)?.size ?? 0) < 2 || (i > 0 && (seen.get(keys[i - 1] ?? "")?.size ?? 0) >= 2)) return;
			blocks.add(`${(lines[i] ?? "").slice(0, 60)} | ${[...seen.get(k) ?? []].join(" ")} | ${path}`);
		});
	return [...new Set([...blocks].map(b => b.slice(0, b.lastIndexOf(" | "))))].sort();
}

export function metrics(files: readonly Src[]) {
	const prod = prodOf(files);
	const graph = importGraph(prod);
	return {
		fileLines: sorted(oversizeFiles(prod, 800)),
		longFunctions: sorted(longFunctions(prod, 300)),
		importCycles: cycles(graph),
		boundaries: boundaryEdges(graph),
		webStaticImports: webStaticImports(files),
		hubWebImports: hubWebImports(prod),
		webGlobalDuplicates: duplicateGlobals(webJs(files)),
		swallowedErrors: swallowedErrors(prod),
		nonAtomicWrites: nonAtomicWrites(prod),
		unboundedCalls: unboundedCalls(prod),
		testTiming: testTiming(files),
		deadExports: deadExports(prod, files),
		deadWebGlobals: deadWebGlobals(files),
		unmappedModules: unmappedModules(prod, files.find(f => f.path === ARCH)?.text ?? ""),
		helperCopies: helperCopies(prod),
		pastedBlocks: pastedBlocks(prod),
	};
}

if (import.meta.main) {
	const m = metrics(loadTree(join(import.meta.dir, "..")));
	if (process.argv.includes("--json")) console.log(JSON.stringify(m, null, 2));
	else for (const [k, v] of Object.entries(m)) {
		console.log(`${k.padEnd(22)} ${Array.isArray(v) ? `${v.length} listed` : JSON.stringify(v).slice(0, 110)}`);
	}
}
