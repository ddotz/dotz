import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flatCounts } from "./engineering-rules.ts";
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
// - C ownerWrites "NAME|file": writes to a shared object or cross-file let from a file that does not own it (hub/web-structure-owners.json).
//   A match is skipped where an enclosing function declares a parameter or local of that name (bkStep(S), a local `target`).
// - B goBranches: `name === "` inside go(); fnReassign "name|file": a declared function reassigned outside any function (a monkeypatch).
// - D overlaySites: rawdialog/overlay sites (hub/ui-surfaces.ts) outside the files that implement dialogs, menus, overlays and history.
// - E rawNet: fetch(, new EventSource, new XMLHttpRequest and a window.fetch wrapper outside api(), per file.
// - F currentAssign: `current =` per file; go() is the only one.
// - G emptyBypass: el() calls building an empty state (class empty/rq-empty/cv-empty/mon-ov-empty, id kk-empty/cm-empty/dm-empty/kk-nomatch)
//   outside emptyNode, per file. kk-note alone is a loading, error or pick-a-room line, not counted.
// Regenerate after a fix: WEB_STRUCTURE_WRITE=1 bun test hub/web-structure-web.test.ts (reasons and _rule are kept; the test preload drops DOTZ_* names).
type Counts = Record<string, number>;
type Audit = { ownerWrites: Counts; goBranches: number; fnReassign: Counts; overlaySites: string[]; rawNet: Counts; currentAssign: Counts; emptyBypass: Counts };
type Allow = { _rule: string; counts: Audit; reasons: Record<string, string> };
const ALLOW_PATH = join(ROOT, "hub/web-structure-allow.json");
const OWNERS = JSON.parse(readFileSync(join(ROOT, "hub/web-structure-owners.json"), "utf8")) as { objects: Record<string, string[]>; lets: Record<string, string[]> };
const OVERLAY_HOMES = new Set(["02-basic-markdown.js", "03-menu.js", "38-overlay.js", "32-history-nav.js"]);
const EMPTY_CLASS = new Set(["empty", "rq-empty", "cv-empty", "mon-ov-empty"]);
const EMPTY_ID = new Set(["kk-empty", "cm-empty", "dm-empty", "kk-nomatch"]);
const NOT_PARAMS = new Set(["if", "while", "switch", "with", "return", "typeof", "await"]);
const NET = /(?<![\w$.])(?:window\.)?fetch\(|(?<![\w$.])window\.fetch\s*=(?![=>])|(?<![\w$.])new\s+(?:EventSource|XMLHttpRequest)\(/g;
const ASSIGN = /(?<![\w$.])([\w$]+)\s*=(?![=>])/g;
const esc = (s: string) => s.replace(/[$]/g, "\\$");
const objectWrite = (x: string) =>
  new RegExp(`(?<![\\w$.])${esc(x)}\\.[\\w.]+\\s*(?:=(?![=>])|\\+\\+|--|[-+*/|&?]{1,2}=)|(?<![\\w$.])${esc(x)}\\.[\\w.]+\\.(?:add|delete|clear|set|push|splice)\\(|Object\\.assign\\(${esc(x)}\\b`, "g");
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

// One file: its code with strings and comments blanked, its { } blocks, and its top-level declarations.
function parse(text: string) {
  const mask = codeMask(text), code = Array.from(text, (c, i) => (mask[i] || c === "\n" ? c : " ")).join("");
  const blocks: [number, number][] = [], open: number[] = [];
  for (let i = 0; i < code.length; i++) if (code[i] === "{") open.push(i); else if (code[i] === "}" && open.length) blocks.push([open.pop()!, i]);
  const decls = [...text.matchAll(DECL)].filter((m) => mask[m.index]).map((m) => ({ at: m.index, name: m[1] ?? m[2]!, fn: !!m[1] }));
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
  // Locals a block declares itself: its text with the blocks inside it blanked, read for const/let/var lists.
  const locals = ([o, c]: [number, number], name: string) => {
    let own = code.slice(o + 1, c);
    for (const [io, ic] of blocks) if (io > o && ic < c) own = own.slice(0, io - o - 1) + " ".repeat(ic - io + 1) + own.slice(ic - o);
    return [...own.matchAll(/(?<![\w$.])(?:const|let|var)\s+([^;]*)/g)].some((m) => declares(m[1]!, name));
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
    for (const [name, owners] of Object.entries(OWNERS.lets)) if (!owners.includes(f))
      for (const m of p.find(letWrite(name))) if (!p.isDecl(m.index) && !p.shadowed(m.index, name)) bump(r.ownerWrites, `${name}|${f}`);
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
  r.overlaySites = sites.filter((s) => (s.kind === "rawdialog" || s.kind === "overlay") && !OVERLAY_HOMES.has(s.file)).map((s) => s.key).sort();
  for (const k of ["ownerWrites", "fnReassign", "rawNet", "currentAssign", "emptyBypass"] as const) r[k] = sortKeys(r[k]);
  return r;
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

test("planted B: a go() branch and a top-level function reassignment count", () => {
  const cp = files["05-command-palette.js"]!;
  expect(delta({ "05-command-palette.js": cp.replace("function go(name, tgt) {\n", "function go(name, tgt) {\n  if (name === \"zz\") return;\n") })).toEqual({ goBranches: 1 });
  expect(delta(mailBox("const zzGo = go;\ngo = function (n, t) { zzGo(n, t); };"))).toEqual({ "fnReassign go|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzGo2() { let go = 1; go = 2; }"))).toEqual({});
});

test("planted D: a raw <dialog> or ovOpen outside the overlay files counts", () => {
  expect(delta(mailBox("function zzOpen(d) { d.showModal(); ovOpen(() => d.close()); }"))).toEqual({ "overlaySites overlay:zzOpen": 1, "overlaySites rawdialog:zzOpen": 1 });
  expect(delta({ "03-menu.js": `${files["03-menu.js"]}\nfunction zzMenu(d) { d.showModal(); }\n` })).toEqual({});
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
