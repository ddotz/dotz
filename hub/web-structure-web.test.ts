import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flatCounts } from "./engineering-rules.ts";
import { readScreens } from "./screens-read.ts";
import { codeMask, DECL, extractOpenSitesFromText } from "./ui-surfaces.ts";

const ROOT = join(import.meta.dir, "..");
const AREAS = new Set(["core", "chat", "home", "reply", "projects", "settings", "harness", "monitoring", "mail", "kakao", "comments", "notices", "peers", "panes", "shell", "boot"]);

test("hub/web-areas.json names every web/js file once and registers the pending ones", () => {
  const { pending, ...map } = JSON.parse(readFileSync(join(ROOT, "hub/web-areas.json"), "utf8")) as { pending: string[] } & Record<string, string>;
  const onDisk = readdirSync(join(ROOT, "web/js")).filter((f) => f.endsWith(".js"));
  expect(Object.keys(map).sort()).toEqual([...onDisk, ...pending].sort());
  for (const f of pending) expect(existsSync(join(ROOT, "web/js", f)), f + " is pending but exists").toBe(false);
  for (const [f, a] of Object.entries(map)) expect(AREAS.has(a), f + " has unknown area " + a).toBe(true);
});

// Structure ratchet over web/js/*.js and web/custom.js, read as code only (codeMask: strings and comments do not count). audit() is the same
// path for the real files and for the planted cases below, so a planted violation proves each rule can fail. Its numbers must equal the
// "counts" of hub/web-structure-allow.json exactly: a new violation fails, and so does a fix that leaves its number standing.
// - C ownerWrites "NAME|file": writes to a shared object or cross-file let from a file that does not own it (hub/web-structure-owners.json):
//   X.f = / += / ++, ++X.f / --X.f / ++X[k], X.f[k] =, X[k] =, delete X.f / X.f[k] / X[k], X(.f)?.add/delete/clear/set/push/pop/shift/unshift/splice/sort/reverse(,
//   Object.assign(X; for a let also its reassignment, and the same writes to the object or list it holds (CS.who = "", PICK.push(x)).
//   A match is skipped where an enclosing function declares a parameter or local of that name (bkStep(S), a local `target`).
// - B goBranches: `name === "` inside go(); fnReassign "name|file": a declared function reassigned outside any function (a monkeypatch).
// - D overlaySites: rawdialog/overlay sites (hub/ui-surfaces.ts) outside the files that implement dialogs, menus, overlays and history, and
//   outside the side drawer's own back step (showSheet), a shared part itself. A site that stays needs a reason in "reasons".
// - E rawNet: fetch(, new EventSource, new XMLHttpRequest and a window.fetch wrapper outside api(), per file.
// - F currentAssign: `current =` per file; go() is the only one.
// - G emptyBypass: el() calls building an empty state (class empty/rq-empty/cv-empty/mon-ov-empty, id kk-empty/cm-empty/dm-empty/kk-nomatch)
//   outside emptyNode, per file. kk-note alone is a loading, error or pick-a-room line, not counted.
// Regenerate after a fix: WEB_STRUCTURE_WRITE=1 bun test hub/web-structure-web.test.ts (reasons and _rule are kept; the test preload drops DOTZ_* names).
type Counts = Record<string, number>;
type Audit = { ownerWrites: Counts; goBranches: number; fnReassign: Counts; overlaySites: string[]; rawNet: Counts; currentAssign: Counts; emptyBypass: Counts };
type Allow = { _rule: string; counts: Audit; reasons: Record<string, string> };
const ALLOW_PATH = join(ROOT, "hub/web-structure-allow.json");
const OWNERS = JSON.parse(readFileSync(join(ROOT, "hub/web-structure-owners.json"), "utf8")) as { objects: Record<string, string[]>; lets: Record<string, string[]>; exempt: Record<string, string> };
const OVERLAY_HOMES = new Set(["02-basic-markdown.js", "03-menu.js", "38-overlay.js", "32-history-nav.js"]);
// The side drawer's back step. 06-subagents.js also holds the drawer's callers, so the part is named by its site, not by its file.
const OVERLAY_PARTS = new Set(["overlay:showSheet"]);
const unreasoned = (sites: string[], reasons: Record<string, string>) => sites.filter((k) => !reasons[`overlaySites ${k}`]);
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
  const decls = [...text.matchAll(DECL)].filter((m) => mask[m.index]).flatMap((m) => {
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
  // Locals a block declares itself: its text with the blocks inside it blanked, read for const/let/var lists. A brace-less for head
  // (`for (const t of done) PQ.of.delete(t);`) declares only what stands before its of/in, never the loop body after it.
  const locals = ([o, c]: [number, number], name: string) => {
    let own = code.slice(o + 1, c);
    for (const [io, ic] of blocks) if (io > o && ic < c) own = own.slice(0, io - o - 1) + " ".repeat(ic - io + 1) + own.slice(ic - o);
    return [...own.matchAll(/(?<![\w$.])(?:const|let|var)\s+([^;]*)/g)].some((m) => declares(m[1]!.split(/\s(?:of|in)\s/)[0]!, name));
  };
  return {
    text, code, decls, topAt,
    find: (re: RegExp) => [...code.matchAll(re)],
    // The statement holding `at` starts with const/let/var: a declaration, not a write.
    isDecl: (at: number) => {
      let j = at - 1;
      for (let d = 0; j >= 0; j--) {
        const c = code[j]!;
        if (")]}".includes(c)) d++;
        else if ("([{".includes(c)) { if (d === 0) break; d--; } else if (c === ";" && d === 0) break;
      }
      return /^\s*(?:const|let|var)\s/.test(code.slice(j + 1, at));
    },
    shadowed: (at: number, name: string) => enclosing(at).some((b) => declares(head(b[0]).decl, name) || locals(b, name)),
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

function audit(files: Record<string, string>): Audit {
  const parsed = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, t]) => [f, parse(t)] as const);
  const vars = new Set(parsed.flatMap(([, p]) => p.decls.filter((d) => !d.fn).map((d) => d.name)));
  const fnNames = new Set(parsed.flatMap(([, p]) => p.decls.filter((d) => d.fn && !vars.has(d.name)).map((d) => d.name)));
  const r: Audit = { ownerWrites: {}, goBranches: 0, fnReassign: {}, overlaySites: [], rawNet: {}, currentAssign: {}, emptyBypass: {} };
  for (const [f, p] of parsed) {
    for (const [name, owners] of Object.entries(OWNERS.objects)) if (!owners.includes(f))
      for (const m of p.find(objectWrite(name))) if (!p.shadowed(m.index, name)) bump(r.ownerWrites, `${name}|${f}`);
    // A let is reassigned, and the object or list it holds is written like an owned object's (CS.who = "", PICK.push(x)).
    for (const [name, owners] of Object.entries(OWNERS.lets)) if (!owners.includes(f)) {
      for (const m of p.find(letWrite(name))) if (!p.isDecl(m.index) && !p.shadowed(m.index, name)) bump(r.ownerWrites, `${name}|${f}`);
      for (const m of p.find(objectWrite(name))) if (!p.shadowed(m.index, name)) bump(r.ownerWrites, `${name}|${f}`);
    }
    for (const m of p.find(letWrite("current"))) if (!p.isDecl(m.index) && !p.shadowed(m.index, "current")) bump(r.currentAssign, f);
    for (const m of p.find(ASSIGN)) if (fnNames.has(m[1]!) && /^$|[;{}]$/.test(p.code.slice(Math.max(0, m.index - 300), m.index).trimEnd()) && !p.inFunction(m.index)) bump(r.fnReassign, `${m[1]}|${f}`);
    for (const m of p.find(NET)) if (!(f === "02-basic-markdown.js" && p.topAt(m.index) === "api")) bump(r.rawNet, f);
    for (const m of p.find(/(?<![\w$.])el\(/g)) {
      if (f === "05-command-palette.js" && p.topAt(m.index) === "emptyNode") continue;
      const props = p.args(m.index + 3)[1] ?? "";
      const cls = /(?:^|[{,\s])class:\s*"([^"]*)"/.exec(props)?.[1] ?? "", id = /(?:^|[{,\s])id:\s*"([^"]*)"/.exec(props)?.[1] ?? "";
      if (cls.split(/\s+/).some((c) => EMPTY_CLASS.has(c)) || EMPTY_ID.has(id)) bump(r.emptyBypass, f);
    }
    const go = p.decls.findIndex((d) => d.fn && d.name === "go");
    if (go >= 0) {
      const from = p.decls[go]!.at, to = p.decls[go + 1]?.at ?? p.text.length;
      r.goBranches += [...p.text.slice(from, to).matchAll(/(?<![\w$.])name === "/g)].filter((m) => p.code[from + m.index] !== " ").length;
    }
  }
  const sites = extractOpenSitesFromText(Object.fromEntries(Object.entries(files).map(([f, t]) => [f === "custom.js" ? f : `js/${f}`, t])));
  r.overlaySites = sites.filter((s) => (s.kind === "rawdialog" || s.kind === "overlay") && !OVERLAY_HOMES.has(s.file) && !OVERLAY_PARTS.has(s.key)).map((s) => s.key).sort();
  for (const k of ["ownerWrites", "fnReassign", "rawNet", "currentAssign", "emptyBypass"] as const) r[k] = sortKeys(r[k]);
  return r;
}

// Completeness of the owners file: a top-level name that holds {}, [], a Map, Set, WeakMap or WeakSet and takes a rule C write from a file
// other than the one declaring it is owned (objects or lets) or exempt with a reason. Each finding is "NAME|declaring file <- writing file".
const CONTAINER = /^\s*(?:\{|\[|new\s+(?:Map|Set|WeakMap|WeakSet)\b)/;
function unowned(files: Record<string, string>): string[] {
  const known = new Set([...Object.keys(OWNERS.objects), ...Object.keys(OWNERS.lets), ...Object.keys(OWNERS.exempt)]);
  const parsed = Object.entries(files).map(([f, t]) => [f, parse(t)] as const), out: string[] = [];
  for (const [df, dp] of parsed) for (const d of dp.decls) if (CONTAINER.test(d.init) && !known.has(d.name))
    for (const [f, p] of parsed) if (f !== df && p.code.includes(d.name)) {
      const writes = [...p.find(objectWrite(d.name)), ...(d.kw === "const" ? [] : p.find(letWrite(d.name)).filter((m) => !p.isDecl(m.index)))];
      if (writes.some((m) => !p.shadowed(m.index, d.name))) out.push(`${d.name}|${df} <- ${f}`);
    }
  return out.sort();
}

const webFiles = (): Record<string, string> => {
  const dir = join(ROOT, "web/js"), files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) files[f] = readFileSync(join(dir, f), "utf8");
  files["custom.js"] = readFileSync(join(ROOT, "web/custom.js"), "utf8");
  return files;
};
// The allowlist as generated: sorted keys, one per line, two-space JSON.
const render = (a: Allow) => JSON.stringify({ _rule: a._rule, counts: Object.fromEntries(Object.entries(a.counts).sort(([x], [y]) => (x < y ? -1 : 1))), reasons: sortKeys(a.reasons as unknown as Counts) }, null, 2) + "\n";
const REAL = audit(webFiles());

test("web/js and web/custom.js add no foreign state write, go() branch, raw overlay, raw request, current assignment or empty-state bypass", () => {
  let text = readFileSync(ALLOW_PATH, "utf8");
  if (process.env.WEB_STRUCTURE_WRITE) writeFileSync(ALLOW_PATH, (text = render({ ...(JSON.parse(text) as Allow), counts: REAL })));
  const allow = JSON.parse(text) as Allow;
  expect(allow.counts).toEqual(REAL);
  expect(text).toBe(render(allow));
  const keys = Object.keys(flatCounts(allow) ?? {});
  expect(Object.keys(allow.reasons).filter((k) => !keys.includes(k))).toEqual([]);
  expect(unreasoned(allow.counts.overlaySites, allow.reasons)).toEqual([]);
});

// .githooks/pre-push runs this alone (-t "^recount") in a tree of the pushed hub/ and the baseline's web/ files: the baseline code counted by
// this commit's rule C and owners. hub/engineering-rules.ts --base-recount lets an ownerWrites number rise up to that count, so a rule that
// starts seeing a write shape the baseline code already had is not a raise, and a new write still is.
test.if(!!process.env.WEB_STRUCTURE_RECOUNT)("recount: the ownerWrites of these web files, written to $WEB_STRUCTURE_RECOUNT", () => {
  writeFileSync(process.env.WEB_STRUCTURE_RECOUNT!, JSON.stringify(REAL.ownerWrites));
});

test("every shared {} / [] / Map / Set another file writes is owned or exempt in hub/web-structure-owners.json", () => {
  expect(unowned(webFiles())).toEqual([]);
  expect(Object.entries(OWNERS.exempt).filter(([, why]) => !why.trim())).toEqual([]);
});

test("hub/web-structure-owners.json names files that exist or are pending", () => {
  const { pending } = JSON.parse(readFileSync(join(ROOT, "hub/web-areas.json"), "utf8")) as { pending: string[] };
  const files = new Set([...Object.keys(webFiles()), ...pending]);
  const named = [...Object.values(OWNERS.objects), ...Object.values(OWNERS.lets)].flat();
  expect(named.filter((f) => !files.has(f))).toEqual([]);
});

// Each planted line moves exactly its own number, and the skipped shapes move nothing.
const files = webFiles();
const delta = (plant: Record<string, string>) => {
  const a = flatCounts({ counts: REAL })!, b = flatCounts({ counts: audit({ ...files, ...plant }) })!;
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => ((b[k] ?? 0) - (a[k] ?? 0) ? [[k, (b[k] ?? 0) - (a[k] ?? 0)]] : [])));
};
const mailBox = (line: string) => ({ "30-mail-box.js": `${files["30-mail-box.js"]}\n${line}\n` });

test("planted C: a foreign write counts, a parameter or local of that name does not", () => {
  expect(delta(mailBox("MON.zz = 1;"))).toEqual({ "ownerWrites MON|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzW() { MON.seen.add(1); Object.assign(MON, {}); S.bk = 1; }"))).toEqual({ "ownerWrites MON|30-mail-box.js": 2, "ownerWrites S|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzStick() { chatStick = true; target ??= \"x\"; }"))).toEqual({ "ownerWrites chatStick|30-mail-box.js": 1, "ownerWrites target|30-mail-box.js": 1 });
  expect(delta(mailBox("function bkStep(S){S.bk=1}"))).toEqual({});
  expect(delta(mailBox("function zzT(x) { const a = 1, target = x; target = 2; for (const MON of x) { MON.a = 1; } [1].map((S) => { S.b = 2; }); }"))).toEqual({});
  expect(delta({ "30-monitoring.js": `${files["30-monitoring.js"]}\nMON.zz = 1;\n` })).toEqual({});
});

test("planted C: a write to a registered Map itself and a write in a brace-less for body count", () => {
  expect(delta(mailBox("function zzMap() { MAILS.set(\"zz\", {}); CONV.delete(\"zz\"); TURN.set(\"zz\", 1); }"))).toEqual({ "ownerWrites CONV|30-mail-box.js": 1, "ownerWrites MAILS|30-mail-box.js": 1, "ownerWrites TURN|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzFor(xs) { for (const t of xs) PQ.of.delete(t); }"))).toEqual({ "ownerWrites PQ|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzFor2(xs) { for (const PQ of xs) PQ.of.delete(1); }"))).toEqual({});
});

test("planted C: an indexed write, a delete, an in-place list change and a write to an object a registered let holds count", () => {
  expect(delta(mailBox("function zzIx(k) { NT.by[\"k\"] = 1; NT[k] = 1; NT.by[k].n += 1; }"))).toEqual({ "ownerWrites NT|30-mail-box.js": 3 });
  expect(delta(mailBox("function zzDel(k) { delete NT.zz; delete NT.by[\"k\"]; delete NT[k]; }"))).toEqual({ "ownerWrites NT|30-mail-box.js": 3 });
  expect(delta(mailBox("function zzList() { MON.xs.pop(); MON.xs.shift(); MON.xs.unshift(1); MON.xs.sort(); MON.xs.reverse(); }"))).toEqual({ "ownerWrites MON|30-mail-box.js": 5 });
  expect(delta(mailBox("function zzLet() { CS.who = \"\"; CS.prog.set(1, 2); PICK.push(1); }"))).toEqual({ "ownerWrites CS|30-mail-box.js": 2, "ownerWrites PICK|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzNew() { RELAY.name[\"x\"] = 1; DC.st[\"k\"] = 1; }"))).toEqual({ "ownerWrites DC|30-mail-box.js": 1, "ownerWrites RELAY|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzRead(k) { return NT.by[k] === 1 || NT.by[1] == 2 || [...PICK].sort() || MON.xs.slice().sort(); }"))).toEqual({});
  expect(delta(mailBox("function zzShadow(CS, NT) { CS.who = 1; delete NT.a; NT.b[1] = 2; const PICK = []; PICK.push(1); }"))).toEqual({});
});

test("planted C: a prefix ++ / -- write counts, a prefix on another name does not", () => {
  expect(delta(mailBox("function zzPre(k) { ++MON.zz; --MON.yy; ++MON.by[k]; }"))).toEqual({ "ownerWrites MON|30-mail-box.js": 3 });
  expect(delta(mailBox("function zzPre2(k) { return ++k + MON.a; }"))).toEqual({});
});

test("planted completeness: a later declarator holding a Map, Set, {} or [] and written from another file is named until owned", () => {
  const mon = (line: string) => ({ "30-monitoring.js": `${files["30-monitoring.js"]}\n${line}\n` });
  expect(unowned({ ...files, ...mailBox("const ZA = 1, ZB = new Map();"), ...mon("function zzZB() { ZB.set(1, 2); }") })).toEqual(["ZB|30-mail-box.js <- 30-monitoring.js"]);
  expect(unowned({ ...files, ...mailBox("let ZC = null, ZD = 0,\n  ZE = [];"), ...mon("function zzZE() { ZE = []; ZD = 1; }") })).toEqual(["ZE|30-mail-box.js <- 30-monitoring.js"]);
  expect(unowned({ ...files, ...mailBox("const ZA = 1, ZB = new Map();\nfunction zzOwn() { ZB.set(1, 2); }"), ...mon("function zzRd(ZB) { ZB.set(1, 2); return ZB; }") })).toEqual([]);
});

test("planted B: a go() branch and a top-level function reassignment count", () => {
  const cp = files["05-command-palette.js"]!;
  expect(delta({ "05-command-palette.js": cp.replace("function go(name, tgt) {\n", "function go(name, tgt) {\n  if (name === \"zz\") return;\n") })).toEqual({ goBranches: 1 });
  expect(delta(mailBox("const zzGo = go;\ngo = function (n, t) { zzGo(n, t); };"))).toEqual({ "fnReassign go|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzGo2() { let go = 1; go = 2; }"))).toEqual({});
});

test("planted D: a raw <dialog> or ovOpen outside the overlay files counts", () => {
  expect(delta(mailBox("function zzOpen(d) { d.showModal(); ovOpen(() => d.close()); }"))).toEqual({ "overlaySites overlay:zzOpen": 1, "overlaySites rawdialog:zzOpen": 1 });
  expect(delta({ "03-menu.js": `${files["03-menu.js"]}\nfunction zzMenu(d) { d.showModal(); }\n` })).toEqual({});
  expect(delta({ "06-subagents.js": `${files["06-subagents.js"]}\nfunction zzSub() { ovOpen(() => {}); }\n` })).toEqual({ "overlaySites overlay:zzSub": 1 });
  expect(unreasoned(["overlay:zzOpen", "rawdialog:lightboxAt"], { "overlaySites rawdialog:lightboxAt": "a media stage" })).toEqual(["overlay:zzOpen"]);
});

test("planted E: a raw request outside api() counts", () => {
  expect(delta(mailBox("function zzNet() { fetch(\"/x\"); window.fetch(\"/y\"); new EventSource(\"/z\"); return new XMLHttpRequest(); }"))).toEqual({ "rawNet 30-mail-box.js": 4 });
  expect(delta(mailBox("// fetch(\"/x\") in a comment\nconst zzS = \"new EventSource(\";"))).toEqual({});
});

test("planted F: assigning current outside go() counts, a local does not", () => {
  expect(delta(mailBox("function zzCur() { current = \"home\"; }"))).toEqual({ "currentAssign 30-mail-box.js": 1 });
  expect(delta(mailBox("function zzCur2() { let current = 1; current = 2; }"))).toEqual({});
});

test("planted G: an empty state built outside emptyNode counts, a kk-note line does not", () => {
  expect(delta(mailBox("const zzE = () => [el(\"div\", { class: \"list rq-empty\", text: \"\" }), el(\"div\", { class: \"kk-note\", id: \"cm-empty\" })];"))).toEqual({ "emptyBypass 30-mail-box.js": 2 });
  expect(delta(mailBox("const zzN = () => el(\"div\", { class: \"kk-note\", id: \"kk-load\", text: \"\" });"))).toEqual({});
});

// Rule A: the screen lists. Only web/js/03-screens.js declares or changes SCREENS and the lists made from it; a local of the same name
// (a function's `const views = $("#views")`, the notice wording's own SUB inside its IIFE) is not one. The rows marked html: true and the
// #v-<id> sections of web/index.html match both ways. Unlike the ratchet above there is no allowance: every finding fails.
const SCREENS_FILE = "03-screens.js";
const SCREEN_LISTS = ["SCREENS", "views", "SUB", "titles", "NAV", "VIEW_ICON"];
const listWrite = (x: string) => {
  const ref = `(?<![\\w$.])${x}(?:\\.[\\w$]+|\\[[^\\]\\n]*\\])*`;
  return new RegExp(`${ref}\\s*(?:=(?![=>])|\\+\\+|--|[-+*/|&?]{1,2}=)|${ref}\\.(?:push|pop|shift|unshift|splice|sort|reverse|add|delete|clear|set)\\(|Object\\.assign\\(${x}\\b`, "g");
};
function screenRule(files: Record<string, string>, html: string): string[] {
  const out: string[] = [];
  for (const [f, t] of Object.entries(files)) {
    if (f === SCREENS_FILE) continue;
    const p = parse(t);
    for (const d of p.decls) if (SCREEN_LISTS.includes(d.name) && p.topLevel(d.at)) out.push(`declares ${d.name}|${f}`);
    for (const x of SCREEN_LISTS) for (const m of p.find(listWrite(x))) if (!p.isDecl(m.index) && !p.shadowed(m.index, x)) out.push(`changes ${x}|${f}`);
  }
  const rows = readScreens(files[SCREENS_FILE] ?? "") ?? [];
  const inTable = new Set(rows.filter((r) => r.html).map((r) => r.id)), inHtml = new Set([...html.matchAll(/\bid="v-([\w-]+)"/g)].map((m) => m[1]!));
  for (const id of inTable) if (!inHtml.has(id)) out.push(`no section #v-${id} in web/index.html`);
  for (const id of inHtml) if (!inTable.has(id)) out.push(`no html: true row in SCREENS for #v-${id}`);
  return out.sort();
}
const INDEX_HTML = readFileSync(join(ROOT, "web/index.html"), "utf8");

test("rule A: only 03-screens.js declares or changes the screen lists, and its html rows match web/index.html", () => {
  expect(readScreens(files[SCREENS_FILE]!)?.length).toBeGreaterThan(0);
  expect(screenRule(files, INDEX_HTML)).toEqual([]);
});

test("planted A: a list declared or changed elsewhere, or a row and a section out of step, is named", () => {
  expect(screenRule({ ...files, ...mailBox("views.push(\"zz\"); SUB.add(\"zz\"); titles.zz = \"x\"; VIEW_ICON[\"zz\"] = \"x\";\nconst NAV = [];") }, INDEX_HTML))
    .toEqual(["changes SUB|30-mail-box.js", "changes VIEW_ICON|30-mail-box.js", "changes titles|30-mail-box.js", "changes views|30-mail-box.js", "declares NAV|30-mail-box.js"]);
  expect(screenRule({ ...files, ...mailBox("function zzV() { const views = $(\"#views\"); views.scrollTop += 1; }") }, INDEX_HTML)).toEqual([]);
  const noHarness = files[SCREENS_FILE]!.replace(/^ {2}harness: .*\n/m, "");
  expect(screenRule({ ...files, [SCREENS_FILE]: noHarness }, INDEX_HTML)).toEqual(["no html: true row in SCREENS for #v-harness"]);
  expect(screenRule(files, INDEX_HTML.replace('id="v-usage"', 'id="zz-usage"'))).toEqual(["no section #v-usage in web/index.html"]);
});
