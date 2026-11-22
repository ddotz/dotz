import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../firstrun/atomic.ts"; // not hub/config.ts: it needs a data dir at load
import { flatCounts } from "./engineering-rules.ts";
import { readScreens, type ScreenRow } from "./screens-read.ts";
import { codeMask, DECL, extractOpenSitesFromText } from "./ui-surfaces.ts";

const ROOT = join(import.meta.dir, "..");
const AREAS = new Set(["core", "chat", "home", "reply", "projects", "settings", "harness", "monitoring", "mail", "kakao", "comments", "notices", "peers", "panes", "shell", "boot"]);

// Structure ratchet over web/js/*.js and web/custom.js, read as code only (codeMask: strings and comments do not count). audit() is the same
// path for the real files and for the planted cases below, so a planted violation proves each rule can fail. Its numbers must equal the
// "counts" of hub/web-structure-allow.json exactly: a new violation fails, and so does a fix that leaves its number standing.
// - C ownerWrites "NAME|file": writes to a shared object or cross-file let from a file that does not own it (hub/web-structure-owners.json):
//   X.f = / += / ++, ++X.f / --X.f / ++X[k], X.f[k] =, X[k] =, delete X.f / X.f[k] / X[k], X(.f)?.add/delete/clear/set/push/pop/shift/unshift/splice/sort/reverse(,
//   Object.assign(X; for a let also its reassignment, and the same writes to the object or list it holds (CS.who = "", PICK.push(x)).
//   A function-local alias `const g = X(.path);` counts its writes (g.live = true) as writes to X, within the block declaring it.
//   A match is skipped where an enclosing function or expression-bodied arrow declares a parameter or local of that name (bkStep(S),
//   a local `target`, `list => list.sort()`).
// - B goBranches: each test of a screen name inside go() (goTests below); fnReassign "name|file": a declared function reassigned outside any function (a monkeypatch).
// - D overlaySites: rawdialog/overlay sites (hub/ui-surfaces.ts) outside the files that implement dialogs, menus, overlays and history, and
//   outside the side drawer's own back step (showSheet), a shared part itself. A site that stays needs a reason in "reasons".
// - E rawNet: fetch(, new EventSource, new XMLHttpRequest and a window.fetch wrapper outside api(), per file.
// - F currentAssign: `current =` per file; go() is the only one.
// - G emptyBypass: el() calls building an empty state (class empty/rq-empty/cv-empty/mon-ov-empty, id kk-empty/cm-empty/dm-empty/kk-nomatch)
//   outside emptyNode, per file. kk-note alone is a loading, error or pick-a-room line, not counted.
// Regenerate after a fix: WEB_STRUCTURE_WRITE=1 bun hub/check.ts (reasons and _rule are kept).
export const SCREENS_FILE = "03-screens.js";
type Counts = Record<string, number>;
type Audit = { ownerWrites: Counts; goBranches: number; fnReassign: Counts; overlaySites: string[]; rawNet: Counts; currentAssign: Counts; emptyBypass: Counts };
type Allow = { _rule: string; counts: Audit; reasons: Record<string, string> };
const ALLOW_PATH = join(ROOT, "hub/web-structure-allow.json");
const OWNERS = JSON.parse(readFileSync(join(ROOT, "hub/web-structure-owners.json"), "utf8")) as { objects: Record<string, string[]>; lets: Record<string, string[]>; exempt: Record<string, string> };
const OVERLAY_HOMES = new Set(["02-basic-markdown.js", "03-menu.js", "38-overlay.js", "32-history-nav.js"]);
// The side drawer's back step. 06-subagents.js also holds the drawer's callers, so the part is named by its site, not by its file.
const OVERLAY_PARTS = new Set(["overlay:showSheet"]);
export const unreasoned = (sites: string[], reasons: Record<string, string>) => sites.filter((k) => !reasons[`overlaySites ${k}`]);
const EMPTY_CLASS = new Set(["empty", "rq-empty", "cv-empty", "mon-ov-empty"]);
const EMPTY_ID = new Set(["kk-empty", "cm-empty", "dm-empty", "kk-nomatch"]);
const NOT_PARAMS = new Set(["if", "while", "switch", "with", "return", "typeof", "await"]);
const NET = /(?<![\w$.])(?:window\.)?fetch\(|(?<![\w$.])window\.fetch\s*=(?![=>])|(?<![\w$.])new\s+(?:EventSource|XMLHttpRequest)\(/g;
const ASSIGN = /(?<![\w$.])([\w$]+)\s*=(?![=>])/g;
const esc = (s: string) => s.replace(/[$]/g, "\\$");
// A path below X: .field and [index] segments (strings inside an index are blank in the masked code).
const PATH = String.raw`(?:\.[\w$]+|\[[^\]\n]*\])`;
const objectWrite = (x: string) => {
  const at = `(?<![\\w$.])${esc(x)}`;
  return new RegExp(`${at}${PATH}+\\s*(?:=(?![=>])|\\+\\+|--|[-+*/|&?]{1,2}=)|(?:\\+\\+|--)\\s*${esc(x)}${PATH}+|${at}${PATH}*\\.(?:add|delete|clear|set|push|pop|shift|unshift|splice|sort|reverse)\\(|(?<![\\w$.])delete\\s+${esc(x)}${PATH}+|Object\\.assign\\(${esc(x)}\\b`, "g");
};
const letWrite = (x: string) => new RegExp(`(?<![\\w$.])${esc(x)}\\s*(?:=(?![=>])|\\+=|\\|\\|=|\\?\\?=)`, "g");
// `const g = X.f;` (or X itself, or an indexed path) ending its statement: g names the object X holds there.
const aliasOf = (x: string) => new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*${esc(x)}${PATH}*[ \\t]*(?=;|\\n)`, "g");
// Top-level declarations: hub/ui-surfaces.ts DECL plus a destructuring one (`const { a, b } = ...`).
const TOP = new RegExp(String.raw`${DECL.source}|^(?:const|let|var)\s+(?=[{[])`, "gm");

// Whether a declarator list ("a = 1, { b, c } = d", a parameter list) declares `name`: the part before each top-level comma's first `=`.
function declares(list: string, name: string): boolean {
  const word = new RegExp(`(?<![\\w$.])${esc(name)}(?![\\w$])`);
  let depth = 0, start = 0;
  for (let i = 0; i <= list.length; i++) {
    const c = list[i];
    if (c === undefined || (c === "," && depth === 0)) {
      if (word.test(list.slice(start, i).split(/(?<![=!<>])=(?![=>])/)[0]!)) return true;
      start = i + 1;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return false;
}

// The declarators of the const/let/var statement whose list starts at `from` in masked code: each bound name, where it stands and the code
// of its initializer ("" for none or a destructuring pattern). The statement ends at a `;` outside brackets, or at a line break outside
// brackets whose next line starts in column 0 (a continuation line is indented or starts with an operator).
function declarators(code: string, from: number): { at: number; name: string; init: string }[] {
  const out: { at: number; name: string; init: string }[] = [];
  let depth = 0, start = from;
  for (let i = from; ; i++) {
    const c = code[i];
    const end = c === undefined || (depth === 0 && (c === ";" || (c === "\n" && /[^\s,.?:)\]}]/.test(code[i + 1] ?? ""))));
    if (end || (c === "," && depth === 0)) {
      const part = code.slice(start, i), eq = /(?<![=!<>])=(?![=>])/.exec(part), lhs = eq ? part.slice(0, eq.index) : part;
      const simple = /^\s*([\w$]+)\s*$/.exec(lhs);
      // A pattern binds the names not followed by `:` (`{ a, b: c }` binds a and c).
      const names = simple ? [simple[1]!] : [...lhs.matchAll(/(?<![\w$])[\w$]+(?![\w$]|\s*:)/g)].map((n) => n[0]);
      for (const name of names) out.push({ at: start + lhs.indexOf(name), name, init: simple && eq ? part.slice(eq.index + 1) : "" });
      if (end) return out;
      start = i + 1;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
}

// One file: its code with strings and comments blanked, its { } blocks, and its top-level declarations.
function parse(text: string) {
  const mask = codeMask(text), code = Array.from(text, (c, i) => (mask[i] || c === "\n" ? c : " ")).join("");
  const blocks: [number, number][] = [], open: number[] = [];
  for (let i = 0; i < code.length; i++) if (code[i] === "{") open.push(i); else if (code[i] === "}" && open.length) blocks.push([open.pop()!, i]);
  // Every name a top-level declaration makes: a function or class, and each declarator of `const|let|var a = ..., b = ...` (one line or
  // several), with the masked code of its initializer and its keyword.
  const decls = [...text.matchAll(TOP)].filter((m) => mask[m.index]).flatMap((m) => {
    const kw = /^(const|let|var)\s/.exec(m[0])?.[1];
    if (!kw) return [{ at: m.index, name: m[1] ?? m[2]!, fn: !!m[1], kw: "", init: "" }];
    return declarators(code, m.index + kw.length).map((d, i) => ({ ...d, at: i ? d.at : m.index, fn: false, kw }));
  });
  const topAt = (at: number) => decls.filter((d) => d.at <= at).at(-1)?.name ?? "";
  // A block's head: the parameters it declares (a function, an arrow, a catch, a for's let/const) and whether it is a function body.
  const head = (at: number) => {
    let h = code.slice(Math.max(0, at - 600), at).trimEnd();
    const arrow = h.endsWith("=>");
    if (arrow) h = h.slice(0, -2).trimEnd();
    if (!h.endsWith(")")) return { fn: arrow, decl: arrow ? (/([\w$]+)$/.exec(h)?.[1] ?? "") : "" };
    let j = h.length - 1;
    for (let d = 0; j >= 0; j--) if (h[j] === ")") d++; else if (h[j] === "(" && --d === 0) break;
    const inner = h.slice(j + 1, -1), word = /([\w$]*)\s*$/.exec(h.slice(0, Math.max(0, j)))![1]!;
    if (word === "for") return { fn: false, decl: /^\s*(?:const|let|var)\s/.test(inner) ? inner.replace(/^\s*(?:const|let|var)\s+/, "").split(/\s(?:of|in)\s|;/)[0]! : "" };
    return arrow || (j >= 0 && !NOT_PARAMS.has(word)) ? { fn: true, decl: inner } : { fn: false, decl: "" };
  };
  const enclosing = (at: number) => blocks.filter(([o, c]) => o < at && at < c).sort((a, b) => b[0] - a[0]);
  // Expression-bodied arrows (`list => list.sort()`, `(a, b) => a.x`): their parameter list and their body, which ends at a `,` or `;`
  // outside its own brackets, at the bracket that closes around it, or where the statement ends (a line starting in column 0).
  const arrows: { decl: string; o: number; c: number }[] = [];
  for (const m of code.matchAll(/=>\s*(?=[^\s{])/g)) {
    const h = code.slice(Math.max(0, m.index - 600), m.index).trimEnd();
    let decl = /([\w$]+)$/.exec(h)?.[1] ?? "";
    if (h.endsWith(")")) {
      let j = h.length - 1;
      for (let d = 0; j >= 0; j--) if (h[j] === ")") d++; else if (h[j] === "(" && --d === 0) break;
      decl = h.slice(j + 1, -1);
    }
    let i = m.index + m[0].length;
    for (let d = 0; i < code.length; i++) {
      const c = code[i]!;
      if ("([{".includes(c)) d++;
      else if (")]}".includes(c) && d-- === 0) break;
      else if (d === 0 && (c === "," || c === ";" || (c === "\n" && /[^\s,.?:)\]}]/.test(code[i + 1] ?? "")))) break;
    }
    arrows.push({ decl, o: m.index, c: i });
  }
  // Locals a block declares itself: its text with the blocks inside it blanked, read for const/let/var lists. A brace-less for head
  // (`for (const t of done) PQ.of.delete(t);`) declares only what stands before its of/in, never the loop body after it. A { } right after
  // const/let/var or a comma is a destructuring pattern or an object literal, not a block: kept (`const a = 1, { w } = act`).
  const locals = ([o, c]: [number, number], name: string) => {
    let own = code.slice(o + 1, c);
    for (const [io, ic] of blocks) if (io > o && ic < c && !/(?:,|(?<![\w$.])(?:const|let|var))\s*$/.test(code.slice(Math.max(0, io - 12), io))) own = own.slice(0, io - o - 1) + " ".repeat(ic - io + 1) + own.slice(ic - o);
    return [...own.matchAll(/(?<![\w$.])(?:const|let|var)\s+([^;]*)/g)].some((m) => declares(m[1]!.split(/\s(?:of|in)\s/)[0]!, name));
  };
  return {
    text, mask, code, decls, topAt,
    // Every identifier in the code: a name the file never spells cannot be written there.
    words: new Set(code.match(/[\w$]+/g)),
    find: (re: RegExp) => [...code.matchAll(re)],
    // The statement holding `at` starts with const/let/var: a declaration, not a write. A line starting with the keyword right before `at`
    // is one too (after a `function f() {}` there is no `;` to stop the walk back).
    isDecl: (at: number) => {
      if (/(?:^|\n)[ \t]*(?:const|let|var)\s+$/.test(code.slice(Math.max(0, at - 80), at))) return true;
      let j = at - 1;
      for (let d = 0; j >= 0; j--) {
        const c = code[j]!;
        if (")]}".includes(c)) d++;
        else if ("([{".includes(c)) { if (d === 0) break; d--; } else if (c === ";" && d === 0) break;
      }
      return /^\s*(?:const|let|var)\s/.test(code.slice(j + 1, at));
    },
    shadowed: (at: number, name: string) => enclosing(at).some((b) => declares(head(b[0]).decl, name) || locals(b, name)) || arrows.some((a) => a.o < at && at < a.c && declares(a.decl, name)),
    // The innermost { } block holding `at`, or undefined at top level.
    scope: (at: number): [number, number] | undefined => enclosing(at)[0],
    inFunction: (at: number) => enclosing(at).some((b) => head(b[0]).fn),
    topLevel: (at: number) => enclosing(at).length === 0,
    // The source text of each top-level argument of the call whose "(" ends just before `at`.
    args: (at: number) => {
      const out: string[] = [];
      let d = 0, s = at;
      for (let i = at; i < code.length; i++) {
        const c = code[i]!;
        if ("([{".includes(c)) d++;
        else if (")]}".includes(c) && d-- === 0) { out.push(text.slice(s, i)); break; }
        else if (c === "," && d === 0) { out.push(text.slice(s, i)); s = i + 1; }
      }
      return out;
    },
  };
}

const bump = (c: Counts, k: string) => { c[k] = (c[k] ?? 0) + 1; };
const sortKeys = (c: Counts): Counts => Object.fromEntries(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : 1)));

// Parsing and the per-file counts are cached by file text: the planted cases change one or two files, so each re-reads only those and
// shares the rest with REAL (re-parsing and re-scanning all of web/js per case made each planted test take seconds).
type Parsed = ReturnType<typeof parse>;
const PARSED = new Map<string, Parsed>();
const parsed = (text: string): Parsed => { let p = PARSED.get(text); if (!p) PARSED.set(text, (p = parse(text))); return p; };

// Rule B: each test of a screen name inside go(). A screen name is a SCREENS row id, or an address whose first part (before / or :) is
// one ("monitoring/c:"). A test is the name compared with === !== == != (on either side), a case label, an item of an array literal or
// new Set([...]) read with .includes( .indexOf( .has(, or the argument of .startsWith( .endsWith( .includes( .indexOf(. Each literal
// counts once. Not counted: a test whose other side is a SCREENS row field (row.tab === "chat", switch (SCREENS[n].tab), ["chat"].
// includes(r.tab): the row's data), and a name written as a value, an address, an argument, a key or an index (name = "home",
// navSync("monitoring", ...), SCREENS["chat"]). Strings in comments and template text are not code.
function goTests(p: Parsed, from: number, to: number, rows: ScreenRow[]): number {
  const ids = new Set(rows.map((r) => r.id)), fields = new Set(rows.flatMap((r) => Object.keys(r)).filter((k) => k !== "id"));
  const { text, mask, code } = p, OPERAND = String.raw`[\w$.?[\]]*`;
  const rowField = (operand: string) => fields.has(/\.([\w$]+)$/.exec(operand.trim())?.[1] ?? "");
  const tail = (at: number) => new RegExp(`${OPERAND}$`).exec(code.slice(Math.max(from, at - 200), at).trimEnd())![0];
  let n = 0;
  for (let s = from; s < to; s++) {
    const q = text[s];
    // A string starts at a quote that is not code right after a character that is (inside a comment or a template the one before is not).
    if ((q !== '"' && q !== "'") || mask[s] || !mask[s - 1]) continue;
    let e = s + 1;
    while (e < text.length && text[e] !== q && text[e] !== "\n") e += text[e] === "\\" ? 2 : 1;
    const value = text.slice(s + 1, e), pre = code.slice(Math.max(from, s - 200), s), post = code.slice(e + 1, e + 200);
    const at = s;
    s = e;
    if (!ids.has(value) && !ids.has(value.split(/[/:]/)[0]!)) continue;
    const left = new RegExp(`(${OPERAND})\\s*[!=]==?\\s*$`).exec(pre), right = new RegExp(`^\\s*[!=]==?\\s*(${OPERAND})`).exec(post);
    const method = /\.(?:startsWith|endsWith|includes|indexOf)\(\s*$/.exec(pre);
    let tested: string | undefined;
    if (left) tested = left[1]!;
    else if (right) tested = right[1]!;
    else if (method) tested = tail(at - method[0].length);
    else if (/(?<![\w$.])case\s*$/.test(pre)) {
      // The switch's discriminant: the parenthesized text after the nearest `switch` before the label.
      const sw = code.lastIndexOf("switch", at);
      const open = sw >= from ? code.indexOf("(", sw) : -1;
      let c = open + 1;
      for (let d = 0; open >= 0 && c < at; c++) if (code[c] === "(") d++; else if (code[c] === ")" && d-- === 0) break;
      tested = open >= 0 ? code.slice(open + 1, c) : "";
    } else {
      // An item of an array literal: walk back to the unclosed [ (not an index: no name, ) or ] before it), forward to its ], then a read.
      let o = at - 1;
      for (let d = 0; o >= from; o--) {
        const c = code[o]!;
        if (")]}".includes(c)) d++;
        else if ("([{".includes(c)) { if (d === 0) break; d--; } else if (c === ";" && d === 0) { o = from - 1; break; }
      }
      if (o < from || code[o] !== "[" || /[\w$)\]]$/.test(code.slice(from, o).trimEnd())) continue;
      let c = e + 1;
      for (let d = 0; c < to; c++) if ("([{".includes(code[c]!)) d++; else if (")]}".includes(code[c]!) && d-- === 0) break;
      const read = new RegExp(`^\\]\\s*\\)?\\s*\\.(?:includes|indexOf|has)\\(\\s*(${OPERAND})`).exec(code.slice(c, c + 200));
      if (!read) continue;
      tested = read[1]!;
    }
    if (!rowField(tested)) n++;
  }
  return n;
}

// One file's counts, cached by its name and text. topAssigns holds every name assigned outside any function after a statement end;
// audit() keeps those naming a declared function (fnReassign). overlay holds the file's rawdialog and overlay sites as "kind:fn" in
// order; audit() numbers repeats across files as hub/ui-surfaces.ts does.
type FileAudit = { ownerWrites: Counts; topAssigns: string[]; rawNet: number; currentAssign: number; emptyBypass: number; overlay: string[] };
const FILE_AUDITS = new Map<string, FileAudit>();
function auditFile(f: string, text: string): FileAudit {
  const key = `${f}\n${text}`, hit = FILE_AUDITS.get(key);
  if (hit) return hit;
  const p = parsed(text), r: FileAudit = { ownerWrites: {}, topAssigns: [], rawNet: 0, currentAssign: 0, emptyBypass: 0, overlay: [] };
  for (const [name, owners] of Object.entries(OWNERS.objects)) if (!owners.includes(f))
    for (const m of p.find(objectWrite(name))) if (!p.shadowed(m.index, name)) bump(r.ownerWrites, `${name}|${f}`);
  // A block-local alias of an owned object or let: its writes after the alias, inside that block, are writes to the owned name.
  for (const [name, owners] of [...Object.entries(OWNERS.objects), ...Object.entries(OWNERS.lets)]) if (!owners.includes(f))
    for (const a of p.find(aliasOf(name))) {
      const s = p.scope(a.index);
      if (s && !p.shadowed(a.index, name)) for (const m of p.find(objectWrite(a[1]!))) if (m.index > a.index && m.index < s[1]) bump(r.ownerWrites, `${name}|${f}`);
    }
  // A let is reassigned, and the object or list it holds is written like an owned object's (CS.who = "", PICK.push(x)).
  for (const [name, owners] of Object.entries(OWNERS.lets)) if (!owners.includes(f)) {
    for (const m of p.find(letWrite(name))) if (!p.isDecl(m.index) && !p.shadowed(m.index, name)) bump(r.ownerWrites, `${name}|${f}`);
    for (const m of p.find(objectWrite(name))) if (!p.shadowed(m.index, name)) bump(r.ownerWrites, `${name}|${f}`);
  }
  for (const m of p.find(letWrite("current"))) if (!p.isDecl(m.index) && !p.shadowed(m.index, "current")) r.currentAssign++;
  for (const m of p.find(ASSIGN)) if (/^$|[;{}]$/.test(p.code.slice(Math.max(0, m.index - 300), m.index).trimEnd()) && !p.inFunction(m.index)) r.topAssigns.push(m[1]!);
  for (const m of p.find(NET)) if (!(f === "02-basic-markdown.js" && p.topAt(m.index) === "api")) r.rawNet++;
  for (const m of p.find(/(?<![\w$.])el\(/g)) {
    if (f === "05-command-palette.js" && p.topAt(m.index) === "emptyNode") continue;
    const props = p.args(m.index + 3)[1] ?? "";
    const cls = /(?:^|[{,\s])class:\s*"([^"]*)"/.exec(props)?.[1] ?? "", id = /(?:^|[{,\s])id:\s*"([^"]*)"/.exec(props)?.[1] ?? "";
    if (cls.split(/\s+/).some((c) => EMPTY_CLASS.has(c)) || EMPTY_ID.has(id)) r.emptyBypass++;
  }
  r.overlay = extractOpenSitesFromText({ [f === "custom.js" ? f : `js/${f}`]: text }).filter((s) => s.kind === "rawdialog" || s.kind === "overlay").map((s) => s.key.replace(/#\d+$/, ""));
  FILE_AUDITS.set(key, r);
  return r;
}

export function audit(files: Record<string, string>): Audit {
  const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1));
  const decls = entries.flatMap(([, t]) => parsed(t).decls), vars = new Set(decls.filter((d) => !d.fn).map((d) => d.name));
  const fnNames = new Set(decls.filter((d) => d.fn && !vars.has(d.name)).map((d) => d.name));
  const rows = readScreens(files[SCREENS_FILE] ?? "") ?? [];
  const r: Audit = { ownerWrites: {}, goBranches: 0, fnReassign: {}, overlaySites: [], rawNet: {}, currentAssign: {}, emptyBypass: {} };
  for (const [f, t] of entries) {
    const a = auditFile(f, t), p = parsed(t);
    Object.assign(r.ownerWrites, a.ownerWrites);
    for (const name of a.topAssigns) if (fnNames.has(name)) bump(r.fnReassign, `${name}|${f}`);
    if (a.rawNet) r.rawNet[f] = a.rawNet;
    if (a.currentAssign) r.currentAssign[f] = a.currentAssign;
    if (a.emptyBypass) r.emptyBypass[f] = a.emptyBypass;
    const go = p.decls.findIndex((d) => d.fn && d.name === "go");
    if (go >= 0) r.goBranches += goTests(p, p.decls[go]!.at, p.decls[go + 1]?.at ?? p.text.length, rows);
  }
  // The overlay sites in hub/ui-surfaces.ts order (web/js by name, then custom.js), a repeated "kind:fn" numbered #2, #3 across files.
  const seen = new Map<string, number>();
  for (const [f, t] of [...entries.filter(([f]) => f !== "custom.js"), ...entries.filter(([f]) => f === "custom.js")])
    for (const base of auditFile(f, t).overlay) {
      const n = (seen.get(base) ?? 0) + 1, key = n > 1 ? `${base}#${n}` : base;
      seen.set(base, n);
      if (!OVERLAY_HOMES.has(f) && !OVERLAY_PARTS.has(key)) r.overlaySites.push(key);
    }
  r.overlaySites.sort();
  for (const k of ["ownerWrites", "fnReassign", "rawNet", "currentAssign", "emptyBypass"] as const) r[k] = sortKeys(r[k]);
  return r;
}

// Completeness of the owners file: a top-level name (any declarator, a destructured one too, whatever its initializer: {}, a Map, null, a
// call, a number) that takes a rule C write from a file other than the one declaring it is owned (objects or lets) or exempt with a reason.
// A write is a property or container write (X.f =, X.set(, X[k] =, X.push( ...), and for a let or var also its reassignment. Each
// finding is "NAME|declaring file <- writing file".
// Whether a file's code writes a name, cached per parsed file (shared across the planted cases like the parse itself).
const WRITES = new WeakMap<Parsed, Map<string, boolean>>();
export function unowned(files: Record<string, string>): string[] {
  const known = new Set([...Object.keys(OWNERS.objects), ...Object.keys(OWNERS.lets), ...Object.keys(OWNERS.exempt)]);
  const all = Object.entries(files).map(([f, t]) => [f, parsed(t)] as const), out: string[] = [];
  const writes = (p: Parsed, name: string, isConst: boolean) => {
    let memo = WRITES.get(p);
    if (!memo) WRITES.set(p, (memo = new Map()));
    const key = `${isConst ? "c" : "l"} ${name}`;
    let hit = memo.get(key);
    if (hit === undefined) {
      const ms = [...p.find(objectWrite(name)), ...(isConst ? [] : p.find(letWrite(name)).filter((m) => !p.isDecl(m.index)))];
      memo.set(key, (hit = ms.some((m) => !p.shadowed(m.index, name))));
    }
    return hit;
  };
  for (const [df, dp] of all) for (const d of dp.decls) if (!d.fn && !known.has(d.name))
    for (const [f, p] of all) if (f !== df && p.words.has(d.name) && writes(p, d.name, d.kw === "const")) out.push(`${d.name}|${df} <- ${f}`);
  return out.sort();
}

export const webFiles = (): Record<string, string> => {
  const dir = join(ROOT, "web/js"), files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) files[f] = readFileSync(join(dir, f), "utf8");
  files["custom.js"] = readFileSync(join(ROOT, "web/custom.js"), "utf8");
  return files;
};
// The allowlist as generated: sorted keys, one per line, two-space JSON.
const render = (a: Allow) => JSON.stringify({ _rule: a._rule, counts: Object.fromEntries(Object.entries(a.counts).sort(([x], [y]) => (x < y ? -1 : 1))), reasons: sortKeys(a.reasons as unknown as Counts) }, null, 2) + "\n";

// Rule A: the screen lists. Only web/js/03-screens.js declares or changes SCREENS and the lists made from it; a local of the same name
// (a function's `const views = $("#views")`, the notice wording's own SUB inside its IIFE) is not one. The rows marked html: true and the
// #v-<id> sections of web/index.html match both ways. Unlike the ratchet above there is no allowance: every finding fails.
const SCREEN_LISTS = ["SCREENS", "views", "SUB", "titles", "NAV", "VIEW_ICON"];
const listWrite = (x: string) => {
  const ref = `(?<![\\w$.])${x}(?:\\.[\\w$]+|\\[[^\\]\\n]*\\])*`;
  return new RegExp(`${ref}\\s*(?:=(?![=>])|\\+\\+|--|[-+*/|&?]{1,2}=)|${ref}\\.(?:push|pop|shift|unshift|splice|sort|reverse|add|delete|clear|set)\\(|Object\\.assign\\(${x}\\b`, "g");
};
export function screenRule(files: Record<string, string>, html: string): string[] {
  const out: string[] = [];
  for (const [f, t] of Object.entries(files)) {
    if (f === SCREENS_FILE) continue;
    const p = parsed(t);
    for (const d of p.decls) if (SCREEN_LISTS.includes(d.name) && p.topLevel(d.at)) out.push(`declares ${d.name}|${f}`);
    for (const x of SCREEN_LISTS) for (const m of p.find(listWrite(x))) if (!p.isDecl(m.index) && !p.shadowed(m.index, x)) out.push(`changes ${x}|${f}`);
  }
  const rows = readScreens(files[SCREENS_FILE] ?? "") ?? [];
  const inTable = new Set(rows.filter((r) => r.html).map((r) => r.id)), inHtml = new Set([...html.matchAll(/\bid="v-([\w-]+)"/g)].map((m) => m[1]!));
  for (const id of inTable) if (!inHtml.has(id)) out.push(`no section #v-${id} in web/index.html`);
  for (const id of inHtml) if (!inTable.has(id)) out.push(`no html: true row in SCREENS for #v-${id}`);
  return out.sort();
}

// What `bun hub/check.ts` reports; each returns its findings. hub/web-structure-web.test.ts proves the scanner on planted code.

// hub/web-areas.json names every web/js file once and registers the pending ones.
export function areasFindings(): string[] {
  const { pending, ...map } = JSON.parse(readFileSync(join(ROOT, "hub/web-areas.json"), "utf8")) as { pending: string[] } & Record<string, string>;
  const onDisk = readdirSync(join(ROOT, "web/js")).filter((f) => f.endsWith(".js"));
  return [
    ...onDisk.filter((f) => !(f in map)).map((f) => `web/js/${f} has no area in hub/web-areas.json`),
    ...Object.keys(map).filter((f) => !onDisk.includes(f) && !pending.includes(f)).map((f) => `${f} is in hub/web-areas.json but is neither on disk nor pending`),
    ...pending.filter((f) => !(f in map) || existsSync(join(ROOT, "web/js", f))).map((f) => `${f} is pending but ${f in map ? "exists" : "has no area"}`),
    ...Object.entries(map).filter(([, a]) => !AREAS.has(a)).map(([f, a]) => `${f} has unknown area ${a}`),
  ];
}

// The allowlist numbers equal what the scanner counts, its file is in generated form, and every reason names a count that is still there.
export function ratchetFindings(): string[] {
  const real = audit(webFiles());
  let text = readFileSync(ALLOW_PATH, "utf8");
  if (process.env.WEB_STRUCTURE_WRITE) writeAtomic(ALLOW_PATH, (text = render({ ...(JSON.parse(text) as Allow), counts: real })));
  const allow = JSON.parse(text) as Allow;
  const had = flatCounts({ counts: allow.counts }) ?? {}, now = flatCounts({ counts: real }) ?? {};
  const out = [...new Set([...Object.keys(had), ...Object.keys(now)])].sort().filter((k) => (had[k] ?? 0) !== (now[k] ?? 0)).map((k) => `${k}: allowlist ${had[k] ?? 0}, code ${now[k] ?? 0}`);
  if (text !== render(allow)) out.push("hub/web-structure-allow.json is not in its generated form (WEB_STRUCTURE_WRITE=1 bun hub/check.ts rewrites it)");
  const keys = Object.keys(flatCounts(allow) ?? {});
  out.push(...Object.keys(allow.reasons).filter((k) => !keys.includes(k)).map((k) => `reason for a count that is gone: ${k}`));
  out.push(...unreasoned(allow.counts.overlaySites, allow.reasons).map((k) => `overlay site with no reason: ${k}`));
  return out;
}

// The pre-push hook's recount: the ownerWrites of these web files, for hub/engineering-rules.ts --base-recount.
export const recountWrites = (file: string) => writeAtomic(file, JSON.stringify(audit(webFiles()).ownerWrites));

export function completenessFindings(): string[] {
  return [
    ...unowned(webFiles()).map((f) => `written from another file, neither owned nor exempt in hub/web-structure-owners.json: ${f}`),
    ...Object.entries(OWNERS.exempt).filter(([, why]) => !why.trim()).map(([name]) => `exempt name with no reason in hub/web-structure-owners.json: ${name}`),
  ];
}

export function ownersFindings(): string[] {
  const { pending } = JSON.parse(readFileSync(join(ROOT, "hub/web-areas.json"), "utf8")) as { pending: string[] };
  const files = new Set([...Object.keys(webFiles()), ...pending]);
  return [...Object.values(OWNERS.objects), ...Object.values(OWNERS.lets)].flat().filter((f) => !files.has(f)).map((f) => `hub/web-structure-owners.json names ${f}, which does not exist`);
}

// Only 03-screens.js declares or changes the screen lists, and its html rows match web/index.html.
export function screenFindings(): string[] {
  const files = webFiles();
  return [...(readScreens(files[SCREENS_FILE] ?? "")?.length ? [] : ["no SCREENS rows read from web/js/03-screens.js"]), ...screenRule(files, readFileSync(join(ROOT, "web/index.html"), "utf8"))];
}
