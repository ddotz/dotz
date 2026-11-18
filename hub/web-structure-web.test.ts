import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flatCounts } from "./engineering-rules.ts";
import { audit, SCREENS_FILE, screenRule, unowned, unreasoned, webFiles } from "./web-structure.ts";

// The scanner of hub/web-structure.ts proven on planted code: each case moves exactly its own number and the skipped shapes move nothing. The real tree is audited by `bun hub/check.ts`.
const files = webFiles();
const REAL = audit(files);
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
  expect(unowned({ ...files, ...mailBox("let ZC = null, ZD = 0,\n  ZE = [];"), ...mon("function zzZE() { ZE = []; ZD = 1; }") })).toEqual(["ZD|30-mail-box.js <- 30-monitoring.js", "ZE|30-mail-box.js <- 30-monitoring.js"]);
  expect(unowned({ ...files, ...mailBox("const ZA = 1, ZB = new Map();\nfunction zzOwn() { ZB.set(1, 2); }"), ...mon("function zzRd(ZB) { ZB.set(1, 2); return ZB; }") })).toEqual([]);
});

test("planted completeness: a null or call initializer later holding an object, a destructured name and a primitive let are named until owned", () => {
  const mon = (line: string) => ({ "30-monitoring.js": `${files["30-monitoring.js"]}\n${line}\n` });
  expect(unowned({ ...files, ...mailBox("let ZN = null;\nconst ZK = zzMake(), ZU = undefined;"), ...mon("function zzNK(k) { ZN.k = 1; ZK.set(1, 2); ZU[k] = 1; }") }))
    .toEqual(["ZK|30-mail-box.js <- 30-monitoring.js", "ZN|30-mail-box.js <- 30-monitoring.js", "ZU|30-mail-box.js <- 30-monitoring.js"]);
  expect(unowned({ ...files, ...mailBox("const { ZP, ZQ: ZR } = zzObj();\nlet [ZV] = [1];"), ...mon("function zzDs() { ZR.x = 1; ZV = 2; return ZP; }") }))
    .toEqual(["ZR|30-mail-box.js <- 30-monitoring.js", "ZV|30-mail-box.js <- 30-monitoring.js"]);
  expect(unowned({ ...files, ...mailBox("let ZS = 0, ZT = \"\";"), ...mon("function zzPr() { ZS = 2; return ZT; }") })).toEqual(["ZS|30-mail-box.js <- 30-monitoring.js"]);
  expect(unowned({ ...files, ...mailBox("let ZS = 0;"), ...mon("function zzPr(ZS) { ZS = 2; }\nconst zzPr2 = ZS => ZS.k = 1;") })).toEqual([]);
});

test("planted C: a write to a registered primitive let from another file counts", () => {
  expect(delta(mailBox("function zzLets() { botName = \"x\"; convSig = \"\"; hSel = null; }"))).toEqual({ "ownerWrites botName|30-mail-box.js": 1, "ownerWrites convSig|30-mail-box.js": 1, "ownerWrites hSel|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzDecl() {}\nlet botName = \"\";"))).toEqual({});
});

test("planted C: writes through a block-local alias of an owned object count in that block only", () => {
  expect(delta(mailBox("function zzAl() { const g = CS.group; g.live = 1; g.xs.push(1); const t = FS[FS.length - 1]; t.ends.push(1); }"))).toEqual({ "ownerWrites CS|30-mail-box.js": 2, "ownerWrites FS|30-mail-box.js": 1 });
  expect(delta(mailBox("function zzAl2() { const g = CS.group; return g.live; }\nfunction zzAl3(g) { g.live = 1; }\nfunction zzAl4(CS) { const g = CS.group; g.live = 1; }"))).toEqual({});
});

test("planted C: a parameter of an expression-bodied arrow and a destructured local shadow", () => {
  expect(delta(mailBox("const zzAr = MON => MON.xs.sort();\nconst zzAr2 = (a, NT) => NT.by[a] = 1;\nfunction zzDs(act) { const a = 1, { MON } = act; MON.zz = 1; }"))).toEqual({});
  expect(delta(mailBox("const zzAr3 = (xs) => MON.xs.sort(), zzAr4 = NT => 1;\nfunction zzAr5() { NT.zz = 1; }"))).toEqual({ "ownerWrites MON|30-mail-box.js": 1, "ownerWrites NT|30-mail-box.js": 1 });
});

const inGo = (line: string) => ({ "05-command-palette.js": files["05-command-palette.js"]!.replace("function go(name, tgt) {\n", `function go(name, tgt) {\n  ${line}\n`) });

test("planted B: each test of a screen name inside go() counts, whatever its form", () => {
  expect(delta(inGo("if (name === \"notices\") return;"))).toEqual({ goBranches: 1 });
  expect(delta(inGo("if (\"usage\" !== current || prevView == \"apps\" || tgt.view != 'models') return;"))).toEqual({ goBranches: 3 });
  expect(delta(inGo("switch (name) { case \"devices\": return; case \"zz\": break; }"))).toEqual({ goBranches: 1 });
  expect(delta(inGo("if ([\"models\", \"usage\"].includes(name) || new Set([\"apps\"]).has(current)) return;"))).toEqual({ goBranches: 3 });
  expect(delta(inGo("if (name.startsWith(\"monitoring\") || current.indexOf(\"monitoring/c:\") === 0 || routeName(tgt) === \"chat\") return;"))).toEqual({ goBranches: 3 });
});

test("planted B: a screen name written, a row field tested, a non-screen literal or a test outside go() does not count", () => {
  expect(delta(inGo("if (!tgt) { name = \"home\"; tgt = tgt ? \"chat/list\" : `monitoring/c:${tgt}`; navSync(\"monitoring\", \"settings\"); }"))).toEqual({});
  expect(delta(inGo("if (SCREENS[name]?.tab === \"chat\" || \"settings\" !== SCREENS[name].tab || [\"chat\"].includes(SCREENS[name].tab)) tgt = SCREENS[\"chat\"];"))).toEqual({});
  expect(delta(inGo("switch (SCREENS[name].tab) { case \"chat\": break; }"))).toEqual({});
  expect(delta(inGo("if (tgt === \"list\" || name === \"zz\" || $(\"#v-chat\") || localStorage.getItem(\"chat\")) return; // name === \"notices\""))).toEqual({});
  expect(delta(mailBox("function zzNm(name) { return name === \"notices\" || [\"apps\"].includes(name); }"))).toEqual({});
});

test("planted B: a top-level function reassignment counts", () => {
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

const INDEX_HTML = readFileSync(join(import.meta.dir, "..", "web/index.html"), "utf8");

test("planted A: a list declared or changed elsewhere, or a row and a section out of step, is named", () => {
  expect(screenRule({ ...files, ...mailBox("views.push(\"zz\"); SUB.add(\"zz\"); titles.zz = \"x\"; VIEW_ICON[\"zz\"] = \"x\";\nconst NAV = [];") }, INDEX_HTML))
    .toEqual(["changes SUB|30-mail-box.js", "changes VIEW_ICON|30-mail-box.js", "changes titles|30-mail-box.js", "changes views|30-mail-box.js", "declares NAV|30-mail-box.js"]);
  expect(screenRule({ ...files, ...mailBox("function zzV() { const views = $(\"#views\"); views.scrollTop += 1; }") }, INDEX_HTML)).toEqual([]);
  const noHarness = files[SCREENS_FILE]!.replace(/^ {2}harness: .*\n/m, "");
  expect(screenRule({ ...files, [SCREENS_FILE]: noHarness }, INDEX_HTML)).toEqual(["no html: true row in SCREENS for #v-harness"]);
  expect(screenRule(files, INDEX_HTML.replace('id="v-usage"', 'id="zz-usage"'))).toEqual(["no section #v-usage in web/index.html"]);
});
