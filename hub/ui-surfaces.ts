import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every place web/js and web/index.html can put something on screen: go() to a view, a dialog, a sheet, a menu, a toast, the palette, a
// floating card. hub/ui-surfaces.json names each one; hub/ui-surfaces.test.ts fails when a site is in the code but not in the list, or the
// other way round. A site key is `kind:enclosing top-level name[:literal argument][#n]`: it survives line moves, and a new opener (even a
// second one in an old function) gets a new key. web/js is one global scope, so top-level names are unique.
export type Site = { key: string; kind: string; file: string; line: number; look?: string };

// Opener patterns: the call, and the argument that names it. `own` names the functions that implement the opener or shadow its name with a local, whose inner calls are not sites.
const CALLS: { kind: string; re: RegExp; arg?: "title" | "first" | "label" | "go"; own?: string[] }[] = [
	{ kind: "go", re: /(?<![\w.$])go\(/g, arg: "go", own: ["go", "api", "pendingLoginAsk"] },
	{ kind: "dialog", re: /(?<![\w.$])dialog\(/g, arg: "title", own: ["dialog", "ask"] },
	{ kind: "fsOpen", re: /(?<![\w.$])fsOpen\(/g, arg: "label" },
	{ kind: "ask", re: /(?<![\w.$])ask\(/g, arg: "first", own: ["cmPaint"] },
	{ kind: "menu", re: /(?<![\w.$])showMenu\(/g, own: ["selectButton"] },
	{ kind: "select", re: /(?<![\w.$])selectButton\(/g, arg: "label", own: ["selectField"] },
	{ kind: "select", re: /(?<![\w.$])selectField\(/g, arg: "first" },
	{ kind: "toast", re: /(?<![\w.$])toast\(/g },
	{ kind: "palette", re: /(?<![\w.$])openPalette\(/g },
	{ kind: "rawdialog", re: /\.showModal\(/g, own: ["dialog", "openPalette"] },
	{ kind: "overlay", re: /(?<![\w.$])ovOpen\(/g, own: ["dialogHist", "fsOpen", "showMenu"] },
	{ kind: "float", re: /document\.body\.(?:append|appendChild)\(/g, own: ["dialog", "fsOpen", "openPalette", "~99-boot", "mbMeasure", "hFileEditor"] },
	{ kind: "reveal", re: /\b(?:pkBox|canvasPane)\.hidden = false|\bbox\.hidden = false(?=;\s*\n\s*const sr)/g },
];
const DECL = /^(?:export\s+)?(?:async\s+)?function\*?\s+([\w$]+)|^(?:const|let|var|class)\s+([\w$]+)/gm;

// Marks which characters are code: not inside a comment, a string, a regex literal or the text of a template (its ${} parts are code).
function codeMask(t: string): Uint8Array {
	const n = t.length, m = new Uint8Array(n), stk: number[] = [];
	let i = 0, prev = "", brace = 0;
	const tpl = () => {
		while (i < n) {
			if (t[i] === "\\") i += 2;
			else if (t[i] === "`") { i++; prev = "s"; return; }
			else if (t[i] === "$" && t[i + 1] === "{") { i += 2; stk.push(brace); brace = 0; return; }
			else i++;
		}
	};
	const regex = () => {
		let j = i + 1, cls = false;
		for (; j < n && t[j] !== "\n" && (cls || t[j] !== "/"); j++) { if (t[j] === "\\") j++; else if (t[j] === "[") cls = true; else if (t[j] === "]") cls = false; }
		if (t[j] !== "/") return false;
		for (i = j + 1; /[a-z]/.test(t[i] ?? ""); i++);
		prev = "s";
		return true;
	};
	while (i < n) {
		const c = t[i]!, two = t.slice(i, i + 2);
		if (c === '"' || c === "'") { for (i++; i < n && t[i] !== c && t[i] !== "\n"; i += t[i] === "\\" ? 2 : 1); i++; prev = "s"; }
		else if (c === "`") { i++; tpl(); }
		else if (two === "//") { while (i < n && t[i] !== "\n") i++; }
		else if (two === "/*") { const e = t.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; }
		else if (c === "/" && (prev === "" || "(,=:[!&|?{};>".includes(prev) || /(?:^|[^\w$])(?:return|typeof|case|in|of)\s*$/.test(t.slice(Math.max(0, i - 8), i))) && regex()) continue;
		else {
			if (c === "{") brace++;
			else if (c === "}") { if (brace === 0 && stk.length) { brace = stk.pop()!; i++; tpl(); continue; } brace--; }
			m[i] = 1; if (!/\s/.test(c)) prev = c; i++;
		}
	}
	return m;
}

// The text of the call's arguments: from just after "(" to its matching ")" (parens in strings and comments do not count).
function argsOf(t: string, mask: Uint8Array, from: number): string {
	let d = 1, i = from;
	for (; i < t.length && d > 0; i++) if (mask[i]) { if ("([{".includes(t[i]!)) d++; else if (")]}".includes(t[i]!)) d--; }
	return t.slice(from, i - 1);
}
function splitTop(a: string): string[] {
	const out: string[] = []; let d = 0, q = "", cur = "";
	for (let i = 0; i < a.length; i++) {
		const c = a[i]!;
		if (q) { cur += c; if (c === "\\") cur += a[++i] ?? ""; else if (c === q) q = ""; continue; }
		if (c === '"' || c === "'" || c === "`") q = c;
		else if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--;
		if (c === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}
const lit = (s: string | undefined) => { const m = s && /^(["'`])((?:\\.|(?!\1)[^\\$])*)\1$/.exec(s.trim()); return m ? m[2]! : null; };
const clip = (s: string) => s.replace(/\s+/g, " ").slice(0, 40);

function literalArg(kind: string, how: string | undefined, args: string): string {
	const parts = splitTop(args);
	if (how === "go") { const v = lit(parts[0]), tg = parts[1] === undefined ? "" : lit(parts[1]); return `${v ?? "*"}${tg === "" ? "" : `:${tg ?? "*"}`}`; }
	if (how === "first") return clip(lit(parts[0]) ?? "");
	const field = how && new RegExp(`(?:^|[,{\\s])${how}:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\$])*)\\1`).exec(args);
	return field ? clip(field[2]!) : "";
}
// A toast's look: .snack, .snack.bad (second argument true), .snack.act (a third argument); a second argument that is a variable is "dynamic".
function toastLook(args: string): string {
	const [, bad, act] = splitTop(args);
	const b = bad === undefined || /^(false|null|undefined|0)$/.test(bad) ? "" : bad === "true" ? "bad" : "dynamic";
	return [b, act === undefined ? "" : "act"].filter(Boolean).join("+") || "plain";
}

export function extractOpenSites(webDir: string): Site[] {
	const sites: Site[] = [], seen = new Map<string, number>();
	const add = (kind: string, fn: string, arg: string, file: string, line: number, look?: string) => {
		const base = [kind, fn, arg].filter(Boolean).join(":"), n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		sites.push({ key: n > 1 ? `${base}#${n}` : base, kind, file, line, ...(look ? { look } : {}) });
	};
	const files = readdirSync(join(webDir, "js")).filter(f => f.endsWith(".js")).sort();
	for (const f of files) {
		const t = readFileSync(join(webDir, "js", f), "utf8"), mask = codeMask(t);
		const decls = [...t.matchAll(DECL)].filter(m => mask[m.index]).map(m => ({ at: m.index, name: m[1] ?? m[2]! }));
		const lineOf = (at: number) => t.slice(0, at).split("\n").length;
		const fnAt = (at: number) => { let name = `~${f.replace(/\.js$/, "")}`; for (const d of decls) { if (d.at > at) break; name = d.name; } return name; };
		const found: { at: number; kind: string; arg: string; look?: string; fn: string }[] = [];
		for (const c of CALLS) for (const m of t.matchAll(c.re)) {
			const at = m.index;
			if (!mask[at] || /function\s+$/.test(t.slice(Math.max(0, at - 12), at))) continue;
			const fn = fnAt(at);
			if (c.own?.includes(fn)) continue;
			if (c.kind === "float" && /showModal/.test(t.slice(at, t.indexOf("\n", at)))) continue;
			const args = c.kind === "reveal" || c.kind === "float" ? "" : argsOf(t, mask, at + m[0].length);
			found.push({ at, kind: c.kind, fn, arg: literalArg(c.kind, c.arg, args), look: c.kind === "toast" ? toastLook(args) : undefined });
		}
		for (const s of found.sort((a, b) => a.at - b.at)) add(s.kind, s.fn, s.arg, f, lineOf(s.at), s.look);
	}
	const state = readFileSync(join(webDir, "js", "04-state.js"), "utf8");
	for (const v of /\bconst views = \[([^\]]*)\]/.exec(state)?.[1]?.match(/"([^"]+)"/g) ?? []) add("view", v.slice(1, -1), "", "04-state.js", 0);
	const pages = readFileSync(join(webDir, "js", "22-settings-pages.js"), "utf8");
	for (const m of /\bconst SET_PAGE = \{([\s\S]*?)\n\};/.exec(pages)?.[1]?.matchAll(/^ {2}(\w+): \{/gm) ?? []) add("view", m[1]!, "", "22-settings-pages.js", 0);
	const html = readFileSync(join(webDir, "index.html"), "utf8");
	for (const m of html.matchAll(/<(dialog|[a-z]+)\b[^>]*?(?:role="dialog"|\spopover\b)[^>]*>|<dialog\b[^>]*>/g)) {
		const id = /\bid="([^"]+)"/.exec(m[0])?.[1] ?? /aria-label="([^"]+)"/.exec(m[0])?.[1] ?? "";
		add("html", id, "", "index.html", html.slice(0, m.index).split("\n").length);
	}
	return sites;
}
